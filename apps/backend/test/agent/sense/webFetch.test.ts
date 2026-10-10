import { describe, expect, it, vi } from 'vitest'
import { WebFetchRuntime, type WebFetchTransport } from '@/agent/sense/web/fetch.js'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => [{
    address: hostname === 'localhost' ? '127.0.0.1' : '93.184.216.34',
    family: 4,
  }]),
}))

function transport(handler: WebFetchTransport): WebFetchTransport {
  return handler
}

const html = '<html><head><script>secret()</script><style>.x{}</style></head><body>Hello <b>public</b></body></html>'

describe('web fetch SSRF boundary', () => {
  it('rejects credentials, unsupported schemes and non-public ports before transport', async () => {
    let calls = 0
    const runtime = new WebFetchRuntime(transport(async () => {
      calls++
      throw new Error('must not call')
    }))
    for (const url of ['file:///etc/passwd', 'http://user:pass@example.test/', 'http://example.test:8080/']) {
      expect((await runtime.fetch({ url })).error?.code).toBe('invalid_url')
    }
    expect(calls).toBe(0)
  })

  it('rejects DNS-resolved private and loopback addresses', async () => {
    const runtime = new WebFetchRuntime()
    for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://10.0.0.1/', 'http://[::1]/']) {
      expect((await runtime.fetch({ url })).error?.code).toBe('forbidden_address')
    }
  })

  it('follows only validated public redirects and validates every hop', async () => {
    const seen: string[] = []
    const runtime = new WebFetchRuntime(transport(async (url) => {
      seen.push(url.href)
      if (seen.length === 1) return { status: 302, headers: { location: 'https://example.org/next' }, body: new Uint8Array() }
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html) }
    }))
    const result = await runtime.fetch({ url: 'https://example.org/start' })
    expect(result.ok).toBe(true)
    expect(result.url).toBe('https://example.org/next')
    expect(result.text).toBe('Hello public')
    expect(result.text).not.toContain('secret')
    expect(seen).toEqual(['https://example.org/start', 'https://example.org/next'])
  })

  it('fails closed on redirect to a private address and unsupported content', async () => {
    const redirectRuntime = new WebFetchRuntime(transport(async () => ({
      status: 302,
      headers: { location: 'http://127.0.0.1/' },
      body: new Uint8Array(),
    })))
    expect((await redirectRuntime.fetch({ url: 'https://example.org/' })).error?.code).toBe('forbidden_address')

    const typeRuntime = new WebFetchRuntime(transport(async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}'),
    })))
    expect((await typeRuntime.fetch({ url: 'https://example.org/' })).error?.code).toBe('unsupported_content_type')
  })

  it('marks character truncation and rejects oversized responses', async () => {
    const limited = new WebFetchRuntime(transport(async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from('abcdefghij'),
    })))
    await expect(limited.fetch({ url: 'https://example.org/', max_output_chars: 512 })).resolves.toMatchObject({ ok: true, truncated: false })

    const oversized = new WebFetchRuntime(transport(async (_url, _signal, maxBytes) => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: new Uint8Array(maxBytes + 1),
    })))
    expect((await oversized.fetch({ url: 'https://example.org/' })).error?.code).toBe('response_too_large')
  })
})
