import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addPendingInput,
  createChat,
  deleteChat,
  getChat,
  listPendingInputs,
  updateChatMetadata,
} from '@/db/chat.js'
import { createSpawnTask, finishSpawnTask, getSpawnTaskByChild } from '@/db/delivery.js'
import {
  ensureActiveChatEpoch,
  freezeChatEpochSnapshot,
  getFrozenChatSnapshot,
  listChatEpochs,
} from '@/db/epoch.js'
import { applyRetiredRoles, archivePresetRoots } from '@/service/config/roleLifecycle.js'
import { getSoulDb } from '@/db/index.js'

const cleanup: string[] = []

afterEach(() => {
  for (const chatId of cleanup.splice(0).reverse()) deleteChat(chatId)
})

describe('role lifecycle across context epochs', () => {
  it('recursively abandons an unfinished retired-role subtree', () => {
    const root = randomUUID()
    const child = randomUUID()
    const grandchild = randomUUID()
    cleanup.push(root, child, grandchild)
    createChat(root, { presetId: 'preset-a' })
    const epoch = ensureActiveChatEpoch({ chatId: root, revisionId: 'revision-a' }).epoch
    createChat(child, { type: 'coder', roleId: 'role-coder' }, root)
    createChat(grandchild, { type: 'reviewer', roleId: 'role-reviewer' }, child)
    createSpawnTask({
      childChatId: child,
      parentChatId: root,
      type: 'coder',
      prompt: 'work',
      brain: 'brain',
      senseGroup: 'tools',
      roleId: 'role-coder',
      epochId: epoch.epochId,
    })
    addPendingInput({
      inputId: randomUUID(),
      chatId: child,
      messageId: randomUUID(),
      commandId: randomUUID(),
      content: 'queued work',
      queueSequence: 1,
      state: 'queued',
      acceptedAt: Date.now(),
    })
    freezeChatEpochSnapshot({
      epochId: epoch.epochId,
      chatId: child,
      roleId: 'role-coder',
      roleName: 'coder',
      systemPrompt: 'coder prompt',
      tools: [],
    })

    const result = applyRetiredRoles({
      roleIds: ['role-coder'],
      reason: 'role deleted',
    })

    expect(result.abandonedChatIds).toEqual(expect.arrayContaining([child, grandchild]))
    expect(getChat(child)?.lifecycle).toBe('abandoned')
    expect(getChat(grandchild)?.lifecycle).toBe('abandoned')
    expect(getSpawnTaskByChild(child)?.status).toBe('abandoned')
    expect(listPendingInputs(child)).toHaveLength(0)
    expect(getFrozenChatSnapshot(epoch.epochId, child)?.lifecycle).toBe('abandoned')
  })

  it('keeps a completed branch as retired read-only history', () => {
    const root = randomUUID()
    const child = randomUUID()
    const grandchild = randomUUID()
    cleanup.push(root, child, grandchild)
    createChat(root)
    ensureActiveChatEpoch({ chatId: root, revisionId: 'revision-a' })
    createChat(child, { type: 'coder', roleId: 'role-coder' }, root)
    createChat(grandchild, { type: 'reviewer', roleId: 'role-reviewer' }, child)
    const task = createSpawnTask({
      childChatId: child,
      parentChatId: root,
      type: 'coder',
      prompt: 'done',
      brain: 'brain',
      senseGroup: 'tools',
    })
    finishSpawnTask(task.taskId)
    updateChatMetadata(child, { finished: true })
    const nestedTask = createSpawnTask({
      childChatId: grandchild,
      parentChatId: child,
      type: 'reviewer',
      prompt: 'also done',
      brain: 'brain',
      senseGroup: 'tools',
    })
    finishSpawnTask(nestedTask.taskId)
    updateChatMetadata(grandchild, { finished: true })

    const result = applyRetiredRoles({ roleIds: ['role-coder'], reason: 'role deleted' })

    expect(result.retiredChatIds).toEqual([child, grandchild])
    expect(getChat(child)?.lifecycle).toBe('retired')
    expect(getChat(grandchild)?.lifecycle).toBe('retired')
    expect(getSpawnTaskByChild(child)?.status).toBe('finished')
  })

  it('archives a deleted preset root and leaves no executable epoch', () => {
    const root = randomUUID()
    const child = randomUUID()
    cleanup.push(root)
    createChat(root, { presetId: 'preset-deleted' })
    ensureActiveChatEpoch({ chatId: root, revisionId: 'revision-a' })
    createChat(child, { type: 'coder' }, root)
    createSpawnTask({
      childChatId: child,
      parentChatId: root,
      type: 'coder',
      prompt: 'pending',
      brain: 'brain',
      senseGroup: 'tools',
    })
    addPendingInput({
      inputId: randomUUID(),
      chatId: child,
      messageId: randomUUID(),
      commandId: randomUUID(),
      content: 'queued work',
      queueSequence: 1,
      state: 'queued',
      acceptedAt: Date.now(),
    })

    expect(archivePresetRoots(['preset-deleted'], 'preset deleted')).toEqual([root])
    expect(getChat(root)?.lifecycle).toBe('archived')
    expect(getChat(child)?.lifecycle).toBe('archived')
    expect(getSpawnTaskByChild(child)?.status).toBe('abandoned')
    expect(listPendingInputs(child)).toHaveLength(0)
    expect(listChatEpochs(root).every((epoch) => epoch.status === 'archived')).toBe(true)
    expect(
      (
        getSoulDb()
          .prepare('SELECT COUNT(*) AS count FROM pending_inputs WHERE chat_id = ? AND state != ?')
          .get(child, 'cancelled') as { count: number }
      ).count,
    ).toBe(0)
  })
})
