import { z } from 'zod'
import {
  BoundedRuntimeCache,
  canonicalCacheKey,
  createObservationDedupe,
  type RuntimeCacheOptions,
} from '@/core/sense/runtimeCache.js'

export const webSearchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .refine((s) => s.split(/\s+/).length <= 75),
    limit: z.number().int().min(1).max(10).optional(),
    max_output_chars: z.number().int().min(512).max(12000).optional(),
  })
  .strict()

export type SearchInput = z.infer<typeof webSearchSchema>
export type Availability = 'ready' | 'configuration_missing' | 'provider_unavailable'
export interface SearchResult {
  title: string
  url: string
  snippet: string
  source?: string
  publishedAt?: string
}
export interface SearchProvider {
  id: string
  availability(): Availability
  search(input: { query: string; limit: number }, signal: AbortSignal): Promise<SearchResult[]>
}
const errors = {
  invalid_input: '搜索参数无效。',
  no_provider: '没有注册搜索服务。',
  configuration_missing: '搜索服务缺少配置。',
  provider_unavailable: '指定搜索服务不可用。',
  ambiguous_provider: '多个搜索服务可用，请在后端明确选择。',
  network_error: '搜索服务请求失败。',
  timeout: '搜索请求超时。',
  cancelled: '搜索请求已取消。',
  authentication_failed: '搜索服务认证失败。',
  rate_limited: '搜索服务请求额度或频率受限。',
  invalid_response: '搜索服务返回无效响应。',
  response_too_large: '搜索服务响应超过大小上限。',
  recovery_unavailable: '没有可恢复的有效搜索观察，请明确发起新的搜索。',
} as const
export type SearchErrorCode = keyof typeof errors
export class SearchError extends Error {
  constructor(public readonly code: SearchErrorCode) {
    super(errors[code])
  }
}

export interface SearchObservation {
  ok: boolean
  provider: string | null
  observedAt: string
  truncated: boolean
  trust: 'untrusted_external_data'
  results: SearchResult[]
  error?: { code: SearchErrorCode; message: string }
}

export interface WebSearchRateLimitOptions {
  maxRequests: number
  windowMs: number
}

function clean(value: string, limit: number): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/** Registrations are trusted backend code, not model-controlled configuration. */
export class WebSearchRuntime {
  private readonly providers = new Map<string, SearchProvider>()
  private readonly cache: BoundedRuntimeCache<SearchObservation>
  private readonly rateLimit: WebSearchRateLimitOptions
  private readonly requestTimes: number[] = []
  constructor(
    private readonly options: {
      provider?: () => string | undefined
      cacheNamespace?: () => string
      timeoutMs?: number
      cache?: RuntimeCacheOptions
      rateLimit?: WebSearchRateLimitOptions
      now?: () => number
    } = {},
  ) {
    this.cache = new BoundedRuntimeCache(
      options.cache ?? { ttlMs: 60000, maxEntries: 128, maxBytes: 1048576 },
    )
    this.rateLimit = options.rateLimit ?? { maxRequests: 10, windowMs: 60000 }
    if (
      !Number.isInteger(this.rateLimit.maxRequests) ||
      this.rateLimit.maxRequests < 1 ||
      !Number.isFinite(this.rateLimit.windowMs) ||
      this.rateLimit.windowMs <= 0
    )
      throw new Error('Invalid web search rate limit')
  }

