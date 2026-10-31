import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'
import { QQFileResponseSchemas, type QQEventSubmitRequest } from '@chery/protocol'
import type { BackendChannel } from './wire.js'

const MAX_BYTES = 100 * 1024 * 1024
type Access = { wire: BackendChannel; action(name: string, params: unknown): Promise<any>;
  dataRoot?: string; signal: AbortSignal; validate(): void }
function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
const unwrap = (value: any) => value?.data ?? value
const text = (value: unknown) => typeof value === 'string' && value.length <= 8192 ? value : undefined
function safeUrl(input: unknown): URL | undefined {
  try { const url = new URL(String(input)); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : undefined } catch { return undefined }
}
function publicHttps(url: URL | undefined): url is URL {
  if (!url || url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number]
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0)
  }
  return !isIP(host) || isIP(host) === 6 && /^[23]/.test(host) && !/^2001:(db8|0|10|20):/i.test(host)
}

/** No raw message path is readable: only a get_file result under the official data root. */
export function readSourceFile(root: string, filename: string, validate: () => void): Buffer {
  if (process.platform !== 'linux' || !path.isAbsolute(root) || !path.isAbsolute(filename)) fail('SOURCE_UNAVAILABLE')
  const relative = path.relative(root, filename), segments = relative.split(path.sep)
  if (!relative || path.isAbsolute(relative) || segments.some(value => !value || value === '.' || value === '..' || /[\x00-\x1f]/.test(value))) fail('SOURCE_UNAVAILABLE')
  const descriptors: number[] = []
  try {
    let directory = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    descriptors.push(directory)
    for (const segment of [...path.resolve(root).split('/').filter(Boolean), ...segments.slice(0, -1)]) {
      directory = fs.openSync(`/proc/self/fd/${directory}/${segment}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
      descriptors.push(directory)
    }
    validate()
    const file = fs.openSync(`/proc/self/fd/${directory}/${segments.at(-1)}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    descriptors.push(file)
    const before = fs.fstatSync(file, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0 || before.size > BigInt(MAX_BYTES)) fail('FILE_INVALID')
    const body = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < body.length) {
      validate()
      const n = fs.readSync(file, body, offset, Math.min(65536, body.length - offset), offset)
      if (!n) fail('SOURCE_UNAVAILABLE')
      offset += n
    }
    const after = fs.fstatSync(file, { bigint: true }), named = fs.lstatSync(`/proc/self/fd/${directory}/${segments.at(-1)}`, { bigint: true })
    for (const stat of [after, named]) if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(key =>
      before[key as keyof typeof before] !== stat[key as keyof typeof stat])) fail('SOURCE_UNAVAILABLE')
    validate()
    return body
  } finally { for (const descriptor of descriptors.reverse()) fs.closeSync(descriptor) }
}

async function downloadOfficialFile(url: URL, access: Access, redirects = 0): Promise<Buffer> {
  access.validate()
  if (redirects > 3) fail('FILE_DOWNLOAD_FAILED')
  const response = await fetch(url, { signal: access.signal, redirect: 'manual', credentials: 'omit' })
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const next = safeUrl(new URL(response.headers.get('location') ?? '', url))
    await response.body?.cancel()
    if (!next) fail('FILE_DOWNLOAD_FAILED')
    return downloadOfficialFile(next, access, redirects + 1)
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); fail('FILE_DOWNLOAD_FAILED') }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); fail('FILE_TOO_LARGE') }
  const reader = response.body.getReader(), chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      access.validate()
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.length
      if (bytes > MAX_BYTES) fail('FILE_TOO_LARGE')
      chunks.push(Buffer.from(next.value))
    }
    access.validate()
    if (!bytes) fail('FILE_INVALID')
    return Buffer.concat(chunks, bytes)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

let active = 0
const queue: Array<() => void> = []
async function limited<T>(operation: () => Promise<T>, access: Access): Promise<T> {
  if (active >= 2) {
    if (queue.length >= 32) fail('SOURCE_UNAVAILABLE')
    await new Promise<void>((resolve, reject) => {
      const ready = () => { access.signal.removeEventListener('abort', abort); resolve() }
      const abort = () => { const position = queue.indexOf(ready); if (position >= 0) queue.splice(position, 1); reject(access.signal.reason) }
      access.signal.addEventListener('abort', abort, { once: true }); queue.push(ready)
      if (access.signal.aborted) abort()
    })
  } else active++
  try { access.validate(); return await operation() }
  finally { const next = queue.shift(); if (next) next(); else active-- }
}

