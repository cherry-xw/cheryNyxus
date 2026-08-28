import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat, getChat } from '@/db/chat.js'
import {
  createSpawnTask,
  finishSpawnTask,
  getSpawnTask,
  listOpenSpawnTasks,
} from '@/db/delivery.js'
import { ensureActiveChatEpoch, rotateActiveChatEpoch } from '@/db/epoch.js'
import { handleChatStartSpawn } from '@/service/chat/handler.js'
import type { HandlerContext } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'

const cleanup: string[] = []

afterEach(() => {
  for (const chatId of cleanup.splice(0).reverse()) deleteChat(chatId)
})

describe('spawn task epoch ownership', () => {
  it('rejects a direct replay from an old epoch before claiming and abandons the subtree', async () => {
    const root = randomUUID()
    const child = randomUUID()
    cleanup.push(root, child)
    createChat(root)
    const oldEpoch = ensureActiveChatEpoch({ chatId: root, revisionId: 'revision-a' }).epoch
    createChat(child, { type: 'reviewer', roleId: 'role-reviewer' }, root)
    const task = createSpawnTask({
      childChatId: child,
      parentChatId: root,
      type: 'reviewer',
      prompt: 'old task',
      brain: 'brain',
      senseGroup: 'tools',
      epochId: oldEpoch.epochId,
      roleId: 'role-reviewer',
    })
    rotateActiveChatEpoch({
      chatId: root,
      transitionReason: 'test-change',
      handoffSummary: 'old task must not cross this boundary',
    })

    const generator = handleChatStartSpawn(
      { log: logger, requestId: randomUUID() } as HandlerContext,
      { taskId: task.taskId },
    )
    const result = await generator.next()

    expect(result.done).toBe(true)
    expect(getSpawnTask(task.taskId)?.status).toBe('abandoned')
    expect(getChat(child)?.lifecycle).toBe('abandoned')
  })

  it('keeps a terminal historical task unchanged when its event is replayed', async () => {
    const root = randomUUID()
    const child = randomUUID()
    cleanup.push(root, child)
    createChat(root)
    const oldEpoch = ensureActiveChatEpoch({ chatId: root, revisionId: 'revision-a' }).epoch
    createChat(child, { type: 'reviewer', roleId: 'role-reviewer' }, root)
    const task = createSpawnTask({
      childChatId: child,
      parentChatId: root,
      type: 'reviewer',
      prompt: 'completed task',
      brain: 'brain',
      senseGroup: 'tools',
      epochId: oldEpoch.epochId,
      roleId: 'role-reviewer',
    })
    finishSpawnTask(task.taskId)
    rotateActiveChatEpoch({
      chatId: root,
      transitionReason: 'test-change',
      handoffSummary: 'completed history remains immutable',
    })

    const generator = handleChatStartSpawn(
      { log: logger, requestId: randomUUID() } as HandlerContext,
      { taskId: task.taskId },
    )
    const result = await generator.next()

    expect(result.done).toBe(true)
    expect(getSpawnTask(task.taskId)?.status).toBe('finished')
    expect(getChat(child)?.lifecycle).toBe('active')
  })

  it('lists only active tasks owned by the current epoch', () => {
    const root = randomUUID()
    const oldChild = randomUUID()
    const currentChild = randomUUID()
    cleanup.push(root, oldChild, currentChild)
    createChat(root)
    const oldEpoch = ensureActiveChatEpoch({ chatId: root, revisionId: 'revision-a' }).epoch
    createChat(oldChild, { type: 'reviewer', roleId: 'role-reviewer' }, root)
    createSpawnTask({
      childChatId: oldChild,
      parentChatId: root,
      type: 'reviewer',
      prompt: 'old task',
      brain: 'brain',
      senseGroup: 'tools',
      epochId: oldEpoch.epochId,
      roleId: 'role-reviewer',
    })
    const currentEpoch = rotateActiveChatEpoch({
      chatId: root,
      transitionReason: 'test-change',
      handoffSummary: 'only new tasks may be recovered',
    })
    createChat(currentChild, { type: 'reviewer', roleId: 'role-reviewer-v2' }, root)
    const currentTask = createSpawnTask({
      childChatId: currentChild,
      parentChatId: root,
      type: 'reviewer',
      prompt: 'current task',
      brain: 'brain-v2',
      senseGroup: 'tools-v2',
      epochId: currentEpoch.epochId,
      roleId: 'role-reviewer-v2',
    })

    expect(listOpenSpawnTasks(root).map((task) => task.taskId)).toEqual([currentTask.taskId])
  })
})
