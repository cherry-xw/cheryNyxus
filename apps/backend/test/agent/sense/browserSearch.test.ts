import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import script from '../../../src/agent/sense/web/browser-search.mjs?raw'
import { browserSearch } from '../../../src/agent/sense/web/searchService.js'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
const settings = { providers: ['browser'] as const, proxyEnabled: false, proxyUrl: '' }

// Execute the unchanged raw module without its CLI entrypoint or a TS runner.
async function loadSearch() {
  const argv = process.argv[1]
  process.argv[1] = 'fixture-test'
  try {
    return (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(script).toString('base64')}`)).searchBrowser
  } finally { process.argv[1] = argv! }
}
function fixture(items: unknown[][], failFirst = false) {
  let index = 0
  const pages: any[] = []
  const contexts: any[] = []
  const browser = { newContext: vi.fn(async () => {
    const current = index++
    const page = {
      goto: vi.fn(async () => { if (failFirst && current === 0) throw new Error('fixture timeout') }),
      waitForSelector: vi.fn(async () => {}),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => items[current] ?? []) })),
    }
    const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => {}) }
    pages.push(page); contexts.push(context)
    return context
  }), close: vi.fn(async () => {}) }
  return { chromium: { launch: vi.fn(async () => browser) }, browser, pages, contexts }
}
function child() {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  })
  spawn.mockReturnValue(proc)
  return proc
}
beforeEach(() => vi.clearAllMocks())

describe('Node browser search', () => {
  it('preserves Bing priority, proxy, timeout, download policy and JSON result shape', async () => {
    const run = await loadSearch()
    const f = fixture([[{ title: '中文', url: 'https://example.org/', snippet: 'fixture' },
      { title: 'credential', url: 'https://user:pass@example.org/', snippet: '' },
      { title: 'unsafe', url: 'javascript:alert(1)', snippet: '' }]])
    const result = await run({ query: '中文 / test', limit: 1, proxy: 'http://proxy.test:7890' }, f.chromium)
    expect(f.chromium.launch).toHaveBeenCalledWith({ headless: true, proxy: { server: 'http://proxy.test:7890' } })
    expect(f.browser.newContext).toHaveBeenCalledWith({ acceptDownloads: false })
    expect(f.pages[0].goto).toHaveBeenCalledWith('https://www.bing.com/search?q=%E4%B8%AD%E6%96%87%20%2F%20test', { waitUntil: 'domcontentloaded', timeout: 12000 })
    expect(f.pages[0].waitForSelector).toHaveBeenCalledWith('li.b_algo h2 a, li.b_algo h3 a', { timeout: 6000 })
    expect(JSON.parse(JSON.stringify(result))).toEqual({ results: [{ title: '中文', url: 'https://example.org/', snippet: 'fixture', source: 'browser-bing' }], attempts: [{ provider: 'browser-bing', ok: true }] })
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    expect(f.browser.close).toHaveBeenCalledOnce()
  })
  it('falls back to Baidu on Bing failure and uses scoped heading selectors', async () => {
    const f = fixture([[], [{ title: 'Baidu', url: 'https://example.org/', snippet: 'fixture' }]], true)
    const result = await (await loadSearch())({ query: 'test', limit: 5 }, f.chromium)
    expect(f.chromium.launch).toHaveBeenCalledWith({ headless: true })
    expect(f.pages[1].goto).toHaveBeenCalledWith('https://www.baidu.com/s?wd=test', { waitUntil: 'domcontentloaded', timeout: 12000 })
    expect(f.pages[1].waitForSelector).toHaveBeenCalledWith('#content_left .result h2 a, #content_left .result h3 a, #content_left .c-container h2 a, #content_left .c-container h3 a', { timeout: 6000 })
    expect(result.attempts).toEqual([{ provider: 'browser-bing', ok: false, code: 'provider_unavailable' }, { provider: 'browser-baidu', ok: true }])
    expect(result.results[0].source).toBe('browser-baidu')
    expect(f.contexts.every(c => c.close.mock.calls.length === 1)).toBe(true)
    expect(f.browser.close).toHaveBeenCalledOnce()
  })
  it('returns both empty attempts and always closes the browser', async () => {
    const f = fixture([[], []])
    expect(await (await loadSearch())({ query: 'test', limit: 5 }, f.chromium)).toEqual({ results: [], attempts: [{ provider: 'browser-bing', ok: false }, { provider: 'browser-baidu', ok: false }] })
    expect(f.browser.close).toHaveBeenCalledOnce()
  })
  it('spawns this Node executable with raw ESM and stdin JSON', async () => {
    const proc = child()
    const result = browserSearch({ query: 'test', limit: 1 }, { ...settings, providers: [...settings.providers], proxyEnabled: true, proxyUrl: 'http://proxy.test:7890' }, new AbortController().signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawn).toHaveBeenCalledWith(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    expect(JSON.parse(proc.stdin.read().toString())).toEqual({ query: 'test', limit: 1, proxy: 'http://proxy.test:7890' })
    proc.stdout.write(JSON.stringify({ results: [{ title: 'Fixture', url: 'https://example.org/', source: 'browser-bing' }], attempts: [] }))
    proc.emit('close', 0)
    await expect(result).resolves.toMatchObject([{ source: 'browser-bing' }])
  })
  it('kills the Node subprocess on cancellation', async () => {
    const proc = child(); const controller = new AbortController()
    const result = browserSearch({ query: 'test', limit: 1 }, { ...settings, providers: [...settings.providers] }, controller.signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'cancelled' })
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })
  it('maps missing Playwright or subprocess failure to provider_unavailable', async () => {
    const proc = child()
    const result = browserSearch({ query: 'test', limit: 1 }, { ...settings, providers: [...settings.providers] }, new AbortController().signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    proc.emit('close', 1)
    await expect(result).rejects.toMatchObject({ code: 'provider_unavailable' })
  })
  it('kills oversized browser output', async () => {
    const proc = child()
    const result = browserSearch({ query: 'test', limit: 1 }, { ...settings, providers: [...settings.providers] }, new AbortController().signal)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    proc.stdout.write(Buffer.alloc(1048577))
    await expect(result).rejects.toMatchObject({ code: 'response_too_large' })
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