  register(provider: SearchProvider): void {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(provider.id) || this.providers.has(provider.id)) {
      throw new Error('Invalid or duplicate search provider id')
    }
    this.providers.set(provider.id, provider)
  }

  status(): { id: string; configured: boolean; state: Availability }[] {
    return [...this.providers.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => {
        let state: Availability
        try {
          state = p.availability()
        } catch {
          state = 'provider_unavailable'
        }
        if (!['ready', 'configuration_missing', 'provider_unavailable'].includes(state))
          state = 'provider_unavailable'
        return { id: p.id, configured: state !== 'configuration_missing', state }
      })
  }

  async search(
    raw: unknown,
    signal?: AbortSignal,
    mode: 'execute' | 'replay' = 'execute',
  ): Promise<SearchObservation> {
    const out: SearchObservation = {
      ok: false,
      provider: null,
      observedAt: new Date().toISOString(),
      truncated: false,
      trust: 'untrusted_external_data',
      results: [],
    }
    const fail = (code: SearchErrorCode): SearchObservation => ({
      ...out,
      ok: false,
      results: [],
      error: { code, message: errors[code] },
    })
    const parsed = webSearchSchema.safeParse(raw)
    if (!parsed.success) return fail('invalid_input')
    if (signal?.aborted) return fail('cancelled')
    const input = parsed.data
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const cancel = () => controller.abort(new SearchError('cancelled'))
    let onAbort: (() => void) | undefined
    try {
      const statuses = this.status()
      if (!statuses.length) return fail('no_provider')
      const selected = this.options.provider?.()?.trim()
      let id: string
      if (selected) {
        const status = statuses.find((p) => p.id === selected)
        if (!status) return fail('provider_unavailable')
        out.provider = status.id
        if (status.state !== 'ready') return fail(status.state)
        id = status.id
      } else {
        const ready = statuses.filter((p) => p.state === 'ready')
        if (ready.length > 1) return fail('ambiguous_provider')
        if (!ready.length)
          return fail(
            statuses.some((p) => p.state === 'configuration_missing')
              ? 'configuration_missing'
              : 'provider_unavailable',
          )
        id = ready[0]!.id
      }
      out.provider = id
      const limit = input.limit ?? 5
      const budget = input.max_output_chars ?? 8000
      const key = canonicalCacheKey({
        operationClass: 'web-search',
        provider: `${id}:${this.options.cacheNamespace?.() ?? ''}`,
        query: { query: input.query, limit, max_output_chars: budget },
      })
      if (signal?.aborted) return fail('cancelled')
      const cached = this.cache.get(key)
      if (cached.value) return structuredClone(cached.value)
      // Recovery never starts work, including after restart or TTL expiry.
      if (mode === 'replay') return fail('recovery_unavailable')
      const now = this.options.now?.() ?? Date.now()
      while (this.requestTimes[0] !== undefined && now - this.requestTimes[0] >= this.rateLimit.windowMs)
        this.requestTimes.shift()
      if (this.requestTimes.length >= this.rateLimit.maxRequests) return fail('rate_limited')
      this.requestTimes.push(now)
      const provider = this.providers.get(id)!
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', onAbort, { once: true })
        if (controller.signal.aborted) onAbort()
      })
      timer = setTimeout(
        () => controller.abort(new SearchError('timeout')),
        this.options.timeoutMs ?? 15000,
      )
      const results = await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          return provider.search({ query: input.query, limit }, controller.signal)
        }),
        aborted,
      ])
      if (!Array.isArray(results)) throw new SearchError('invalid_response')
      out.ok = true
      const routed = results as typeof results & { selectedProvider?: string }
      if (routed.selectedProvider) out.provider = routed.selectedProvider
      const dedupe = createObservationDedupe()
      for (const result of results.slice(0, 100)) {
        if (
          !result ||
          typeof result.url !== 'string' ||
          typeof result.title !== 'string' ||
          typeof result.snippet !== 'string'
        ) {
          out.truncated = true
          continue
        }
        let url: URL
        try {
          url = new URL(result.url)
        } catch {
          out.truncated = true
          continue
        }
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.href.length > 2048
        ) {
          out.truncated = true
          continue
        }
        url.hash = ''
        if (dedupe.urlSeen(url.href)) continue
        if (out.results.length >= limit) {
          out.truncated = true
          break
        }
        const item: SearchResult = {
          title: clean(result.title, 300),
          url: url.href,
          snippet: clean(result.snippet, 2000),
          source: clean(typeof result.source === 'string' ? result.source : url.hostname, 200),
          ...(typeof result.publishedAt === 'string'
            ? { publishedAt: clean(result.publishedAt, 80) }
            : {}),
        }
        if (
          result.title.length > 300 ||
          result.snippet.length > 2000 ||
          (result.source?.length ?? 0) > 200 ||
          (result.publishedAt?.length ?? 0) > 80
        )
          out.truncated = true
        if (dedupe.resultSeen(item)) continue
        out.results.push(item)
        if (JSON.stringify(out).length > budget) {
          out.results.pop()
          out.truncated = true
          break
        }
      }
      if (results.length > 100) out.truncated = true
      controller.signal.throwIfAborted()
      this.cache.set(key, structuredClone(out))
      return out
    } catch (error) {
      return fail(error instanceof SearchError ? error.code : 'network_error')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    }
  }
}
