import { randomUUID } from 'node:crypto'
import type {
  WorkflowSnapshot,
  WorkflowOpenRequest,
  WorkflowOpenResponse,
  WorkflowCloseRequest,
  WorkflowCloseResponse,
  WorkflowCall,
} from '@chery/protocol'
import {
  onWorkflowJournalCommit,
  readWorkflowStepSnapshot,
  type WorkflowJournalCommit,
} from '@/db/workflowJournal.js'
import { onPreparedChatEvent } from '@/db/delivery.js'
import { getChat, getMessages, getChatRuntimeSelection, getMessageLinksForRoot } from '@/db/chat.js'
import { listLatestExecutionRuns, listExecutionNodes } from '@/db/executionGraph.js'
import { getActiveChatEpoch } from '@/db/epoch.js'
import { listInteractions } from '@/db/interaction.js'
import { observeWorkflow, type WorkflowBoundary } from '@/core/middleware/workflowObservation.js'
import { loadHookRegistry } from '@/agent/hooks/registry.js'
import { matches } from '@/agent/hooks/matcher.js'
import type { HookEvent } from '@/agent/hooks/types.js'
import config from '@/utils/config.js'
import { resolveBrainAdapterKey } from '@/core/llm/routing.js'
import { peekChatMessages, isChatRunning, getActiveChatRunId } from './runtime.js'
import { effectiveSkillCount, memoryRows, workflowCallStatus } from './workflowEvidence.js'
import {
  readWorkflowHistory,
  requireWorkflowRoot,
  resolveWorkflowRootScope,
  workflowResources,
  workflowStageId,
} from './workflowHistory.js'
import { computeCurrentState } from './currentState.js'
import { Method, createNotification } from '../message/types.js'
import type { HandlerContext, RpcRouter } from '../message/router.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { onChatLifecycle } from './lifecycleEvents.js'

interface Projection {
  streamId: string
  snapshot: WorkflowSnapshot
  stop: () => void
}
interface Lease {
  connectionId: string
  observerId: string
  requestedChatId: string
  rootChatId: string
  revision: number
}
const projections = new Map<string, Projection>()
const leases = new Map<string, Lease>()

function hooks(_chatId: string, event: HookEvent, target = ''): boolean {
  return (loadHookRegistry()[event] ?? []).some((handler) => matches(handler.matcher, target))
}

function modelHooks(chatId: string) {
  const selection = getChatRuntimeSelection(chatId)
  const provider = selection ? config.llm.brain[selection.brain]?.provider : undefined
  const brain = selection ? config.llm.brain[selection.brain] : undefined
  const requestHookWired =
    !!brain && ['anthropic', 'minimax'].includes(resolveBrainAdapterKey(brain))
  return {
    before:
      hooks(chatId, 'UserPromptSubmit', 'user') ||
      (requestHookWired && hooks(chatId, 'PreLLMRequest', provider)),
    after: hooks(chatId, 'PostLLMResponse', provider) || hooks(chatId, 'Stop'),
  }
}

