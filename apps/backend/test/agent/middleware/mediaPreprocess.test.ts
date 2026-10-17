import { describe, it, expect, vi, beforeEach } from 'vitest'
import { enrichMediaInputs } from '@/agent/middleware/mediaEnrichment.js'
import { createMockContext, createMockRuntime, createTestSense } from '../helpers/fakeContext.js'

const store = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn() }))
vi.mock('@/service/media/store.js', () => ({ getAssetStore: () => store }))
vi.mock('@/service/media/access.js', () => ({ fileAccessForChat: () => ({ ownerId: 'owner', chatId: 'test-chat' }) }))
vi.mock('@/db/chat.js', () => ({ getChatType: () => undefined, getChatPreset: () => undefined, getChatWorkspace: () => undefined }))

beforeEach(() => vi.clearAllMocks())

describe('旧媒体正文不再触发文件读取', () => {
  it('标记只是普通文字，即使旧工具声明允许前置处理', async () => {
    const execute = vi.fn(async () => ({ content: '不应执行' }))
    const legacyCapabilities = { accepts: ['image'], preprocess: true }
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [
      createTestSense('old_preprocess', execute, undefined, undefined, legacyCapabilities),
    ] }) })
    const history = [{ id: 'u', role: 'user' as const, content: '看图 [[media:aa-1.png]]', createdAt: 0, updateAt: 0 }]
    const result = await enrichMediaInputs(ctx, history)
    expect(result.history).toBe(history)
    expect(store.get).not.toHaveBeenCalled()
    expect(store.read).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})
