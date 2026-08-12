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

  it('projects message runtime snapshots for root and child agent replies', () => {
    const rootChatId = randomUUID()
    const childChatId = randomUUID()
    cleanupChats.push(rootChatId, childChatId)
    createChat(rootChatId)
    createChat(childChatId, { type: 'coder' }, rootChatId)
    const rootRuntime = { brain: 'root-brain', senseGroup: 'root-senses', mcpServers: ['root-mcp'] }
    const childRuntime = {
      brain: 'child-brain',
      senseGroup: 'child-senses',
      mcpServers: ['child-mcp'],
    }
    addMessage('root-user-runtime', rootChatId, {
      role: 'user',
      content: 'root prompt',
      runtime: rootRuntime,
    })
    addMessage('root-assistant-runtime', rootChatId, { role: 'assistant', content: 'root reply' })
    addMessage('child-user-runtime', childChatId, {
      role: 'user',
      content: 'child prompt',
      runtime: childRuntime,
    })
    addMessage('child-assistant-runtime', childChatId, {
      role: 'assistant',
      content: 'child reply',
    })
    addMessage('child-return-runtime', rootChatId, {
      role: 'role',
      content: '[角色 coder] child reply',
      link: {
        relation: 'child_return',
        sourceChatId: childChatId,
        parentChatId: rootChatId,
        relatedMessageId: 'child-assistant-runtime',
      },
    })

    const nodes = buildRootTimeline(rootChatId).nodes
    expect(nodes.find((node) => node.id === 'root-assistant-runtime')?.runtime).toEqual(rootRuntime)
    expect(nodes.find((node) => node.id === 'child-assistant-runtime')?.runtime).toEqual(
      childRuntime,
    )
    expect(nodes.find((node) => node.id === 'child-return-runtime')?.runtime).toEqual(childRuntime)
  })
})
