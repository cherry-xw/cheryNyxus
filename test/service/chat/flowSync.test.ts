/**
 * chat.sync 单一事件流测试（G3 改造A）。
 * - messagesToStagedEvents：消息→staged 转换（chat.get 与回填复用）
 * - 非超窗：chat.sync(0) 返回全部事件 + currentState（单一水源）
 * - 超窗（强制淘汰）：回填合成旧历史 + 留存近期，按 msgId/id 去重，reset:false + backfilled:true
 */
import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat, getChat, getMessages } from '@/db/chat.js'
import { getMonthlyDb } from '@/db/index.js'
import { appendChatEvent } from '@/db/delivery.js'
import { handleChatSync, messagesToStagedEvents } from '@/service/chat/handler.js'
import type { HandlerContext } from '@/service/message/router.js'
import type { Chunk, Notification } from '@/service/message/types.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

/** 耗尽 async generator，返回 {events(_yielded), response(return)} */
async function drainSync(
  chatId: string,
  afterSeq: number,
): Promise<{ events: Array<Chunk | Notification>; response: unknown }> {
  const gen = handleChatSync({} as HandlerContext, { chatId, afterSeq })
  const events: Array<Chunk | Notification> = []
  let response: unknown
  while (true) {
    const r = await gen.next()
    if (r.done) {
      response = r.value
      break
    }
    events.push(r.value as Chunk | Notification)
  }
  return { events, response }
}

describe('messagesToStagedEvents（消息→staged 转换）', () => {
  it('把 user/assistant 消息转成 content_end staged（带 msgId）', () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    addMessage('m-u', chatId, { role: 'user', content: 'hi' })
    addMessage('m-a', chatId, { role: 'assistant', content: 'yo' })
    const chunks = messagesToStagedEvents(chatId)
    const contents = chunks.filter((c) => c.data.type === 'content_end').map((c) => c.data.msgId)
    expect(contents).toEqual(['m-u', 'm-a'])
  })
})

describe('chat.sync 非超窗（单一水源）', () => {
  it('chat.sync(0) 返回全部事件 + currentState', async () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    appendChatEvent(chatId, {
      kind: 'notification',
      type: 'consumed',
      data: { count: 1 },
      chatId,
    })
    appendChatEvent(chatId, {
      kind: 'chunk',
      type: 'staged',
      data: { type: 'content_end', content: 'hello', msgId: 'c1' },
      chatId,
    })
    const { events, response } = await drainSync(chatId, 0)
    expect(events.length).toBe(2)
    expect((response as { currentState: unknown }).currentState).toBeDefined()
    expect((response as { reset: boolean }).reset).toBe(false)
  })
})

describe('chat.sync 超窗回填（G3）', () => {
  it('强制淘汰旧事件 → 回填合成旧消息 + 留存近期，按 msgId 去重', async () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    // 两条消息：m-old（旧，事件将被淘汰）、m-recent（近期，事件留存）
    addMessage('m-old', chatId, { role: 'user', content: 'old' })
    addMessage('m-recent', chatId, { role: 'assistant', content: 'recent' })
    // 追加 2 个占位事件（seq1, seq2，将被淘汰）+ m-recent 的 content_end（seq3，留存）
    appendChatEvent(chatId, { kind: 'notification', type: 'consumed', data: { count: 1 }, chatId })
    appendChatEvent(chatId, { kind: 'notification', type: 'consumed', data: { count: 2 }, chatId })
    appendChatEvent(chatId, {
      kind: 'chunk',
      type: 'staged',
      data: { type: 'content_end', content: 'recent', msgId: 'm-recent' },
      chatId,
    })
    // 强制淘汰 seq1, seq2（模拟超窗）→ minSeq=3
    const month = getChat(chatId)!.messages_month
    getMonthlyDb(month).prepare('DELETE FROM chat_events WHERE chat_id = ? AND chat_seq < 3').run(chatId)

    const { events, response } = await drainSync(chatId, 0)
    const res = response as { reset: boolean; backfilled?: boolean; currentState: unknown }
    expect(res.reset).toBe(false)
    expect(res.backfilled).toBe(true)
    // m-old 由回填合成（留存无其事件）→ 出现一次
    const oldChunks = events.filter(
      (e) => e.kind === 'chunk' && e.data.type === 'content_end' && e.data.msgId === 'm-old',
    )
    expect(oldChunks.length).toBe(1)
    // m-recent 由留存提供（回填去重）→ 仅一次
    const recentChunks = events.filter(
      (e) => e.kind === 'chunk' && e.data.type === 'content_end' && e.data.msgId === 'm-recent',
    )
    expect(recentChunks.length).toBe(1)
  })
})
