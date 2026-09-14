import { createHash } from 'node:crypto'
import type {
  WorkflowContentAnchor,
  WorkflowOccurrenceStatus,
  WorkflowStepKind,
  WorkflowStepReason,
  WorkflowWaitReason,
} from '@chery/protocol'
import type { MiddlewareChunk } from '@/core/middleware/types'
import { observeWorkflow, type WorkflowBoundary } from '@/core/middleware/workflowObservation.js'
import {
  appendWorkflowJournalEvents,
  recordWorkflowJournalGap,
  type WorkflowJournalEventInput,
} from '@/db/workflowJournal.js'
import { getActiveChatRunId } from './runtime.js'
import { getSpawnTaskByChild } from '@/db/delivery.js'
import {
  recordWorkflowStep,
  resolveWorkflowIdentity,
  WORKFLOW_STEP_LABELS,
  workflowContextStageId,
} from './workflowStepWriter.js'

const NODE_KIND: Record<string, WorkflowStepKind> = {
  context: 'context',
  command: 'command',
  input: 'input',
  model: 'model',
  retry: 'retry',
  tools: 'tool-execution',
  checkpoint: 'checkpoint',
  decision: 'loop-decision',
  compact: 'compact-applied',
  result: 'result',
}

function shortId(parts: readonly unknown[]): string {
  return `wf:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`
}

function legacyStatus(boundary: WorkflowBoundary): {
  status: WorkflowOccurrenceStatus
  waitReason?: WorkflowWaitReason
  reason?: WorkflowStepReason
} {
  if (boundary.waitReason)
    return { status: 'waiting', waitReason: boundary.waitReason, reason: 'normal' }
  switch (boundary.status) {
    case 'completed':
      return { status: 'succeeded', reason: 'normal' }
    case 'failed':
      return { status: 'failed', reason: 'error' }
    case 'cancelled':
      return { status: 'cancelled', reason: 'user' }
    case 'paused':
      return { status: 'interrupted', reason: 'system' }
    case 'unknown':
      return { status: 'unknown', reason: 'unknown' }
    default:
      return { status: 'running' }
  }
}

export interface WorkflowRunRecorder {
  recordCommittedMessage(message: {
    id: string
    role: string
    contextCompaction?: boolean
    inputId?: string
    commandId?: string
  }): void
  recordChunk(chunk: MiddlewareChunk): void
  finish(status?: WorkflowOccurrenceStatus, reason?: WorkflowStepReason): void
}

const NOOP_RECORDER: WorkflowRunRecorder = {
  recordCommittedMessage: () => {},
  recordChunk: () => {},
  finish: () => {},
}

/** Installs a recorder for one run. It exists independently from UI leases. */
export function startWorkflowRunRecorder(chatId: string): WorkflowRunRecorder {
  try {
    return createWorkflowRunRecorder(chatId)
  } catch {
    return NOOP_RECORDER
  }
}

