import { getSoulDb } from './index.js'
import { getChat, getRootChatId } from './chat.js'
import { safeJsonParse } from '@/utils/json.js'

export type InteractionKind = 'approval' | 'question_batch'
export type InteractionStatus =
  'pending' | 'resolving' | 'completed' | 'expired' | 'cancelled' | 'blocked'

export interface InteractionRecord {
  interactionId: string
  kind: InteractionKind
  chatId: string
  rootChatId: string
  presetId?: string
  anchorNodeId?: string
  status: InteractionStatus
  payload: Record<string, unknown>
  deadlineAt?: number
  result?: Record<string, unknown>
  revision: number
  createdAt: number
  updatedAt: number
  completedAt?: number
}

interface InteractionRow {
  interaction_id: string
  kind: InteractionKind
  chat_id: string
  root_chat_id: string
  preset_id: string | null
  anchor_node_id: string | null
  status: InteractionStatus
  payload_json: string
  deadline_at: number | null
  result_json: string | null
  revision: number
  created_at: number
  updated_at: number
  completed_at: number | null
}

function toRecord(row: InteractionRow): InteractionRecord {
  return {
    interactionId: row.interaction_id,
    kind: row.kind,
    chatId: row.chat_id,
    rootChatId: row.root_chat_id,
    ...(row.preset_id ? { presetId: row.preset_id } : {}),
    ...(row.anchor_node_id ? { anchorNodeId: row.anchor_node_id } : {}),
    status: row.status,
    payload: safeJsonParse<Record<string, unknown>>(row.payload_json, {}),
    ...(row.deadline_at !== null ? { deadlineAt: row.deadline_at } : {}),
    ...(row.result_json
      ? { result: safeJsonParse<Record<string, unknown>>(row.result_json, {}) }
      : {}),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
  }
}

function presetIdOf(chatId: string): string | undefined {
  const metadata = getChat(chatId)?.metadata
  if (!metadata) return undefined
  const parsed = safeJsonParse<{ presetId?: string }>(metadata, {})
  return parsed.presetId
}

export function upsertPendingInteraction(input: {
  interactionId: string
  kind: InteractionKind
  chatId: string
  anchorNodeId?: string
  payload: Record<string, unknown>
  deadlineAt?: number
}): InteractionRecord {
  const db = getSoulDb()
  const now = Date.now()
  const rootChatId = getRootChatId(input.chatId)
  db.prepare(
    `INSERT INTO interactions
      (interaction_id, kind, chat_id, root_chat_id, preset_id, anchor_node_id, status,
       payload_json, deadline_at, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?)
     ON CONFLICT(interaction_id) DO UPDATE SET
       chat_id=excluded.chat_id, root_chat_id=excluded.root_chat_id,
       preset_id=COALESCE(excluded.preset_id, interactions.preset_id),
       anchor_node_id=COALESCE(excluded.anchor_node_id, interactions.anchor_node_id),
       status=CASE WHEN interactions.status='resolving' THEN 'resolving' ELSE 'pending' END,
       payload_json=excluded.payload_json,
       deadline_at=excluded.deadline_at, result_json=NULL, completed_at=NULL,
       revision=interactions.revision + 1, updated_at=excluded.updated_at
     WHERE interactions.status NOT IN ('completed','expired','cancelled')`,
  ).run(
    input.interactionId,
    input.kind,
    input.chatId,
    rootChatId,
    presetIdOf(input.chatId) ?? null,
    input.anchorNodeId ?? null,
    JSON.stringify(input.payload),
    input.deadlineAt ?? null,
    now,
    now,
  )
  return getInteraction(input.interactionId)!
}

/** Claim a pending interaction before doing asynchronous recovery work. */
export function claimInteraction(
  interactionId: string,
  expectedRevision: number,
): InteractionRecord | undefined {
  const now = Date.now()
  const change = getSoulDb()
    .prepare(
      `UPDATE interactions SET status='resolving', revision=revision+1, updated_at=?
       WHERE interaction_id=? AND revision=? AND status IN ('pending','blocked')`,
    )
    .run(now, interactionId, expectedRevision)
  return change.changes ? getInteraction(interactionId) : undefined
}

export function getInteraction(interactionId: string): InteractionRecord | undefined {
  const row = getSoulDb()
    .prepare('SELECT * FROM interactions WHERE interaction_id = ?')
    .get(interactionId) as InteractionRow | undefined
  return row ? toRecord(row) : undefined
}

export function listInteractions(input?: {
  presetId?: string
  includeActivity?: boolean
}): InteractionRecord[] {
  const clauses = input?.includeActivity
    ? ["status IN ('pending','resolving','blocked','completed','expired','cancelled')"]
    : ["status IN ('pending','resolving','blocked')"]
  const params: unknown[] = []
  if (input?.presetId) {
    clauses.push('preset_id = ?')
    params.push(input.presetId)
  }
  const rows = getSoulDb()
    .prepare(
      `SELECT * FROM interactions WHERE ${clauses.join(' AND ')}
       ORDER BY CASE WHEN status IN ('pending','resolving','blocked') THEN 0 ELSE 1 END,
                created_at ASC, updated_at DESC LIMIT 500`,
    )
    .all(...params) as InteractionRow[]
  return rows.map(toRecord)
}

export function transitionInteraction(
  interactionId: string,
  from: InteractionStatus[],
  status: InteractionStatus,
  result?: Record<string, unknown>,
): InteractionRecord | undefined {
  const now = Date.now()
  const placeholders = from.map(() => '?').join(',')
  const terminal = ['completed', 'expired', 'cancelled'].includes(status)
  const change = getSoulDb()
    .prepare(
      `UPDATE interactions SET status=?, result_json=?, revision=revision+1, updated_at=?,
       completed_at=? WHERE interaction_id=? AND status IN (${placeholders})`,
    )
    .run(
      status,
      result ? JSON.stringify(result) : null,
      now,
      terminal ? now : null,
      interactionId,
      ...from,
    )
  return change.changes ? getInteraction(interactionId) : undefined
}

export function listOverdueApprovals(now = Date.now()): InteractionRecord[] {
  const rows = getSoulDb()
    .prepare(
      "SELECT * FROM interactions WHERE kind='approval' AND status='pending' AND deadline_at IS NOT NULL AND deadline_at <= ?",
    )
    .all(now) as InteractionRow[]
  return rows.map(toRecord)
}