export function initialWorkflowSnapshot(chatId: string): WorkflowSnapshot {
  requireWorkflowRoot(chatId)
  const active = listLatestExecutionRuns(chatId).find((run) => run.chatId === chatId)
  const memory = peekChatMessages(chatId)
  const rows = getMessages(chatId)
  const summary = memory?.findLast(
    (message) => message.contextCompaction && message.role === 'system',
  )
  const persistedSummary = !memory
    ? rows.findLast((message) => !!message.context_compaction)
    : undefined
  const contextStageId = workflowStageId(chatId, summary?.id ?? persistedSummary?.id)
  const effective = memory
    ? memoryRows(memory)
    : rows.slice(persistedSummary ? rows.indexOf(persistedSummary) + 1 : 0)
  const pending = listInteractions().find(
    (item) => item.chatId === chatId && item.status === 'pending',
  )
  const current = computeCurrentState(chatId)
  const running = isChatRunning(chatId)
  const nodes = listExecutionNodes(chatId)
  const lastOutcome = nodes
    .filter((node) => node.sourceChatId === chatId && node.kind !== 'tool-batch')
    .findLast((node) => !!(node.workflow as { outcome?: string } | undefined)?.outcome)
  const outcome = lastOutcome?.workflow as { outcome?: string; outcomeRunId?: string } | undefined
  const terminated = nodes.findLast(
    (node) => node.sourceChatId === chatId && node.runId === active?.runId && !!node.termination,
  )
  const waitingChild =
    !terminated &&
    (active?.status === 'waiting' ||
      (outcome?.outcome === 'waiting' && outcome.outcomeRunId === active?.runId))
  const status: WorkflowSnapshot['status'] = terminated
    ? (terminated.termination as { code?: string }).code === 'error'
      ? 'failed'
      : 'paused'
    : pending || waitingChild || running
      ? 'running'
      : active?.status === 'running'
        ? 'unknown'
        : active?.status === 'waiting'
          ? 'running'
          : (active?.status ?? 'idle')
  const waitReason = terminated
    ? undefined
    : pending
      ? pending.kind === 'approval'
        ? 'approval'
        : 'answer'
      : waitingChild
        ? 'child'
        : undefined
  const effectiveIds = new Set(effective.map((row) => row.id))
  const lastAssistant = rows.findLast(
    (row) =>
      row.role === 'assistant' && !row.revoked && row.sense_calls && effectiveIds.has(row.id),
  )
  let batch: WorkflowSnapshot['batch']
  if (
    lastAssistant &&
    (!persistedSummary || rows.indexOf(lastAssistant) > rows.indexOf(persistedSummary))
  ) {
    try {
      const calls = JSON.parse(lastAssistant.sense_calls!) as Array<{ id: string; name: string }>
      batch = {
        id: `batch:${lastAssistant.id}`,
        complete: true,
        calls: calls.map((call) => {
          const row = rows.find((item) => item.id === call.id)
          const executing = current.runningTools.some((item) => item.id === call.id)
          return {
            id: call.id,
            name: call.name,
            beforeHook: hooks(chatId, 'PreToolUse', call.name),
            afterHook: hooks(chatId, 'PostToolUse', call.name),
            status: executing
              ? 'running'
              : workflowCallStatus(row?.content ?? null, !!row?.revoked),
          }
        }),
      }
    } catch {
      /* Old incomplete batch remains unknown. */
    }
  }
  const activeStep = current.executionSteps?.findLast((step) => step.status === 'running')
  const returned = new Set(
    getMessageLinksForRoot(chatId)
      .filter((link) => link.relation === 'child_return')
      .map((link) => link.sourceChatId),
  )
  const dispatches: WorkflowSnapshot['dispatches'] = nodes
    .filter(
      (node) =>
        node.kind === 'dispatch' &&
        (node.actor as { chatId?: string } | undefined)?.chatId === chatId &&
        typeof node.targetChatId === 'string',
    )
    .map((node) => ({
      id: node.targetChatId as string,
      name: '子 Agent',
      status: returned.has(node.targetChatId as string) ? 'returned' : 'waiting',
    }))
  return {
    chatId,
    rootChatId: chatId,
    epochId: getActiveChatEpoch(chatId)?.epochId,
    contextStageId,
    runId: getActiveChatRunId(chatId) ?? active?.runId,
    revision: 0,
    status,
    waitReason,
    activeNodeId: terminated
      ? 'result'
      : pending
        ? 'tools'
        : running && activeStep
          ? activeStep.kind === 'model'
            ? 'model'
            : 'tools'
          : undefined,
    phaseKnown: !!terminated || !!pending || (running && !!activeStep),
    historyComplete: true,
    visitedNodeIds: [],
    batch,
    dispatches: [...new Map(dispatches.map((dispatch) => [dispatch.id, dispatch])).values()],
    resources: { ...workflowResources(chatId), ...effectiveSkillCount(effective) },
    modelHooks: modelHooks(chatId),
  }
}

function release(subscriptionId: string): void {
  const lease = leases.get(subscriptionId)
  if (!lease) return
  leases.delete(subscriptionId)
  if (![...leases.values()].some((item) => item.rootChatId === lease.rootChatId)) {
    projections.get(lease.rootChatId)?.stop()
    projections.delete(lease.rootChatId)
  }
}

connectionManager.onClose((connectionId) => {
  for (const [id, lease] of leases) if (lease.connectionId === connectionId) release(id)
})

function sendUpdate(
  subscriptionId: string,
  lease: Lease,
  data: Omit<WorkflowJournalCommit, 'rootChatId'> & { invalidated?: boolean },
): void {
  const projection = projections.get(lease.rootChatId)
  if (!projection) return
  const ws = connectionManager.getWsByConnectionId(lease.connectionId)
  if (!ws || ws.readyState !== ws.OPEN) {
    release(subscriptionId)
    return
  }
  const payload = {
    subscriptionId,
    streamId: projection.streamId,
    ...data,
  }
  try {
    if (JSON.stringify(payload).length > 128 * 1024) {
      ws.send(
        transport.encode(
          createNotification('workflow.updated', undefined, {
            subscriptionId,
            streamId: projection.streamId,
            baseRevision: lease.revision,
            revision: data.revision,
            invalidated: true,
          }),
        ),
      )
    } else {
      ws.send(transport.encode(createNotification('workflow.updated', undefined, payload)))
    }
    lease.revision = data.revision
  } catch {
    release(subscriptionId)
  }
}

