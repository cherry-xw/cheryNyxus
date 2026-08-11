import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, addPendingInput, createChat, deleteChat } from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import {
  addTreePauseTarget,
  createTreePause,
  getTreeControlOperation,
  updateTreeControlOperation,
} from '@/db/treeControl.js'
import { buildRootTimeline } from '@/service/chat/handler.js'
import { recordRunFact } from '@/service/chat/executionFacts.js'
import { handleChatAbort } from '@/service/chat/send.js'
import { handleChatResumeTree } from '@/service/chat/treeControl.js'
import {
  activateChatRun,
  clearChatRuntime,
  ensureChat,
} from '@/service/chat/runtime.js'
import type { HandlerContext } from '@/service/message/router.js'
import { registerBuiltinProviders } from '@/agent/provider/index.js'
import { reloadSenses } from '@/agent/sense/index.js'

const cleanup: string[] = []
const pauseIds: string[] = []
const commandIds: string[] = []

afterEach(() => {
  for (const chatId of cleanup) clearChatRuntime(chatId)
  const db = getSoulDb()
  for (const pauseId of pauseIds.splice(0)) {
    db.prepare('DELETE FROM tree_control_targets WHERE pause_id = ?').run(pauseId)
    db.prepare('DELETE FROM tree_control_operations WHERE pause_id = ?').run(pauseId)
  }
  for (const commandId of commandIds.splice(0)) {
    db.prepare('DELETE FROM request_journal WHERE request_id = ?').run(commandId)
  }
  for (const chatId of cleanup.splice(0).reverse()) deleteChat(chatId)
})

