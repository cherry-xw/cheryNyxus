import type { WorkflowOccurrenceStatus, WorkflowStepKind } from '@chery/protocol'

export type WorkflowMotionSource = 'reset' | 'hydrate' | 'live'

export interface WorkflowMotionItem {
  occurrenceId: string
  rootChatId: string
  sourceHeaderId: string
  kind: WorkflowStepKind
  status: WorkflowOccurrenceStatus
  live: boolean
  orderQuality: 'exact' | 'reconstructed'
  firstSequence: number
  lastSequence: number
}

export interface WorkflowMotionContext {
  source: WorkflowMotionSource
  rootChatId: string
  synced: boolean
  replay: boolean
  suspended: boolean
  hidden: boolean
  spatial: boolean
  loops: boolean
  visibleOccurrenceIds?: ReadonlySet<string>
  limit?: number
}

export interface WorkflowMotionDecision {
  item: WorkflowMotionItem
  phase: 'enter' | 'settle' | 'status'
  spatial: boolean
}

const TERMINAL = new Set<WorkflowOccurrenceStatus>([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'interrupted',
])

function canAnimate(context: WorkflowMotionContext): boolean {
  return (
    context.source === 'live' &&
    context.synced &&
    !context.replay &&
    !context.suspended &&
    !context.hidden
  )
}

function visible(item: WorkflowMotionItem, context: WorkflowMotionContext): boolean {
  return !context.visibleOccurrenceIds || context.visibleOccurrenceIds.has(item.occurrenceId)
}

export function planWorkflowMotion(
  previous: readonly WorkflowMotionItem[],
  next: readonly WorkflowMotionItem[],
  context: WorkflowMotionContext,
): WorkflowMotionDecision[] {
  if (!canAnimate(context)) return []
  const before = new Map(previous.map((item) => [item.occurrenceId, item]))
  const decisions: WorkflowMotionDecision[] = []
  const ordered = [...next].sort(
    (left, right) =>
      left.lastSequence - right.lastSequence ||
      left.firstSequence - right.firstSequence ||
      left.occurrenceId.localeCompare(right.occurrenceId),
  )
  for (const item of ordered) {
    if (
      item.rootChatId !== context.rootChatId ||
      item.orderQuality !== 'exact' ||
      item.status === 'unknown' ||
      !visible(item, context)
    )
      continue
    const prior = before.get(item.occurrenceId)
    if (!prior) {
      if (TERMINAL.has(item.status))
        decisions.push({ item, phase: 'settle', spatial: context.spatial })
      else if (item.live) decisions.push({ item, phase: 'enter', spatial: context.spatial })
      continue
    }
    if (prior.status === item.status) continue
    decisions.push({
      item,
      phase: TERMINAL.has(item.status) ? 'settle' : 'status',
      spatial: context.spatial,
    })
  }
  const limit = Math.max(0, context.limit ?? 12)
  return limit ? decisions.slice(-limit) : []
}

export function shouldLoopWorkflowMotion(
  item: WorkflowMotionItem,
  context: WorkflowMotionContext,
): boolean {
  return (
    context.loops &&
    context.synced &&
    !context.replay &&
    !context.suspended &&
    !context.hidden &&
    item.rootChatId === context.rootChatId &&
    item.orderQuality === 'exact' &&
    item.live &&
    (item.status === 'running' || item.status === 'waiting') &&
    visible(item, context)
  )
}

export function selectWorkflowMotionLoops(
  items: readonly WorkflowMotionItem[],
  context: WorkflowMotionContext,
  limit = 8,
): WorkflowMotionItem[] {
  if (limit <= 0) return []
  return [...items]
    .sort(
      (left, right) =>
        right.lastSequence - left.lastSequence ||
        right.firstSequence - left.firstSequence ||
        right.occurrenceId.localeCompare(left.occurrenceId),
    )
    .filter((item) => shouldLoopWorkflowMotion(item, context))
    .slice(0, limit)
}

/** Replaces motion atomically so rapid facts can cancel stale visuals and settle latest state. */
export class WorkflowMotionRegistry {
  private readonly entries = new Map<string, () => void>()

  get size(): number {
    return this.entries.size
  }

  track(key: string, cancel: () => void): () => void {
    this.cancel(key)
    this.entries.set(key, cancel)
    return () => {
      if (this.entries.get(key) === cancel) this.entries.delete(key)
    }
  }

  cancel(key: string): void {
    const cancel = this.entries.get(key)
    if (!cancel) return
    this.entries.delete(key)
    cancel()
  }

  cancelAll(): void {
    const pending = [...this.entries.values()]
    this.entries.clear()
    for (const cancel of pending) cancel()
  }
}
