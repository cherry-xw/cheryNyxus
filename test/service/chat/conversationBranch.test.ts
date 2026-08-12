import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat, getChat, getChatMetadata } from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import {
  ensureConversationTask,
  getConversationBranchByChat,
  listConversationBranches,
} from '@/db/conversationBranch.js'
import { buildRootTimeline, handleChatTimelineGet } from '@/service/chat/handler.js'
import {
  handleChatAbortTask,
  handleChatBranchActivate,
  handleChatBranchCreate,
  handleChatBranchPreview,
} from '@/service/chat/conversationBranch.js'
import { createSpawnTask, getSpawnTask } from '@/db/delivery.js'
import type { HandlerContext } from '@/service/message/router.js'
import { clearChatRuntime } from '@/service/chat/runtime.js'
import { recordRunFact } from '@/service/chat/executionFacts.js'
import { registerBuiltinProviders } from '@/agent/provider/index.js'
import { reloadSenses } from '@/agent/sense/index.js'
import { resolveSpawnRoster } from '@/agent/sense/spawn.js'
import { getChatMentionableRoles } from '@/service/chat/roleMentions.js'

const chats: string[] = []
const tasks: string[] = []
const commandIds: string[] = []

afterEach(() => {
  const db = getSoulDb()
  for (const chatId of chats) clearChatRuntime(chatId)
  for (const commandId of commandIds.splice(0)) {
    db.prepare('DELETE FROM request_journal WHERE request_id = ? OR request_id LIKE ?').run(commandId, `${commandId}:%`)
  }
  for (const taskId of tasks.splice(0)) {
    db.prepare('DELETE FROM conversation_branches WHERE task_id = ?').run(taskId)
    db.prepare('DELETE FROM conversation_tasks WHERE task_id = ?').run(taskId)
  }
  for (const chatId of chats.splice(0).reverse()) if (getChat(chatId)) deleteChat(chatId)
})

