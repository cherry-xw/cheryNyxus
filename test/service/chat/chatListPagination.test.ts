import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import { ensureConversationTask, insertConversationBranch } from '@/db/conversationBranch.js'
import { handleChatList } from '@/service/chat/handler.js'
import type { HandlerContext } from '@/service/message/router.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

const ctx = {} as HandlerContext

const PRESET = 'research'
const PRESET_ID = 'preset-1'

describe('chat.list preset pagination', () => {
  it('returns all roots and no total when limit is omitted', async () => {
    const a = randomUUID()
    const b = randomUUID()
    cleanup.push(a, b)
    createChat(a, { preset: PRESET, presetId: PRESET_ID })
    createChat(b, { preset: PRESET, presetId: PRESET_ID })

    const res = await handleChatList(ctx, { scope: 'preset', preset: PRESET, presetId: PRESET_ID })
    expect(res.chats.map((c) => c.chatId).sort()).toEqual([a, b].sort())
    expect(res.total).toBeUndefined()
  })

  it('pages roots with limit/offset and reports total without overlap', async () => {
    const ids: string[] = []
    for (let i = 0; i < 25; i += 1) {
      const id = randomUUID()
      ids.push(id)
      cleanup.push(id)
      createChat(id, { preset: PRESET, presetId: PRESET_ID })
    }

    const page1 = await handleChatList(ctx, {
      scope: 'preset',
      preset: PRESET,
      presetId: PRESET_ID,
      limit: 10,
      offset: 0,
    })
    expect(page1.chats).toHaveLength(10)
    expect(page1.total).toBe(25)

    const page2 = await handleChatList(ctx, {
      scope: 'preset',
      preset: PRESET,
      presetId: PRESET_ID,
      limit: 10,
      offset: 10,
    })
    const page3 = await handleChatList(ctx, {
      scope: 'preset',
      preset: PRESET,
      presetId: PRESET_ID,
      limit: 10,
      offset: 20,
    })
    expect(page2.chats).toHaveLength(10)
    expect(page3.chats).toHaveLength(5)
    expect(page3.total).toBe(25)

    const seen = new Set([...page1.chats, ...page2.chats, ...page3.chats].map((c) => c.chatId))
    expect(seen.size).toBe(25)
  })

  it('excludes non-original branch roots and counts them out of total', async () => {
    const original = randomUUID()
    const continuation = randomUUID()
    cleanup.push(original, continuation)
    createChat(original, { preset: PRESET, presetId: PRESET_ID })
    createChat(continuation, { preset: PRESET, presetId: PRESET_ID })
    // original 有 original 分支记录（保留）；continuation 同一 task 下为 continuation 分支（排除）。
    const { task } = ensureConversationTask(original, {})
    insertConversationBranch({
      branchId: `branch-${continuation}`,
      taskId: task.taskId,
      chatId: continuation,
      kind: 'continuation',
      runtimeSnapshot: {},
    })

    const res = await handleChatList(ctx, {
      scope: 'preset',
      preset: PRESET,
      presetId: PRESET_ID,
      limit: 20,
      offset: 0,
    })
    expect(res.chats.map((c) => c.chatId)).not.toContain(continuation)
    expect(res.total).toBe(1)
  })

  it('keeps legacy preset-name-only roots matching under pagination', async () => {
    const legacy = randomUUID()
    cleanup.push(legacy)
    createChat(legacy, { preset: PRESET })

    const res = await handleChatList(ctx, {
      scope: 'preset',
      preset: PRESET,
      limit: 20,
      offset: 0,
    })
    expect(res.chats.map((c) => c.chatId)).toContain(legacy)
    expect(res.total).toBe(1)
  })

  it('rejects invalid limit/offset values', async () => {
    await expect(
      handleChatList(ctx, { scope: 'preset', preset: PRESET, limit: 0 }),
    ).rejects.toThrow('分页参数非法')
    await expect(
      handleChatList(ctx, { scope: 'preset', preset: PRESET, limit: 101 }),
    ).rejects.toThrow('分页参数非法')
    await expect(
      handleChatList(ctx, { scope: 'preset', preset: PRESET, limit: 10, offset: -1 }),
    ).rejects.toThrow('分页参数非法')
  })
})