function createWorkflowRunRecorder(chatId: string): WorkflowRunRecorder {
  const identity = resolveWorkflowIdentity(chatId)
  const runId = getActiveChatRunId(chatId)
  let contextStageId = workflowContextStageId(chatId)
  let iteration = 0
  let attempt = 0
  let activeOccurrenceId: string | undefined
  let activeKind: WorkflowStepKind | undefined
  let pendingGap = false
  let closed = false
  const ordinals = new Map<string, number>()
  const callOccurrences = new Map<string, string>()
  const keyedOccurrences = new Map<string, string>()
  const preflightCandidates = new Set<string>()
  // 审批注册（sense_pending）在模型流中先于校验/授权到达；把 tool-approval 的 started
  // 延后到 sense_end（授权之后）记录，使工具链记录顺序与模板链一致（清单→校验→授权→审批）。
  const pendingApprovals = new Set<string>()
  const latest = new Map<WorkflowStepKind, { id: string; iteration: number; attempt: number }>()
  const callBatches = new Map<string, { id: string; occurrenceId: string }>()
  // callId -> tool-result occurrenceId（用于 checkpoint 边界挂接工具结果关系）
  const toolResultOccurrences = new Map<string, string>()
  let childRunOccurrenceId: string | undefined

  function current(kind: WorkflowStepKind, sameAttempt = false): string | undefined {
    const item = latest.get(kind)
    return item?.iteration === iteration && (!sameAttempt || item.attempt === attempt)
      ? item.id
      : undefined
  }

  function callKey(callId: string, kind: WorkflowStepKind): string {
    return `${iteration}:${attempt}:${kind}:${callId}`
  }

  // These are execution dependencies, not the most recently observed event.
  function predecessor(kind: WorkflowStepKind, callId?: string): string | undefined {
    if (callId) {
      const call = (step: WorkflowStepKind) => callOccurrences.get(callKey(callId, step))
      switch (kind) {
        case 'tool-validation':
          return callBatches.get(callId)?.occurrenceId
        case 'tool-authorization':
          return call('tool-validation')
        case 'tool-approval':
          return call('tool-authorization')
        case 'tool-preflight':
          return call('tool-approval') ?? call('tool-authorization')
        case 'tool-execution':
          return call('tool-preflight')
        case 'tool-result':
          return (
            call('tool-execution') ??
            call('tool-preflight') ??
            call('tool-approval') ??
            call('tool-authorization') ??
            call('tool-validation')
          )
      }
    }
    switch (kind) {
      case 'input': {
        const decision = latest.get('loop-decision')
        return decision?.iteration === iteration - 1 ? decision.id : undefined
      }
      case 'command':
        return current('input')
      case 'request':
        return current('retry') ?? current('command') ?? current('input') ?? current('context')
      case 'model':
        return current('request', true)
      case 'retry':
        return current('model', true)
      case 'tool-list':
        return current('model', true)
      case 'checkpoint':
        return current('model', true)
      case 'loop-decision':
        return current('checkpoint')
      case 'result':
        return current('loop-decision') ?? current('retry') ?? current('model', true)
      case 'compact-request':
        return current('request', true)
      case 'compact-summary':
        return current('compact-request')
      case 'compact-applied':
        return current('compact-summary')
      default:
        return undefined
    }
  }

  const common = () => ({
    ...identity,
    chatId,
    contextStageId,
    ...(runId ? { runId } : {}),
    ...(iteration ? { iteration } : {}),
    ...(attempt ? { attempt } : {}),
  })

  function persist(events: WorkflowJournalEventInput[]): void {
    if (!events.length || closed) return
    try {
      if (pendingGap) {
        recordWorkflowJournalGap({
          rootChatId: identity.rootChatId,
          chatId,
          ...(runId ? { runId } : {}),
          contextStageId,
          reason: 'write-failed',
        })
        pendingGap = false
      }
      appendWorkflowJournalEvents(events.slice(0, 100))
      if (events.length > 100) {
        recordWorkflowJournalGap({
          rootChatId: identity.rootChatId,
          chatId,
          ...(runId ? { runId } : {}),
          contextStageId,
          reason: 'recorder-overflow',
        })
      }
    } catch {
      pendingGap = true
    }
  }

  function occurrenceId(kind: WorkflowStepKind, key: string = kind): string {
    const ordinalKey = `${iteration}:${attempt}:${key}`
    const ordinal = (ordinals.get(ordinalKey) ?? 0) + 1
    ordinals.set(ordinalKey, ordinal)
    return shortId([identity.rootChatId, chatId, runId, iteration, attempt, key, ordinal])
  }

  function start(
    kind: WorkflowStepKind,
    key: string = kind,
    fields: Partial<WorkflowJournalEventInput> = {},
  ): string {
    const id = occurrenceId(kind, key)
    const causeOccurrenceId = fields.causeOccurrenceId ?? predecessor(kind, fields.callId)
    persist([
      {
        ...common(),
        sourceKey: `${id}:started`,
        occurrenceId: id,
        eventKind: 'started',
        kind,
        label: WORKFLOW_STEP_LABELS[kind],
        status: 'running',
        ...(causeOccurrenceId ? { causeOccurrenceId } : {}),
        ...fields,
      },
    ])
    latest.set(kind, { id, iteration, attempt })
    return id
  }

  function status(
    occurrenceId: string,
    kind: WorkflowStepKind,
    value: WorkflowOccurrenceStatus,
    options: {
      waitReason?: WorkflowWaitReason
      reason?: WorkflowStepReason
      sourceSuffix?: string
      batchId?: string
      callId?: string
    } = {},
  ): void {
    persist([
      {
        ...common(),
        sourceKey: `${occurrenceId}:status:${options.sourceSuffix ?? `${value}:${options.waitReason ?? ''}`}`,
        occurrenceId,
        eventKind: 'status',
        kind,
        label: WORKFLOW_STEP_LABELS[kind],
        status: value,
        ...(options.waitReason ? { waitReason: options.waitReason } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.batchId ? { batchId: options.batchId } : {}),
        ...(options.callId ? { callId: options.callId } : {}),
      },
    ])
  }

  function addAnchor(
    occurrenceId: string,
    kind: WorkflowStepKind,
    anchor: WorkflowContentAnchor,
    fields: Partial<WorkflowJournalEventInput> = {},
  ): void {
    persist([
      {
        ...common(),
        sourceKey: `${occurrenceId}:anchor:${anchor.kind}:${anchor.id}`,
        occurrenceId,
        eventKind: 'anchor-added',
        kind,
        label: WORKFLOW_STEP_LABELS[kind],
        anchor,
        ...fields,
      },
    ])
  }

  function finishActive(
    value: WorkflowOccurrenceStatus = 'succeeded',
    reason: WorkflowStepReason = 'normal',
  ): void {
    if (!activeOccurrenceId || !activeKind) return
    status(activeOccurrenceId, activeKind, value, { reason })
    activeOccurrenceId = undefined
    activeKind = undefined
  }

  function startOnce(
    kind: WorkflowStepKind,
    key: string,
    fields: Partial<WorkflowJournalEventInput> = {},
  ): string {
    const mapKey = `${iteration}:${attempt}:${kind}:${key}`
    const existing = keyedOccurrences.get(mapKey)
    if (existing) return existing
    const id = start(kind, key, fields)
    keyedOccurrences.set(mapKey, id)
    return id
  }

  /** 首个工具链事件到来时提前建立"调用清单"（收集中），批次提交时再补终态与真实 batchId。 */
  function pendingBatchList(): string {
    return startOnce('tool-list', `pending-batch:${iteration}:${attempt}`)
  }

  /** run 级"上下文构建/恢复"：整个 run 只建立一个 occurrence，不携带 iteration/attempt。 */
  function recordRunContext(): void {
    if (latest.has('context')) return
    const id = occurrenceId('context', 'context')
    persist([
      {
        ...common(),
        iteration: undefined,
        attempt: undefined,
        sourceKey: `${id}:started`,
        occurrenceId: id,
        eventKind: 'started',
        kind: 'context',
        label: WORKFLOW_STEP_LABELS['context'],
        status: 'running',
      },
      {
        ...common(),
        iteration: undefined,
        attempt: undefined,
        sourceKey: `${id}:status:succeeded:normal`,
        occurrenceId: id,
        eventKind: 'status',
        kind: 'context',
        label: WORKFLOW_STEP_LABELS['context'],
        status: 'succeeded',
        reason: 'normal',
      },
    ])
    latest.set('context', { id, iteration, attempt })
  }

  function onBoundary(boundary: WorkflowBoundary): void {
    if (closed) return
    if (boundary.newIteration) {
      finishActive()
      iteration = boundary.iteration ?? iteration + 1
      attempt = 0
      // Loop has entered a new consumption round, even when it consumes tool results.
      activeOccurrenceId = start('input')
      activeKind = 'input'
      callBatches.clear()
      preflightCandidates.clear()
      pendingApprovals.clear()
    }
    if (boundary.attempt !== undefined && boundary.attempt !== attempt) {
      attempt = boundary.attempt
      callBatches.clear()
      preflightCandidates.clear()
      pendingApprovals.clear()
    }
    const previousStage = contextStageId
    if (boundary.compactRequested) {
      const compact = start('compact-request')
      status(compact, 'compact-request', 'succeeded', { reason: 'request' })
    }
    let detailedModelBoundary = false
    if (boundary.activeNodeId === 'model' && boundary.phaseLabel === '准备请求') {
      detailedModelBoundary = true
      // 上下文在"准备请求"阶段随请求一并记录（记录顺序 = 模板链：输入→请求准备+上下文供给），
      // 使流程开始时的点亮顺序与连线一致；整个 run 只建立一个 run 级 context occurrence。
      recordRunContext()
      if (activeKind !== 'request' || !activeOccurrenceId) {
        finishActive()
        activeOccurrenceId = start('request')
        activeKind = 'request'
      }
    } else if (boundary.activeNodeId === 'model' && boundary.phaseLabel === '调用中') {
      detailedModelBoundary = true
      if (activeKind === 'request') finishActive('succeeded', 'request')
      if (activeKind !== 'model' || !activeOccurrenceId) {
        finishActive()
        activeOccurrenceId = start('model')
        activeKind = 'model'
      }
      status(activeOccurrenceId, 'model', 'waiting', {
        waitReason: 'model',
        reason: 'request',
        sourceSuffix: 'waiting:model',
      })
    } else if (boundary.activeNodeId === 'model' && boundary.phaseLabel === '处理响应') {
      detailedModelBoundary = true
      if (activeKind === 'request') finishActive('succeeded', 'request')
      if (activeKind !== 'model' || !activeOccurrenceId) {
        finishActive()
        activeOccurrenceId = start('model')
        activeKind = 'model'
      }
      status(activeOccurrenceId, 'model', 'running', {
        reason: 'response',
        sourceSuffix: 'response',
      })
    }
    // 上下文边界不占用 active occurrence：context 延后到"准备请求"阶段记录，
    // 保证记录顺序与模板链一致（输入 → 请求准备 + 上下文供给），避免流程开始时上下文先于输入点亮。
    if (
      boundary.activeNodeId &&
      boundary.activeNodeId !== 'tools' &&
      boundary.activeNodeId !== 'context' &&
      !detailedModelBoundary
    ) {
      const kind = NODE_KIND[boundary.activeNodeId] ?? 'unknown'
      const next = legacyStatus(boundary)
      if (activeKind !== kind || !activeOccurrenceId) {
        finishActive(
          kind === 'retry' ? 'failed' : 'succeeded',
          kind === 'retry' ? 'error' : 'normal',
        )
        activeOccurrenceId = start(kind)
        activeKind = kind
      }
      if (next.status !== 'running')
        status(activeOccurrenceId, kind, next.status, {
          ...(next.waitReason ? { waitReason: next.waitReason } : {}),
          ...(next.reason ? { reason: next.reason } : {}),
        })
    }
    if (boundary.activeNodeId === 'checkpoint') {
      // 边界建立的 checkpoint occurrence 立即挂接已完成工具结果的关系锚点：
      // 与消息提交路径复用同一 occurrence，使"内容记录"的两条入边在同一帧点亮。
      const checkpointId = activeOccurrenceId
      if (checkpointId) {
        for (const [callId, resultId] of toolResultOccurrences) {
          addAnchor(
            checkpointId,
            'checkpoint',
            { kind: 'message', id: callId, chatId },
            { callId, causeOccurrenceId: resultId },
          )
        }
      }
    }
    if (boundary.batch) {
      if (activeKind === 'model') finishActive('succeeded', 'response')
      // 清单已在首个工具链事件（sense_pending/sense_end）时提前建立（收集中）；
      // 此处复用同一 occurrence，补真实 batchId 与终态，保证 firstSequence 早于校验/授权/审批。
      const pendingKey = `pending-batch:${iteration}:${attempt}`
      const pendingMapKey = `${iteration}:${attempt}:tool-list:${pendingKey}`
      let list = keyedOccurrences.get(pendingMapKey)
      if (list) keyedOccurrences.delete(pendingMapKey)
      else list = startOnce('tool-list', boundary.batch.id, {
        batchId: boundary.batch.id,
      })
      status(list, 'tool-list', 'succeeded', {
        reason: 'normal',
        batchId: boundary.batch.id,
      })
      for (const call of boundary.batch.calls) {
        callBatches.set(call.id, { id: boundary.batch.id, occurrenceId: list })
        const validation = callOccurrences.get(callKey(call.id, 'tool-validation'))
        if (validation)
          addAnchor(
            validation,
            'tool-validation',
            { kind: 'tool-call', id: call.id, chatId },
            { callId: call.id, batchId: boundary.batch.id, causeOccurrenceId: list },
          )
      }
    }
    if (boundary.contextStageId && boundary.contextStageId !== previousStage) {
      contextStageId = boundary.contextStageId
    }
  }

  const stop = observeWorkflow(chatId, onBoundary)
  const spawnTask = getSpawnTaskByChild(chatId)
  if (spawnTask) {
    childRunOccurrenceId = start('child-run', `child-run:${spawnTask.taskId}`, {
      anchor: { kind: 'branch', id: chatId, chatId },
    })
  }

  function callOccurrence(
    callId: string,
    kind: WorkflowStepKind,
    fields: Partial<WorkflowJournalEventInput> = {},
  ): string {
    const key = callKey(callId, kind)
    const existing = callOccurrences.get(key)
    if (existing) return existing
    const id = startOnce(kind, callId, {
      callId,
      ...(callBatches.get(callId) ? { batchId: callBatches.get(callId)!.id } : {}),
      ...fields,
    })
    callOccurrences.set(key, id)
    // Validation may precede the final batch notification; its anchor is added there.
    if (kind !== 'tool-validation') addAnchor(id, kind, { kind: 'tool-call', id: callId, chatId })
    return id
  }

  return {
    recordCommittedMessage(message) {
      const anchor: WorkflowContentAnchor = { kind: 'message', id: message.id, chatId }
      if (message.role === 'user') {
        const inputKey = message.inputId ?? message.id
        const submission = recordWorkflowStep(chatId, {
          kind: 'submission',
          key: inputKey,
          scope: 'chat',
          ...(runId ? { runId } : {}),
          status: 'succeeded',
          reason: 'accepted',
          eventKey: 'accepted',
          anchor,
        })
        const queue = recordWorkflowStep(chatId, {
          kind: 'queue',
          key: inputKey,
          scope: 'chat',
          ...(runId ? { runId } : {}),
          status: 'succeeded',
          reason: 'consumed',
          eventKey: 'consumed',
          anchor,
          causeOccurrenceId: submission,
        })
        const input = current('input')
        if (input) addAnchor(input, 'input', anchor, { causeOccurrenceId: queue })
      }
      if (message.role === 'role') {
        return
      }
      if (message.contextCompaction) {
        const summary = startOnce('compact-summary', message.id)
        addAnchor(summary, 'compact-summary', anchor)
        status(summary, 'compact-summary', 'succeeded', { reason: 'result' })
        const applied = startOnce('compact-applied', message.id, {
          anchor: { kind: 'compaction', id: message.id, chatId },
        })
        status(applied, 'compact-applied', 'succeeded', { reason: 'normal' })
        contextStageId = `${chatId}:${message.id}`
        return
      }
      const kind: WorkflowStepKind =
        message.role === 'user' ? 'input' : message.role === 'sense' ? 'tool-result' : 'model'
      const linkedToolResult =
        kind === 'tool-result' ? callOccurrences.get(callKey(message.id, 'tool-result')) : undefined
      if (linkedToolResult) {
        addAnchor(linkedToolResult, kind, anchor)
        // 复用本轮边界（activeNodeId 'checkpoint'）已建立的 checkpoint occurrence：
        // 边界事件先于工具结果消息提交到达，两条输入线（模型响应→响应分流→内容记录、
        // 工具结果→内容记录）因此指向同一个 occurrence，"内容记录"只点亮一次且入边同时点亮。
        const checkpoint =
          current('checkpoint', true) ??
          startOnce('checkpoint', `checkpoint:${message.id}`, {
            callId: message.id,
            causeOccurrenceId: linkedToolResult,
          })
        addAnchor(checkpoint, 'checkpoint', anchor, {
          callId: message.id,
          causeOccurrenceId: linkedToolResult,
        })
        status(checkpoint, 'checkpoint', 'succeeded', { reason: 'result', callId: message.id })
      }
      // A persisted pending placeholder is not a completed tool result.
      else if (kind === 'tool-result') return
      else if (kind === 'model' && current('model', true)) {
        const modelId = current('model', true)!
        addAnchor(modelId, kind, anchor)
        // 模型响应消息已提交（流已结束）：立即终态化 model occurrence，使"大模型响应"
        // 在工具链（校验/授权/审批）之前点亮，并让前端能即时证明
        // model→response→channels→tool-list 的前驱连线（记录时机 = 触发时机）。
        if (activeOccurrenceId === modelId && activeKind === 'model')
          finishActive('succeeded', 'response')
      } else if (activeOccurrenceId && activeKind === kind) {
        addAnchor(activeOccurrenceId, kind, anchor)
        if (kind === 'model') finishActive('succeeded', 'response')
      } else {
        const id = start(kind, `${kind}:message:${message.id}`)
        addAnchor(id, kind, anchor)
        status(id, kind, 'succeeded', { reason: 'result' })
      }
    },
    recordChunk(chunk) {
      if (closed) return
      if (chunk.type === 'sense_end') {
        // 首个工具链事件：提前建立"调用清单"（收集中），使清单 firstSequence 早于校验/授权/审批。
        const list = pendingBatchList()
        const invalidArguments = chunk.security?.findings.some(
          (finding) => finding.code === 'schema.invalid-arguments',
        )
        const validation = callOccurrence(chunk.id, 'tool-validation', {
          causeOccurrenceId: list,
        })
        status(validation, 'tool-validation', invalidArguments ? 'rejected' : 'succeeded', {
          reason: invalidArguments ? 'validation' : 'normal',
          callId: chunk.id,
        })
        if (invalidArguments) return
        const authorization = callOccurrence(chunk.id, 'tool-authorization', {
          causeOccurrenceId: validation,
        })
        status(
          authorization,
          'tool-authorization',
          chunk.security?.decision === 'deny' ? 'rejected' : 'succeeded',
          {
            reason: chunk.security?.decision === 'deny' ? 'policy' : 'normal',
            callId: chunk.id,
          },
        )
        if (!invalidArguments && chunk.security?.decision !== 'deny')
          preflightCandidates.add(chunk.id)
        // 审批注册（sense_pending）在模型流中先到；把 approval 的 started 放在授权之后，
        // 使工具链记录顺序与模板链一致（清单→校验→授权→审批）。
        if (pendingApprovals.delete(chunk.id)) {
          const approval = callOccurrence(chunk.id, 'tool-approval', {
            causeOccurrenceId: authorization,
          })
          status(approval, 'tool-approval', 'waiting', {
            waitReason: 'approval',
            reason: 'approval',
            callId: chunk.id,
          })
        }
      } else if (chunk.type === 'sense_pending') {
        pendingApprovals.add(chunk.approvalId)
        pendingBatchList()
      } else if (chunk.type === 'sense_started') {
        const preflight = callOccurrence(chunk.id, 'tool-preflight')
        const approval = callOccurrences.get(callKey(chunk.id, 'tool-approval'))
        if (approval)
          status(approval, 'tool-approval', 'succeeded', { reason: 'approval', callId: chunk.id })
        status(preflight, 'tool-preflight', 'succeeded', {
          reason: 'preflight',
          callId: chunk.id,
        })
        const id = callOccurrence(chunk.id, 'tool-execution')
        status(id, 'tool-execution', 'running', {
          reason: 'execution',
          callId: chunk.id,
        })
      } else if (chunk.type === 'sense_accept' || chunk.type === 'sense_reject') {
        const finalStatus = chunk.type === 'sense_reject' ? 'rejected' : 'succeeded'
        const approval = callOccurrences.get(callKey(chunk.id, 'tool-approval'))
        const execution = callOccurrences.get(callKey(chunk.id, 'tool-execution'))
        if (approval && !execution)
          status(approval, 'tool-approval', finalStatus, { reason: 'approval', callId: chunk.id })
        if (
          chunk.type === 'sense_reject' &&
          !approval &&
          !execution &&
          preflightCandidates.has(chunk.id)
        ) {
          const preflight = callOccurrence(chunk.id, 'tool-preflight')
          status(preflight, 'tool-preflight', 'rejected', {
            reason: 'preflight',
            callId: chunk.id,
          })
        }
        if (execution)
          status(execution, 'tool-execution', finalStatus, {
            reason: chunk.type === 'sense_reject' ? 'policy' : 'result',
            callId: chunk.id,
          })
        const result = callOccurrence(chunk.id, 'tool-result')
        toolResultOccurrences.set(chunk.id, result)
        status(result, 'tool-result', finalStatus, {
          reason: 'result',
          callId: chunk.id,
        })
      } else if (chunk.type === 'retry_reset') {
        finishActive('failed', 'error')
      } else if (chunk.type === 'question_batch_pending') {
        const id = startOnce('input', `question:${chunk.batchId}`, { batchId: chunk.batchId })
        status(id, 'input', 'waiting', { waitReason: 'answer', reason: 'normal' })
      } else if (chunk.type === 'child_yield') {
        if (childRunOccurrenceId)
          status(childRunOccurrenceId, 'child-run', 'waiting', {
            waitReason: 'child',
            reason: 'normal',
          })
      } else if (chunk.type === 'child_done') {
        if (childRunOccurrenceId) {
          status(childRunOccurrenceId, 'child-run', 'succeeded', {
            reason: 'result',
            sourceSuffix: 'child-done',
          })
          childRunOccurrenceId = undefined
        }
        const id = start('child-return', `child-return:${chunk.childChatId}`)
        status(id, 'child-return', 'succeeded', { reason: 'result' })
      } else if (chunk.type === 'error') {
        finishActive('failed', 'error')
        activeOccurrenceId = start('result', 'result:error')
        activeKind = 'result'
        finishActive('failed', 'error')
      } else if (chunk.type === 'run_paused') {
        finishActive('interrupted', 'system')
      } else if (chunk.type === 'done') {
        finishActive(chunk.waitingForChild ? 'waiting' : 'succeeded', 'normal')
      }
    },
    finish(value = 'unknown', reason = 'unknown') {
      if (closed) return
      finishActive(value, reason)
      if (
        childRunOccurrenceId &&
        value !== 'unknown' &&
        value !== 'running' &&
        value !== 'waiting'
      ) {
        status(childRunOccurrenceId, 'child-run', value, {
          reason,
          sourceSuffix: `run-finish:${value}`,
        })
        childRunOccurrenceId = undefined
      }
      if (pendingGap) {
        try {
          recordWorkflowJournalGap({
            rootChatId: identity.rootChatId,
            chatId,
            ...(runId ? { runId } : {}),
            contextStageId,
            reason: 'write-failed',
          })
        } catch {
          /* The persisted completeness flag remains best effort on hard DB failure. */
        }
      }
      closed = true
      stop()
    },
  }
}
