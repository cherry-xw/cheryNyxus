import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat } from '@/db/chat.js'
import { closeAllDbs, getSoulDb } from '@/db/index.js'
import { ensureConversationTask, insertConversationBranch } from '@/db/conversationBranch.js'
import { getTaskResultView } from '@/db/taskResultView.js'
import { upsertExecutionNode } from '@/db/executionGraph.js'
import { recordRunFact, recordTerminationFact } from '@/service/chat/executionFacts.js'
import { handleChatTaskList, handleChatTaskResultView } from '@/service/chat/taskCatalog.js'
import { buildTaskOverview, listTaskOverviews } from '@/service/chat/overview.js'

const cleanup: string[] = []
const ctx = {}
const preset = { preset: 'catalog-test', presetId: 'catalog-preset' }

afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

function task(content: string, identity = preset): string {
  const chatId = randomUUID()
  cleanup.push(chatId)
  createChat(chatId, identity)
  addMessage(randomUUID(), chatId, { role: 'user', content })
  return chatId
}

function finish(chatId: string, runId: string, content: string, updatedAt: number): void {
  recordRunFact({ chatId, runId, status: 'completed' })
  getSoulDb()
    .prepare('UPDATE execution_active_runs SET updated_at = ? WHERE chat_id = ? AND run_id = ?')
    .run(updatedAt, chatId, runId)
  upsertExecutionNode({
    id: `result-${runId}`,
    rootChatId: chatId,
    sourceChatId: chatId,
    kind: 'message',
    actor: { kind: 'agent', chatId },
    direction: 'self',
    visibility: 'conversation',
    content,
    runId,
    status: 'committed',
    createdAt: updatedAt,
    updatedAt,
  })
}

describe('chat.task.list', () => {
  it('searches the complete preset history instead of only a loaded page', async () => {
    for (let index = 0; index < 30; index += 1) task(`普通任务 ${index}`)
    const target = task('只有深页历史包含 精准针脚')

    const page = await handleChatTaskList(ctx, {
      presetId: preset.presetId,
      query: '精准针脚',
      limit: 5,
    })

    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({ taskKey: target, openChatId: target })
    expect(page.items[0]?.matches.some((match) => match.source === 'user_prompt')).toBe(true)
  })

  it('merges branches before filtering and pagination', async () => {
    const original = task('原任务')
    const continuation = task('续接分支中的唯一线索')
    const { task: conversationTask } = ensureConversationTask(original, {})
    insertConversationBranch(
      {
        branchId: randomUUID(),
        taskId: conversationTask.taskId,
        chatId: continuation,
        kind: 'continuation',
        runtimeSnapshot: {},
      },
      { activate: true },
    )

    const page = await handleChatTaskList(ctx, {
      presetId: preset.presetId,
      query: '唯一线索',
    })

    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({
      taskKey: original,
      originalChatId: original,
      openChatId: continuation,
      branchCount: 2,
    })
    expect(buildTaskOverview(continuation, 0)).toMatchObject({
      taskKey: original,
      rootChatId: original,
      openChatId: continuation,
      branchCount: 2,
    })
    expect(listTaskOverviews(0).filter((entry) => entry.taskKey === original)).toHaveLength(1)
  })

  it('keeps cursor membership and order stable when new tasks arrive', async () => {
    task('快照任务 A')
    task('快照任务 B')
    const first = await handleChatTaskList(ctx, { presetId: preset.presetId, limit: 1 })
    expect(first.total).toBe(2)
    expect(first.nextCursor).toBeTruthy()

    const late = task('快照之后的新任务')
    const second = await handleChatTaskList(ctx, { cursor: first.nextCursor!, limit: 10 })

    expect(second.total).toBe(2)
    expect(second.items.map((item) => item.taskKey)).not.toContain(late)
    expect(new Set([...first.items, ...second.items].map((item) => item.taskKey)).size).toBe(2)
  })

  it('returns UTF-16 offsets and isolates presets', async () => {
    const included = task('😀目标内容')
    task('😀目标内容', { preset: 'other', presetId: 'other-preset' })

    const page = await handleChatTaskList(ctx, {
      presetId: preset.presetId,
      query: '目标',
    })
    const match = page.items[0]?.matches.find(
      (candidate) => candidate.source === 'user_prompt' && candidate.text.includes('😀目标'),
    )

    expect(page.items.map((item) => item.taskKey)).toEqual([included])
    expect(match?.highlights[0]).toEqual({ start: 2, end: 4 })
  })

  it('keeps attention stable during ordinary progress and changes it at the terminal result', async () => {
    const chatId = task('关注键测试')
    recordRunFact({ chatId, runId: 'attention-run', status: 'running' })
    const running = await handleChatTaskList(ctx, { presetId: preset.presetId })

    upsertExecutionNode({
      id: 'attention-step',
      rootChatId: chatId,
      sourceChatId: chatId,
      kind: 'system',
      content: '普通步骤推进',
      createdAt: 1,
      updatedAt: 1,
    })
    const progressed = await handleChatTaskList(ctx, { presetId: preset.presetId })
    expect(progressed.items[0]?.attentionKey).toBe(running.items[0]?.attentionKey)

    recordRunFact({ chatId, runId: 'attention-run', status: 'completed' })
    const completed = await handleChatTaskList(ctx, { presetId: preset.presetId })
    expect(completed.items[0]?.attentionKey).not.toBe(running.items[0]?.attentionKey)
    expect(completed.items[0]?.latestResult?.resultId).toBeTruthy()
  })

  it('reads the final assistant content through the active run node id', async () => {
    const chatId = task('node id result lookup')
    const runId = 'node-id-run'
    const nodeId = 'node-id-result'
    recordRunFact({ chatId, runId, status: 'running', turnId: nodeId, nodeId })
    upsertExecutionNode({
      id: nodeId,
      rootChatId: chatId,
      sourceChatId: chatId,
      kind: 'message',
      actor: { kind: 'agent', chatId },
      direction: 'self',
      visibility: 'conversation',
      content: 'linked only by node id',
      status: 'committed',
      createdAt: 30_000,
      updatedAt: 30_000,
    })
    recordRunFact({ chatId, runId, status: 'completed' })

    const page = await handleChatTaskList(ctx, { presetId: preset.presetId })

    expect(page.items[0]?.latestResult).toMatchObject({
      status: 'completed',
      content: 'linked only by node id',
    })
  })
})

