import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders, RequestOptions } from 'node:http'
import { URL } from 'node:url'
import { z } from 'zod'

export const webFetchSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  max_output_chars: z.number().int().min(512).max(100_000).optional(),
})
  .strict()

export type WebFetchInput = z.infer<typeof webFetchSchema>

export type FetchErrorCode =
  | 'invalid_input'
  | 'invalid_url'
  | 'forbidden_address'
  | 'dns_error'
  | 'redirect_limit'
  | 'redirect_error'
  | 'timeout'
  | 'cancelled'
  | 'network_error'
  | 'unsupported_content_type'
  | 'response_too_large'
  | 'invalid_response'

export interface FetchObservation {
  ok: boolean
  url: string
  observedAt: string
  contentType?: string
  bytesRead: number
  truncated: boolean
  text: string
  error?: { code: FetchErrorCode; message: string }
}

interface TransportResponse {
  status: number
  headers: IncomingHttpHeaders | Record<string, string | undefined>
  body: Uint8Array
}

export type WebFetchTransport = (
  url: URL,
  signal: AbortSignal,
  maxBytes: number,
) => Promise<TransportResponse>

const MAX_BYTES = 400_000
const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 15_000
const PUBLIC_PORTS = new Set(['', '80', '443'])
const errorMessages: Record<FetchErrorCode, string> = {
  invalid_input: '网页地址参数无效。',
  invalid_url: '网页地址必须是公开 HTTP(S) 地址。',
  forbidden_address: '网页地址解析到了受限网络地址。',
  dns_error: '网页地址 DNS 解析失败。',
  redirect_limit: '网页重定向次数超过上限。',
  redirect_error: '网页重定向地址无效或被拒绝。',
  timeout: '网页读取超时。',
  cancelled: '网页读取已取消。',
  network_error: '网页读取请求失败。',
  unsupported_content_type: '网页响应不是允许的 HTML 或纯文本。',
  response_too_large: '网页响应超过大小上限。',
  invalid_response: '网页响应无效。',
}

function fail(code: FetchErrorCode, url: string, observedAt: string): FetchObservation {
  return {
    ok: false,
    url,
    observedAt,
    bytesRead: 0,
    truncated: false,
    text: '',
    error: { code, message: errorMessages[code] },
  }
}

function forbiddenIp(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number)
    const a = octets[0] ?? -1
    const b = octets[1] ?? -1
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && octets[2] === 0) ||
      (a === 192 && b === 168) ||
      // RFC 5737 TEST-NET documentation ranges are not public fetch targets.
      (a === 192 && b === 0 && octets[2] === 2) ||
      (a === 198 && b === 51 && octets[2] === 100) ||
      (a === 203 && b === 0 && octets[2] === 113) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (isIP(normalized) !== 6) return true
  const value = normalized.split(':').map((part) => parseInt(part || '0', 16))
  const first = value[0] ?? 0
  const second = value[1] ?? 0
  return (
    normalized === '::' ||
    normalized === '::1' ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first === 0x2001 && second === 0x0db8) ||
    first >= 0xff00
  )
}

function validateUrl(raw: string): URL {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('invalid_url')
  if (!url.hostname || !PUBLIC_PORTS.has(url.port)) throw new Error('invalid_url')
  url.hash = ''
  return url
}

async function validateHost(url: URL): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (forbiddenIp(host)) throw new Error('forbidden_address')
    return [host]
  }
  let records: Array<{ address: string }>
  try {
    records = await lookup(host, { all: true, verbatim: true })
  } catch {
    throw new Error('dns_error')
  }
  if (!records.length || records.some((record) => forbiddenIp(record.address)))
    throw new Error('forbidden_address')
  return records.map((record) => record.address)
}

function contentType(headers: IncomingHttpHeaders | Record<string, string | undefined>): string {
  const value = headers['content-type']
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

async function defaultTransport(url: URL, signal: AbortSignal, maxBytes: number): Promise<TransportResponse> {
  const addresses = await validateHost(url)
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, result?: TransportResponse) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(result!)
    }
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { Accept: 'text/html, text/plain', 'Accept-Encoding': 'identity' },
      timeout: REQUEST_TIMEOUT_MS,
      signal,
      lookup: (_hostname, options, callback) => {
        // Node's autoSelectFamily requests all records; never re-resolve after
        // validation, and report each pinned address's actual IP family.
        const records = addresses.map(address => ({ address, family: isIP(address) }))
        if (options.all) callback(null, records)
        else callback(null, records[0]!.address, records[0]!.family)
      },
    }
    const request = requestFn(options, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size > maxBytes) {
          request.destroy(new Error('response_too_large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => finish(undefined, { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', (error) => finish(error))
    })
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', (error) => finish(error))
    request.end()
  })
}

function stripMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class WebFetchRuntime {
  constructor(private readonly transport: WebFetchTransport = defaultTransport) {}

  async fetch(raw: unknown, signal?: AbortSignal): Promise<FetchObservation> {
    const observedAt = new Date().toISOString()
    const parsed = webFetchSchema.safeParse(raw)
    if (!parsed.success) return fail('invalid_input', '', observedAt)
    let url: URL
    try {
      url = validateUrl(parsed.data.url)
    } catch {
      return fail('invalid_url', parsed.data.url, observedAt)
    }
    const maxOutput = parsed.data.max_output_chars ?? 20_000
    const maxBytes = MAX_BYTES
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      if (signal?.aborted) return fail('cancelled', url.href, observedAt)
      try {
        await validateHost(url)
        const response = await this.transport(url, signal ?? new AbortController().signal, maxBytes)
        const type = contentType(response.headers)
        if (response.body.byteLength > maxBytes) return fail('response_too_large', url.href, observedAt)
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location
          if (typeof location !== 'string' || redirect === MAX_REDIRECTS) return fail('redirect_limit', url.href, observedAt)
          try {
            url = validateUrl(new URL(location, url).href)
          } catch {
            return fail('redirect_error', url.href, observedAt)
          }
          continue
        }
        if (response.status < 200 || response.status >= 300) return fail('network_error', url.href, observedAt)
        if (!/^(text\/html|text\/plain)(?:\s*;|$)/i.test(type))
          return fail('unsupported_content_type', url.href, observedAt)
        const rawText = Buffer.from(response.body).toString('utf8')
        const text = stripMarkup(rawText)
        const truncated = text.length > maxOutput
        return {
          ok: true,
          url: url.href,
          observedAt,
          contentType: type,
          bytesRead: response.body.byteLength,
          truncated,
          text: text.slice(0, maxOutput),
        }
      } catch (error) {
        const code = error instanceof Error && (error.message in errorMessages)
          ? error.message as FetchErrorCode
          : signal?.aborted ? 'cancelled' : 'network_error'
        return fail(code, url.href, observedAt)
      }
    }
    return fail('redirect_limit', url.href, observedAt)
  }
}
