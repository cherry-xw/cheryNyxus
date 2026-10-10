import { describe, expect, it, vi } from 'vitest'
import { WebSearchRuntime, SearchError, type SearchProvider } from '@/agent/sense/web/runtime.js'
import { createBraveProvider } from '@/agent/sense/web/brave.js'
import { createWebSearchSense } from '@/agent/sense/webSearch.js'

const result = {
  title: 'Test title',
  url: 'https://example.org/page',
  snippet: 'Local test fixture',
}
function provider(
  id = 'test',
  state: 'ready' | 'configuration_missing' | 'provider_unavailable' = 'ready',
): SearchProvider {
  return { id, availability: () => state, search: vi.fn(async () => [result]) }
}
function runtime(p = provider(), options = {}) {
  const r = new WebSearchRuntime(options)
  r.register(p)
  return r
}

describe('web search runtime', () => {
  it.each([
    {},
    { query: '' },
    { query: '   ' },
    { query: 'a'.repeat(601) },
    { query: 'x', limit: 11 },
    { query: 'x', limit: 0 },
    { query: 'x', max_output_chars: 511 },
    { query: 'x', unknown: true },
  ])('rejects invalid input %j', async (input) => {
    expect((await runtime().search(input)).error?.code).toBe('invalid_input')
  })
  it('keeps required schema and omits stable hash', async () => {
    const sense = createWebSearchSense(runtime())
    expect(sense.definition.function.parameters.required).toContain('query')
    expect(await sense.executor.execute({ query: 'test' }, new Map())).not.toHaveProperty('hash')
  })
  it('distinguishes empty, missing configuration, unavailable and ambiguous providers', async () => {
    expect((await new WebSearchRuntime().search({ query: 'test' })).error?.code).toBe('no_provider')
    expect(
      (await runtime(provider('test', 'configuration_missing')).search({ query: 'test' })).error
        ?.code,
    ).toBe('configuration_missing')
    expect(
      (await runtime(provider('test', 'provider_unavailable')).search({ query: 'test' })).error
        ?.code,
    ).toBe('provider_unavailable')
    const r = runtime()
    r.register(provider('other'))
    expect((await r.search({ query: 'test' })).error?.code).toBe('ambiguous_provider')
    expect(() => r.register(provider())).toThrow()
  })
  it('selects deterministically, never makes a request during status', async () => {
    for (const ids of [
      ['one', 'two'],
      ['two', 'one'],
    ]) {
      const r = new WebSearchRuntime({ provider: () => 'one' })
      const ps = ids.map((id) => provider(id))
      ps.forEach((p) => r.register(p))
      expect(r.status().map((p) => p.id)).toEqual(['one', 'two'])
      ps.forEach((p) => expect(p.search).not.toHaveBeenCalled())
      expect((await r.search({ query: 'test' })).provider).toBe('one')
    }
    expect(
      (await runtime(provider(), { provider: () => 'absent' }).search({ query: 'test' })).error
        ?.code,
    ).toBe('provider_unavailable')
  })
  it('does not leak status or request exceptions', async () => {
    const p = provider()
    p.availability = () => {
      throw new Error('private fixture value')
    }
    expect(JSON.stringify(await runtime(p).search({ query: 'test' }))).not.toContain(
      'private fixture value',
    )
    p.availability = () => 'ready'
    p.search = async () => {
      throw new Error('private fixture value')
    }
    const response = await runtime(p).search({ query: 'test' })
    expect(response.error?.code).toBe('network_error')
    expect(JSON.stringify(response)).not.toContain('private fixture value')
  })
  it('limits, cleans and deduplicates results without fetching source URLs', async () => {
    const p = provider()
    p.search = async () => [
      result,
      { ...result, url: result.url + '#fragment' },
      { ...result, url: 'javascript:alert(1)' },
      { ...result, url: 'https://user:pass@example.org' },
      ...Array.from({ length: 15 }, (_, i) => ({
        ...result,
        url: `https://example.org/${i}`,
        title: '<script>bad()</script><b>title</b>',
        snippet: 's'.repeat(3000),
      })),
    ]
    const output = await runtime(p).search({ query: 'test', limit: 2, max_output_chars: 12000 })
    expect(output.results).toHaveLength(2)
    expect(output.results[1]?.title).toBe('title')
    expect(output.results[1]?.snippet).toHaveLength(2000)
    expect(output.truncated).toBe(true)
    expect(output.trust).toBe('untrusted_external_data')
    expect(Number.isNaN(Date.parse(output.observedAt))).toBe(false)
    expect(
      JSON.stringify(await runtime(p).search({ query: 'test', max_output_chars: 512 })).length,
    ).toBeLessThanOrEqual(512)
  })
  it('times out and cancels even when provider ignores cancellation, then recovers', async () => {
    const p = provider()
    let received: AbortSignal | undefined
    p.search = async (_, signal) => {
      received = signal
      return new Promise(() => {})
    }
    const r = runtime(p, { timeoutMs: 10 })
    expect((await r.search({ query: 'test' })).error?.code).toBe('timeout')
    expect(received?.aborted).toBe(true)
    const controller = new AbortController()
    const pending = r.search({ query: 'test' }, controller.signal)
    controller.abort('secret cancellation reason')
    expect((await pending).error?.code).toBe('cancelled')
    expect((await r.search({ query: 'test' }, controller.signal)).error?.code).toBe('cancelled')
    p.search = async () => [result]
    expect((await r.search({ query: 'test' })).ok).toBe(true)
  })
  it('applies a fixed-window local limit without queuing or retrying', async () => {
    let now = 1000
    const p = provider()
    const r = runtime(p, { rateLimit: { maxRequests: 1, windowMs: 60000 }, now: () => now })
    expect((await r.search({ query: 'first' })).ok).toBe(true)
    expect((await r.search({ query: 'second' })).error?.code).toBe('rate_limited')
    expect(p.search).toHaveBeenCalledTimes(1)
    now += 60000
    expect((await r.search({ query: 'third' })).ok).toBe(true)
    expect(p.search).toHaveBeenCalledTimes(2)
  })
  it.each([
    'authentication_failed',
    'rate_limited',
    'invalid_response',
    'response_too_large',
  ] as const)('preserves classified %s', async (code) => {
    const p = provider()
    p.search = async () => {
      throw new SearchError(code)
    }
    expect((await runtime(p).search({ query: 'test' })).error?.code).toBe(code)
  })
})