describe('conversation branches', () => {
  it('lazily assigns one stable original branch without using parent_chat_id', () => {
    const rootChatId = randomUUID()
    chats.push(rootChatId)
    createChat(rootChatId, { runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] } })

    const first = ensureConversationTask(rootChatId, { runtime: 'snapshot' })
    const second = ensureConversationTask(rootChatId, { runtime: 'ignored' })
    tasks.push(first.task.taskId)

    expect(second).toEqual(first)
    expect(first.branch).toMatchObject({ chatId: rootChatId, kind: 'original' })
    expect(getChat(rootChatId)?.parent_chat_id).toBeNull()
    expect(getConversationBranchByChat(rootChatId)?.taskId).toBe(first.task.taskId)
  })

  it('previews completed tool effects after an eligible anchor', async () => {
    const rootChatId = randomUUID()
    chats.push(rootChatId)
    createChat(rootChatId, { runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] } })
    addMessage('anchor-user', rootChatId, { role: 'user', content: '先做什么？' })
    addMessage('tool-owner', rootChatId, {
      role: 'assistant',
      content: '执行修改',
      senseCall: [{ id: 'write-call', name: 'write_file', arguments: '{"path":"a.ts"}' }],
    })
    addMessage('write-call', rootChatId, { role: 'sense', content: 'written' })

    const preview = await handleChatBranchPreview(
      { connectionId: 'branch-test' } as HandlerContext,
      { rootChatId, anchorNodeId: 'anchor-user' },
    )
    tasks.push(preview.taskId)

    expect(preview.eligible).toBe(true)
    expect(preview.sideEffects).toEqual([
      expect.objectContaining({ callId: 'write-call', toolName: 'write_file', result: 'written' }),
    ])
    expect(preview.effectDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('combines branches with explicit fork identities and preserves canonical roots', async () => {
    const rootChatId = randomUUID()
    const branchChatId = randomUUID()
    chats.push(rootChatId, branchChatId)
    createChat(rootChatId, { runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] } })
    createChat(branchChatId, { runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] } })
    addMessage('source-user', rootChatId, { role: 'user', content: '原问题' })
    addMessage('branch-user', branchChatId, { role: 'user', content: '新问题' })
    const original = ensureConversationTask(rootChatId, { runtime: 'original' })
    tasks.push(original.task.taskId)
    const now = Date.now()
    getSoulDb().prepare(
      `INSERT INTO conversation_branches
       (branch_id, task_id, chat_id, kind, source_branch_id, anchor_root_chat_id, anchor_node_id,
        runtime_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, 'continuation', ?, ?, ?, '{}', ?, ?)`,
    ).run('branch-continuation', original.task.taskId, branchChatId, original.branch.branchId, rootChatId, 'source-user', now, now)

    const response = await handleChatTimelineGet(
      { connectionId: 'branch-test' } as HandlerContext,
      { taskId: original.task.taskId, view: 'tree' },
    )
    const timeline = response.rootTimeline!

    expect(listConversationBranches(original.task.taskId)).toHaveLength(2)
    expect(timeline.nodes.find((node) => node.id === 'source-user')).toMatchObject({
      branchId: original.branch.branchId,
      forkAnchor: true,
    })
    expect(timeline.nodes.find((node) => node.id === 'branch-user')).toMatchObject({
      branchId: 'branch-continuation',
      forkAnchor: true,
    })
    expect(timeline.edges).toContainEqual(
      expect.objectContaining({
        kind: 'fork-continuation',
        fromNodeId: 'source-user',
        toNodeId: 'branch-user',
      }),
    )
    const orderKeys = [
      ...timeline.nodes.map((node) => node.orderKey),
      ...timeline.edges.map((edge) => edge.orderKey),
    ]
    expect(new Set(orderKeys)).toHaveLength(orderKeys.length)
    expect(buildRootTimeline(branchChatId, 'tree').edges.some((edge) => edge.kind === 'fork-continuation')).toBe(false)
  })

  it('switches the unique active mainline and reroutes unfinished inherited delivery', async () => {
    const rootChatId = randomUUID()
    const branchChatId = randomUUID()
    const childChatId = randomUUID()
    const commandId = randomUUID()
    chats.push(rootChatId, branchChatId, childChatId)
    commandIds.push(commandId)
    createChat(rootChatId)
    createChat(branchChatId)
    createChat(childChatId, {}, rootChatId)
    const original = ensureConversationTask(rootChatId, {})
    tasks.push(original.task.taskId)
    const now = Date.now()
    getSoulDb().prepare(
      `INSERT INTO conversation_branches
       (branch_id, task_id, chat_id, kind, source_branch_id, context_snapshot_json,
        runtime_snapshot_json, created_at, updated_at)
       VALUES ('switch-target', ?, ?, 'continuation', ?, '[]', ?, ?, ?)`,
    ).run(
      original.task.taskId,
      branchChatId,
      original.branch.branchId,
      JSON.stringify({ inheritedTaskIds: ['open-spawn'] }),
      now,
      now,
    )
    createSpawnTask({
      taskId: 'open-spawn',
      childChatId,
      parentChatId: rootChatId,
      type: 'reviewer',
      prompt: 'review',
      brain: 'mock_content',
      senseGroup: 'auto_senses',
    })

    const response = await handleChatBranchActivate(
      { connectionId: 'branch-test' } as HandlerContext,
      { branchId: 'switch-target', commandId },
    )

    expect(response).toMatchObject({
      taskId: original.task.taskId,
      activeBranchId: 'switch-target',
      activeChatId: branchChatId,
      deliveryGeneration: 1,
    })
    expect(getSpawnTask('open-spawn')).toMatchObject({
      parentChatId: rootChatId,
      deliveryChatId: branchChatId,
      deliveryBranchId: 'switch-target',
      deliveryGeneration: 1,
    })
    const timeline = await handleChatTimelineGet(
      { connectionId: 'branch-test' } as HandlerContext,
      { taskId: original.task.taskId, view: 'tree' },
    )
    expect(timeline.rootTimeline?.activeBranchId).toBe('switch-target')
  })

  it('creates an isolated detail branch and replays an identical command idempotently', async () => {
    registerBuiltinProviders()
    await reloadSenses()
    const rootChatId = randomUUID()
    const commandId = randomUUID()
    chats.push(rootChatId)
    commandIds.push(commandId)
    createChat(rootChatId, {
      preset: 'detail-test',
      runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] },
    })
    addMessage('detail-anchor', rootChatId, { role: 'assistant', content: '术语 A' })
    const request = {
      rootChatId,
      anchorNodeId: 'detail-anchor',
      branchType: 'detail' as const,
      prompt: '解释术语 A',
      commandId,
      clientMessageId: randomUUID(),
      messageId: randomUUID(),
    }

    const first = await handleChatBranchCreate({ connectionId: 'branch-test' } as HandlerContext, request)
    chats.push(first.chatId)
    tasks.push(first.taskId)
    const second = await handleChatBranchCreate({ connectionId: 'branch-test' } as HandlerContext, request)

    expect(second).toEqual(first)
    expect(listConversationBranches(first.taskId)).toHaveLength(2)
    expect(getChatMetadata(first.chatId)).toMatchObject({
      branchKind: 'detail',
      runtime: { brain: 'mock_content', senseGroup: 'detail_diagnostics', mcpServers: [] },
    })
    expect(String(getChatMetadata(first.chatId).branchContext)).toContain('独立的细节解释分支')

    const another = await handleChatBranchCreate(
      { connectionId: 'branch-test' } as HandlerContext,
      {
        ...request,
        commandId: randomUUID(),
        clientMessageId: randomUUID(),
        messageId: randomUUID(),
        prompt: '再解释一次术语 A',
      },
    )
    chats.push(another.chatId)
    expect(another.chatId).not.toBe(first.chatId)
    expect(listConversationBranches(first.taskId).filter((branch) => branch.kind === 'detail')).toHaveLength(2)

    const timeline = await handleChatTimelineGet(
      { connectionId: 'branch-test' } as HandlerContext,
      { taskId: first.taskId, view: 'conversation' },
    )
    expect(timeline.rootTimeline?.branches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: first.chatId, title: '解释术语 A' }),
        expect.objectContaining({ chatId: another.chatId, title: '再解释一次术语 A' }),
      ]),
    )
  })

  it('keeps the reserved detail member out of spawn and @role rosters', () => {
    const rootChatId = randomUUID()
    chats.push(rootChatId)
    createChat(rootChatId, {
      preset: 'detail-test',
      spawnTypes: ['reviewer', 'explanation'],
      runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] },
    })

    expect(resolveSpawnRoster(rootChatId)).not.toContain('explanation')
    expect(getChatMentionableRoles(rootChatId).map((role) => role.name)).not.toContain('explanation')
  })

  it('rejects a detail branch when the source conversation has no configured preset', async () => {
    const rootChatId = randomUUID()
    const commandId = randomUUID()
    chats.push(rootChatId)
    commandIds.push(commandId)
    createChat(rootChatId, { runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] } })
    addMessage('detail-without-role', rootChatId, { role: 'assistant', content: '术语 B' })

    await expect(handleChatBranchCreate(
      { connectionId: 'branch-test' } as HandlerContext,
      {
        rootChatId,
        anchorNodeId: 'detail-without-role',
        branchType: 'detail',
        prompt: '解释术语 B',
        commandId,
        clientMessageId: randomUUID(),
        messageId: randomUUID(),
      },
    )).rejects.toThrow('来源会话未绑定预设')
  })

  it('rejects stale continuation confirmation and releases the command for retry', async () => {
    const rootChatId = randomUUID()
    const commandId = randomUUID()
    chats.push(rootChatId)
    commandIds.push(commandId)
    createChat(rootChatId, { runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] } })
    addMessage('continue-anchor', rootChatId, { role: 'user', content: '原始问题' })
    const request = {
      rootChatId,
      anchorNodeId: 'continue-anchor',
      branchType: 'continuation' as const,
      prompt: '换个方向继续',
      commandId,
      clientMessageId: randomUUID(),
      messageId: randomUUID(),
      effectDigest: 'stale',
    }

    await expect(handleChatBranchCreate({ connectionId: 'branch-test' } as HandlerContext, request))
      .rejects.toThrow('副作用已变化')
    await expect(handleChatBranchCreate({ connectionId: 'branch-test' } as HandlerContext, request))
      .rejects.toThrow('副作用已变化')
    expect(getSoulDb().prepare('SELECT 1 FROM request_journal WHERE request_id = ?').get(commandId)).toBeUndefined()
  })

  it('requires the whole task to be idle before creating a continuation', async () => {
    const rootChatId = randomUUID()
    const commandId = randomUUID()
    chats.push(rootChatId)
    commandIds.push(commandId)
    createChat(rootChatId, { runtime: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] } })
    addMessage('running-anchor', rootChatId, { role: 'user', content: '原始问题' })
    const preview = await handleChatBranchPreview(
      { connectionId: 'branch-test' } as HandlerContext,
      { rootChatId, anchorNodeId: 'running-anchor' },
    )
    tasks.push(preview.taskId)
    recordRunFact({ chatId: rootChatId, runId: 'still-running', status: 'running' })

    await expect(handleChatBranchCreate(
      { connectionId: 'branch-test' } as HandlerContext,
      {
        rootChatId,
        anchorNodeId: 'running-anchor',
        branchType: 'continuation',
        prompt: '继续',
        commandId,
        clientMessageId: randomUUID(),
        messageId: randomUUID(),
        effectDigest: preview.effectDigest,
      },
    )).rejects.toThrow('任务仍在运行')
  })

  it('pauses every branch once and replays the task command idempotently', async () => {
    const rootChatId = randomUUID()
    const branchChatId = randomUUID()
    const commandId = randomUUID()
    chats.push(rootChatId, branchChatId)
    commandIds.push(commandId)
    createChat(rootChatId)
    createChat(branchChatId)
    const original = ensureConversationTask(rootChatId, {})
    tasks.push(original.task.taskId)
    const now = Date.now()
    getSoulDb().prepare(
      `INSERT INTO conversation_branches
       (branch_id, task_id, chat_id, kind, source_branch_id, runtime_snapshot_json, created_at, updated_at)
       VALUES ('abort-branch', ?, ?, 'detail', ?, '{}', ?, ?)`,
    ).run(original.task.taskId, branchChatId, original.branch.branchId, now, now)

    const request = { taskId: original.task.taskId, commandId }
    const first = await handleChatAbortTask({ connectionId: 'branch-test' } as HandlerContext, request)
    const second = await handleChatAbortTask({ connectionId: 'branch-test' } as HandlerContext, request)

    expect(second).toEqual(first)
    expect(first.abortedBranches).toEqual(expect.arrayContaining([original.branch.branchId, 'abort-branch']))
  })
})
