import type { ExecutionStep } from '@/services/agentApi'

export interface ExecutionTimingEvent {
  chatId: string
  runId?: string
  type: string
  data?: unknown
}

function dataOf(event: ExecutionTimingEvent): Record<string, unknown> {
  return event.data && typeof event.data === 'object'
    ? (event.data as Record<string, unknown>)
    : {}
}

function runIdOf(event: ExecutionTimingEvent, data: Record<string, unknown>): string | undefined {
  return typeof data.runId === 'string' ? data.runId : event.runId
}

export function executionStepKey(step: ExecutionStep): string {
  return `${step.chatId}:${step.runId}:${step.kind}:${step.id}`
}

function isTerminal(step: ExecutionStep): boolean {
  return step.status !== 'running'
}

function mergeStep(current: ExecutionStep | undefined, incoming: ExecutionStep): ExecutionStep {
  if (!current) return incoming
  const keepCurrentTerminal = isTerminal(current) && incoming.status === 'running'
  return {
    ...current,
    ...incoming,
    name: incoming.name || current.name,
    startedAt: Math.min(current.startedAt, incoming.startedAt),
    ...(keepCurrentTerminal
      ? { status: current.status, completedAt: current.completedAt }
      : incoming.completedAt === undefined && current.completedAt !== undefined
        ? { completedAt: current.completedAt }
        : {}),
  }
}

function upsertStep(steps: ExecutionStep[], incoming: ExecutionStep): ExecutionStep[] {
  const key = executionStepKey(incoming)
  const byKey = new Map(steps.map((step) => [executionStepKey(step), step]))
  byKey.set(key, mergeStep(byKey.get(key), incoming))
  return [...byKey.values()].sort(
    (a, b) => a.startedAt - b.startedAt || executionStepKey(a).localeCompare(executionStepKey(b)),
  )
}

function completeStep(
  steps: ExecutionStep[],
  match: (step: ExecutionStep) => boolean,
  status: ExecutionStep['status'],
  completedAt: number | undefined,
): ExecutionStep[] {
  return steps.map((step) =>
    match(step) && !isTerminal(step)
      ? {
          ...step,
          status,
          ...(completedAt !== undefined ? { completedAt } : {}),
        }
      : step,
  )
}

/**
 * Applies one timing-bearing event without side effects. The composite
 * chat/run/kind/id identity keeps duplicate snapshot/replay/live facts
 * idempotent, and a late start cannot reopen a terminal step.
 */
export function applyExecutionTimingEvent(
  current: readonly ExecutionStep[],
  event: ExecutionTimingEvent,
  fallbackNow?: number,
): ExecutionStep[] {
  const data = dataOf(event)
  const runId = runIdOf(event, data)
  let steps = current.map((step) => ({ ...step }))

  if (event.type === 'run.updated' && runId) {
    const status = data.status ?? data.state
    if (status === 'running') {
      steps = steps.filter((step) => step.chatId !== event.chatId || step.runId === runId)
    }
    if (status === 'paused' || status === 'completed' || status === 'failed') {
      const completedAt = typeof data.at === 'number' ? data.at : fallbackNow
      const terminalStatus: ExecutionStep['status'] =
        status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'cancelled'
      steps = completeStep(
        steps,
        (step) => step.chatId === event.chatId && step.runId === runId && step.status === 'running',
        terminalStatus,
        completedAt,
      )
    }
    return steps
  }

  if (event.type === 'turn.started' && runId && typeof data.turnId === 'string') {
    const startedAt =
      typeof data.createdAt === 'number'
        ? data.createdAt
        : typeof data.startedAt === 'number'
          ? data.startedAt
          : fallbackNow
    if (startedAt === undefined) return steps
    return upsertStep(steps, {
      id: data.turnId,
      runId,
      chatId: event.chatId,
      kind: 'model',
      name: '模型响应',
      status: 'running',
      startedAt,
    })
  }

  if (event.type === 'turn.completed' && typeof data.turnId === 'string') {
    const completedAt = typeof data.completedAt === 'number' ? data.completedAt : fallbackNow
    const existing = steps.find(
      (step) =>
        step.chatId === event.chatId &&
        step.kind === 'model' &&
        step.id === data.turnId &&
        (!runId || step.runId === runId),
    )
    if (existing) {
      return completeStep(
        steps,
        (step) => executionStepKey(step) === executionStepKey(existing),
        'completed',
        completedAt,
      )
    }
    if (!runId || completedAt === undefined) return steps
    return upsertStep(steps, {
      id: data.turnId,
      runId,
      chatId: event.chatId,
      kind: 'model',
      name: '模型响应',
      status: 'completed',
      startedAt: completedAt,
      completedAt,
    })
  }

  if (event.type === 'sense_started' && runId && typeof data.id === 'string') {
    const startedAt = typeof data.startedAt === 'number' ? data.startedAt : fallbackNow
    if (startedAt === undefined) return steps
    return upsertStep(steps, {
      id: data.id,
      runId,
      chatId: event.chatId,
      kind: 'tool',
      name: typeof data.senseName === 'string' ? data.senseName : '',
      status: 'running',
      startedAt,
    })
  }

  if (
    (event.type === 'accept' || event.type === 'rejected') &&
    typeof data.approvalId === 'string'
  ) {
    const completedAt = typeof data.completedAt === 'number' ? data.completedAt : fallbackNow
    const existing = steps.find(
      (step) =>
        step.chatId === event.chatId &&
        step.kind === 'tool' &&
        step.id === data.approvalId &&
        (!runId || step.runId === runId),
    )
    const failed =
      event.type === 'accept' &&
      typeof data.result === 'string' &&
      data.result.startsWith('感官执行失败：')
    const status: ExecutionStep['status'] =
      event.type === 'rejected' ? 'rejected' : failed ? 'failed' : 'completed'
    if (existing) {
      return completeStep(
        steps,
        (step) => executionStepKey(step) === executionStepKey(existing),
        status,
        completedAt,
      )
    }
    if (!runId || completedAt === undefined) return steps
    return upsertStep(steps, {
      id: data.approvalId,
      runId,
      chatId: event.chatId,
      kind: 'tool',
      name: typeof data.senseName === 'string' ? data.senseName : '',
      status,
      startedAt: completedAt,
      completedAt,
    })
  }

  if ((event.type === 'done' || event.type === 'error') && runId) {
    const completedAt =
      typeof data.completedAt === 'number'
        ? data.completedAt
        : typeof data.at === 'number'
          ? data.at
          : fallbackNow
    return completeStep(
      steps,
      (step) => step.chatId === event.chatId && step.runId === runId && step.status === 'running',
      event.type === 'error' ? 'failed' : data.canResume === true ? 'cancelled' : 'completed',
      completedAt,
    )
  }

  return steps
}