describe('Brave protocol using local response fixtures only', () => {
  const key = 'test-only-secret-value'
  const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  it('fixed endpoint, no redirects/cookies, correct query and no credential echoes', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      json({
        web: {
          results: [
            { title: key, url: result.url, description: key },
            { title: 'link', url: `https://example.org/${key}`, description: 'echo' },
          ],
        },
      }),
    )
    const p = createBraveProvider(() => key, request)
    expect(p.availability()).toBe('ready')
    expect(request).not.toHaveBeenCalled()
    const output = await runtime(p).search({ query: ' test ', limit: 3 })
    const [url, options] = request.mock.calls[0]!
    expect(String(url)).toContain('https://api.search.brave.com/res/v1/web/search?q=test&count=3')
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    expect(options?.headers).toEqual({ Accept: 'application/json', 'X-Subscription-Token': key })
    expect(JSON.stringify(output)).not.toContain(key)
    expect(output.results).toHaveLength(1)
  })
  it.each([
    [401, 'authentication_failed'],
    [403, 'authentication_failed'],
    [429, 'rate_limited'],
    [500, 'network_error'],
  ] as const)('maps HTTP %s safely', async (status, code) => {
    const p = createBraveProvider(
      () => key,
      async () => new Response(key, { status }),
    )
    const output = await runtime(p).search({ query: 'test' })
    expect(output.error?.code).toBe(code)
    expect(JSON.stringify(output)).not.toContain(key)
  })
  it('missing credentials never sends a request', async () => {
    const request = vi.fn<typeof fetch>()
    expect(
      (await runtime(createBraveProvider(() => undefined, request)).search({ query: 'test' })).error
        ?.code,
    ).toBe('configuration_missing')
    expect(request).not.toHaveBeenCalled()
  })
  it.each([
    () => new Response('html', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => json({ wrong: [] }),
  ])('rejects malformed responses', async (response) => {
    expect(
      (
        await runtime(
          createBraveProvider(
            () => key,
            async () => response(),
          ),
        ).search({ query: 'test' })
      ).error?.code,
    ).toBe('invalid_response')
  })
  it('rejects oversized declared and streamed responses', async () => {
    for (const response of [
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '2000000' },
      }),
      new Response('x'.repeat(1048577), { headers: { 'content-type': 'application/json' } }),
    ]) {
      expect(
        (
          await runtime(
            createBraveProvider(
              () => key,
              async () => response,
            ),
          ).search({ query: 'test' })
        ).error?.code,
      ).toBe('response_too_large')
    }
  })
})
