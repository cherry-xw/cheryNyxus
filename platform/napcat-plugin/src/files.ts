import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, unlink, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { QQNotification } from '@chery/protocol'

/** 只读取受认证的分段接口；不接受服务端提供的本地文件路径。 */
export async function sendAssetFile(input: {
  dataPath: string
  event: QQNotification['data']
  read(offset: number): Promise<{ offset: number; dataBase64: string; eof: boolean }>
  action(name: string, params: unknown): Promise<any>
  validate?(): void
}): Promise<{ messageIds: string[]; fileIds?: string[]; fileUploaded?: true }> {
  const asset = input.event.asset
  input.validate?.()
  if (!asset || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || asset.sizeBytes > 100 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid asset')
  const root = path.join(input.dataPath, 'file-deliveries')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(path.join(root, 'delivery-'))
  let name = ''
  for (const char of asset.originalName.replace(/[\x00-\x1f\x7f/\\]/g, '_')) {
    if (Buffer.byteLength(name + char, 'utf8') > 180) break
    name += char
  }
  name ||= 'file'
  const filePath = path.join(directory, name === '.' || name === '..' ? 'file' : name)
  let actionStarted = false
  try {
    const file = await open(filePath, 'wx', 0o600)
    try {
      let offset = 0
      const hash = createHash('sha256')
      while (offset < asset.sizeBytes) {
        input.validate?.()
        const chunk = await input.read(offset)
        input.validate?.()
        if (chunk.offset !== offset || typeof chunk.dataBase64 !== 'string' || chunk.dataBase64.length > 349528) throw new Error('Invalid chunk')
        const bytes = Buffer.from(chunk.dataBase64, 'base64')
        if (!bytes.length || bytes.length > 256 * 1024 || bytes.toString('base64') !== chunk.dataBase64 || offset + bytes.length > asset.sizeBytes) throw new Error('Invalid chunk')
        await file.writeFile(bytes)
        hash.update(bytes)
        offset += bytes.length
        if (chunk.eof !== (offset === asset.sizeBytes)) throw new Error('Invalid length')
      }
      if (hash.digest('hex') !== asset.sha256) throw new Error('Invalid digest')
      await file.sync()
    } finally { await file.close() }
    const target = input.event.targetId
    const group = input.event.conversationType === 'group'
    const media = asset.mimeType.startsWith('image/') ? 'image' : asset.mimeType.startsWith('audio/') ? 'record' : asset.mimeType.startsWith('video/') ? 'video' : undefined
    input.validate?.()
    actionStarted = true
    const result = media
      ? await input.action('send_msg', { message_type: group ? 'group' : 'private', ...(group ? { group_id: target } : { user_id: target }),
        message: [{ type: media, data: { file: pathToFileURL(filePath).href } }] })
      : await input.action(group ? 'upload_group_file' : 'upload_private_file', { ...(group ? { group_id: target } : { user_id: target }), file: filePath, name, upload_file: true })
    if (result?.retcode !== undefined && result.retcode !== 0 || result?.status === 'failed') throw Object.assign(new Error('File action rejected'), { definitelyFailed: true })
    if (!media) {
      const id = result?.file_id ?? result?.data?.file_id
      if (typeof id === 'string' && id.length && id.length <= 512) return { messageIds: [], fileIds: [id], fileUploaded: true }
      if (result?.status === 'ok' && result.retcode === 0) return { messageIds: [], fileIds: [], fileUploaded: true }
      throw new Error('File delivery unknown')
    }
    const id = result?.message_id ?? result?.data?.message_id
    if (id === undefined || id === null || !/^-?\d{1,100}$/.test(String(id))) throw new Error('File delivery unknown')
    return { messageIds: [String(id)] }
  } catch (error) {
    if (!actionStarted) throw Object.assign(new Error('File preparation failed'), { definitelyFailed: true })
    throw error
  } finally { await unlink(filePath).catch(() => undefined); await rmdir(directory).catch(() => undefined) }
}