onWorkflowJournalCommit((commit) => {
  for (const [subscriptionId, lease] of leases) {
    if (lease.rootChatId !== commit.rootChatId) continue
    if (lease.revision !== commit.baseRevision) {
      sendUpdate(subscriptionId, lease, {
        baseRevision: lease.revision,
        revision: commit.revision,
        events: [],
        gaps: [],
        invalidated: true,
      })
      continue
    }
    sendUpdate(subscriptionId, lease, commit)
  }
})

onChatLifecycle((data) => {
  const changed = new Set(data.chatIds)
  for (const [subscriptionId, lease] of leases) {
    if (!changed.has(lease.requestedChatId) && !changed.has(lease.rootChatId)) continue
    const chat = getChat(lease.requestedChatId)
    if (chat) {
      if (chat.lifecycle !== 'active') projections.get(lease.rootChatId)?.stop()
      continue
    }
    sendUpdate(subscriptionId, lease, {
      baseRevision: lease.revision,
      revision: lease.revision,
      events: [],
      gaps: [],
      invalidated: true,
    })
    release(subscriptionId)
  }
})

function updateBoundary(chatId: string, boundary: WorkflowBoundary): void {
  const projection = projections.get(chatId)
  if (!projection) return
  const snapshot = projection.snapshot
  const { newIteration, ...patch } = boundary
  if (newIteration) {
    snapshot.visitedNodeIds = []
    snapshot.activeNodeId = undefined
    snapshot.attempt = undefined
  }
  if (patch.activeNodeId) {
    if (snapshot.activeNodeId && !snapshot.visitedNodeIds.includes(snapshot.activeNodeId))
      snapshot.visitedNodeIds.push(snapshot.activeNodeId)
    snapshot.waitReason = undefined
    snapshot.phaseKnown = true
  }
  if (patch.batch) {
    const rows = new Map(getMessages(chatId).map((row) => [row.id, row]))
    patch.batch = {
      ...patch.batch,
      calls: patch.batch.calls.map((call) => ({
        ...call,
        status:
          call.status === 'unknown'
            ? workflowCallStatus(rows.get(call.id)?.content ?? null, !!rows.get(call.id)?.revoked)
            : call.status,
        beforeHook: hooks(chatId, 'PreToolUse', call.name),
        afterHook: hooks(chatId, 'PostToolUse', call.name),
      })),
    }
  }
  Object.assign(snapshot, patch)
  snapshot.runId = getActiveChatRunId(chatId) ?? snapshot.runId
}

export function refreshWorkflowContext(chatId: string): void {
  const projection = projections.get(chatId)
  if (!projection) return
  const memory = peekChatMessages(chatId)
  if (!memory) return
  const contextStageId = workflowStageId(
    chatId,
    memory.findLast((message) => message.contextCompaction && message.role === 'system')?.id,
  )
  const resources = { ...workflowResources(chatId), ...effectiveSkillCount(memoryRows(memory)) }
  if (contextStageId !== projection.snapshot.contextStageId) {
    projection.snapshot.batch = undefined
    projection.snapshot.visitedNodeIds = []
    projection.snapshot.activeNodeId = 'compact'
    projection.snapshot.phaseLabel = '压缩已生效'
    projection.snapshot.compactRequested = false
  }
  Object.assign(projection.snapshot, {
    contextStageId,
    resources,
    epochId: getActiveChatEpoch(chatId)?.epochId,
  })
}

export async function openWorkflow(
  ctx: HandlerContext,
  data: WorkflowOpenRequest,
): Promise<WorkflowOpenResponse> {
  const scope = resolveWorkflowRootScope(data.chatId)
  for (const [id, lease] of leases) {
    if (lease.connectionId !== ctx.connectionId || lease.observerId !== data.observerId) continue
    if (lease.requestedChatId === data.chatId) {
      const projection = projections.get(scope.rootChatId)!
      const steps = readWorkflowStepSnapshot(scope.rootChatId)
      lease.revision = steps.revision
      return {
        subscriptionId: id,
        streamId: projection.streamId,
        snapshot: structuredClone(projection.snapshot),
        steps,
      }
    }
    release(id)
  }
  let projection = projections.get(scope.rootChatId)
  if (!projection) {
    const snapshot = initialWorkflowSnapshot(data.chatId)
    snapshot.rootChatId = scope.rootChatId
    projection = {
      streamId: randomUUID(),
      snapshot,
      stop: () => {},
    }
    projections.set(scope.rootChatId, projection)
    if (getChat(data.chatId)?.lifecycle === 'active')
      projection.stop = observeWorkflow(data.chatId, (boundary) =>
        updateBoundary(scope.rootChatId, boundary),
      )
  }
  const steps = readWorkflowStepSnapshot(scope.rootChatId)
  const subscriptionId = randomUUID()
  leases.set(subscriptionId, {
    observerId: data.observerId,
    connectionId: ctx.connectionId,
    requestedChatId: data.chatId,
    rootChatId: scope.rootChatId,
    revision: steps.revision,
  })
  return {
    subscriptionId,
    streamId: projection.streamId,
    snapshot: structuredClone(projection.snapshot),
    steps,
  }
}

