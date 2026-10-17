import { isIP } from 'node:net'
import {
  FileServiceAdapterError,
  type FileServiceAdapterDependencies,
  type FileServiceAdapterInput,
  type FileServiceAdapterPart,
  type FileServiceAdapterOutput,
} from './types.js'

export const MAX_FILE_SERVICE_OUTPUT_BYTES = 100 * 1024 * 1024
const MAX_JSON_BYTES = 256 * 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function malformed(message = '服务返回了无法识别的结果'): never {
  throw new FileServiceAdapterError('file_service.invalid_response', message)
}

export function httpUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new FileServiceAdapterError('file_service.invalid_config', '接口地址必须是完整 HTTP/S URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new FileServiceAdapterError('file_service.invalid_config', '接口仅接受无内嵌凭据和片段的 HTTP/S URL')
  }
  return url
}

/** Append a documented route to an explicitly configured API base, never probe routes. */
export function endpoint(input: FileServiceAdapterInput, route: string, version: string): URL {
  const override = input.connection.endpoints?.[input.operation]
  if (override) return httpUrl(override)
  const base = httpUrl(input.connection.baseUrl)
  if (base.search) throw new FileServiceAdapterError('file_service.invalid_config', '基础地址不能包含查询参数，请使用完整端点覆盖')
  const path = base.pathname.replace(/\/+$/, '')
  base.pathname = `${path.endsWith(`/${version}`) ? path : `${path}/${version}`}/${route}`
  return base
}

export async function boundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared && Number(declared) > maxBytes) {
    await response.body?.cancel()
    throw new FileServiceAdapterError('asset.too_large', '服务返回的文件或响应超过大小限制')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      signal.throwIfAborted()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new FileServiceAdapterError('asset.too_large', '服务返回的文件或响应超过大小限制')
      }
      chunks.push(Buffer.from(next.value))
    }
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

export function providerFailure(value: unknown, httpStatus?: number): never {
  const raw = record(value)
  const code = raw.code ?? raw.status ?? raw.status_code ?? 'unknown'
  // Provider messages may echo prompts, URLs or secrets; expose only a bounded code.
  const providerCode = String(code).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 128)
  throw new FileServiceAdapterError('file_service.provider_error', `文件服务请求失败（${providerCode}）`, providerCode, httpStatus)
}

export interface AdapterHttpContext {
  outputParts: FileServiceAdapterPart[]
  incomplete?: FileServiceAdapterOutput['incomplete']
  response?: Record<string, unknown>
  signal: AbortSignal
  dependencies: FileServiceAdapterDependencies
  request(url: URL, body: Record<string, unknown> | FormData, google?: boolean): Promise<Record<string, unknown>>
  file(base64: unknown, mimeType: string, index: number): FileServiceAdapterPart
  download(url: unknown, mimeType: string, index: number): Promise<FileServiceAdapterPart>
  text(text: string, index: number): FileServiceAdapterPart
  failed(code: string, text: string, index: number): FileServiceAdapterPart
}

