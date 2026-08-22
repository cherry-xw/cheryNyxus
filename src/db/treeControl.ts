import { getSoulDb } from './index.js'

export type TreeControlOperationStatus =
  'pausing' | 'paused' | 'resuming' | 'partial' | 'completed' | 'superseded'

export type TreeControlTargetStatus =
  'paused' | 'resuming' | 'resumed' | 'delegated' | 'skipped' | 'failed'

export interface TreeControlTargetRow {
  pauseId: string
  chatId: string
  pausedRunId: string
  status: TreeControlTargetStatus
  resumeRunId?: string
  detail?: string
}

export interface TreeControlOperationRow {
  pauseId: string
  rootChatId: string
  status: TreeControlOperationStatus
  createdAt: number
  updatedAt: number
  targets: TreeControlTargetRow[]
}

function targetFromRow(row: Record<string, unknown>): TreeControlTargetRow {
  return {
    pauseId: String(row.pause_id),
    chatId: String(row.chat_id),
    pausedRunId: String(row.paused_run_id),
    status: row.status as TreeControlTargetStatus,
    ...(row.resume_run_id ? { resumeRunId: String(row.resume_run_id) } : {}),
    ...(row.detail ? { detail: String(row.detail) } : {}),
  }
}

export function createTreePause(pauseId: string, rootChatId: string): void {
  const now = Date.now()
  const db = getSoulDb()
  db.transaction(() => {
    db.prepare(
      `UPDATE tree_control_operations
       SET status = 'superseded', updated_at = ?
       WHERE root_chat_id = ? AND pause_id <> ?
         AND status IN ('pausing','paused','resuming','partial')`,
    ).run(now, rootChatId, pauseId)
    db.prepare(
      `INSERT INTO tree_control_operations (pause_id, root_chat_id, status, created_at, updated_at)
       VALUES (?, ?, 'pausing', ?, ?)
       ON CONFLICT(pause_id) DO NOTHING`,
    ).run(pauseId, rootChatId, now, now)
  })()
}

export function addTreePauseTarget(pauseId: string, chatId: string, pausedRunId: string): void {
  getSoulDb()
    .prepare(
      `INSERT INTO tree_control_targets
       (pause_id, chat_id, paused_run_id, status, updated_at)
       VALUES (?, ?, ?, 'paused', ?)
       ON CONFLICT(pause_id, chat_id) DO NOTHING`,
    )
    .run(pauseId, chatId, pausedRunId, Date.now())
}

export function updateTreeControlOperation(
  pauseId: string,
  status: TreeControlOperationStatus,
): void {
  getSoulDb()
    .prepare('UPDATE tree_control_operations SET status = ?, updated_at = ? WHERE pause_id = ?')
    .run(status, Date.now(), pauseId)
}

export function updateTreeControlTarget(
  pauseId: string,
  chatId: string,
  status: TreeControlTargetStatus,
  options: { pausedRunId?: string; resumeRunId?: string; detail?: string } = {},
): void {
  getSoulDb()
    .prepare(
      `UPDATE tree_control_targets
       SET status = ?, paused_run_id = COALESCE(?, paused_run_id),
           resume_run_id = COALESCE(?, resume_run_id), detail = ?, updated_at = ?
       WHERE pause_id = ? AND chat_id = ?`,
    )
    .run(
      status,
      options.pausedRunId ?? null,
      options.resumeRunId ?? null,
      options.detail ?? null,
      Date.now(),
      pauseId,
      chatId,
    )
}

export function getTreeControlOperation(pauseId: string): TreeControlOperationRow | undefined {
  const db = getSoulDb()
  const row = db
    .prepare('SELECT * FROM tree_control_operations WHERE pause_id = ?')
    .get(pauseId) as Record<string, unknown> | undefined
  if (!row) return undefined
  const targets = db
    .prepare('SELECT * FROM tree_control_targets WHERE pause_id = ? ORDER BY updated_at, chat_id')
    .all(pauseId) as Record<string, unknown>[]
  return {
    pauseId: String(row.pause_id),
    rootChatId: String(row.root_chat_id),
    status: row.status as TreeControlOperationStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    targets: targets.map(targetFromRow),
  }
}

export function getActiveTreeControl(rootChatId: string): TreeControlOperationRow | undefined {
  const row = getSoulDb()
    .prepare(
      `SELECT pause_id FROM tree_control_operations
       WHERE root_chat_id = ? AND status IN ('pausing','paused','resuming','partial')
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(rootChatId) as { pause_id: string } | undefined
  return row ? getTreeControlOperation(row.pause_id) : undefined
}

export function markActiveTreeTargetDelegated(rootChatId: string, chatId: string): void {
  const operation = getActiveTreeControl(rootChatId)
  const target = operation?.targets.find(
    (candidate) => candidate.chatId === chatId && ['paused', 'failed'].includes(candidate.status),
  )
  if (!operation || !target) return
  updateTreeControlTarget(operation.pauseId, chatId, 'delegated')
  refreshTreeControlStatus(operation.pauseId)
}

export function refreshTreeControlStatus(pauseId: string): TreeControlOperationStatus {
  const operation = getTreeControlOperation(pauseId)
  if (!operation) return 'completed'
  const pending = operation.targets.filter((target) =>
    ['paused', 'resuming', 'failed'].includes(target.status),
  )
  const status: TreeControlOperationStatus =
    pending.length === 0
      ? 'completed'
      : pending.some((target) => target.status === 'failed')
        ? 'partial'
        : pending.some((target) => target.status === 'resuming')
          ? 'resuming'
          : 'paused'
  updateTreeControlOperation(pauseId, status)
  return status
}
