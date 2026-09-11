import { createHash } from 'node:crypto'
import type {
  WorkflowContentAnchor,
  WorkflowOccurrenceStatus,
  WorkflowStepKind,
  WorkflowStepReason,
  WorkflowWaitReason,
} from '@chery/protocol'
import { getMessages, getRootChatId } from '@/db/chat.js'
import { getConversationBranchByChat, getConversationTask } from '@/db/conversationBranch.js'
import {
  appendWorkflowJournalEvents,
  readWorkflowStepSnapshot,
  recordWorkflowJournalGap,
  type WorkflowJournalEventInput,
} from '@/db/workflowJournal.js'

export const WORKFLOW_STEP_LABELS: Record<WorkflowStepKind, string> = {
  submission: '提交请求',
  queue: '等待执行',
  context: '准备上下文',
  command: '注入指令',
  input: '接入输入',
  request: '准备模型请求',
  model: '模型交互',
  retry: '模型重试',
  'tool-list': '工具调用清单',
  'tool-validation': '校验工具调用',
  'tool-authorization': '检查工具权限',
  'tool-approval': '等待工具审批',
  'tool-preflight': '工具执行前检查',
  'tool-execution': '执行工具',
  'tool-result': '记录工具结果',
  checkpoint: '记录本轮结果',
  'loop-decision': '判断后续执行',
  dispatch: '派发子任务',
  'child-run': '子 Agent 执行',
  'child-return': '子任务返回',
  'parent-receive': '父 Agent 接收',
  wake: '唤醒后续执行',
  'compact-request': '请求上下文压缩',
  'compact-summary': '生成上下文摘要',
  'compact-applied': '采用上下文摘要',
  result: '本轮结果',
  unknown: '未确认步骤',
}

export interface WorkflowIdentity {
  rootChatId: string
  taskId?: string
  branchId?: string
}

export interface WorkflowStepWrite {
  kind: WorkflowStepKind
  key: string
  status?: WorkflowOccurrenceStatus
  waitReason?: WorkflowWaitReason
  reason?: WorkflowStepReason
  eventKey?: string
  runId?: string
  contextStageId?: string
  iteration?: number
  attempt?: number
  batchId?: string
  callId?: string
  anchor?: WorkflowContentAnchor
  parentOccurrenceId?: string
  causeOccurrenceId?: string
  at?: number
  /** Chat scope is used for waits which can finish in a later resumed run. */
  scope?: 'run' | 'chat'
}

export interface FinishActiveWorkflowStepsOptions {
  kind?: WorkflowStepKind
  waitReason?: WorkflowWaitReason
  batchId?: string
  callId?: string
  anchor?: Pick<WorkflowContentAnchor, 'kind' | 'id'>
  status: Extract<
    WorkflowOccurrenceStatus,
    'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'interrupted'
  >
  reason: WorkflowStepReason
  eventKey: string
  includeRunning?: boolean
}

function shortId(parts: readonly unknown[]): string {
  return `wf:${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`
}

export function resolveWorkflowIdentity(chatId: string): WorkflowIdentity {
  const executionRootId = getRootChatId(chatId)
  const branch = getConversationBranchByChat(executionRootId)
  const task = branch ? getConversationTask(branch.taskId) : undefined
  return {
    rootChatId: task?.originalChatId ?? executionRootId,
    ...(task ? { taskId: task.taskId } : {}),
    ...(branch ? { branchId: branch.branchId } : {}),
  }
}

export function workflowContextStageId(chatId: string): string {
  const summary = getMessages(chatId).findLast(
    (message) => !!message.context_compaction && message.role === 'assistant',
  )
  return `${chatId}:${summary?.id ?? 'start'}`
}

function safelyRecordGap(input: {
  rootChatId: string
  chatId: string
  runId?: string
  contextStageId?: string
}): void {
  try {
    recordWorkflowJournalGap({ ...input, reason: 'write-failed' })
  } catch {
    /* Detailed observation remains optional even when the database is unavailable. */
  }
}

