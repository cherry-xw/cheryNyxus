import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { z } from 'zod'

import { SearchError, type SearchProvider, type SearchResult } from './runtime.js'

export const searchSettingsSchema = z.object({
  providers: z.array(z.enum(['anysearch', 'parallel', 'exa', 'browser'])).min(1).max(4).refine(v => new Set(v).size === v.length),
  proxyEnabled: z.boolean(),
  proxyUrl: z.string().max(2048).refine(v => {
    if (!v) return true
    try { const u = new URL(v); return ['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash } catch { return false }
  }),
}).strict().refine(v => !v.proxyEnabled || !!v.proxyUrl)
export type SearchSettings = z.infer<typeof searchSettingsSchema>
const defaults: SearchSettings = { providers: ['anysearch', 'parallel', 'exa', 'browser'], proxyEnabled: false, proxyUrl: '' }
const file = () => path.join(process.env.CHERY_DIR || process.cwd(), '.chery', 'web-search.json')
const revision = (s: SearchSettings) => createHash('sha256').update(JSON.stringify(s)).digest('hex')
export function readSearchSettings() {
  const settings = fs.existsSync(file()) ? searchSettingsSchema.parse(JSON.parse(fs.readFileSync(file(), 'utf8'))) : structuredClone(defaults)
  return { settings, revision: revision(settings) }
}
export function saveSearchSettings(settings: SearchSettings, expectedRevision: string) {
  const parsed = searchSettingsSchema.parse(settings)
  if (readSearchSettings().revision !== expectedRevision) throw new Error('搜索设置已变化，请重新读取后保存')
  const target = file(); fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${randomUUID()}.next`
  try { fs.writeFileSync(tmp, JSON.stringify(parsed), { mode: 0o600 }); fs.renameSync(tmp, target) }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
  return { ...readSearchSettings(), saved: true }
}
export interface SearchAttempt { provider: string; ok: boolean; code?: string }
export interface ServiceResults extends Array<SearchResult> { attempts?: SearchAttempt[]; selectedProvider?: string }

/** Fixed, trusted upstreams. Proxy settings are administrator-only; model inputs cannot set endpoints. */
export async function requestSearch(url: string, body: unknown, settings: SearchSettings, signal: AbortSignal): Promise<string> {
  const payload = JSON.stringify(body)
  if (!settings.proxyEnabled) {
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: payload, signal })
    if (!response.ok) { await response.body?.cancel(); throw new SearchError(response.status === 429 ? 'rate_limited' : [401,403].includes(response.status) ? 'authentication_failed' : 'network_error') }
    if (!response.body) throw new SearchError('invalid_response')
    const chunks: Uint8Array[] = []; let bytes = 0
    for await (const chunk of response.body) {
      bytes += chunk.byteLength
      if (bytes > 1048576) { await response.body.cancel().catch(() => {}); throw new SearchError('response_too_large') }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  // curl is provided in the runtime image. No shell, inherited proxy or credentials; stdin carries the body.
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const proc = spawn('curl', ['--silent', '--show-error', '--fail-with-body', '--max-time', '12', '--max-filesize', '1048576', '--proxy', settings.proxyUrl, '--noproxy', '', '--proto', '=https', '--request', 'POST', '--header', 'Content-Type: application/json', '--header', 'Accept: application/json, text/event-stream', '--data-binary', '@-', url], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['pipe','pipe','pipe'] })
    const chunks: Buffer[] = []; let bytes = 0; let settled = false
    const finish = (err?: Error, value?: string) => { if (settled) return; settled = true; signal.removeEventListener('abort', cancel); if (err) reject(err); else resolve(value!) }
    const cancel = () => { proc.kill('SIGKILL'); finish(new SearchError('cancelled')) }
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
    proc.stdout.on('data', (b: Buffer) => { bytes += b.length; if (bytes > 1048576) { proc.kill('SIGKILL'); finish(new SearchError('response_too_large')) } else chunks.push(b) })
    proc.stderr.resume()
    proc.stdin.on('error', () => {})
    proc.on('error', () => finish(new SearchError('network_error')))
    proc.on('close', code => finish(code ? new SearchError(code === 28 ? 'timeout' : 'network_error') : undefined, Buffer.concat(chunks).toString('utf8')))
    proc.stdin.end(payload)
  })
}
function rpcPayload(body: string): any {
  const candidates = body.trim().startsWith('{') ? [body] : body.split(/\r?\n/).filter(v => v.startsWith('data:')).map(v => v.slice(5).trim())
  for (const line of candidates) {
    let value: any
    try { value = JSON.parse(line) } catch { continue }
    if (value.error || value.result?.isError) throw new SearchError('invalid_response')
    if (value.result?._meta?.['ai.exa/rateLimited']) throw new SearchError('rate_limited')
    if (value.result) return value.result
  }
  throw new SearchError('invalid_response')
}
export function parseSearchResponse(provider: string, body: string): SearchResult[] {
  let items: any[]
  if (provider === 'anysearch') {
    const v = JSON.parse(body)
    if (v.code !== 0) throw new SearchError('provider_unavailable')
    items = v.data?.results
  } else {
    const result = rpcPayload(body)
    if (!Array.isArray(result.content)) throw new SearchError('invalid_response')
    const text = result.content.filter((c: any) => c.type === 'text' && typeof c.text === 'string').map((c: any) => c.text).join('\n')
    if (/hit.*rate limit|free MCP rate limit/i.test(text)) throw new SearchError('rate_limited')
    try { items = JSON.parse(text).results }
    catch {
      if (provider !== 'exa') throw new SearchError('invalid_response')
      items = text.split(/(?=^Title: )/m).map((block: string) => ({ title: block.match(/^Title: (.+)/m)?.[1], url: block.match(/^URL: (.+)/m)?.[1], snippet: block.split(/\n(?:Text: |Highlights:\s*\n)/)[1] || '', publishedAt: block.match(/^Published: (.+)/m)?.[1] }))
    }
  }
  if (!Array.isArray(items)) throw new SearchError('invalid_response')
  return items.flatMap(item => {
    if (!item || typeof item.title !== 'string' || !item.title.trim() || typeof item.url !== 'string') return []
    try { const u = new URL(item.url); if (!['http:','https:'].includes(u.protocol) || u.username || u.password) return [] } catch { return [] }
    return [{ title: item.title, url: item.url, snippet: typeof item.snippet === 'string' ? item.snippet : Array.isArray(item.excerpts) ? item.excerpts.filter((x: unknown) => typeof x === 'string').join('\n') : typeof item.text === 'string' ? item.text : '', source: provider, ...(typeof (item.publishedAt || item.publish_date || item.publishedDate) === 'string' && (item.publishedAt || item.publish_date || item.publishedDate) !== 'N/A' ? { publishedAt: item.publishedAt || item.publish_date || item.publishedDate } : {}) }]
  })
}
export async function browserSearch(input: { query: string; limit: number }, settings: SearchSettings, signal: AbortSignal): Promise<SearchResult[]> {
  const { default: browserScript } = await import('./browser-search.mjs?raw')
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const child = spawn(process.execPath, ['--input-type=module', '-e', browserScript], { stdio: ['pipe', 'pipe', 'pipe'] })
    let settled = false; let size = 0; const chunks: Buffer[] = []
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', cancel)
      if (error) return reject(error)
      try { const value = JSON.parse(Buffer.concat(chunks).toString()); resolve(parseSearchResponse('anysearch', JSON.stringify({ code: 0, data: value })).map((item, index) => ({ ...item, source: value.results[index]?.source || 'browser' }))) }
      catch { reject(new SearchError('invalid_response')) }
    }
    const cancel = () => { child.kill('SIGKILL'); finish(new SearchError('cancelled')) }
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
    child.stdout.on('data', (b: Buffer) => { size += b.length; if (size > 1048576) { child.kill('SIGKILL'); finish(new SearchError('response_too_large')) } else chunks.push(b) })
    child.stderr.resume(); child.stdin.on('error', () => {})
    child.on('error', () => finish(new SearchError('provider_unavailable')))
    child.on('close', code => finish(code ? new SearchError('provider_unavailable') : undefined))
    child.stdin.end(JSON.stringify({ ...input, proxy: settings.proxyEnabled ? settings.proxyUrl : undefined }))
  })
}
export async function searchProviders(input: { query: string; limit: number }, settings: SearchSettings, signal: AbortSignal, transport = requestSearch): Promise<ServiceResults> {
  const attempts: SearchAttempt[] = []
  let last: SearchError = new SearchError('provider_unavailable')
  for (const provider of settings.providers) {
    signal.throwIfAborted()
    const timeout = AbortSignal.timeout(provider === 'browser' ? 40000 : 12000)
    const attemptSignal = AbortSignal.any([signal, timeout])
    try {
      const url = provider === 'anysearch' ? 'https://api.anysearch.com/v1/search' : provider === 'exa' ? 'https://mcp.exa.ai/mcp' : 'https://search.parallel.ai/mcp'
      const body = provider === 'anysearch' ? { query: input.query, max_results: input.limit } : { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: provider === 'exa' ? 'web_search_exa' : 'web_search', arguments: provider === 'exa' ? { query: input.query, numResults: input.limit, type: 'auto', livecrawl: 'preferred' } : { objective: input.query, search_queries: [input.query] } } }
      const cancelled = new Promise<never>((_, reject) => { if (attemptSignal.aborted) reject(new SearchError('timeout')); else attemptSignal.addEventListener('abort', () => reject(new SearchError('timeout')), { once: true }) })
      const operation = provider === 'browser' ? browserSearch(input, settings, attemptSignal) : transport(url, body, settings, attemptSignal).then(body => parseSearchResponse(provider, body))
      const results = (await Promise.race([operation, cancelled])).slice(0, input.limit) as ServiceResults
      if (!results.length) throw new SearchError('invalid_response')
      attempts.push({ provider, ok: true }); results.attempts = attempts; results.selectedProvider = provider; return results
    } catch (error) {
      if (signal.aborted) throw new SearchError('cancelled')
      last = timeout.aborted ? new SearchError('timeout') : error instanceof SearchError ? error : new SearchError('invalid_response')
      attempts.push({ provider, ok: false, code: last.code })
    }
  }
  const error = last as SearchError & { attempts: SearchAttempt[] }; error.attempts = attempts; throw error
}
export function createSearchServiceProvider(): SearchProvider {
  return { id: 'multi-search', availability: () => { try { readSearchSettings(); return 'ready' } catch { return 'configuration_missing' } }, search: (input, signal) => searchProviders(input, readSearchSettings().settings, signal) }
}