describe('tree control persistence', () => {
  it('records only runs actually stopped by one root pause', async () => {
    registerBuiltinProviders()
    await reloadSenses()
    const rootChatId = randomUUID()
    const childChatId = randomUUID()
    const idleChildChatId = randomUUID()
    const pauseId = randomUUID()
    cleanup.push(rootChatId, childChatId, idleChildChatId)
    pauseIds.push(pauseId)
    commandIds.push(pauseId)
    createChat(rootChatId)
    createChat(childChatId, { type: 'coder' }, rootChatId)
    createChat(idleChildChatId, { type: 'reviewer' }, rootChatId)

    const selection = { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] }
    await ensureChat(rootChatId, selection)
    await ensureChat(childChatId, selection)
    activateChatRun(rootChatId, 'run-root')
    activateChatRun(childChatId, 'run-child')
    recordRunFact({ chatId: rootChatId, runId: 'run-root', status: 'running' })
    recordRunFact({ chatId: childChatId, runId: 'run-child', status: 'running' })

    const response = await handleChatAbort(
      { requestId: pauseId, connectionId: 'tree-control-test' } as HandlerContext,
      { chatId: rootChatId, commandId: pauseId },
    )
    expect('success' in response).toBe(false)
    const operation = getTreeControlOperation(pauseId)
    expect(operation?.status).toBe('paused')
    expect(operation?.targets.map((target) => [target.chatId, target.pausedRunId])).toEqual(
      expect.arrayContaining([
        [rootChatId, 'run-root'],
        [childChatId, 'run-child'],
      ]),
    )
    expect(operation?.targets.some((target) => target.chatId === idleChildChatId)).toBe(false)
    expect(buildRootTimeline(rootChatId, 'tree').controlState?.pauseId).toBe(pauseId)
  })

  it('projects an interruption notice as a system node instead of user input', () => {
    const rootChatId = randomUUID()
    cleanup.push(rootChatId)
    createChat(rootChatId)
    addMessage('user-instruction', rootChatId, { role: 'user', content: '改变需求' })
    addMessage('tree-notice', rootChatId, {
      role: 'role',
      content: '[任务树状态] 仍有 1 个子任务中断',
      link: { relation: 'system' },
    })

    const nodes = buildRootTimeline(rootChatId, 'tree').nodes
    expect(nodes.find((node) => node.id === 'tree-notice')).toMatchObject({
      kind: 'system',
      actor: { kind: 'system' },
      direction: 'internal',
    })
    expect(nodes.find((node) => node.id === 'user-instruction')?.kind).toBe('message')
  })

  it('recreates a missing interruption notice when restoring an acknowledged root input', async () => {
    registerBuiltinProviders()
    await reloadSenses()
    const rootChatId = randomUUID()
    const childChatId = randomUUID()
    const pauseId = randomUUID()
    const commandId = randomUUID()
    const userMessageId = randomUUID()
    cleanup.push(rootChatId, childChatId)
    pauseIds.push(pauseId)
    createChat(rootChatId)
    createChat(childChatId, { type: 'coder' }, rootChatId)
    createTreePause(pauseId, rootChatId)
    addTreePauseTarget(pauseId, childChatId, 'paused-child-run')
    updateTreeControlOperation(pauseId, 'paused')

    // Crash-window shape: user message committed, its paired system notice did
    // not. The accepted input row remains until the consumed effect is handled.
    addMessage(userMessageId, rootChatId, { role: 'user', content: '修改任务' })
    addPendingInput({
      inputId: randomUUID(),
      chatId: rootChatId,
      messageId: userMessageId,
      commandId,
      content: '修改任务',
      queueSequence: 1,
      state: 'started',
      acceptedAt: Date.now(),
    })

    const builder = await ensureChat(rootChatId, {
      brain: 'mock_content',
      senseGroup: 'auto_senses',
      mcpServers: [],
    })
    expect(builder.getPendingInputs()).toEqual([
      expect.objectContaining({
        messageId: `tree-interruption:${pauseId}:${commandId}`,
        role: 'role',
        linkRelation: 'system',
      }),
    ])
  })

  it('skips a paused run that has been replaced by a newer run', async () => {
    const rootChatId = randomUUID()
    const pauseId = randomUUID()
    const commandId = randomUUID()
    cleanup.push(rootChatId)
    pauseIds.push(pauseId)
    commandIds.push(commandId)
    createChat(rootChatId)
    createTreePause(pauseId, rootChatId)
    addTreePauseTarget(pauseId, rootChatId, 'old-run')
    updateTreeControlOperation(pauseId, 'paused')
    recordRunFact({ chatId: rootChatId, runId: 'old-run', status: 'paused' })
    recordRunFact({ chatId: rootChatId, runId: 'new-run', status: 'running' })
    const db = getSoulDb()
    db.prepare('UPDATE execution_active_runs SET updated_at = 1 WHERE run_id = ?').run('old-run')
    db.prepare('UPDATE execution_active_runs SET updated_at = 2 WHERE run_id = ?').run('new-run')

    const response = await handleChatResumeTree(
      { requestId: commandId, connectionId: 'tree-control-test' } as HandlerContext,
      { rootChatId, pauseId, commandId },
    )
    expect(response.status).toBe('completed')
    expect(response.results).toContainEqual(
      expect.objectContaining({
        chatId: rootChatId,
        status: 'skipped',
        detail: '原暂停运行已被新状态取代',
      }),
    )
  })

  it('keeps failed resume targets retryable with a new command id', async () => {
    const rootChatId = randomUUID()
    const pauseId = randomUUID()
    const firstCommandId = randomUUID()
    const retryCommandId = randomUUID()
    cleanup.push(rootChatId)
    pauseIds.push(pauseId)
    commandIds.push(firstCommandId, retryCommandId)
    createChat(rootChatId)
    createTreePause(pauseId, rootChatId)
    addTreePauseTarget(pauseId, rootChatId, 'paused-run')
    updateTreeControlOperation(pauseId, 'paused')
    recordRunFact({ chatId: rootChatId, runId: 'paused-run', status: 'paused' })

    const first = await handleChatResumeTree(
      { requestId: firstCommandId, connectionId: 'tree-control-test' } as HandlerContext,
      { rootChatId, pauseId, commandId: firstCommandId },
    )
    expect(first.status).toBe('partial')
    expect(first.results[0]).toMatchObject({ status: 'failed', detail: '目标当前不可续接' })

    const retry = await handleChatResumeTree(
      { requestId: retryCommandId, connectionId: 'tree-control-test' } as HandlerContext,
      { rootChatId, pauseId, commandId: retryCommandId },
    )
    expect(retry.status).toBe('partial')
    expect(retry.results[0]).toMatchObject({ status: 'failed', detail: '目标当前不可续接' })
  })

  it('rejects a pause id that a newer tree pause superseded', async () => {
    const rootChatId = randomUUID()
    const oldPauseId = randomUUID()
    const newPauseId = randomUUID()
    const commandId = randomUUID()
    cleanup.push(rootChatId)
    pauseIds.push(oldPauseId, newPauseId)
    createChat(rootChatId)
    createTreePause(oldPauseId, rootChatId)
    addTreePauseTarget(oldPauseId, rootChatId, 'old-run')
    updateTreeControlOperation(oldPauseId, 'paused')
    createTreePause(newPauseId, rootChatId)
    updateTreeControlOperation(newPauseId, 'paused')

    await expect(
      handleChatResumeTree(
        { requestId: commandId, connectionId: 'tree-control-test' } as HandlerContext,
        { rootChatId, pauseId: oldPauseId, commandId },
      ),
    ).rejects.toThrow('暂停操作已被新的暂停取代')
    expect(
      getSoulDb().prepare('SELECT 1 FROM request_journal WHERE request_id = ?').get(commandId),
    ).toBeUndefined()
  })
})