export async function closeWorkflow(
  ctx: HandlerContext,
  data: WorkflowCloseRequest,
): Promise<WorkflowCloseResponse> {
  const closed = leases.get(data.subscriptionId)?.connectionId === ctx.connectionId
  if (closed) release(data.subscriptionId)
  return { subscriptionId: data.subscriptionId, closed }
}

// Consume existing semantic notifications, never token events or a new journal.
onPreparedChatEvent((chatId, event) => {
  if (!projections.has(chatId) || event.kind !== 'notification' || event.transient) return
  const projection = projections.get(chatId)!
  const data = (event.data ?? {}) as Record<string, unknown>
  const type = String(event.type)
  const snapshot = projection.snapshot
  try {
    if (type === 'run.updated') {
      const status = data.status
      const hasTermination = listExecutionNodes(chatId).some(
        (node) =>
          node.sourceChatId === chatId &&
          node.runId === (data.runId ?? snapshot.runId) &&
          !!node.termination,
      )
      const waitingChild =
        (status === 'paused' || status === 'completed' || status === 'waiting') &&
        snapshot.waitReason === 'child' &&
        !hasTermination
      if (waitingChild)
        updateBoundary(chatId, {
          status: 'running',
          activeNodeId: 'decision',
          waitReason: 'child',
          phaseLabel: '等待子任务返回',
        })
      else if (status === 'running') updateBoundary(chatId, { status: 'running' })
      else if (status === 'paused' || status === 'completed' || status === 'failed')
        updateBoundary(chatId, {
          status,
          activeNodeId: 'result',
          phaseLabel:
            status === 'paused' ? '本轮暂停' : status === 'failed' ? '本轮失败' : '本轮完成',
        })
    } else if (['sense_started', 'interrupt', 'accept', 'rejected'].includes(type)) {
      const callId = String(data.id ?? data.approvalId ?? '')
      const call = snapshot.batch?.calls.find((item) => item.id === callId)
      const status: WorkflowCall['status'] =
        type === 'sense_started'
          ? 'running'
          : type === 'interrupt'
            ? 'waiting'
            : type === 'rejected'
              ? 'rejected'
              : workflowCallStatus(typeof data.result === 'string' ? data.result : 'completed')
      if (call) call.status = status
      updateBoundary(chatId, {
        activeNodeId: 'tools',
        status: 'running',
        waitReason: type === 'interrupt' ? 'approval' : undefined,
        phaseLabel:
          type === 'interrupt'
            ? '等待审批'
            : type === 'sense_started'
              ? '执行工具'
              : '工具结果已返回',
      })
      if (type === 'accept' && data.senseName === 'skill') refreshWorkflowContext(chatId)
    } else if (type === 'question_batch_requested')
      updateBoundary(chatId, {
        activeNodeId: 'tools',
        status: 'running',
        waitReason: 'answer',
        phaseLabel: '等待用户回答',
      })
    else if (type === 'role_created') {
      const id = String(data.childChatId ?? '')
      if (id && !snapshot.dispatches.some((item) => item.id === id))
        snapshot.dispatches.push({ id, name: String(data.type ?? '子 Agent'), status: 'waiting' })
    } else if (type === 'role_reply' || type === 'child_abandoned') {
      const dispatch = snapshot.dispatches.find((item) => item.id === data.childChatId)
      if (dispatch) dispatch.status = type === 'role_reply' ? 'returned' : 'cancelled'
    } else if (type === 'replaced' || type === 'timeline.patch') refreshWorkflowContext(chatId)
  } catch {
    /* Observer errors cannot affect the task. */
  }
})

export function registerWorkflowHandlers(router: RpcRouter): void {
  router.register(Method.CHAT_WORKFLOW_OPEN, openWorkflow)
  router.register(Method.CHAT_WORKFLOW_CLOSE, closeWorkflow)
  router.register(Method.CHAT_WORKFLOW_HISTORY, async (_ctx, data) => readWorkflowHistory(data))
}
