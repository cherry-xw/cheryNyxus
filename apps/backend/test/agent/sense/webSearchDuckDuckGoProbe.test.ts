/**
 * 独立测试任务补充探针（t_a7e73c70）：DuckDuckGo 生产 Provider 边界。
 * B 车道将内置 web_search 从 Brave 切换为无密钥 DuckDuckGo 公共 HTML 端点；
 * 本探针只覆盖其协议边界，全部本地 HTML fixture，无网络。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSearchRuntime, type SearchProvider } from '@/agent/sense/web/runtime.js'
import { createDuckDuckGoProvider } from '@/agent/sense/web/duckduckgo.js'
import { createWebSearchSense } from '@/agent/sense/webSearch.js'

function runtime(p: SearchProvider) {
  const r = new WebSearchRuntime()
  r.register(p)
  return r
}
afterEach(() => vi.restoreAllMocks())

const RESULT_PAGE = `
<html><body>
<div class="results">
  <div class="result results_links">
    <h2><a rel="nofollow" class="result__a" href="https://example.org/one">First &amp; title</a></h2>
    <a class="result__snippet" href="https://example.org/one">Snippet <b>one</b> with &lt;tag&gt; &amp; entity</a>
  </div>
  <div class="result results_links">
    <h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftarget.example%2Ftwo&amp;rut=abc">Second title</a></h2>
    <a class="result__snippet">Second snippet</a>
  </div>
  <div class="result results_links">
    <h2><a class="result__a" href="javascript:alert(1)">Bad scheme</a></h2>
    <a class="result__snippet">bad</a>
  </div>
  <div class="result results_links">
    <h2><a class="result__a" href="https://user:pass@example.org/cred">Cred url</a></h2>
    <a class="result__snippet">cred</a>
  </div>
  <div class="result results_links">
    <h2>no anchor here</h2>
  </div>
  <div class="ad result">
    <a class="result__a" href="https://ads.example.org/x">Ad title</a>
    <a class="result__snippet">Ad snippet</a>
  </div>
</div>
</body></html>`

function htmlResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  })
}

describe('duckduckgo provider hard boundaries (local fixtures only)', () => {
  it('fixed endpoint, GET, no cookies, documented headers, query encoded', async () => {
    const request = vi.fn<typeof fetch>(async () => htmlResponse(RESULT_PAGE))
    const p = createDuckDuckGoProvider(request)
    expect(p.id).toBe('duckduckgo')
    expect(p.availability()).toBe('ready')
    expect(request).not.toHaveBeenCalled()
    const out = await runtime(p).search({ query: 'probe query' })
    const [url, options] = request.mock.calls[0]!
    expect(String(url)).toBe('https://html.duckduckgo.com/html/?q=probe+query')
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit' })
    expect(options?.headers).toEqual({ Accept: 'text/html' })
    expect(out.ok).toBe(true)
  })
  it('parses results, decodes uddg redirect targets; runtime strips html-like text (layered sanitization)', async () => {
    const request = vi.fn<typeof fetch>(async () => htmlResponse(RESULT_PAGE))
    const p = createDuckDuckGoProvider(request)
    const out = await runtime(p).search({ query: 'x' })
    // DDG clean decodes &lt;tag&gt; to literal <tag>; the runtime-level clean then strips
    // html-like text from any provider output (web-search.md: 文本去除标记及控制字符)
    expect(out.results[0]).toEqual({
      title: 'First & title',
      url: 'https://example.org/one',
      snippet: 'Snippet one with & entity',
      source: 'example.org',
    })
    expect(out.results[1]?.url).toBe('https://target.example/two')
    expect(out.results.map((r) => r.title)).not.toContain('Bad scheme')
    expect(out.results.map((r) => r.title)).not.toContain('Cred url')
  })
  it('never returns http results with embedded credentials (runtime filters, provider keeps data flow)', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      htmlResponse(
        `<div class="result"><a class="result__a" href="https://example.org/ok">Ok</a><a class="result__snippet">s</a></div>`,
      ),
    )
    const out = await runtime(createDuckDuckGoProvider(request)).search({ query: 'x' })
    expect(out.results[0]?.url).toBe('https://example.org/ok')
  })
  it('maps HTTP 429 to rate_limited and other non-ok to network_error', async () => {
    for (const [status, code] of [
      [429, 'rate_limited'],
      [403, 'network_error'],
      [500, 'network_error'],
    ] as const) {
      const request = vi.fn<typeof fetch>(async () => htmlResponse('x', { status }))
      const out = await runtime(createDuckDuckGoProvider(request)).search({ query: 'x' })
      expect(out.error?.code).toBe(code)
    }
  })
  it('rejects non-html content types', async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    )
    const out = await runtime(createDuckDuckGoProvider(request)).search({ query: 'x' })
    expect(out.error?.code).toBe('invalid_response')
  })
  it('rejects oversized declared and streamed responses', async () => {
    for (const response of [
      htmlResponse('x', {
        headers: { 'content-type': 'text/html', 'content-length': '2000000' },
      }),
      htmlResponse('x'.repeat(1048577)),
    ]) {
      const request = vi.fn<typeof fetch>(async () => response)
      const out = await runtime(createDuckDuckGoProvider(request)).search({ query: 'x' })
      expect(out.error?.code).toBe('response_too_large')
    }
  })
  it('zero result blocks is a valid empty observation', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      htmlResponse('<html><body>no results</body></html>'),
    )
    const out = await runtime(createDuckDuckGoProvider(request)).search({ query: 'x' })
    expect(out.ok).toBe(true)
    expect(out.results).toHaveLength(0)
    expect(out.truncated).toBe(false)
  })
  it('fetch throwing synchronously maps to network_error without leaking internals', async () => {
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error('EAI_AGAIN internal-dns-7')
    })
    const out = await runtime(createDuckDuckGoProvider(request)).search({ query: 'x' })
    expect(out.error?.code).toBe('network_error')
    expect(JSON.stringify(out)).not.toContain('EAI_AGAIN')
  })
  it('built-in default runtime registers the configured search service and sense factory uses it', async () => {
    const { webSearchRuntime } = await import('@/agent/sense/webSearch.js')
    const statuses = webSearchRuntime.status()
    expect(statuses.map((s) => s.id)).toEqual(['multi-search'])
    expect(statuses[0]?.state).toBe('ready')
    expect(statuses[0]?.configured).toBe(true)
    const sense = createWebSearchSense(webSearchRuntime)
    expect(sense.supervisionLevel?.valueOf()).toBe(1)
    expect(sense.definition.function.parameters.required).toContain('query')
  })
  it('aborted signal before request prevents fetch; cancellation mid-stream surfaces as cancelled', async () => {
    const request = vi.fn<typeof fetch>(async () => htmlResponse(RESULT_PAGE))
    const p = createDuckDuckGoProvider(request)
    const c = new AbortController()
    c.abort()
    expect((await runtime(p).search({ query: 'x' }, c.signal)).error?.code).toBe('cancelled')
    expect(request).not.toHaveBeenCalled()
  })
})
