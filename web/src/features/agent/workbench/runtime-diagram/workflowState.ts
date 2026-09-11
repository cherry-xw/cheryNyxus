import type {
  WorkflowFact,
  WorkflowGap,
  WorkflowHistoryResponse,
  WorkflowOccurrence,
  WorkflowOccurrenceStatus,
  WorkflowStepEvent,
  WorkflowStepSnapshot,
  WorkflowUpdated,
} from '@chery/protocol'

const TERMINAL = new Set<WorkflowOccurrenceStatus>([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'interrupted',
])

export interface WorkflowClientState {
  rootChatId: string
  revision: number
  upperSequence: number
  occurrences: Record<string, WorkflowOccurrence>
  recentEvents: WorkflowStepEvent[]
  gaps: WorkflowGap[]
  hasEarlier: boolean
  historyComplete: boolean
}

const LEGACY_KIND: Record<WorkflowFact['nodeId'], WorkflowOccurrence['kind']> = {
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

function replayGaps(history: WorkflowHistoryResponse, upperSequence: number): WorkflowGap[] {
  return (history.gaps ?? [])
    .filter((gap) => gap.fromSequence <= upperSequence)
    .map((gap) => ({ ...gap, toSequence: Math.min(gap.toSequence, upperSequence) }))
}

export function workflowReplayLength(history: WorkflowHistoryResponse | undefined): number {
  if (!history) return 0
  if (history.events?.length) return history.events.length
  if (history.occurrences?.length) return history.occurrences.length
  return history.facts.length || !history.historyComplete || history.gaps?.length ? 1 : 0
}

/** Builds a detached replay frame without consulting or mutating the live slice. */
export function buildWorkflowReplayState(
  history: WorkflowHistoryResponse,
  index: number,
): WorkflowClientState {
  const events = [...(history.events ?? [])].sort(
    (left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId),
  )
  if (events.length) {
    const selected = events.slice(0, Math.max(0, index) + 1)
    const upperSequence = selected.at(-1)?.sequence ?? 0
    const gaps = replayGaps(history, upperSequence)
    return installWorkflowSnapshot({
      rootChatId: selected[0]?.rootChatId ?? history.chatId,
      revision: history.revision ?? selected.at(-1)?.revision ?? 0,
      upperSequence,
      active: [],
      recentEvents: selected,
      gaps,
      hasEarlier: false,
      historyComplete: history.historyComplete && gaps.length === 0,
    })
  }

  const occurrences = [...(history.occurrences ?? [])].sort(
    (left, right) =>
      left.firstSequence - right.firstSequence ||
      left.occurrenceId.localeCompare(right.occurrenceId),
  )
  if (occurrences.length) {
    const selected = occurrences.slice(0, Math.max(0, index) + 1)
    const upperSequence = Math.max(0, ...selected.map((occurrence) => occurrence.lastSequence))
    const gaps = replayGaps(history, upperSequence)
    return {
      rootChatId: selected[0]?.rootChatId ?? history.chatId,
      revision: history.revision ?? 0,
      upperSequence,
      occurrences: Object.fromEntries(
        selected.map((occurrence) => [occurrence.occurrenceId, structuredClone(occurrence)]),
      ),
      recentEvents: [],
      gaps,
      hasEarlier: false,
      historyComplete: history.historyComplete && gaps.length === 0,
    }
  }

  const firstFact = history.facts.slice().sort((left, right) => left.orderKey - right.orderKey)[0]
  const upperSequence = history.upperSequence ?? history.boundary
  const occurrence: WorkflowOccurrence = {
    occurrenceId: `legacy:${history.contextStageId}:${history.boundary}`,
    rootChatId: history.chatId,
    chatId: history.chatId,
    contextStageId: history.contextStageId,
    kind: firstFact ? LEGACY_KIND[firstFact.nodeId] : 'unknown',
    label: '旧记录 · 细节未记录',
    status: 'unknown',
    reason: 'legacy',
    anchors: [],
    startedAt: firstFact?.orderKey ?? 0,
    updatedAt: firstFact?.orderKey ?? 0,
    firstSequence: 0,
    lastSequence: upperSequence,
    orderQuality: 'reconstructed',
  }
  return {
    rootChatId: history.chatId,
    revision: history.revision ?? 0,
    upperSequence,
    occurrences: { [occurrence.occurrenceId]: occurrence },
    recentEvents: [],
    gaps: replayGaps(history, upperSequence),
    hasEarlier: false,
    historyComplete: false,
  }
}

function foldEvent(
  previous: WorkflowOccurrence | undefined,
  event: WorkflowStepEvent,
): WorkflowOccurrence {
  const previousTerminal = previous && TERMINAL.has(previous.status)
  const status = previousTerminal
    ? previous.status
    : (event.status ?? previous?.status ?? 'unknown')
  const anchors = previous ? [...previous.anchors] : []
  if (
    event.anchor &&
    !anchors.some(
      (anchor) =>
        anchor.kind === event.anchor!.kind &&
        anchor.id === event.anchor!.id &&
        anchor.chatId === event.anchor!.chatId,
    )
  )
    anchors.push(event.anchor)
  return {
    occurrenceId: previous?.occurrenceId ?? event.occurrenceId,
    rootChatId: previous?.rootChatId ?? event.rootChatId,
    chatId: previous?.chatId ?? event.chatId,
    ...(previous?.taskId || event.taskId ? { taskId: previous?.taskId ?? event.taskId } : {}),
    ...(previous?.branchId || event.branchId
      ? { branchId: previous?.branchId ?? event.branchId }
      : {}),
    contextStageId: previous?.contextStageId ?? event.contextStageId,
    ...(previous?.runId || event.runId ? { runId: previous?.runId ?? event.runId } : {}),
    ...(previous?.iteration !== undefined || event.iteration !== undefined
      ? { iteration: previous?.iteration ?? event.iteration }
      : {}),
    ...(previous?.attempt !== undefined || event.attempt !== undefined
      ? { attempt: previous?.attempt ?? event.attempt }
      : {}),
    ...(previous?.batchId || event.batchId ? { batchId: previous?.batchId ?? event.batchId } : {}),
    ...(previous?.callId || event.callId ? { callId: previous?.callId ?? event.callId } : {}),
    ...(previous?.parentOccurrenceId || event.parentOccurrenceId
      ? { parentOccurrenceId: previous?.parentOccurrenceId ?? event.parentOccurrenceId }
      : {}),
    ...(previous?.causeOccurrenceId || event.causeOccurrenceId
      ? { causeOccurrenceId: previous?.causeOccurrenceId ?? event.causeOccurrenceId }
      : {}),
    kind: previous?.kind ?? event.kind,
    label: event.label,
    status,
    ...(status === 'waiting' && (event.waitReason || previous?.waitReason)
      ? { waitReason: event.waitReason ?? previous?.waitReason }
      : {}),
    ...(event.reason || previous?.reason ? { reason: event.reason ?? previous?.reason } : {}),
    anchors,
    startedAt: previous?.startedAt ?? event.at,
    updatedAt: event.at,
    ...(TERMINAL.has(status) ? { endedAt: previous?.endedAt ?? event.at } : {}),
    firstSequence: previous?.firstSequence ?? event.sequence,
    lastSequence: event.sequence,
    orderQuality:
      previous?.orderQuality === 'reconstructed' || event.orderQuality === 'reconstructed'
        ? 'reconstructed'
        : 'exact',
  }
}

export function installWorkflowSnapshot(snapshot: WorkflowStepSnapshot): WorkflowClientState {
  const occurrences: Record<string, WorkflowOccurrence> = {}
  for (const event of snapshot.recentEvents)
    occurrences[event.occurrenceId] = foldEvent(occurrences[event.occurrenceId], event)
  for (const occurrence of snapshot.active)
    occurrences[occurrence.occurrenceId] = structuredClone(occurrence)
  return {
    rootChatId: snapshot.rootChatId,
    revision: snapshot.revision,
    upperSequence: snapshot.upperSequence,
    occurrences,
    recentEvents: structuredClone(snapshot.recentEvents),
    gaps: structuredClone(snapshot.gaps),
    hasEarlier: snapshot.hasEarlier,
    historyComplete: snapshot.historyComplete,
  }
}

export type WorkflowUpdateDecision =
  | { kind: 'applied'; state: WorkflowClientState }
  | { kind: 'ignored' }
  | { kind: 'reload'; reason: 'stream' | 'revision' | 'sequence' | 'invalidated' }

export function applyWorkflowUpdate(
  current: WorkflowClientState | undefined,
  update: WorkflowUpdated,
  lease: { subscriptionId: string; streamId: string },
): WorkflowUpdateDecision {
  if (update.subscriptionId !== lease.subscriptionId || update.streamId !== lease.streamId)
    return { kind: 'ignored' }
  if (update.invalidated) return { kind: 'reload', reason: 'invalidated' }
  if (!current || update.baseRevision === undefined || update.revision === undefined)
    return { kind: 'reload', reason: 'revision' }
  if (update.revision <= current.revision) return { kind: 'ignored' }
  if (update.baseRevision !== current.revision) return { kind: 'reload', reason: 'revision' }
  const events = update.events ?? []
  const gaps = update.gaps ?? []
  const expected = current.upperSequence + 1
  const firstSequence = Math.min(
    events[0]?.sequence ?? Number.POSITIVE_INFINITY,
    gaps[0]?.fromSequence ?? Number.POSITIVE_INFINITY,
  )
  if (firstSequence !== Number.POSITIVE_INFINITY && firstSequence !== expected)
    return { kind: 'reload', reason: 'sequence' }
  const occurrences = { ...current.occurrences }
  for (const event of events)
    occurrences[event.occurrenceId] = foldEvent(occurrences[event.occurrenceId], event)
  const upperSequence = Math.max(
    current.upperSequence,
    ...events.map((event) => event.sequence),
    ...gaps.map((gap) => gap.toSequence),
  )
  return {
    kind: 'applied',
    state: {
      ...current,
      revision: update.revision,
      upperSequence,
      occurrences,
      recentEvents: [...current.recentEvents, ...events].slice(-500),
      gaps: [...current.gaps, ...gaps].slice(-100),
      historyComplete: current.historyComplete && gaps.length === 0,
    },
  }
}

export function installWorkflowHistory(
  current: WorkflowClientState,
  occurrences: readonly WorkflowOccurrence[],
  events: readonly WorkflowStepEvent[],
  gaps: readonly WorkflowGap[],
): WorkflowClientState {
  const merged = { ...current.occurrences }
  for (const occurrence of occurrences)
    merged[occurrence.occurrenceId] = structuredClone(occurrence)
  return {
    ...current,
    occurrences: merged,
    recentEvents: [...events, ...current.recentEvents]
      .filter(
        (event, index, values) =>
          values.findIndex((candidate) => candidate.eventId === event.eventId) === index,
      )
      .sort((left, right) => left.sequence - right.sequence),
    gaps: [...gaps, ...current.gaps].filter(
      (gap, index, values) =>
        values.findIndex((candidate) => candidate.gapId === gap.gapId) === index,
    ),
    hasEarlier: false,
    historyComplete: current.historyComplete && gaps.length === 0,
  }
}
