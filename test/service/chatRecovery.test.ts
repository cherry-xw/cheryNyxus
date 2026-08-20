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
import {
  createSpawnTask,
  finishSpawnTask,
  listSpawnTasksNeedingWakeRecovery,
} from '@/db/delivery.js'
import { buildRootTimeline, handleChatList } from '@/service/chat/handler.js'
import { getExecutionActiveRun } from '@/db/executionGraph.js'
import { computeCanResume } from '@/service/chat/canResume.js'
import { recordRunFact } from '@/service/chat/executionFacts.js'
import { reconcileOrphanedExecutionRuns } from '@/service/chat/runRecovery.js'
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
    const response = await handleChatList({} as HandlerContext, { scope: 'history' })
    expect(response.chats.find((chat) => chat.chatId === childChatId)?.finished).toBe(true)
  })

  it('loads only spawn tasks that still need startup wake recovery', () => {
    const parentChatId = randomUUID()
    const pendingChildId = randomUUID()
    const finishedChildId = randomUUID()
    const injectedChildId = randomUUID()
    cleanupChats.push(parentChatId, pendingChildId, finishedChildId, injectedChildId)
    createChat(parentChatId)
    createChat(pendingChildId, { wake: 'immediate' }, parentChatId)
    createChat(finishedChildId, { wake: 'immediate', finished: true }, parentChatId)
    createChat(
      injectedChildId,
      { wake: 'immediate', finished: true, roleInjected: true },
      parentChatId,
    )

    const pending = createSpawnTask({
      childChatId: pendingChildId,
      parentChatId,
      type: 'coder',
      prompt: 'pending',
      brain: 'mock',
      senseGroup: 'default',
      wait: true,
    })
    const finished = createSpawnTask({
      childChatId: finishedChildId,
      parentChatId,
      type: 'coder',
      prompt: 'finished but not injected',
      brain: 'mock',
      senseGroup: 'default',
      wait: true,
    })
    const injected = createSpawnTask({
      childChatId: injectedChildId,
      parentChatId,
      type: 'coder',
      prompt: 'already injected',
      brain: 'mock',
      senseGroup: 'default',
      wait: true,
    })
    cleanupTasks.push(pending.taskId, finished.taskId, injected.taskId)
    finishSpawnTask(finished.taskId)
    finishSpawnTask(injected.taskId)

    const matchingTaskIds = listSpawnTasksNeedingWakeRecovery()
      .filter((task) => task.parentChatId === parentChatId)
      .map((task) => task.taskId)

    expect(matchingTaskIds).toHaveLength(2)
    expect(matchingTaskIds).toEqual(expect.arrayContaining([pending.taskId, finished.taskId]))
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

  it('parks an orphaned durable run as paused and recoverable after restart', () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId)
    addMessage('unfinished-role-return', chatId, { role: 'role', content: '[角色 coder] done' })
    recordRunFact({
      chatId,
      runId: 'orphaned-run',
      status: 'running',
      turnId: 'unfinished-turn',
    })
    const run = getExecutionActiveRun(chatId, 'orphaned-run')!

    expect(reconcileOrphanedExecutionRuns({ runs: [run], isLive: () => false })).toEqual([
      expect.objectContaining({ chatId, runId: 'orphaned-run', status: 'paused' }),
    ])
    expect(getExecutionActiveRun(chatId, 'orphaned-run')?.status).toBe('paused')
    expect(buildRootTimeline(chatId).activeRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId, runId: 'orphaned-run', status: 'paused' }),
      ]),
    )
    expect(computeCanResume(chatId)).toBe(true)
  })

  it('leaves a durable run running while its in-memory runtime is still live', () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId)
    recordRunFact({ chatId, runId: 'live-run', status: 'waiting' })
    const run = getExecutionActiveRun(chatId, 'live-run')!

    expect(reconcileOrphanedExecutionRuns({ runs: [run], isLive: () => true })).toEqual([])
    expect(getExecutionActiveRun(chatId, 'live-run')?.status).toBe('waiting')
  })
})
