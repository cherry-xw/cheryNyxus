import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import config from '@/utils/config.js'
import { createIngressCoreAdapter } from '@/service/ingress/coreAdapter.js'
import { getAssetStore } from '@/service/media/store.js'
import { deleteChat, getChat } from '@/db/chat.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'

const chats: string[] = []
afterEach(() => { for (const id of chats.splice(0)) deleteChat(id) })

describe('插件通用文件边界', () => {
  it('最小检查：导入固定版本后仅允许已打开的本插件会话读取', async () => {
    bootstrapAgentRuntime()
    const core = createIngressCoreAdapter()
    const key = randomUUID()
    const preset = Object.keys(config.presets!)[0]!
    const { chatId } = await core.ensureConversation('file-plugin', key, preset)
    chats.push(chatId)
    const identity = { requestIdentity: { source: 'plugin' as const, ownerId: 'file-plugin', entryId: 'file' }, validateIdentity: () => {} }
    const data = Buffer.alloc(256 * 1024 + 12, 65)
    const asset = await core.importFile!('file-plugin', key, { ...identity, entryId: 'file', originalName: '../fixture.txt', mimeType: 'text/plain', source: { data } })
    expect(asset.originalName).toBe('fixture.txt')
    expect(JSON.parse(getChat(chatId)!.metadata!).fileOwnerId).toBe('file-plugin')
    const read = { ...identity, entryId: 'file', assetId: asset.id, assetVersionId: asset.versionId, offset: 0 }
    const first = await core.readFileChunk!('file-plugin', key, read)
    expect(Buffer.from(first.dataBase64, 'base64')).toEqual(data.subarray(0, 256 * 1024))
    expect(first.eof).toBe(false)
    const last = await core.readFileChunk!('file-plugin', key, { ...read, offset: 256 * 1024 })
    expect(Buffer.from(last.dataBase64, 'base64')).toHaveLength(12)
    expect(last.eof).toBe(true)
    await expect(core.readFileChunk!('another-plugin', key, read)).rejects.toThrow('opened')
    const otherKey = randomUUID()
    const other = await core.ensureConversation('file-plugin', otherKey, preset)
    chats.push(other.chatId)
    await expect(core.readFileChunk!('file-plugin', otherKey, read)).rejects.toThrow('无权访问')
    await expect(core.readFileChunk!('file-plugin', 'unopened', read)).rejects.toThrow('opened')
    await expect(core.readFileChunk!('file-plugin', key, { ...read, validateIdentity: () => { throw new Error('identity expired') } })).rejects.toThrow('expired')
    expect(getAssetStore().get(asset.id, { ownerId: 'file-plugin', chatId }).versionId).toBe(asset.versionId)
  })
})