describe('chat.task.result.view', () => {
  it('persists viewed results and rejects a late confirmation for an older result', async () => {
    const chatId = task('执行并查看结果')
    finish(chatId, 'run-1', '第一版真实结果', 10_000)
    const before = await handleChatTaskList(ctx, { presetId: preset.presetId })
    const firstResult = before.items[0]?.latestResult
    expect(firstResult).toMatchObject({ status: 'completed', content: '第一版真实结果' })
    expect(before.items[0]?.unreadResult).toBe(true)

    const viewed = await handleChatTaskResultView(ctx, {
      taskKey: chatId,
      resultId: firstResult!.resultId,
    })
    expect(viewed.viewed).toBe(true)
    closeAllDbs()
    expect(getTaskResultView(chatId)?.resultId).toBe(firstResult!.resultId)

    finish(chatId, 'run-2', '第二版真实结果', 20_000)
    const late = await handleChatTaskResultView(ctx, {
      taskKey: chatId,
      resultId: firstResult!.resultId,
    })
    expect(late).toMatchObject({ viewed: false })
    expect(late.latestResultId).not.toBe(firstResult!.resultId)

    const after = await handleChatTaskList(ctx, { presetId: preset.presetId })
    expect(after.items[0]?.latestResult?.content).toBe('第二版真实结果')
    expect(after.items[0]?.unreadResult).toBe(true)
  })

  it('projects a user abort as a stopped result with a safe explanation', async () => {
    const chatId = task('停止任务')
    recordRunFact({ chatId, runId: 'stopped-run', status: 'running' })
    recordTerminationFact({
      chatId,
      runId: 'stopped-run',
      actor: 'user',
      code: 'user_abort',
    })

    const page = await handleChatTaskList(ctx, { presetId: preset.presetId })
    expect(page.items[0]).toMatchObject({
      status: 'stopped',
      latestResult: { status: 'stopped' },
      unreadResult: true,
    })
    expect(page.items[0]?.latestResult?.content).toContain('本轮运行已停止')
  })
})
