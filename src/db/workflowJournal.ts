import { randomUUID } from 'node:crypto'
import type {
  WorkflowContentAnchor,
  WorkflowGap,
  WorkflowOccurrence,
  WorkflowOccurrenceStatus,
  WorkflowStepEvent,
  WorkflowStepEventKind,
  WorkflowStepKind,
  WorkflowStepReason,
  WorkflowStepSnapshot,
  WorkflowWaitReason,
} from '@chery/protocol'
import { getSoulDb } from './index.js'

const TERMINAL_STATUSES = new Set<WorkflowOccurrenceStatus>([
  'succeeded',
  'failed',
  'rejected',
  'cancelled',
  'interrupted',
])

export interface WorkflowJournalEventInput {
  eventId?: string
  sourceKey: string
  occurrenceId: string
  rootChatId: string
  chatId: string
  eventKind: WorkflowStepEventKind
  kind: WorkflowStepKind
  label: string
  status?: WorkflowOccurrenceStatus
  waitReason?: WorkflowWaitReason
  reason?: WorkflowStepReason
  taskId?: string
  branchId?: string
  contextStageId: string
  runId?: string
  iteration?: number
  attempt?: number
  batchId?: string
  callId?: string
  parentOccurrenceId?: string
  causeOccurrenceId?: string
  anchor?: WorkflowContentAnchor
  at?: number
  orderQuality?: 'exact' | 'reconstructed'
}

export interface WorkflowJournalCommit {
  rootChatId: string
  baseRevision: number
  revision: number
  events: WorkflowStepEvent[]
  gaps: WorkflowGap[]
  invalidated?: boolean
}

const commitListeners = new Set<(commit: WorkflowJournalCommit) => void>()

export function onWorkflowJournalCommit(
  listener: (commit: WorkflowJournalCommit) => void,
): () => void {
  commitListeners.add(listener)
  return () => commitListeners.delete(listener)
}

function publishCommit(commit: WorkflowJournalCommit): void {
  for (const listener of commitListeners) {
    try {
      listener(commit)
    } catch {
      /* A projection is never allowed to roll back a committed fact. */
    }
  }
}

export function publishWorkflowJournalInvalidation(
  rootChatId: string,
  baseRevision: number,
  revision: number,
): void {
  publishCommit({
    rootChatId,
    baseRevision,
    revision,
    events: [],
    gaps: [],
    invalidated: true,
  })
}

function ensureRoot(rootChatId: string): {
  nextSequence: number
  revision: number
  historyComplete: boolean
} {
  const db = getSoulDb()
  db.prepare(
    `INSERT INTO workflow_journal_roots
      (root_chat_id, next_sequence, revision, history_complete, updated_at)
     VALUES (?, 1, 0, 1, ?)
     ON CONFLICT(root_chat_id) DO NOTHING`,
  ).run(rootChatId, Date.now())
  const row = db
    .prepare(
      'SELECT next_sequence, revision, history_complete FROM workflow_journal_roots WHERE root_chat_id = ?',
    )
    .get(rootChatId) as {
    next_sequence: number
    revision: number
    history_complete: number
  }
  return {
    nextSequence: row.next_sequence,
    revision: row.revision,
    historyComplete: row.history_complete === 1,
  }
}

function parseOccurrence(payload: string): WorkflowOccurrence {
  return JSON.parse(payload) as WorkflowOccurrence
}

function parseEvent(payload: string): WorkflowStepEvent {
  return JSON.parse(payload) as WorkflowStepEvent
}

function occurrenceFromEvent(
  event: WorkflowStepEvent,
  previous?: WorkflowOccurrence,
): WorkflowOccurrence {
  const status = previous?.status ?? event.status ?? 'unknown'
  const nextStatus =
    previous && TERMINAL_STATUSES.has(previous.status) ? previous.status : (event.status ?? status)
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
    label: event.label || previous?.label || '未命名步骤',
    status: nextStatus,
    ...(nextStatus === 'waiting' && event.waitReason
      ? { waitReason: event.waitReason }
      : previous?.waitReason && nextStatus === 'waiting'
        ? { waitReason: previous.waitReason }
        : {}),
    ...(event.reason || previous?.reason ? { reason: event.reason ?? previous?.reason } : {}),
    anchors,
    startedAt: previous?.startedAt ?? event.at,
    updatedAt: event.at,
    ...(TERMINAL_STATUSES.has(nextStatus) ? { endedAt: previous?.endedAt ?? event.at } : {}),
    firstSequence: previous?.firstSequence ?? event.sequence,
    lastSequence: event.sequence,
    orderQuality:
      previous?.orderQuality === 'reconstructed' || event.orderQuality === 'reconstructed'
        ? 'reconstructed'
        : 'exact',
  }
}

