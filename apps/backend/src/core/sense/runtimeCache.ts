import { createHash, randomUUID } from 'node:crypto'

export type CacheStatus = 'hit' | 'miss' | 'stale' | 'bypass'

export interface CacheLookup<T> {
  status: CacheStatus
  value?: T
}

export interface CacheTelemetry {
  status: CacheStatus
  key: string
}

export interface RuntimeCacheOptions {
  ttlMs: number
  maxEntries: number
  maxBytes: number
  now?: () => number
  onLookup?: (event: CacheTelemetry) => void
}

interface CacheEntry<T> {
  value: T
  expiresAt: number
  bytes: number
  touchedAt: number
}

const SECRET_KEY =
  /(^|[-_])(api[-_]?key|key|token|secret|password|passwd|cookie|authorization|credential)([-_]|$)/i

function canonicalize(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[REDACTED]'
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([name]) => !SECRET_KEY.test(name))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, item]) => [name, canonicalize(item, name)]),
  )
}

/** Stable request identity. Secrets are never part of the returned key. */
export function canonicalCacheKey(input: {
  operationClass: string
  url?: string
  query?: unknown
  provider?: string
}): string {
  let url = input.url
  if (url) {
    try {
      const parsed = new URL(url)
      parsed.hash = ''
      for (const name of [...parsed.searchParams.keys()]) {
        if (SECRET_KEY.test(name)) parsed.searchParams.delete(name)
      }
      parsed.searchParams.sort()
      parsed.username = ''
      parsed.password = ''
      url = parsed.href
    } catch {
      url = url.trim()
    }
  }
  const material = JSON.stringify(
    canonicalize({
      operationClass: input.operationClass,
      url,
      query: input.query,
      provider: input.provider,
    }),
  )
  return createHash('sha256').update(material).digest('hex')
}

/** In-memory bounded cache. It is deliberately non-persistent and TTL based. */
export class BoundedRuntimeCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()
  private bytes = 0
  private readonly now: () => number

  constructor(private readonly options: RuntimeCacheOptions) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)
      throw new Error('maxEntries must be positive')
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
      throw new Error('ttlMs must be positive')
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1)
      throw new Error('maxBytes must be positive')
    this.now = options.now ?? Date.now
  }

  get(key: string): CacheLookup<T> {
    const entry = this.entries.get(key)
    if (!entry) {
      this.options.onLookup?.({ status: 'miss', key })
      return { status: 'miss' }
    }
    if (entry.expiresAt <= this.now()) {
      this.bytes -= entry.bytes
      this.entries.delete(key)
      this.options.onLookup?.({ status: 'stale', key })
      return { status: 'stale' }
    }
    entry.touchedAt = this.now()
    this.options.onLookup?.({ status: 'hit', key })
    return { status: 'hit', value: entry.value }
  }

  set(key: string, value: T): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (bytes > this.options.maxBytes) return false
    const previous = this.entries.get(key)
    if (previous) this.bytes -= previous.bytes
    this.entries.set(key, {
      value,
      bytes,
      expiresAt: this.now() + this.options.ttlMs,
      touchedAt: this.now(),
    })
    this.bytes += bytes
    this.evict()
    return this.entries.has(key)
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  get size(): number {
    return this.entries.size
  }

  private evict(): void {
    while (this.entries.size > this.options.maxEntries || this.bytes > this.options.maxBytes) {
      const oldest = [...this.entries.entries()].sort(
        ([, a], [, b]) => a.touchedAt - b.touchedAt,
      )[0]
      if (!oldest) break
      this.bytes -= oldest[1].bytes
      this.entries.delete(oldest[0])
    }
  }
}

export interface ObservationDedupe {
  urlSeen(url: string): boolean
  resultSeen(result: unknown): boolean
}

/** Dedupe is scoped to one observation, never to history or long-term memory. */
export function createObservationDedupe(): ObservationDedupe {
  const urls = new Set<string>()
  const results = new Set<string>()
  return {
    urlSeen(url) {
      const key = canonicalCacheKey({ operationClass: 'observation-url', url })
      if (urls.has(key)) return true
      urls.add(key)
      return false
    },
    resultSeen(result) {
      const key = createHash('sha256')
        .update(JSON.stringify(canonicalize(result)))
        .digest('hex')
      if (results.has(key)) return true
      results.add(key)
      return false
    },
  }
}

export function newOperationId(): string {
  return randomUUID()
}
