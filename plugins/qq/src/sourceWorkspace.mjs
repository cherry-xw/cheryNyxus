import path from 'node:path'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'

const identifier = /^[a-zA-Z0-9._-]{1,120}$/
const digest = /^[a-f0-9]{64}$/
const maxZipBytes = 100 * 1024 * 1024
const maxTextBytes = 64 * 1024 * 1024
const fail = code => { throw Object.assign(new Error(code), { code }) }
const hash = value => createHash('sha256').update(value).digest('hex')
const publications = new Map()

export function sourceDirectory(scope) {
  const qq = /^[1-9]\d{0,19}$/
  if (!scope || typeof scope.ownerId !== 'string' || !scope.ownerId || scope.ownerId.length > 256 ||
    !qq.test(scope.selfId) || !qq.test(scope.targetId) || !['group', 'private'].includes(scope.conversationType) ||
    typeof scope.scopeId !== 'string' || !scope.scopeId || scope.scopeId.length > 256 ||
    !Number.isSafeInteger(scope.permissionRevision) || scope.permissionRevision < 1) fail('IDENTITY_REJECTED')
  return hash(JSON.stringify([scope.ownerId, scope.selfId, scope.conversationType, scope.targetId, scope.scopeId]))
}

export function separateSourceRoot(sourceRoot, sharedRoot) {
  if (![sourceRoot, sharedRoot].every(p => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0'))) fail('STORAGE_UNAVAILABLE')
  const source = path.resolve(sourceRoot), shared = path.resolve(sharedRoot)
  if (source === shared || source.startsWith(shared + path.sep) || shared.startsWith(source + path.sep)) fail('STORAGE_UNAVAILABLE')
  return source
}

const at = (directory, name) => `/proc/self/fd/${directory.fd}/${name}`
/** Linux directory descriptors keep a checked parent pinned through every open. */
export async function openSourceDirectory(root, segments = [], create = false) {
  if (!path.isAbsolute(root) || root.includes('\0') || segments.some(s => !identifier.test(s) || s === '.' || s === '..')) fail('STORAGE_UNAVAILABLE')
  let directory = await fs.open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    for (const segment of [...path.resolve(root).split('/').filter(Boolean), ...segments]) {
      if (create) await fs.mkdir(at(directory, segment), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      const next = await fs.open(at(directory, segment), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      await directory.close()
      directory = next
    }
    return directory
  } catch (error) { await directory.close(); throw error }
}

async function regularFile(directory, name, flags = constants.O_RDONLY, publication) {
  for (let retry = 0; retry < 3; retry++) {
    await publication?.check()
    const file = await fs.open(at(directory, name), flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    try {
      const stat = await file.stat()
      if (!stat.isFile()) fail('FILE_INVALID')
      if (stat.nlink === 1) return file
      // Only a matching private publication temporary may explain a second link.
      // Finishing its unlink is safe even if the original process stopped after linking.
      if (!publication || stat.nlink !== 2) fail('FILE_INVALID')
      const candidates = []
      for (const entry of await fs.readdir(at(publication.directory, '.'))) {
        if (!/^\.source-[a-f0-9-]{36}$/.test(entry)) continue
        const candidate = await fs.lstat(at(publication.directory, entry)).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (candidate?.isFile() && candidate.dev === stat.dev && candidate.ino === stat.ino) candidates.push(entry)
      }
      const current = await file.stat()
      if (current.nlink === 1) return file
      if (candidates.length !== 1 || current.nlink !== 2) fail('FILE_INVALID')
      await publication.check()
      const temporary = at(publication.directory, candidates[0])
      const candidate = await fs.lstat(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (candidate && (!candidate.isFile() || candidate.dev !== stat.dev || candidate.ino !== stat.ino)) fail('FILE_INVALID')
      if (candidate) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
      await publication.directory.sync()
    } catch (error) { await file.close(); throw error }
    await file.close()
  }
  fail('REVISION_CONFLICT')
}
async function readJson(directory, name, publication) {
  const file = await regularFile(directory, name, constants.O_RDONLY, publication)
  try {
    if ((await file.stat()).size > 16384) fail('FILE_INVALID')
    const text = await file.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(text) > 16384) fail('FILE_INVALID')
    return JSON.parse(text)
  } finally { await file.close() }
}
async function atomicFile(directory, name, body, validate, staging = directory) {
  const temporary = `.source-${randomUUID()}`
  try {
    const file = await regularFile(staging, temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL)
    try { await file.writeFile(body); await file.sync() } finally { await file.close() }
    await validate()
    // Never overwrite a pre-existing name, including a symlink planted by a command.
    await fs.link(at(staging, temporary), at(directory, name))
    await fs.unlink(at(staging, temporary)).catch(error => { if (error.code !== 'ENOENT') throw error })
    await directory.sync()
  } finally { await fs.unlink(at(staging, temporary)).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
const sameVersion = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink
async function fileHash(directory, name, size, publication) {
  const file = await regularFile(directory, name, constants.O_RDONLY, publication)
  try {
    const before = await file.stat({ bigint: true })
    if (before.size !== BigInt(size)) fail('FILE_INVALID')
    const value = createHash('sha256'), buffer = Buffer.alloc(65536)
    let offset = 0
    while (offset < size) {
      await publication?.check()
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
      if (!bytesRead) fail('FILE_INVALID')
      offset += bytesRead; value.update(buffer.subarray(0, bytesRead))
    }
    if (!sameVersion(before, await file.stat({ bigint: true })) || !sameVersion(before, await fs.lstat(at(directory, name), { bigint: true }))) fail('REVISION_CONFLICT')
    return value.digest('hex')
  } finally { await file.close() }
}

/** Registry lives beside, never inside, the directory mounted into the command container. */
export function stageSourceZip(input) {
  const key = JSON.stringify([input.sourceRoot, sourceDirectory(input.scope), input.source.recordId, input.source.partId, input.asset.sha256])
  const prior = publications.get(key) ?? Promise.resolve()
  const operation = prior.catch(() => {}).then(() => stageZip(input))
  publications.set(key, operation)
  return operation.finally(() => { if (publications.get(key) === operation) publications.delete(key) })
}
async function stageZip({ sourceRoot, sharedRoot, scope, source, asset, senderId, originalName, body, validate, signal }) {
  separateSourceRoot(sourceRoot, sharedRoot)
  const scopeDirectory = sourceDirectory(scope)
  if (!identifier.test(source.recordId) || !/^p\d+(?:\.\d+)?$/.test(source.partId) || !Number.isSafeInteger(source.revision) || source.revision < 1 ||
    !digest.test(asset.sha256) || body.length <= 0 || body.length > maxZipBytes || body.length !== asset.sizeBytes || hash(body) !== asset.sha256 ||
    body[0] !== 0x50 || body[1] !== 0x4b || !((body[2] === 3 && body[3] === 4) || (body[2] === 5 && body[3] === 6))) fail('FILE_INVALID')
  const slotKey = `${source.recordId}-${source.partId}-${asset.sha256.slice(0, 12)}`
  if (!identifier.test(slotKey)) fail('FILE_INVALID')
  const check = async () => { signal?.throwIfAborted(); await validate(); signal?.throwIfAborted() }
  await check()
  const registry = await openSourceDirectory(sourceRoot, [scopeDirectory, 'slots'], true)
  const publication = { directory: registry, check }
  let slot
  try {
    const identity = { ...source, assetId: asset.assetId, assetVersionId: asset.assetVersionId, originalName,
      safeFileName: 'archive.zip', sizeBytes: asset.sizeBytes, sha256: asset.sha256, senderId }
    let saved
    try { saved = await readJson(registry, `${slotKey}.json`, publication) } catch (error) { if (error.code !== 'ENOENT') throw error }
    // Reserve identity first. An interrupted publisher can finish these same immutable bytes,
    // while a concurrent publisher with different provenance must fail before writing the slot.
    if (!saved) {
      try { await atomicFile(registry, `${slotKey}.json`, JSON.stringify({ identity, stagedAt: Date.now() }), check) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      saved = await readJson(registry, `${slotKey}.json`, publication)
    }
    if (saved && JSON.stringify(saved.identity) !== JSON.stringify(identity)) fail('SOURCE_CONFLICT')
    slot = await openSourceDirectory(sourceRoot, [scopeDirectory, 'incoming-zips', slotKey], true)
    try {
      if (await fileHash(slot, 'archive.zip', asset.sizeBytes, publication) !== asset.sha256) fail('FILE_INVALID')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      try { await atomicFile(slot, 'archive.zip', body, check, registry) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      if (await fileHash(slot, 'archive.zip', asset.sizeBytes, publication) !== asset.sha256) fail('FILE_INVALID')
    }
    const extracted = await openSourceDirectory(sourceRoot, [scopeDirectory, 'incoming-zips', slotKey, 'extracted'], true)
    await extracted.close()
    const stagedAt = saved.stagedAt
    // The displayed manifest is not an authority: a command can edit its mounted copy.
    try { await atomicFile(slot, 'manifest.json', JSON.stringify({ ...identity, stagedAt }), check, registry) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    await check()
    return { slotKey, scope: 'source', scopeId: scope.scopeId,
      containerPath: `/workspace/files/incoming-zips/${slotKey}/archive.zip`, cwd: `incoming-zips/${slotKey}`,
      extractedDir: `/workspace/files/incoming-zips/${slotKey}/extracted`, entryFile: 'archive.zip', sizeBytes: asset.sizeBytes, sha256: asset.sha256 }
  } finally { await slot?.close(); await registry.close() }
}

export async function readSourceZipText({ sourceRoot, sharedRoot, scope, slotKey, path: relative, start = 0, length = 8192, validate, signal }) {
  separateSourceRoot(sourceRoot, sharedRoot)
  const scopeDirectory = sourceDirectory(scope)
  const segments = typeof relative === 'string' ? relative.split('/') : []
  if (!identifier.test(slotKey) || !segments.length || relative.length > 512 || relative.includes('\\') || relative.includes('\0') ||
    segments.some(s => !s || s === '.' || s === '..' || /[\x00-\x1f]/.test(s)) ||
    !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1 || length > 8192) fail('INVALID_PARAMS')
  const check = async () => { signal?.throwIfAborted(); await validate(); signal?.throwIfAborted() }
  await check()
  const registry = await openSourceDirectory(sourceRoot, [scopeDirectory, 'slots'])
  let directory, file
  try {
    const saved = await readJson(registry, `${slotKey}.json`)
    if (!saved?.identity || !digest.test(saved.identity.sha256) || saved.identity.safeFileName !== 'archive.zip') fail('FILE_INVALID')
    // Only the selected source subtree is reachable; each further name is opened relative to a pinned FD.
    directory = await openSourceDirectory(sourceRoot, [scopeDirectory, 'incoming-zips', slotKey, 'extracted'])
    for (const segment of segments.slice(0, -1)) {
      const next = await fs.open(at(directory, segment), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      await directory.close(); directory = next
    }
    file = await regularFile(directory, segments.at(-1))
    const before = await file.stat({ bigint: true })
    if (before.size > BigInt(maxTextBytes)) fail('FILE_TOO_LARGE')
    const decoder = new TextDecoder('utf-8', { fatal: true }), buffer = Buffer.alloc(65536)
    let position = 0, codePoints = 0, text = '', more = false, pendingHigh = ''
    const consume = chunk => {
      // A UTF-16 surrogate pair can straddle decoder chunks; never split one code point.
      chunk = pendingHigh + chunk; pendingHigh = ''
      if (chunk && /[\uD800-\uDBFF]/.test(chunk.at(-1))) { pendingHigh = chunk.at(-1); chunk = chunk.slice(0, -1) }
      for (const character of chunk) {
        if (character === '\0' || /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(character)) fail('FILE_INVALID')
        if (codePoints >= start && codePoints < start + length) text += character
        if (codePoints >= start + length) more = true
        codePoints++
      }
    }
    // Validate the complete UTF-8 file without the old 1 MiB / line-length restriction.
    while (position < Number(before.size)) {
      await check()
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position)
      if (!bytesRead) fail('REVISION_CONFLICT')
      position += bytesRead; consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }))
    }
    consume(decoder.decode())
    if (pendingHigh || !sameVersion(before, await file.stat({ bigint: true }))) fail('REVISION_CONFLICT')
    const named = await fs.lstat(at(directory, segments.at(-1)), { bigint: true })
    if (!sameVersion(before, named)) fail('REVISION_CONFLICT')
    await check()
    if (start > codePoints) fail('INVALID_PARAMS')
    const endCodePoint = start + Array.from(text).length
    return { startCodePoint: start, endCodePoint, text, nextStart: more ? endCodePoint : null, complete: !more }
  } finally { await file?.close(); await directory?.close(); await registry.close() }
}
