import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addMessage,
  createChat,
  deleteChat,
  getChat,
  getLastMessage,
  getMessages,
} from '@/db/chat.js'
import { getMonthlyDb, getSoulDb } from '@/db/index.js'
import { createSpawnTask, finishSpawnTask } from '@/db/delivery.js'
import { buildRootTimeline, handleChatList } from '@/service/chat/handler.js'
import type { HandlerContext } from '@/service/message/router.js'

const cleanupChats: string[] = []
const cleanupTasks: string[] = []

afterEach(() => {
  for (const taskId of cleanupTasks.splice(0)) {
    getSoulDb().prepare('DELETE FROM spawn_tasks WHERE task_id = ?').run(taskId)
  }
  for (const chatId of cleanupChats.splice(0).reverse()) deleteChat(chatId)
})

describe('chat recovery state', () => {
  it('uses insertion order when messages share the same millisecond', () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    const chat = createChat(chatId)
    addMessage('assistant-message', chatId, { role: 'assistant', content: '' })
    addMessage('sense-message', chatId, { role: 'sense', content: '' })
    getMonthlyDb(chat.messages_month)
      .prepare('UPDATE messages SET created_at = ? WHERE chat_id = ?')
      .run(100, chatId)

    expect(getMessages(chatId).map((message) => message.role)).toEqual(['assistant', 'sense'])
    expect(getLastMessage(chatId)?.role).toBe('sense')
  })

  it('projects a finished spawn task as a finished child for old metadata', async () => {
    const parentChatId = randomUUID()
    const childChatId = randomUUID()
    cleanupChats.push(parentChatId, childChatId)
    createChat(parentChatId)
    createChat(childChatId, { wait: false }, parentChatId)
    const task = createSpawnTask({
      childChatId,
      parentChatId,
      type: 'coder',
      prompt: 'work',
      brain: 'mock',
      senseGroup: 'default',
      wait: true,
    })
    cleanupTasks.push(task.taskId)
    finishSpawnTask(task.taskId)

    expect(JSON.parse(getChat(childChatId)!.metadata ?? '{}')).not.toHaveProperty('finished')
    const response = await handleChatList({} as HandlerContext, {})
    expect(response.chats.find((chat) => chat.chatId === childChatId)?.finished).toBe(true)
  })

  it('projects a root timeline with explicit child actors and directions', () => {
    const rootChatId = randomUUID()
    const childChatId = randomUUID()
    cleanupChats.push(rootChatId, childChatId)
    createChat(rootChatId)
    createChat(childChatId, { type: 'coder' }, rootChatId)
    addMessage(randomUUID(), rootChatId, { role: 'user', content: 'delegate' })
    addMessage(randomUUID(), childChatId, { role: 'user', content: 'work' })
    addMessage(randomUUID(), childChatId, { role: 'assistant', content: 'done' })

    const snapshot = buildRootTimeline(rootChatId)
    expect(snapshot.nodes.map((node) => node.direction)).toEqual(
      expect.arrayContaining(['user-to-agent', 'parent-to-child', 'agent-to-user']),
    )
    expect(snapshot.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'agent-to-user',
          actor: expect.objectContaining({ kind: 'agent', chatId: childChatId }),
        }),
      ]),
    )
  })
})
