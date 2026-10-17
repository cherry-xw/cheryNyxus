import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetRecord } from '@chery/protocol'
import config from '@/utils/config.js'
import { createChat, deleteChat } from '@/db/chat.js'
import { runFileOperation, retryFileOperationSave } from '@/service/fileServices/operations.js'

const mocks = vi.hoisted(() => ({ save: vi.fn(), read: vi.fn(), download: vi.fn(), referenceOperation: vi.fn(), attachOwned: vi.fn() }))
vi.mock('@/service/media/store.js', () => ({ getAssetStore: () => mocks }))
vi.mock('@/service/fileServices/download.js', () => ({ downloadProviderResult: (...args: unknown[]) => mocks.download(...args) }))
const previousServices = config.file_services
const files = new Map<string, { asset: AssetRecord; data: Buffer }>()
let chatId: string
const serviceId = 'recovery-test'
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
// 只有格式签名和测试文字，不包含可解码的图片，也不作图片内容验证。
const fixture = (text: string) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(text)])
const begin = () => runFileOperation({ ownerId: 'recovery-owner', chatId, requestId: randomUUID(), serviceId,
  operation: 'image.generate', params: { prompt: 'opaque fixture' }, assets: [] })

beforeEach(() => {
  vi.clearAllMocks(); files.clear()
  chatId = randomUUID(); createChat(chatId, { fileOwnerId: 'recovery-owner' })
  config.file_services = { [serviceId]: { name: '恢复测试', enabled: true, adapter: 'openai-images',
    connection: { baseUrl: 'https://provider.example', model: 'gpt-image-1', keyRef: 'test-secret' }, operations: ['image.generate'] } }
  mocks.save.mockImplementation(async (data: Buffer, options: { originalName: string; ownerId: string }) => {
    const asset: AssetRecord = { id: randomUUID(), versionId: randomUUID(), originalName: options.originalName, ownerId: options.ownerId,
      mimeType: 'image/png', kind: 'image', sizeBytes: data.length, sha256: '0'.repeat(64), source: 'provider', createdAt: 1, availability: 'available', transform: { variant: 'original' } }
    files.set(asset.id, { asset, data }); return asset
  })
  mocks.read.mockImplementation(async (id: string) => files.get(id))
})
afterEach(() => { config.file_services = previousServices; deleteChat(chatId); vi.unstubAllGlobals() })

describe('文件操作保存恢复', () => {
  it('最小检查：下载部分失败保留固定版本，重试只补缺失文件且不再生成', async () => {
    const fetcher = vi.fn().mockImplementation(async () => json({ data: [
      { revised_prompt: '说明', url: 'https://cdn.example/one.png' }, { url: 'https://cdn.example/two.png' },
    ] }))
    vi.stubGlobal('fetch', fetcher)
    mocks.download.mockResolvedValueOnce(new Response(new Uint8Array(fixture('one')), { headers: { 'content-type': 'image/png' } }))
      .mockRejectedValueOnce(new Error('disconnected'))
    const partial = await begin()
    expect(partial.executionStatus).toBe('partial')
    expect(partial.deliveryStatus).toBe('partial_saved')
    expect(partial.outputParts?.map(part => part.type)).toEqual(['text', 'asset'])
    const first = partial.outputParts![1]
    mocks.download.mockResolvedValueOnce(new Response(new Uint8Array(fixture('two')), { headers: { 'content-type': 'image/png' } }))
    const restored = await retryFileOperationSave(partial.operationId, 'recovery-owner', chatId)
    expect(restored.executionStatus).toBe('succeeded')
    expect(restored.deliveryStatus).toBe('saved')
    expect(restored.outputParts?.map(part => part.type)).toEqual(['text', 'asset', 'asset'])
    expect(restored.outputParts?.[1]).toEqual(first)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(mocks.download).toHaveBeenCalledTimes(3)
    expect(String(mocks.download.mock.calls[2]![0])).toBe('https://cdn.example/two.png')
    expect(mocks.save).toHaveBeenCalledTimes(2)
  })

  it('服务商单项拒绝与完整保存分开，不把已保存的一图误报为整批成功', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => json({ data: [
      { b64_json: fixture('one').toString('base64') }, { error: { code: 'blocked' } },
    ] })))
    const record = await begin()
    expect(record.executionStatus).toBe('partial')
    expect(record.deliveryStatus).toBe('saved')
    expect(record.error?.retryable).toBe(false)
    expect(record.outputAssetIds).toHaveLength(1)
    await expect(retryFileOperationSave(record.operationId, 'recovery-owner', chatId)).rejects.toThrow('不需要重新保存')
  })

  it('原响应里的本地字节在服务删除后仍可保存，不重新调用生成或下载接口', async () => {
    const fetcher = vi.fn().mockImplementation(async () => json({ data: [{ b64_json: fixture('one').toString('base64') }] }))
    vi.stubGlobal('fetch', fetcher)
    mocks.save.mockRejectedValueOnce(new Error('disk full'))
    const record = await begin()
    expect(record.deliveryStatus).toBe('delivery_failed')
    // 只留下原始响应，模拟本地标准结果尚未写完的恢复情况。
    await unlink(join(process.env.CHERY_DIR!, '.chery/file-operation-results', `${record.operationId}.json`))
    config.file_services = {}
    const restored = await retryFileOperationSave(record.operationId, 'recovery-owner', chatId)
    expect(restored.executionStatus).toBe('succeeded')
    expect(restored.deliveryStatus).toBe('saved')
    expect(restored.outputAssetIds).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(mocks.download).not.toHaveBeenCalled()
  })
})
