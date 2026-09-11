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
  let childRunOccurrenceId: string | undefined

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
    persist([
      {
        ...common(),
        sourceKey: `${id}:started`,
        occurrenceId: id,
        eventKind: 'started',
        kind,
        label: WORKFLOW_STEP_LABELS[kind],
        status: 'running',
        ...fields,
      },
    ])
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
    const mapKey = `${kind}:${key}`
    const existing = keyedOccurrences.get(mapKey)
    if (existing) return existing
    const id = start(kind, key, fields)
    keyedOccurrences.set(mapKey, id)
    return id
  }

  function onBoundary(boundary: WorkflowBoundary): void {
    if (closed) return
    if (boundary.newIteration) {
      finishActive()
      iteration = boundary.iteration ?? iteration + 1
      attempt = 0
    }
    if (boundary.attempt !== undefined) attempt = boundary.attempt
    const previousStage = contextStageId
    if (boundary.compactRequested) {
      const compact = start('compact-request')
      status(compact, 'compact-request', 'succeeded', { reason: 'request' })
    }
    let detailedModelBoundary = false
    if (boundary.activeNodeId === 'model' && boundary.phaseLabel === '准备请求') {
      detailedModelBoundary = true
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
    if (boundary.activeNodeId && !detailedModelBoundary) {
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
    if (boundary.batch) {
      const list = startOnce('tool-list', boundary.batch.id, {
        batchId: boundary.batch.id,
      })
      status(list, 'tool-list', 'succeeded', {
        reason: 'normal',
        batchId: boundary.batch.id,
      })
    }
    if (boundary.contextStageId && boundary.contextStageId !== previousStage) {
      contextStageId = boundary.contextStageId
    }
  }

  const stop = observeWorkflow(chatId, onBoundary)
  activeOccurrenceId = start('context')
  activeKind = 'context'
  const spawnTask = getSpawnTaskByChild(chatId)
  if (spawnTask) {
    childRunOccurrenceId = start('child-run', `child-run:${spawnTask.taskId}`, {
      anchor: { kind: 'branch', id: chatId, chatId },
    })
  }

  function callOccurrence(callId: string, kind: WorkflowStepKind): string {
    const key = `${kind}:${callId}`
    const existing = callOccurrences.get(key)
    if (existing) return existing
    const id = startOnce(kind, callId, {
      callId,
      anchor: { kind: 'tool-call', id: callId, chatId },
    })
    callOccurrences.set(key, id)
    return id
  }

  return {
    recordCommittedMessage(message) {
      const anchor: WorkflowContentAnchor = { kind: 'message', id: message.id, chatId }
      if (message.role === 'user') {
        const inputKey = message.inputId ?? message.id
        recordWorkflowStep(chatId, {
          kind: 'submission',
          key: inputKey,
          scope: 'chat',
          ...(runId ? { runId } : {}),
          status: 'succeeded',
          reason: 'accepted',
          eventKey: 'accepted',
          anchor,
        })
        recordWorkflowStep(chatId, {
          kind: 'queue',
          key: inputKey,
          scope: 'chat',
          ...(runId ? { runId } : {}),
          status: 'succeeded',
          reason: 'consumed',
          eventKey: 'consumed',
          anchor,
        })
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
        kind === 'tool-result' ? callOccurrences.get(`tool-result:${message.id}`) : undefined
      if (linkedToolResult) addAnchor(linkedToolResult, kind, anchor)
      else if (activeOccurrenceId && activeKind === kind)
        addAnchor(activeOccurrenceId, kind, anchor)
      else {
        const id = start(kind, `${kind}:message:${message.id}`)
        addAnchor(id, kind, anchor)
        status(id, kind, 'succeeded', { reason: 'result' })
      }
    },
    recordChunk(chunk) {
      if (closed) return
      if (chunk.type === 'sense_end') {
        const invalidArguments = chunk.security?.findings.some(
          (finding) => finding.code === 'schema.invalid-arguments',
        )
        const validation = callOccurrence(chunk.id, 'tool-validation')
        status(validation, 'tool-validation', invalidArguments ? 'rejected' : 'succeeded', {
          reason: invalidArguments ? 'validation' : 'normal',
          callId: chunk.id,
        })
        const authorization = callOccurrence(chunk.id, 'tool-authorization')
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
      } else if (chunk.type === 'sense_pending') {
        const id = callOccurrence(chunk.approvalId, 'tool-approval')
        status(id, 'tool-approval', 'waiting', {
          waitReason: 'approval',
          reason: 'approval',
          callId: chunk.approvalId,
        })
      } else if (chunk.type === 'sense_started') {
        const preflight = callOccurrence(chunk.id, 'tool-preflight')
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
        const approval = callOccurrences.get(`tool-approval:${chunk.id}`)
        const execution = callOccurrences.get(`tool-execution:${chunk.id}`)
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
