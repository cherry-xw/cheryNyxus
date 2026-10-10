/**
 * 独立测试任务补充探针（t_a7e73c70）：web runtime / Brave provider 边界。
 * 与 apps/backend/test/agent/sense/webSearch.test.ts 互补，不修改产品实现；全部本地 fixture，无网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  WebSearchRuntime,
  webSearchSchema,
  type SearchProvider,
} from '@/agent/sense/web/runtime.js'
import { createBraveProvider } from '@/agent/sense/web/brave.js'
import { createWebSearchSense } from '@/agent/sense/webSearch.js'

const base = {
  title: 't',
  url: 'https://example.org/x',
  snippet: 's',
}
function provider(
  id = 'p1',
  state: 'ready' | 'configuration_missing' | 'provider_unavailable' = 'ready',
): SearchProvider {
  return { id, availability: () => state, search: vi.fn(async () => [base]) }
}
function runtime(p: SearchProvider = provider(), options = {}) {
  const r = new WebSearchRuntime(options)
  r.register(p)
  return r
}
afterEach(() => vi.restoreAllMocks())

describe('schema wording and query privacy', () => {
  it('schema description marks results as untrusted external data', () => {
    const s = createWebSearchSense(runtime())
    expect(s.definition.function.description).toContain('不可信')
    expect(s.definition.function.description).not.toContain('brave')
    expect(s.definition.function.description.toLowerCase()).not.toContain('api key')
  })
  it('query boundaries: 600 chars / 75 words pass, 601 chars / 76 words fail', () => {
    expect(webSearchSchema.safeParse({ query: 'a'.repeat(600) }).success).toBe(true)
    expect(webSearchSchema.safeParse({ query: 'a'.repeat(601) }).success).toBe(false)
    expect(webSearchSchema.safeParse({ query: Array(75).fill('w').join(' ') }).success).toBe(true)
    expect(webSearchSchema.safeParse({ query: Array(76).fill('w').join(' ') }).success).toBe(false)
    // mixed: word limit counts after trim; 600-char single long word with <=75 words passes
    expect(
      webSearchSchema.safeParse({ query: `  ${Array(75).fill('w').join(' ')}  ` }).success,
    ).toBe(true)
  })
  it('failed observations never echo the query; success echoes it only in results context', async () => {
    const q = 'PRIVATE_MARKER_query'
    const failed = await runtime(provider('p1', 'configuration_missing')).search({ query: q })
    expect(failed.error?.code).toBe('configuration_missing')
    expect(JSON.stringify(failed)).not.toContain(q)
    const ok = await runtime().search({ query: q })
    expect(JSON.stringify(ok).split(q).length).toBeLessThanOrEqual(2)
  })
})

describe('provider selection states', () => {
  it('explicit selection skips ambiguity check and never touches other providers', async () => {
    const a = provider('a')
    const b = provider('b')
    const r = new WebSearchRuntime({ provider: () => 'b' })
    r.register(a)
    r.register(b)
    expect((await r.search({ query: 'x' })).provider).toBe('b')
    expect(a.search).not.toHaveBeenCalled()
  })
  it('explicit blank/whitespace selection falls back to auto rules', async () => {
    const r = new WebSearchRuntime({ provider: () => '   ' })
    r.register(provider())
    expect((await r.search({ query: 'x' })).ok).toBe(true)
  })
  it('availability returning garbage normalizes to provider_unavailable but stays configured', () => {
    const p = provider('weird')
    ;(p as { availability: () => unknown }).availability = () => 'garbage' as unknown
    const r = new WebSearchRuntime()
    r.register(p)
    expect(r.status()[0]?.state).toBe('provider_unavailable')
    expect(r.status()[0]?.configured).toBe(true)
  })
  it('rejects invalid provider ids and duplicate registration', () => {
    const r = new WebSearchRuntime()
    expect(() => r.register(provider('Bad-ID'))).toThrow()
    expect(() => r.register(provider('1x'))).toThrow()
    expect(() => r.register(provider('x'.repeat(41)))).toThrow()
    r.register(provider('ok-id'))
    expect(() => r.register(provider('ok-id'))).toThrow()
  })
  it('status output is sorted and pure: no search network side effects', () => {
    const a = provider('aa')
    const b = provider('bb')
    const r = new WebSearchRuntime()
    r.register(b)
    r.register(a)
    expect(r.status().map((s) => s.id)).toEqual(['aa', 'bb'])
    expect(a.search).not.toHaveBeenCalled()
    expect(b.search).not.toHaveBeenCalled()
  })
})

describe('result processing edges', () => {
  it('keeps provider source field; falls back to result hostname when absent', async () => {
    const p = provider()
    p.search = async () => [
      { ...base, source: 'Example News' },
      { ...base, url: 'https://sub.example2.org/a' },
    ]
    const out = await runtime(p).search({ query: 'x' })
    expect(out.results[0]?.source).toBe('Example News')
    expect(out.results[1]?.source).toBe('sub.example2.org')
  })
  it('drops non-string publishedAt, caps string one at 80 chars with truncated flag', async () => {
    const p = provider()
    p.search = async () => [
      { ...base, publishedAt: 123 as unknown as string },
      { ...base, url: 'https://example.org/2', publishedAt: 'p'.repeat(90) },
    ]
    const out = await runtime(p).search({ query: 'x' })
    expect(out.results[0]).not.toHaveProperty('publishedAt')
    expect(out.results[1]?.publishedAt).toHaveLength(80)
    expect(out.truncated).toBe(true)
  })
  it('limit boundary: limit=1 with two distinct urls keeps one and marks truncated', async () => {
    const p = provider()
    p.search = async () => [base, { ...base, url: 'https://example.org/2' }]
    const out = await runtime(p).search({ query: 'x', limit: 1 })
    expect(out.results).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })
  it('http:// accepted alongside https://; ftp rejected as truncated', async () => {
    const p = provider()
    p.search = async () => [
      { ...base, url: 'http://example.org/plain' },
      { ...base, url: 'ftp://example.org/file' },
    ]
    const out = await runtime(p).search({ query: 'x' })
    expect(out.results.map((r) => r.url)).toEqual(['http://example.org/plain'])
    expect(out.truncated).toBe(true)
  })
  it('url longer than 2048 chars rejected without throwing', async () => {
    const p = provider()
    p.search = async () => [{ ...base, url: `https://example.org/${'a'.repeat(3000)}` }]
    const out = await runtime(p).search({ query: 'x' })
    expect(out.ok).toBe(true)
    expect(out.results).toHaveLength(0)
    expect(out.truncated).toBe(true)
  })
  it('control characters and html tags stripped from all text fields', async () => {
    const p = provider()
    p.search = async () => [
      {
        title: 'a\x00\x1f<b>b</b>',
        url: 'https://example.org/c',
        snippet: '<style>x</style>ok<script>bad()</script>',
        source: 'src\x07name',
        publishedAt: '20\x1f26',
      },
    ]
    const out = await runtime(p).search({ query: 'x' })
    expect(out.results[0]?.title).toBe('a b')
    expect(out.results[0]?.snippet).toBe('ok')
    expect(out.results[0]?.source).toBe('src name')
    expect(out.results[0]?.publishedAt).toBe('20 26')
  })
  it('non-array provider return is invalid_response; malformed entries skipped with truncated', async () => {
    const p1 = provider('p1')
    p1.search = vi.fn(async () => ({ not: 'array' }) as unknown as SearchResultList)
    expect((await runtime(p1).search({ query: 'x' })).error?.code).toBe('invalid_response')
    const p2 = provider('p2')
    p2.search = async () => [null, base]
    const out = await runtime(p2).search({ query: 'x' })
    expect(out.ok).toBe(true)
    expect(out.results).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })
  it('more than 100 provider results are cut at limit with truncated flag', async () => {
    const p = provider()
    p.search = async () =>
      Array.from({ length: 120 }, (_, i) => ({ ...base, url: `https://example.org/${i}` }))
    const out = await runtime(p).search({ query: 'x', limit: 10 })
    expect(out.results).toHaveLength(10)
    expect(out.truncated).toBe(true)
  })
  it('budget floor: max_output_chars=512 always satisfiable via item eviction', async () => {
    const p = provider()
    p.search = async () => [{ ...base, snippet: 'x'.repeat(3000) }]
    const out = await runtime(p).search({ query: 'x', max_output_chars: 512 })
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(512)
    expect(out.ok).toBe(true)
  })
})

describe('cancellation edge cases', () => {
  it('already-aborted signal never calls provider', async () => {
    const p = provider()
    const c = new AbortController()
    c.abort()
    await runtime(p).search({ query: 'x' }, c.signal)
    expect(p.search).not.toHaveBeenCalled()
  })
  it('default 15s timeout applies when options omitted; underlying signal aborted', async () => {
    const p = provider()
    let gotSignal: AbortSignal | undefined
    p.search = async (_, s) => {
      gotSignal = s
      return new Promise(() => {})
    }
    const pending = runtime(p).search({ query: 'x' })
    const out = await pending
    expect(out.error?.code).toBe('timeout')
    expect(gotSignal?.aborted).toBe(true)
  }, 20000)
  it('cancellation preserves trust marker and provider id in failure observation', async () => {
    const r = runtime(provider(), { timeoutMs: 5 })
    const c = new AbortController()
    const pending = r.search({ query: 'x' }, c.signal)
    c.abort()
    const out = await pending
    expect(out.error?.code).toBe('cancelled')
    expect(out.provider).toBe('p1')
    expect(out.trust).toBe('untrusted_external_data')
    expect(out.ok).toBe(false)
  })
})

describe('brave adapter hard boundaries', () => {
  const key = 'probe-secret-42'
  const json = (v: unknown, init?: ResponseInit) =>
    new Response(JSON.stringify(v), {
      headers: { 'content-type': 'application/json' },
      ...init,
    })
  it('sends only documented headers; nothing else injected', async () => {
    const request = vi.fn<typeof fetch>(async () => json({ web: { results: [] } }))
    const p = createBraveProvider(() => key, request)
    await runtime(p).search({ query: 'x' })
    const options = request.mock.calls[0]![1]
    expect(Object.keys((options?.headers ?? {}) as object).sort()).toEqual([
      'Accept',
      'X-Subscription-Token',
    ])
  })
  it('count param equals input.limit; result_filter and text_decorations fixed', async () => {
    const request = vi.fn<typeof fetch>(async () => json({ web: { results: [] } }))
    const p = createBraveProvider(() => key, request)
    await runtime(p).search({ query: 'x', limit: 10 })
    const url = request.mock.calls[0]![0] as URL
    expect(url.searchParams.get('count')).toBe('10')
    expect(url.searchParams.get('result_filter')).toBe('web')
    expect(url.searchParams.get('text_decorations')).toBe('false')
  })
  it('empty results array is a valid ok observation with zero entries', async () => {
    const request = vi.fn<typeof fetch>(async () => json({ web: { results: [] } }))
    const p = createBraveProvider(() => key, request)
    const out = await runtime(p).search({ query: 'x' })
    expect(out.ok).toBe(true)
    expect(out.results).toHaveLength(0)
    expect(out.truncated).toBe(false)
  })
  it('non-object entries inside web.results rejected as invalid_response', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      json({ web: { results: [{ title: 1 }, 'junk'] } }),
    )
    const p = createBraveProvider(() => key, request)
    expect((await runtime(p).search({ query: 'x' })).error?.code).toBe('invalid_response')
  })
  it('content-type with charset suffix still accepted', async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            web: { results: [{ title: 't', url: 'https://example.org/x', description: 's' }] },
          }),
          {
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        ),
    )
    const p = createBraveProvider(() => key, request)
    const out = await runtime(p).search({ query: 'x' })
    expect(out.ok).toBe(true)
    expect(out.results[0]?.snippet).toBe('s')
  })
  it('fetch throwing synchronously maps to network_error without leaking message or key', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('ECONNRESET internal-ip-9')
    })
    const p = createBraveProvider(() => key, request)
    const out = await runtime(p).search({ query: 'x' })
    expect(out.error?.code).toBe('network_error')
    expect(JSON.stringify(out)).not.toContain('ECONNRESET')
    expect(JSON.stringify(out)).not.toContain(key)
  })
  it('3xx response surfaces as network_error and is never followed', async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example.org/' } }),
    )
    const p = createBraveProvider(() => key, request)
    const out = await runtime(p).search({ query: 'x' })
    expect(request).toHaveBeenCalledTimes(1)
    expect(out.error?.code).toBe('network_error')
  })
  it('non-ascii query percent-encoded in endpoint URL', async () => {
    const request = vi.fn<typeof fetch>(async () => json({ web: { results: [] } }))
    const p = createBraveProvider(() => key, request)
    await runtime(p).search({ query: '开源 搜索' })
    const url = request.mock.calls[0]![0] as URL
    expect(url.searchParams.get('q')).toBe('开源 搜索')
    expect(String(url)).not.toMatch(/[^\x00-\x7F]/)
  })
})

type SearchResultList = Awaited<ReturnType<SearchProvider['search']>>
