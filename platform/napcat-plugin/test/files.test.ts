import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendAssetFile } from '../src/files.js'
import type { QQNotification } from '@chery/protocol'

let root: string
beforeEach(async () => { root = await mkdtemp('/tmp/opencode/napcat-files-') })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const bytes = Buffer.from('opaque text fixture')
const event = (mimeType = 'text/plain'): QQNotification['data'] => ({ eventId: 'output', requestId: 'request', selfId: '999', targetId: '123', conversationType: 'private', seq: 1,
  asset: { assetId: 'asset', assetVersionId: 'version', originalName: '../fixture.txt', mimeType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } })

describe('NapCat 受认证文件交付', () => {
  it('最小检查：校验字节后原生上传并清理临时文件，不公开链接', async () => {
    const read = vi.fn().mockResolvedValue({ offset: 0, dataBase64: bytes.toString('base64'), eof: true })
    const action = vi.fn().mockImplementation(async (name: string, params: { file: string; name: string }) => {
      expect(name).toBe('upload_private_file')
      expect(await readFile(params.file)).toEqual(bytes)
      expect(params.name).not.toContain('/')
      return { file_id: 'native-file' }
    })
    expect(await sendAssetFile({ dataPath: root, event: event(), read, action })).toEqual({ messageIds: [], fileIds: ['native-file'], fileUploaded: true })
    expect(await readdir(`${root}/file-deliveries`)).toEqual([])
    expect(read).toHaveBeenCalledWith(0)
  })

  it('摘要不匹配不触发发送，明确失败且清理临时文件', async () => {
    const action = vi.fn()
    await expect(sendAssetFile({ dataPath: root, event: event(), action,
      read: async () => ({ offset: 0, dataBase64: Buffer.alloc(bytes.length).toString('base64'), eof: true }) })).rejects.toMatchObject({ definitelyFailed: true })
    expect(action).not.toHaveBeenCalled()
    expect(await readdir(`${root}/file-deliveries`)).toEqual([])
  })

  it('媒体使用原生消息段，不确定发送不冒报成功', async () => {
    const action = vi.fn().mockImplementation(async (_name: string, params: { message: Array<{ type: string; data: { file: string } }> }) => {
      expect(params.message[0]?.type).toBe('image')
      expect(await readFile(fileURLToPath(params.message[0]!.data.file))).toEqual(bytes)
      return {}
    })
    await expect(sendAssetFile({ dataPath: root, event: event('image/png'), action,
      read: async () => ({ offset: 0, dataBase64: bytes.toString('base64'), eof: true }) })).rejects.toThrow('unknown')
    expect(action).toHaveBeenCalledTimes(1)
    expect(await readdir(`${root}/file-deliveries`)).toEqual([])
  })

  it('原生上传明确成功但没有文件 ID 时不编造消息 ID', async () => {
    const result = await sendAssetFile({ dataPath: root, event: event(), action: async () => ({ status: 'ok', retcode: 0, data: { file_id: null } }),
      read: async () => ({ offset: 0, dataBase64: bytes.toString('base64'), eof: true }) })
    expect(result).toEqual({ messageIds: [], fileIds: [], fileUploaded: true })
  })

  it('长中文文件名按字节限制临时名称，不因文件系统长度限制丢掉结果', async () => {
    const frame = event()
    frame.asset!.originalName = '文件'.repeat(100) + '.txt'
    const action = vi.fn().mockResolvedValue({ file_id: 'file' })
    await sendAssetFile({ dataPath: root, event: frame, action,
      read: async () => ({ offset: 0, dataBase64: bytes.toString('base64'), eof: true }) })
    expect(Buffer.byteLength(action.mock.calls[0]![1].name, 'utf8')).toBeLessThanOrEqual(180)
    expect(await readdir(`${root}/file-deliveries`)).toEqual([])
  })
})