async function acquire(segment: any, input: QQEventSubmitRequest, partId: string, access: Access): Promise<void> {
  const base = { selfId: input.selfId, eventId: input.eventId, partId }
  const request = async (method: keyof typeof QQFileResponseSchemas, params: object) => {
    access.validate()
    const result = await access.wire.request(method, { ...base, ...params })
    access.validate()
    if (!result.success) fail(String(result.error?.code ?? 'SOURCE_UNAVAILABLE'))
    return QQFileResponseSchemas[method].parse(result.data)
  }
  const tryImport = async (url: URL | undefined) => {
    if (!publicHttps(url)) return false
    try { const result = await request('qq.source.file.import', { url: url.href }); return 'state' in result && result.state === 'committed' }
    catch { access.validate(); return false }
  }
  const data = segment.data ?? {}, declaredSize = Number(data.file_size ?? data.size)
  if (Number.isSafeInteger(declaredSize) && declaredSize > 0) await request('qq.source.file.reserve', { size: declaredSize })
  if (await tryImport(safeUrl(data.url))) return
  const fileId = text(data.file_id ?? data.file)
  if (!fileId || !/^[a-zA-Z0-9._/-]{1,512}$/.test(fileId) || fileId.includes('..')) fail('SOURCE_UNAVAILABLE')
  const busid = Number(data.busid)
  let officialUrl: URL | undefined, localPath: string | undefined
  try {
    const value = unwrap(await access.action(input.conversationType === 'group' ? 'get_group_file_url' : 'get_private_file_url',
      input.conversationType === 'group' ? { group_id: input.targetId, file_id: fileId, ...(Number.isSafeInteger(busid) && busid > 0 ? { busid } : {}) }
        : { user_id: input.targetId, file_id: fileId }))
    access.validate(); officialUrl = safeUrl(value?.url)
  } catch { access.validate() }
  if (await tryImport(officialUrl)) return
  let body: Buffer | undefined
  if (officialUrl) try { body = await downloadOfficialFile(officialUrl, access) } catch { access.validate() }
  if (!body) {
    const value = unwrap(await access.action('get_file', { file_id: fileId }))
    access.validate(); officialUrl = safeUrl(value?.url); localPath = text(value?.file ?? value?.path)
    if (await tryImport(officialUrl)) return
    if (localPath && access.dataRoot) body = readSourceFile(access.dataRoot, localPath, access.validate)
    else if (officialUrl) body = await downloadOfficialFile(officialUrl, access)
  }
  if (!body) fail('SOURCE_UNAVAILABLE')
  if (Number.isSafeInteger(declaredSize) && declaredSize > 0 && body.length !== declaredSize) fail('FILE_INVALID')
  if (body[0] !== 80 || body[1] !== 75 || !((body[2] === 3 && body[3] === 4) || (body[2] === 5 && body[3] === 6))) fail('FILE_INVALID')
  const sha256 = createHash('sha256').update(body).digest('hex'), size = body.length
  const status = async () => QQFileResponseSchemas['qq.source.file.status'].parse(await request('qq.source.file.status', {}))
  let state
  try { state = QQFileResponseSchemas['qq.source.file.begin'].parse(await request('qq.source.file.begin', { size, sha256 })) }
  catch { state = await status() }
  if (state.state === 'committed') return
  const uploadId = state.uploadId
  if (state.state !== 'uploading' || !uploadId) fail('SOURCE_UNAVAILABLE')
  let offset = state.nextOffset
  if (offset > size) fail('SOURCE_CONFLICT')
  while (offset < size) {
    access.validate()
    const end = Math.min(size, offset + 65536)
    try {
      const result = QQFileResponseSchemas['qq.source.file.chunk'].parse(await request('qq.source.file.chunk',
        { uploadId, offset, dataBase64: body.subarray(offset, end).toString('base64') }))
      if (result.nextOffset !== end) fail('SOURCE_CONFLICT')
      offset = result.nextOffset
    } catch {
      const saved = await status()
      if (saved.state === 'committed') return
      if (saved.state !== 'uploading' || saved.uploadId !== uploadId || saved.nextOffset !== end) fail('SOURCE_UNAVAILABLE')
      offset = saved.nextOffset
    }
  }
  try { await request('qq.source.file.commit', { uploadId, size, sha256 }) }
  catch { if ((await status()).state !== 'committed') fail('SOURCE_UNAVAILABLE') }
}

export async function acquireSourceZips(raw: any, input: QQEventSubmitRequest, parent: Access): Promise<void> {
  const signal = AbortSignal.any([parent.signal, AbortSignal.timeout(120000)])
  const access = { ...parent, signal, validate: () => { signal.throwIfAborted(); parent.validate() } }
  for (const file of input.attachments ?? []) {
    if (file.type !== 'file' || !(/\.zip$/i.test(file.name ?? '') || ['application/zip', 'application/x-zip-compressed'].includes(file.mimeType ?? ''))) continue
    const position = Number(file.partId.slice(1)), segment = raw.message?.[position]
    if (!segment || segment.type !== 'file') continue
    const identity = JSON.stringify(segment)
    const exact = { ...access, validate: () => { access.validate(); if (raw.message?.[position] !== segment || JSON.stringify(segment) !== identity) fail('SOURCE_CONFLICT') } }
    try { await limited(() => acquire(segment, input, file.partId, exact), exact) }
    catch (error) {
      if (parent.signal.aborted) return
      parent.validate()
      const code = (error as { code?: string })?.code
      await parent.wire.request('qq.source.file.unavailable', { selfId: input.selfId, eventId: input.eventId, partId: file.partId,
        reasonCode: ['FILE_DOWNLOAD_FAILED', 'FILE_INVALID', 'FILE_TOO_LARGE'].includes(code ?? '') ? code : 'SOURCE_UNAVAILABLE' }).catch(() => {})
    }
  }
}
