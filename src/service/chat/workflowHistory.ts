import { z } from 'zod'
import type {
  WorkflowFact,
  WorkflowHistoryRequest,
  WorkflowHistoryResponse,
  WorkflowSnapshot,
} from '@chery/protocol'
import { getChat, getMessages, getMessageLinksForRoot } from '@/db/chat.js'
import { createHash } from 'node:crypto'
import { listExecutionNodes } from '@/db/executionGraph.js'
import { getActiveChatEpoch, getFrozenChatSnapshot, listChatEpochs } from '@/db/epoch.js'
import { effectiveSkillCount, workflowCallStatus } from './workflowEvidence.js'

export function requireWorkflowRoot(chatId: string) {
  const chat = getChat(chatId)
  if (!chat) throw Object.assign(new Error('这个会话不见了'), { code: 'NOT_FOUND' })
  if (chat.parent_chat_id)
    throw Object.assign(new Error('运行流程仅支持主 Agent 会话'), { code: 'INVALID_PARAMS' })
  return chat
}

export function workflowResources(chatId: string, epochId?: string): WorkflowSnapshot['resources'] {
  const epoch =
    epochId ?? getActiveChatEpoch(chatId)?.epochId ?? listChatEpochs(chatId).at(-1)?.epochId
  const frozen = epoch ? getFrozenChatSnapshot(epoch, chatId) : undefined
  const summary = z
    .object({
      memoryCount: z.number().int().nonnegative(),
      skillCount: z.number().int().nonnegative(),
    })
    .safeParse(frozen?.resources.workflow)
  return { ...(summary.success ? summary.data : {}), loadedSkillsComplete: false }
}

export function workflowStageId(chatId: string, summaryId?: string): string {
  return `${chatId}:${summaryId ?? 'start'}`
}

const cursorSchema = z
  .object({
    chatId: z.string(),
    stage: z.string(),
    boundary: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
    fingerprint: z.string(),
  })
  .strict()

