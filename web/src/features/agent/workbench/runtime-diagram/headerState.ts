import type { WorkflowOccurrence, WorkflowOccurrenceStatus } from '@chery/protocol'
import { WORKFLOW_HEADER_TEMPLATE, type HeaderTemplateNode } from './headerTemplate'

export interface HeaderScopeSelection {
  runId?: string
  unassignedRun?: boolean
  iteration?: number
  attempt?: number
  callId?: string
}
export interface HeaderCall {
  id: string
  name: string
  status: string
  current: boolean
  ordinal: number
}
export interface HeaderCallSource {
  id: string
  name: string
  status: string
  batchId?: string
  anchorIds?: string[]
}
export type HeaderSlotStatus = WorkflowOccurrenceStatus | 'idle' | 'unrecorded'
export interface HeaderSlotState {
  nodeId: string
  status: HeaderSlotStatus
  statusText: string
  occurrences: WorkflowOccurrence[]
  occurrence?: WorkflowOccurrence
}
export interface HeaderStateProjection {
  selection: HeaderScopeSelection
  scope: HeaderScopeSelection
  runs: string[]
  hasUnassignedRun: boolean
  iterations: number[]
  attempts: number[]
  calls: HeaderCall[]
  currentCallId?: string
  selectedCallId?: string
  followingCurrent: boolean
  slots: Record<string, HeaderSlotState>
  occurrences: WorkflowOccurrence[]
  coverage: string
}

export function headerStatusText(status: HeaderSlotStatus, waitReason?: string): string {
  if (status === 'waiting')
    return (
      {
        model: '等待模型',
        approval: '等待审批',
        answer: '等待回答',
        child: '等待子任务',
        retry: '等待重试',
        queue: '等待消费',
      }[waitReason ?? ''] ?? '等待继续'
    )
  return {
    running: '正在执行',
    succeeded: '已完成',
    failed: '失败',
    rejected: '已拒绝',
    cancelled: '已取消',
    interrupted: '已中断',
    unknown: '记录不完整',
    idle: '尚未发生',
    unrecorded: '未单独记录',
  }[status]
}

function matches(node: HeaderTemplateNode, occurrence: WorkflowOccurrence): boolean {
  if (!node.kinds.includes(occurrence.kind)) return false
  if (node.match === 'response')
    return (
      occurrence.reason === 'response' ||
      occurrence.anchors.some((anchor) => anchor.kind === 'message')
    )
  if (node.match === 'rejection')
    return occurrence.status === 'rejected' || occurrence.status === 'failed'
  if (node.match === 'wait')
    return (
      occurrence.status === 'waiting' &&
      (occurrence.waitReason === 'answer' || occurrence.waitReason === 'child')
    )
  return true
}

function lastNumber(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined))].sort(
    (a, b) => a - b,
  )
}