export function createHttpContext(
  input: FileServiceAdapterInput,
  dependencies: FileServiceAdapterDependencies,
  signal: AbortSignal,
): AdapterHttpContext {
  const context: AdapterHttpContext = {
    outputParts: [],
    signal,
    dependencies,
    text(text, index) {
      const part: FileServiceAdapterPart = { type: 'text', text }
      context.outputParts[index] = part
      return part
    },
    failed(code, text, index) {
      context.incomplete = { code, message: '部分图片未成功返回；已有文件已保留，不会自动重新生成', retryable: false }
      return context.text(text, index)
    },
    async request(url, body, google = false) {
      signal.throwIfAborted()
      const headers: Record<string, string> = { Accept: 'application/json' }
      const target = new URL(url)
      const authType = input.connection.authType
      if (input.connection.key && authType !== 'none') {
        if (authType === 'query-key') target.searchParams.set('key', input.connection.key)
        else if (authType === 'x-api-key') headers[google ? 'x-goog-api-key' : 'x-api-key'] = input.connection.key
        else if (authType === 'bearer' || !google) headers.Authorization = `Bearer ${input.connection.key}`
        else headers['x-goog-api-key'] = input.connection.key
      }
      const multipart = body instanceof FormData
      if (!multipart) headers['Content-Type'] = 'application/json'
      const response = await (dependencies.fetch ?? globalThis.fetch)(target, {
        method: 'POST', headers, body: multipart ? body : JSON.stringify(body),
        signal, redirect: 'error', credentials: 'omit',
      })
      const bytes = await boundedBody(response, response.ok ? MAX_JSON_BYTES : MAX_ERROR_BYTES, signal)
      let parsed: unknown
      try { parsed = JSON.parse(bytes.toString('utf8')) } catch {
        if (!response.ok) providerFailure({ code: `http_${response.status}` }, response.status)
        malformed('文件接口未返回 JSON；不支持流式或异步接口模式')
      }
      const result = record(parsed)
      if (!response.ok || result.error) providerFailure(result.error ?? { code: `http_${response.status}` }, response.status)
      context.response = result
      return result
    },
    file(base64, mimeType, index) {
      const saved = dependencies.savedParts?.[index]
      if (saved?.type === 'file') { context.outputParts[index] = saved; return saved }
      if (typeof base64 !== 'string' || !base64) malformed('服务返回空图片')
      const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(base64)
      const encoded = dataUrl?.[2] ?? base64
      if (dataUrl) mimeType = dataUrl[1]!
      if (encoded.length > Math.ceil(MAX_FILE_SERVICE_OUTPUT_BYTES / 3) * 4) {
        throw new FileServiceAdapterError('asset.too_large', '输出文件超过 100 MiB')
      }
      const padding = encoded.indexOf('=')
      if (encoded.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(encoded) ||
        (padding >= 0 && (padding < encoded.length - 2 || !['=', '=='].includes(encoded.slice(padding))))) {
        malformed('服务返回的 base64 无效')
      }
      const data = Buffer.from(encoded, 'base64')
      const part = filePart(data, mimeType, index)
      context.outputParts[index] = part
      return part
    },
    async download(value, mimeType, index) {
      const saved = dependencies.savedParts?.[index]
      if (saved?.type === 'file') { context.outputParts[index] = saved; return saved }
      if (typeof value !== 'string') malformed('服务未返回有效下载地址')
      const url = httpUrl(value)
      // The hook must additionally enforce DNS resolution, IP pinning and redirects.
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
      if (isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) {
        throw new FileServiceAdapterError('file_service.unsafe_download', '不允许从此地址下载文件')
      }
      if (!dependencies.download) {
        throw new FileServiceAdapterError('file_operation.delivery_failed', 'URL 结果需要由应用提供受控下载函数；未重新生成图片')
      }
      let response: Response
      try {
        response = await dependencies.download(url, { signal, maxBytes: MAX_FILE_SERVICE_OUTPUT_BYTES })
      } catch (error) {
        if (error instanceof FileServiceAdapterError) throw error
        throw new FileServiceAdapterError('file_operation.delivery_failed', '生成结果下载中断；未重新生成图片')
      }
      if (!response.ok || response.status >= 300) {
        throw new FileServiceAdapterError('file_operation.delivery_failed', '生成结果下载失败；未重新生成图片', undefined, response.status)
      }
      const data = await boundedBody(response, MAX_FILE_SERVICE_OUTPUT_BYTES, signal)
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
      const part = filePart(data, contentType ?? mimeType, index)
      context.outputParts[index] = part
      return part
    },
  }
  return context
}

function filePart(data: Buffer, mimeType: string, index: number): FileServiceAdapterPart {
  if (!data.length) malformed('服务返回空文件')
  if (data.length > MAX_FILE_SERVICE_OUTPUT_BYTES) throw new FileServiceAdapterError('asset.too_large', '输出文件超过 100 MiB')
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
  // MiniMax omits the MIME for raw base64. Recognize only file headers, not image contents.
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png'
  else if (data[0] === 255 && data[1] === 216 && data[2] === 255) mimeType = 'image/jpeg'
  else if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp'
  if (!extensions[mimeType]) malformed('服务返回不支持的图片 MIME 类型')
  return { type: 'file', data, mimeType, originalName: `image-${index + 1}.${extensions[mimeType]}` }
}

export function dataUri(asset: { mimeType: string; data: Buffer }): string {
  return `data:${asset.mimeType};base64,${asset.data.toString('base64')}`
}