/** Pure read: never calls the canonical timeline repair path or ensureChat. */
export function readWorkflowHistory(request: WorkflowHistoryRequest): WorkflowHistoryResponse {
  requireWorkflowRoot(request.chatId)
  let cursor: z.infer<typeof cursorSchema> | undefined
  if (request.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')),
      )
    } catch {
      throw Object.assign(new Error('历史游标无效，请重新加载回放'), { code: 'INVALID_PARAMS' })
    }
    if (
      cursor.chatId !== request.chatId ||
      (request.contextStageId && request.contextStageId !== cursor.stage)
    )
      throw Object.assign(new Error('历史游标不属于当前会话或阶段'), { code: 'INVALID_PARAMS' })
  }
  const chatId = request.chatId
  const boundary = cursor?.boundary ?? Date.now()
  const rows = getMessages(chatId).filter((row) => row.created_at <= boundary)
  const nodes = listExecutionNodes(chatId).filter(
    (node) =>
      node.createdAt <= boundary &&
      (node.sourceChatId === chatId ||
        (node.kind === 'dispatch' &&
          (node.actor as { chatId?: string } | undefined)?.chatId === chatId)),
  )
  const persistedLinks = getMessageLinksForRoot(chatId).filter((link) =>
    rows.some((row) => row.id === link.messageId),
  )
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([rows, nodes, persistedLinks]))
    .digest('hex')
  if (cursor && cursor.fingerprint !== fingerprint)
    throw Object.assign(new Error('历史在加载期间发生变化，请重新加载回放'), { code: 'CONFLICT' })
  const byMessage = new Map(
    nodes
      .filter((node) => node.kind !== 'tool-batch' && node.sourceMessageId)
      .map((node) => [node.sourceMessageId!, node]),
  )
  const links = new Map(persistedLinks.map((link) => [link.messageId, link]))
  const results = new Map(rows.map((row) => [row.id, row]))
  const stages: WorkflowHistoryResponse['stages'] = [
    { id: workflowStageId(chatId), label: '初始上下文', quality: 'exact' },
  ]
  const factsByStage = new Map<string, WorkflowFact[]>([[stages[0]!.id, []]])
  const rowsByStage = new Map<string, typeof rows>([[stages[0]!.id, []]])
  let stage = stages[0]!.id
  let order = 0
  let historyComplete = true
  const append = (fact: Omit<WorkflowFact, 'orderKey'>) =>
    factsByStage.get(stage)!.push({ ...fact, orderKey: ++order })
  const extraNodes = nodes
    .filter(
      (node) =>
        !node.sourceMessageId &&
        ((node.sourceChatId === chatId && node.termination) ||
          (node.kind === 'dispatch' &&
            (node.actor as { chatId?: string } | undefined)?.chatId === chatId)),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  function appendInternal(until: number) {
    while (extraNodes.length && extraNodes[0]!.createdAt <= until) {
      const node = extraNodes.shift()!
      const runId = typeof node.runId === 'string' ? node.runId : undefined
      if (node.kind === 'dispatch') {
        const target = typeof node.targetChatId === 'string' ? node.targetChatId : undefined
        if (target)
          append({
            id: node.id,
            nodeId: 'tools',
            label: '子任务已派发',
            status: 'completed',
            runId,
            dispatches: [{ id: target, name: '子 Agent', status: 'waiting' }],
            orderQuality: 'reconstructed',
          })
      } else {
        const termination = node.termination as { code: string }
        append({
          id: node.id,
          nodeId: 'result',
          label: termination.code === 'error' ? '本轮失败' : '本轮暂停',
          status: termination.code === 'error' ? 'failed' : 'paused',
          runId,
          orderQuality: 'exact',
        })
      }
    }
  }
  for (const row of rows) {
    appendInternal(row.created_at - 1)
    if (row.revoked || row.role === 'sense') continue
    rowsByStage.get(stage)!.push(row)
    const node = byMessage.get(row.id)
    const runId = typeof node?.runId === 'string' ? node.runId : undefined
    const quality = node ? ('exact' as const) : ('reconstructed' as const)
    if (!node) historyComplete = false
    const resourceSummary = () => ({
      ...(row.epoch_id ? workflowResources(chatId, row.epoch_id) : {}),
      ...effectiveSkillCount(rowsByStage.get(stage)!),
    })
    if (links.get(row.id)?.relation === 'child_return') {
      append({
        id: row.id,
        nodeId: 'input',
        label: '子任务结果已接入',
        status: 'completed',
        runId,
        orderQuality: quality,
        dispatches: [
          { id: links.get(row.id)!.sourceChatId ?? row.id, name: '子 Agent', status: 'returned' },
        ],
      })
    } else if (row.role === 'user') {
      const commands = (node?.workflow as { commands?: string[] } | undefined)?.commands
      if (commands?.length)
        append({
          id: `command:${row.id}`,
          nodeId: 'command',
          label: `${commands.join('、')} 已注入`.slice(0, 200),
          status: 'completed',
          runId,
          orderQuality: quality,
        })
      append({
        id: row.id,
        nodeId: 'input',
        label: '用户输入已接入',
        status: 'completed',
        runId,
        orderQuality: quality,
        resources: resourceSummary(),
      })
    } else if (row.role === 'assistant') {
      append({
        id: row.id,
        nodeId: 'model',
        label: node?.termination ? '模型响应（运行中断）' : '模型响应',
        status: node?.termination ? 'unknown' : 'completed',
        runId,
        orderQuality: quality,
        resources: resourceSummary(),
      })
      let calls: Array<{ id: string; name: string }> = []
      try {
        calls = z
          .array(z.object({ id: z.string(), name: z.string() }))
          .parse(JSON.parse(row.sense_calls ?? '[]'))
      } catch {
        historyComplete = false
      }
      if (calls.length) {
        const batch = {
          id: `batch:${row.id}`,
          complete: true,
          calls: calls.map((call) => {
            const result = results.get(call.id)
            if (result) rowsByStage.get(stage)!.push(result)
            return {
              id: call.id,
              name: call.name,
              status: workflowCallStatus(result?.content ?? null, !!result?.revoked),
              resources: resourceSummary(),
            }
          }),
        }
        if (batch.calls.some((call) => call.status === 'unknown')) historyComplete = false
        append({
          id: batch.id,
          nodeId: 'tools',
          label: '工具批次',
          status: 'completed',
          runId,
          batch,
          orderQuality: 'reconstructed',
        })
      }
    }
    const termination = node?.termination as { code?: string } | undefined
    if (termination)
      append({
        id: `result:${row.id}`,
        nodeId: 'result',
        label: termination.code === 'error' ? '本轮失败' : '本轮暂停',
        status: termination.code === 'error' ? 'failed' : 'paused',
        runId,
        orderQuality: quality,
      })
    else {
      const outcome = (node?.workflow as { outcome?: string } | undefined)?.outcome
      if (outcome === 'completed' || outcome === 'waiting')
        append({
          id: `outcome:${row.id}`,
          nodeId: outcome === 'waiting' ? 'decision' : 'result',
          label: outcome === 'waiting' ? '等待子任务返回' : '本轮完成',
          status: outcome === 'waiting' ? 'running' : 'completed',
          runId,
          orderQuality: 'exact',
        })
    }
    if (row.context_compaction) {
      const applied =
        (node?.workflow as { compaction?: { applied?: boolean } } | undefined)?.compaction
          ?.applied === true
      // A generated but unapplied summary in a currently active run is not a boundary.
      if (
        !applied &&
        rows.at(-1)?.id === row.id &&
        getActiveChatEpoch(chatId)?.status === 'active'
      ) {
        historyComplete = false
        continue
      }
      append({
        id: `compact:${row.id}`,
        nodeId: 'compact',
        label: applied ? '上下文压缩已生效' : '历史压缩边界（重建）',
        status: applied ? 'completed' : 'unknown',
        runId,
        orderQuality: applied ? 'exact' : 'reconstructed',
      })
      stage = workflowStageId(chatId, row.id)
      stages.push({
        id: stage,
        label: `压缩后阶段 ${stages.length}`,
        quality: applied ? 'exact' : 'reconstructed',
      })
      factsByStage.set(stage, [])
      rowsByStage.set(stage, [])
      if (!applied) historyComplete = false
    }
  }
  appendInternal(boundary)
  stage = cursor?.stage ?? request.contextStageId ?? stage
  const facts = factsByStage.get(stage)
  if (!facts) throw Object.assign(new Error('该上下文阶段不存在'), { code: 'INVALID_PARAMS' })
  const selectedRows = rowsByStage.get(stage) ?? []
  const ids = new Set(
    selectedRows.flatMap((row) => {
      try {
        return (JSON.parse(row.sense_calls ?? '[]') as Array<{ id: string }>).map((call) => call.id)
      } catch {
        return []
      }
    }),
  )
  const resourceRows = [
    ...selectedRows,
    ...rows.filter((row) => row.role === 'sense' && ids.has(row.id)),
  ]
  const resources = {
    ...(selectedRows.at(-1)?.epoch_id
      ? workflowResources(chatId, selectedRows.at(-1)!.epoch_id!)
      : {}),
    ...effectiveSkillCount(resourceRows),
  }
  const remaining = facts.filter((fact) => fact.orderKey > (cursor?.after ?? 0))
  const page = remaining.slice(0, request.limit ?? 100)
  const complete = page.length === remaining.length
  return {
    chatId,
    contextStageId: stage,
    boundary,
    stages,
    facts: page,
    complete,
    historyComplete,
    resources,
    ...(!complete
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ chatId, stage, boundary, after: page.at(-1)!.orderKey, fingerprint }),
          ).toString('base64url'),
        }
      : {}),
  }
}