/** Select instances, never infer execution from template connectivity or tool names. */
export function projectHeaderState(input: {
  chatId: string
  occurrences: WorkflowOccurrence[]
  calls: HeaderCallSource[]
  selection?: HeaderScopeSelection
  currentRunId?: string
  recorded: boolean
  complete: boolean
}): HeaderStateProjection {
  const all = input.occurrences
    .filter((item) => item.chatId === input.chatId)
    .sort(
      (a, b) => a.firstSequence - b.firstSequence || a.occurrenceId.localeCompare(b.occurrenceId),
    )
  const selection = input.selection ?? {}
  const runs = [...new Set(all.flatMap((item) => (item.runId ? [item.runId] : [])))]
  if (input.currentRunId && !runs.includes(input.currentRunId)) runs.push(input.currentRunId)
  const hasUnassignedRun = all.some((item) => !item.runId)
  const runId =
    selection.unassignedRun && hasUnassignedRun
      ? undefined
      : selection.runId && runs.includes(selection.runId)
        ? selection.runId
        : (input.currentRunId ?? runs.at(-1))
  const run = all.filter((item) => item.runId === runId)
  const iterations = lastNumber(run.map((item) => item.iteration))
  const iteration =
    selection.iteration !== undefined && iterations.includes(selection.iteration)
      ? selection.iteration
      : iterations.at(-1)
  // Run-level intake/context/control facts remain visible throughout the selected iteration.
  const round = run.filter((item) => item.iteration === undefined || item.iteration === iteration)
  const attempts = lastNumber(
    round.filter((item) => item.iteration === iteration).map((item) => item.attempt),
  )
  const attempt =
    selection.attempt !== undefined && attempts.includes(selection.attempt)
      ? selection.attempt
      : attempts.at(-1)
  const attemptKinds = new Set([
    'request',
    'model',
    'retry',
    'tool-list',
    'tool-validation',
    'tool-authorization',
    'tool-approval',
    'tool-preflight',
    'tool-execution',
    'tool-result',
  ])
  const scoped = round.filter(
    (item) =>
      !attemptKinds.has(item.kind) || item.attempt === undefined || item.attempt === attempt,
  )
  const callIds = [...new Set(scoped.flatMap((item) => (item.callId ? [item.callId] : [])))]
  const batchIds = new Set(scoped.flatMap((item) => (item.batchId ? [item.batchId] : [])))
  const anchorIds = new Set(
    scoped.flatMap((item) =>
      item.anchors
        .filter((anchor) => !anchor.chatId || anchor.chatId === input.chatId)
        .map((anchor) => anchor.id),
    ),
  )
  for (const call of input.calls) {
    if (
      !callIds.includes(call.id) &&
      (anchorIds.has(call.id) ||
        (call.batchId && batchIds.has(call.batchId)) ||
        call.anchorIds?.some((id) => anchorIds.has(id)))
    )
      callIds.push(call.id)
  }
  // Canonical-only histories may list calls, but never supply step success evidence.
  if (!all.length && !runId) callIds.push(...input.calls.map((call) => call.id))
  const currentCallId = scoped
    .filter((item) => item.callId && (item.status === 'running' || item.status === 'waiting'))
    .sort((a, b) => a.lastSequence - b.lastSequence)
    .at(-1)?.callId
  const selectedCallId =
    selection.callId && callIds.includes(selection.callId)
      ? selection.callId
      : (currentCallId ?? callIds.at(-1))
  const names = new Map(input.calls.map((call) => [call.id, call]))
  const calls = callIds.map((id, index): HeaderCall => {
    const occurrence = scoped
      .filter((item) => item.callId === id)
      .sort((a, b) => a.lastSequence - b.lastSequence)
      .at(-1)
    return {
      id,
      name: names.get(id)?.name ?? '工具调用',
      status: occurrence?.status ?? 'unknown',
      current: id === currentCallId,
      ordinal: index + 1,
    }
  })
  const selectedCall = scoped.filter((item) => item.callId === selectedCallId)
  const selectedBatchId = selectedCall.findLast((item) => item.batchId)?.batchId
  const slots = Object.fromEntries(
    WORKFLOW_HEADER_TEMPLATE.nodes.map((node) => {
      const occurrences = scoped
        .filter((item) => {
          if (!matches(node, item)) return false
          if (node.id === 'tool-list') return !selectedBatchId || item.batchId === selectedBatchId
          if (node.group === 'tools') return !!selectedCallId && item.callId === selectedCallId
          return true
        })
        .sort(
          (a, b) => a.lastSequence - b.lastSequence || a.occurrenceId.localeCompare(b.occurrenceId),
        )
      const occurrence = occurrences.at(-1)
      const status: HeaderSlotStatus =
        node.match === 'unobserved'
          ? 'unrecorded'
          : occurrence
            ? occurrence.orderQuality === 'exact'
              ? occurrence.status
              : 'unknown'
            : input.recorded && input.complete
              ? 'idle'
              : 'unknown'
      return [
        node.id,
        {
          nodeId: node.id,
          status,
          statusText: headerStatusText(status, occurrence?.waitReason),
          occurrences,
          occurrence,
        },
      ]
    }),
  )
  return {
    selection,
    scope: {
      runId,
      unassignedRun: !runId && hasUnassignedRun,
      iteration,
      attempt,
      callId: selectedCallId,
    },
    runs,
    hasUnassignedRun,
    iterations,
    attempts,
    calls,
    currentCallId,
    selectedCallId,
    followingCurrent: !selection.callId || !callIds.includes(selection.callId),
    slots,
    occurrences: scoped,
    coverage: !input.recorded
      ? '步骤未同步 / 未记录'
      : !input.complete
        ? '记录不完整；空白步骤不可判定'
        : '仅显示实际记录的步骤状态',
  }
}