/**
 * Appends one short, single-root batch. Duplicate source keys are ignored and
 * a terminal occurrence can only receive relationship/anchor enrichment.
 */
export function appendWorkflowJournalEvents(
  inputs: readonly WorkflowJournalEventInput[],
): WorkflowJournalCommit | undefined {
  if (!inputs.length) return undefined
  if (inputs.length > 100) throw new Error('Workflow journal batches are limited to 100 events')
  const rootChatId = inputs[0]!.rootChatId
  if (inputs.some((input) => input.rootChatId !== rootChatId))
    throw new Error('Workflow journal batches must belong to one root')
  const db = getSoulDb()
  const commit = db.transaction((): WorkflowJournalCommit | undefined => {
    const root = ensureRoot(rootChatId)
    const accepted: Array<{ input: WorkflowJournalEventInput; previous?: WorkflowOccurrence }> = []
    const occurrences = new Map<string, WorkflowOccurrence | undefined>()
    const acceptedSourceKeys = new Set<string>()
    const acceptedEventIds = new Set<string>()
    for (const input of inputs) {
      if (
        acceptedSourceKeys.has(input.sourceKey) ||
        (input.eventId !== undefined && acceptedEventIds.has(input.eventId))
      )
        continue
      const duplicate = db
        .prepare(
          `SELECT 1 FROM workflow_step_events
           WHERE (root_chat_id = ? AND source_key = ?) OR event_id = ?`,
        )
        .get(rootChatId, input.sourceKey, input.eventId ?? '')
      if (duplicate) continue
      let previous = occurrences.get(input.occurrenceId)
      if (!occurrences.has(input.occurrenceId)) {
        const row = db
          .prepare('SELECT payload_json FROM workflow_occurrences WHERE occurrence_id = ?')
          .get(input.occurrenceId) as { payload_json: string } | undefined
        previous = row ? parseOccurrence(row.payload_json) : undefined
        occurrences.set(input.occurrenceId, previous)
      }
      if (
        previous &&
        (previous.rootChatId !== input.rootChatId ||
          previous.chatId !== input.chatId ||
          previous.kind !== input.kind ||
          previous.contextStageId !== input.contextStageId)
      )
        throw new Error('Workflow occurrence identity cannot change')
      const relationshipOnly = ['anchor-added', 'parent-linked', 'cause-linked'].includes(
        input.eventKind,
      )
      if (
        previous &&
        TERMINAL_STATUSES.has(previous.status) &&
        input.status &&
        input.status !== previous.status &&
        !relationshipOnly
      )
        continue
      accepted.push({ input, previous })
      acceptedSourceKeys.add(input.sourceKey)
      if (input.eventId !== undefined) acceptedEventIds.add(input.eventId)
      const preview: WorkflowStepEvent = {
        eventId: input.eventId ?? input.sourceKey,
        occurrenceId: input.occurrenceId,
        rootChatId,
        chatId: input.chatId,
        sequence: root.nextSequence + accepted.length - 1,
        revision: root.revision + 1,
        eventKind: input.eventKind,
        kind: input.kind,
        label: input.label.slice(0, 200),
        ...(input.status ? { status: input.status } : {}),
        ...(input.waitReason ? { waitReason: input.waitReason } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        contextStageId: input.contextStageId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(input.callId ? { callId: input.callId } : {}),
        ...(input.parentOccurrenceId ? { parentOccurrenceId: input.parentOccurrenceId } : {}),
        ...(input.causeOccurrenceId ? { causeOccurrenceId: input.causeOccurrenceId } : {}),
        ...(input.anchor ? { anchor: input.anchor } : {}),
        at: input.at ?? Date.now(),
        orderQuality: input.orderQuality ?? 'exact',
      }
      occurrences.set(input.occurrenceId, occurrenceFromEvent(preview, previous))
    }
    if (!accepted.length)
      return {
        rootChatId,
        baseRevision: root.revision,
        revision: root.revision,
        events: [],
        gaps: [],
      }
    const revision = root.revision + 1
    let sequence = root.nextSequence
    const events: WorkflowStepEvent[] = []
    for (const { input, previous } of accepted) {
      const at = input.at ?? Date.now()
      const event: WorkflowStepEvent = {
        eventId: input.eventId ?? randomUUID(),
        occurrenceId: input.occurrenceId,
        rootChatId,
        chatId: input.chatId,
        sequence,
        revision,
        eventKind: input.eventKind,
        kind: input.kind,
        label: input.label.slice(0, 200),
        ...(input.status ? { status: input.status } : {}),
        ...(input.waitReason ? { waitReason: input.waitReason } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.branchId ? { branchId: input.branchId } : {}),
        contextStageId: input.contextStageId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.batchId ? { batchId: input.batchId } : {}),
        ...(input.callId ? { callId: input.callId } : {}),
        ...(input.parentOccurrenceId ? { parentOccurrenceId: input.parentOccurrenceId } : {}),
        ...(input.causeOccurrenceId ? { causeOccurrenceId: input.causeOccurrenceId } : {}),
        ...(input.anchor ? { anchor: input.anchor } : {}),
        at,
        orderQuality: input.orderQuality ?? 'exact',
      }
      const occurrence = occurrenceFromEvent(event, previous)
      db.prepare(
        `INSERT INTO workflow_step_events
          (event_id, root_chat_id, root_sequence, revision, occurrence_id, source_key,
           source_chat_id, branch_id, context_stage_id, run_id, event_kind, order_quality,
           payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.eventId,
        rootChatId,
        sequence,
        revision,
        event.occurrenceId,
        input.sourceKey,
        event.chatId,
        event.branchId ?? null,
        event.contextStageId,
        event.runId ?? null,
        event.eventKind,
        event.orderQuality,
        JSON.stringify(event),
        at,
      )
      db.prepare(
        `INSERT INTO workflow_occurrences
          (occurrence_id, root_chat_id, source_chat_id, task_id, branch_id, context_stage_id,
           run_id, iteration, attempt, batch_id, call_id, kind, status, first_sequence,
           last_sequence, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(occurrence_id) DO UPDATE SET
           status=excluded.status,
           last_sequence=excluded.last_sequence,
           payload_json=excluded.payload_json,
           updated_at=excluded.updated_at`,
      ).run(
        occurrence.occurrenceId,
        occurrence.rootChatId,
        occurrence.chatId,
        occurrence.taskId ?? null,
        occurrence.branchId ?? null,
        occurrence.contextStageId,
        occurrence.runId ?? null,
        occurrence.iteration ?? null,
        occurrence.attempt ?? null,
        occurrence.batchId ?? null,
        occurrence.callId ?? null,
        occurrence.kind,
        occurrence.status,
        occurrence.firstSequence,
        occurrence.lastSequence,
        JSON.stringify(occurrence),
        occurrence.updatedAt,
      )
      events.push(event)
      sequence++
    }
    db.prepare(
      `UPDATE workflow_journal_roots
       SET next_sequence = ?, revision = ?, updated_at = ? WHERE root_chat_id = ?`,
    ).run(sequence, revision, Date.now(), rootChatId)
    return {
      rootChatId,
      baseRevision: root.revision,
      revision,
      events,
      gaps: [],
    }
  })()
  if (commit?.events.length) publishCommit(commit)
  return commit
}

export function recordWorkflowJournalGap(input: {
  rootChatId: string
  chatId?: string
  runId?: string
  contextStageId?: string
  reason: WorkflowGap['reason']
}): WorkflowJournalCommit {
  const db = getSoulDb()
  const commit = db.transaction((): WorkflowJournalCommit => {
    const root = ensureRoot(input.rootChatId)
    const revision = root.revision + 1
    const gap: WorkflowGap = {
      gapId: randomUUID(),
      rootChatId: input.rootChatId,
      fromSequence: root.nextSequence,
      toSequence: root.nextSequence,
      ...(input.chatId ? { chatId: input.chatId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.contextStageId ? { contextStageId: input.contextStageId } : {}),
      reason: input.reason,
    }
    db.prepare(
      `INSERT INTO workflow_journal_gaps
        (gap_id, root_chat_id, from_sequence, to_sequence, source_chat_id, run_id,
         context_stage_id, reason, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      gap.gapId,
      gap.rootChatId,
      gap.fromSequence,
      gap.toSequence,
      gap.chatId ?? null,
      gap.runId ?? null,
      gap.contextStageId ?? null,
      gap.reason,
      JSON.stringify(gap),
      Date.now(),
    )
    db.prepare(
      `UPDATE workflow_journal_roots
       SET next_sequence = ?, revision = ?, history_complete = 0, updated_at = ?
       WHERE root_chat_id = ?`,
    ).run(root.nextSequence + 1, revision, Date.now(), input.rootChatId)
    return {
      rootChatId: input.rootChatId,
      baseRevision: root.revision,
      revision,
      events: [],
      gaps: [gap],
    }
  })()
  publishCommit(commit)
  return commit
}

export interface WorkflowJournalPageOptions {
  rootChatId: string
  upperSequence?: number
  afterSequence?: number
  historyGeneration?: number
  limit?: number
  branchId?: string
  chatId?: string
  runId?: string
  contextStageId?: string
}

export function readWorkflowJournalPage(options: WorkflowJournalPageOptions): {
  revision: number
  historyGeneration: number
  upperSequence: number
  events: WorkflowStepEvent[]
  occurrences: WorkflowOccurrence[]
  gaps: WorkflowGap[]
  complete: boolean
  historyComplete: boolean
} {
  const db = getSoulDb()
  const root = db
    .prepare(
      `SELECT next_sequence, revision, history_generation, history_complete
       FROM workflow_journal_roots WHERE root_chat_id = ?`,
    )
    .get(options.rootChatId) as
    | {
        next_sequence: number
        revision: number
        history_generation: number
        history_complete: number
      }
    | undefined
  const historyGeneration = root?.history_generation ?? 0
  if (options.historyGeneration !== undefined && options.historyGeneration !== historyGeneration)
    throw Object.assign(new Error('历史在加载期间发生变化，请重新加载'), { code: 'CONFLICT' })
  const upperSequence = options.upperSequence ?? Math.max(0, (root?.next_sequence ?? 1) - 1)
  const values: Array<string | number> = [
    options.rootChatId,
    options.afterSequence ?? 0,
    upperSequence,
  ]
  const filters = ['root_chat_id = ?', 'root_sequence > ?', 'root_sequence <= ?']
  if (options.branchId) {
    filters.push('branch_id = ?')
    values.push(options.branchId)
  }
  if (options.chatId) {
    filters.push('source_chat_id = ?')
    values.push(options.chatId)
  }
  if (options.runId) {
    filters.push('run_id = ?')
    values.push(options.runId)
  }
  if (options.contextStageId) {
    filters.push('context_stage_id = ?')
    values.push(options.contextStageId)
  }
  const limit = Math.max(1, Math.min(200, options.limit ?? 100))
  const rows = db
    .prepare(
      `SELECT payload_json FROM workflow_step_events
       WHERE ${filters.join(' AND ')} ORDER BY root_sequence ASC LIMIT ?`,
    )
    .all(...values, limit + 1) as Array<{ payload_json: string }>
  const complete = rows.length <= limit
  const events = rows.slice(0, limit).map((row) => parseEvent(row.payload_json))
  const occurrenceIds = [...new Set(events.map((event) => event.occurrenceId))]
  const occurrenceEventRows = occurrenceIds.length
    ? (db
        .prepare(
          `SELECT occurrence_id, payload_json FROM workflow_step_events
           WHERE root_chat_id = ?
             AND occurrence_id IN (${occurrenceIds.map(() => '?').join(',')})
              AND root_sequence <= ? ORDER BY root_sequence ASC`,
        )
        .all(options.rootChatId, ...occurrenceIds, upperSequence) as Array<{
        occurrence_id: string
        payload_json: string
      }>)
    : []
  const byId = new Map<string, WorkflowOccurrence>()
  for (const row of occurrenceEventRows) {
    const event = parseEvent(row.payload_json)
    byId.set(row.occurrence_id, occurrenceFromEvent(event, byId.get(row.occurrence_id)))
  }
  const occurrences = occurrenceIds
    .map((occurrenceId) => byId.get(occurrenceId))
    .filter((occurrence): occurrence is WorkflowOccurrence => !!occurrence)
  const gaps = (
    db
      .prepare(
        `SELECT payload_json FROM workflow_journal_gaps
         WHERE root_chat_id = ? AND from_sequence <= ? AND to_sequence > ?
         ORDER BY from_sequence ASC LIMIT 50`,
      )
      .all(options.rootChatId, upperSequence, options.afterSequence ?? 0) as Array<{
      payload_json: string
    }>
  ).map((row) => JSON.parse(row.payload_json) as WorkflowGap)
  return {
    revision: root?.revision ?? 0,
    historyGeneration,
    upperSequence,
    events,
    occurrences,
    gaps,
    complete,
    historyComplete: (root?.history_complete ?? 1) === 1 && gaps.length === 0,
  }
}

export function readWorkflowStepSnapshot(rootChatId: string, tailLimit = 80): WorkflowStepSnapshot {
  const db = getSoulDb()
  const rootRow = db
    .prepare(
      'SELECT next_sequence, revision, history_complete FROM workflow_journal_roots WHERE root_chat_id = ?',
    )
    .get(rootChatId) as
    { next_sequence: number; revision: number; history_complete: number } | undefined
  const root = {
    nextSequence: rootRow?.next_sequence ?? 1,
    revision: rootRow?.revision ?? 0,
    historyComplete: (rootRow?.history_complete ?? 1) === 1,
  }
  const upperSequence = Math.max(0, root.nextSequence - 1)
  const recentRows = db
    .prepare(
      `SELECT payload_json FROM (
         SELECT root_sequence, payload_json FROM workflow_step_events
         WHERE root_chat_id = ? ORDER BY root_sequence DESC LIMIT ?
       ) ORDER BY root_sequence ASC`,
    )
    .all(rootChatId, Math.max(1, Math.min(200, tailLimit))) as Array<{ payload_json: string }>
  const recentEvents = recentRows.map((row) => parseEvent(row.payload_json))
  const active = (
    db
      .prepare(
        `SELECT payload_json FROM workflow_occurrences
         WHERE root_chat_id = ? AND status IN ('running', 'waiting')
         ORDER BY first_sequence ASC LIMIT 200`,
      )
      .all(rootChatId) as Array<{ payload_json: string }>
  ).map((row) => parseOccurrence(row.payload_json))
  const gaps = (
    db
      .prepare(
        `SELECT payload_json FROM workflow_journal_gaps
         WHERE root_chat_id = ? ORDER BY from_sequence DESC LIMIT 50`,
      )
      .all(rootChatId) as Array<{ payload_json: string }>
  )
    .map((row) => JSON.parse(row.payload_json) as WorkflowGap)
    .reverse()
  const firstSequence = recentEvents[0]?.sequence ?? upperSequence + 1
  const earlier = db
    .prepare(
      'SELECT 1 FROM workflow_step_events WHERE root_chat_id = ? AND root_sequence < ? LIMIT 1',
    )
    .get(rootChatId, firstSequence)
  return {
    rootChatId,
    revision: root.revision,
    upperSequence,
    active,
    recentEvents,
    gaps,
    hasEarlier: !!earlier,
    historyComplete: root.historyComplete && gaps.length === 0,
  }
}

export function listWorkflowJournalStages(rootChatId: string): Array<{
  id: string
  quality: 'exact' | 'reconstructed'
}> {
  const rows = getSoulDb()
    .prepare(
      `SELECT context_stage_id,
              MIN(CASE WHEN order_quality = 'reconstructed' THEN 0 ELSE 1 END) AS exact
       FROM workflow_step_events WHERE root_chat_id = ?
       GROUP BY context_stage_id ORDER BY MIN(root_sequence) ASC LIMIT 200`,
    )
    .all(rootChatId) as Array<{ context_stage_id: string; exact: number }>
  return rows.map((row) => ({
    id: row.context_stage_id,
    quality: row.exact === 1 ? 'exact' : 'reconstructed',
  }))
}

export function deleteWorkflowJournalScope(
  rootChatId: string,
  chatId: string,
  deleteRoot: boolean,
): void {
  const db = getSoulDb()
  const commit = db.transaction((): WorkflowJournalCommit | undefined => {
    if (deleteRoot) {
      db.prepare('DELETE FROM workflow_step_events WHERE root_chat_id = ?').run(rootChatId)
      db.prepare('DELETE FROM workflow_occurrences WHERE root_chat_id = ?').run(rootChatId)
      db.prepare('DELETE FROM workflow_journal_gaps WHERE root_chat_id = ?').run(rootChatId)
      db.prepare('DELETE FROM workflow_journal_roots WHERE root_chat_id = ?').run(rootChatId)
      return undefined
    }
    const root = db
      .prepare('SELECT revision FROM workflow_journal_roots WHERE root_chat_id = ?')
      .get(rootChatId) as { revision: number } | undefined
    db.prepare(
      'DELETE FROM workflow_step_events WHERE root_chat_id = ? AND source_chat_id = ?',
    ).run(rootChatId, chatId)
    db.prepare(
      'DELETE FROM workflow_occurrences WHERE root_chat_id = ? AND source_chat_id = ?',
    ).run(rootChatId, chatId)
    db.prepare(
      'DELETE FROM workflow_journal_gaps WHERE root_chat_id = ? AND source_chat_id = ?',
    ).run(rootChatId, chatId)
    if (!root) return undefined
    db.prepare(
      `UPDATE workflow_journal_roots
       SET revision = revision + 1, history_generation = history_generation + 1,
           updated_at = ? WHERE root_chat_id = ?`,
    ).run(Date.now(), rootChatId)
    return {
      rootChatId,
      baseRevision: root.revision,
      revision: root.revision + 1,
      events: [],
      gaps: [],
      invalidated: true,
    }
  })()
  if (commit) publishCommit(commit)
}