/** Records a stable one-shot or cross-run step without requiring an active run recorder. */
export function recordWorkflowStep(chatId: string, input: WorkflowStepWrite): string | undefined {
  let gap:
    { rootChatId: string; chatId: string; runId?: string; contextStageId?: string } | undefined
  try {
    const identity = resolveWorkflowIdentity(chatId)
    const occurrenceId = shortId([
      identity.rootChatId,
      chatId,
      input.scope === 'chat' ? undefined : input.runId,
      input.kind,
      input.key,
    ])
    const existing =
      input.scope === 'chat'
        ? readWorkflowStepSnapshot(identity.rootChatId).active.find(
            (occurrence) => occurrence.occurrenceId === occurrenceId,
          )
        : undefined
    const contextStageId =
      existing?.contextStageId ?? input.contextStageId ?? workflowContextStageId(chatId)
    gap = {
      rootChatId: identity.rootChatId,
      chatId,
      ...(input.runId ? { runId: input.runId } : {}),
      contextStageId,
    }
    const common = {
      ...identity,
      chatId,
      occurrenceId,
      kind: input.kind,
      label: WORKFLOW_STEP_LABELS[input.kind],
      contextStageId,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.parentOccurrenceId ? { parentOccurrenceId: input.parentOccurrenceId } : {}),
      ...(input.causeOccurrenceId ? { causeOccurrenceId: input.causeOccurrenceId } : {}),
      ...(input.at !== undefined ? { at: input.at } : {}),
    } satisfies Omit<WorkflowJournalEventInput, 'sourceKey' | 'eventKind'>
    const events: WorkflowJournalEventInput[] = [
      {
        ...common,
        sourceKey: `${occurrenceId}:started`,
        eventKind: 'started',
        status: 'running',
      },
    ]
    if (input.anchor)
      events.push({
        ...common,
        sourceKey: `${occurrenceId}:anchor:${input.anchor.kind}:${input.anchor.id}`,
        eventKind: 'anchor-added',
        anchor: input.anchor,
      })
    if (input.status && (input.status !== 'running' || input.waitReason || input.reason))
      events.push({
        ...common,
        sourceKey: `${occurrenceId}:status:${input.eventKey ?? `${input.status}:${input.waitReason ?? ''}`}`,
        eventKind: 'status',
        status: input.status,
        ...(input.waitReason ? { waitReason: input.waitReason } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      })
    appendWorkflowJournalEvents(events)
    return occurrenceId
  } catch {
    if (gap) safelyRecordGap(gap)
    return undefined
  }
}

/** Ends durable waits after their resolving action, even when that action starts a new run. */
export function finishActiveWorkflowSteps(
  chatId: string,
  options: FinishActiveWorkflowStepsOptions,
): void {
  let gap:
    { rootChatId: string; chatId: string; runId?: string; contextStageId?: string } | undefined
  try {
    const identity = resolveWorkflowIdentity(chatId)
    gap = {
      rootChatId: identity.rootChatId,
      chatId,
      contextStageId: workflowContextStageId(chatId),
    }
    const matches = readWorkflowStepSnapshot(identity.rootChatId).active.filter(
      (occurrence) =>
        occurrence.chatId === chatId &&
        (occurrence.status === 'waiting' ||
          (options.includeRunning === true && occurrence.status === 'running')) &&
        (!options.kind || occurrence.kind === options.kind) &&
        (!options.waitReason || occurrence.waitReason === options.waitReason) &&
        (!options.batchId || occurrence.batchId === options.batchId) &&
        (!options.callId || occurrence.callId === options.callId) &&
        (!options.anchor ||
          occurrence.anchors.some(
            (anchor) => anchor.kind === options.anchor!.kind && anchor.id === options.anchor!.id,
          )),
    )
    for (let offset = 0; offset < matches.length; offset += 100) {
      const batch = matches.slice(offset, offset + 100)
      appendWorkflowJournalEvents(
        batch.map((occurrence) => ({
          rootChatId: occurrence.rootChatId,
          chatId: occurrence.chatId,
          occurrenceId: occurrence.occurrenceId,
          sourceKey: `${occurrence.occurrenceId}:status:${options.eventKey}`,
          eventKind: 'status' as const,
          kind: occurrence.kind,
          label: occurrence.label,
          status: options.status,
          reason: options.reason,
          ...(occurrence.taskId ? { taskId: occurrence.taskId } : {}),
          ...(occurrence.branchId ? { branchId: occurrence.branchId } : {}),
          contextStageId: occurrence.contextStageId,
          ...(occurrence.runId ? { runId: occurrence.runId } : {}),
          ...(occurrence.iteration !== undefined ? { iteration: occurrence.iteration } : {}),
          ...(occurrence.attempt !== undefined ? { attempt: occurrence.attempt } : {}),
          ...(occurrence.batchId ? { batchId: occurrence.batchId } : {}),
          ...(occurrence.callId ? { callId: occurrence.callId } : {}),
        })),
      )
    }
  } catch {
    if (gap) safelyRecordGap(gap)
  }
}
