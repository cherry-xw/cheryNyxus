import { randomUUID } from 'node:crypto'
import { getSoulDb } from './index.js'

export type ConversationBranchKind = 'original' | 'continuation' | 'detail'

export interface ConversationTaskRow {
  taskId: string
  originalChatId: string
  activeBranchId: string
  deliveryGeneration: number
  createdAt: number
  updatedAt: number
}

export interface ConversationBranchRow {
  branchId: string
  taskId: string
  chatId: string
  kind: ConversationBranchKind
  sourceBranchId?: string
  anchorRootChatId?: string
  anchorNodeId?: string
  contextSnapshot?: unknown
  runtimeSnapshot: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

function taskFromRow(row: Record<string, unknown>): ConversationTaskRow {
  return {
    taskId: String(row.task_id),
    originalChatId: String(row.original_chat_id),
    activeBranchId: String(row.active_branch_id),
    deliveryGeneration: Number(row.delivery_generation ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function branchFromRow(row: Record<string, unknown>): ConversationBranchRow {
  return {
    branchId: String(row.branch_id),
    taskId: String(row.task_id),
    chatId: String(row.chat_id),
    kind: String(row.kind) as ConversationBranchKind,
    ...(row.source_branch_id ? { sourceBranchId: String(row.source_branch_id) } : {}),
    ...(row.anchor_root_chat_id ? { anchorRootChatId: String(row.anchor_root_chat_id) } : {}),
    ...(row.anchor_node_id ? { anchorNodeId: String(row.anchor_node_id) } : {}),
    ...(row.context_snapshot_json
      ? { contextSnapshot: JSON.parse(String(row.context_snapshot_json)) as unknown }
      : {}),
    runtimeSnapshot: JSON.parse(String(row.runtime_snapshot_json)) as Record<string, unknown>,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** Lazily gives every legacy root chat an original task/branch identity. */
export function ensureConversationTask(
  rootChatId: string,
  runtimeSnapshot: Record<string, unknown>,
): { task: ConversationTaskRow; branch: ConversationBranchRow } {
  const db = getSoulDb()
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM conversation_tasks WHERE original_chat_id = ?')
      .get(rootChatId) as Record<string, unknown> | undefined
    if (existing) {
      const task = taskFromRow(existing)
      const branch = db
        .prepare('SELECT * FROM conversation_branches WHERE task_id = ? AND kind = ?')
        .get(task.taskId, 'original') as Record<string, unknown>
      return { task, branch: branchFromRow(branch) }
    }
    const now = Date.now()
    const taskId = randomUUID()
    const branchId = randomUUID()
    db.prepare(
      'INSERT INTO conversation_tasks (task_id, original_chat_id, active_branch_id, delivery_generation, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    ).run(taskId, rootChatId, branchId, now, now)
    db.prepare(
      `INSERT INTO conversation_branches
       (branch_id, task_id, chat_id, kind, runtime_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, 'original', ?, ?, ?)`,
    ).run(branchId, taskId, rootChatId, JSON.stringify(runtimeSnapshot), now, now)
    const created: { task: ConversationTaskRow; branch: ConversationBranchRow } = {
      task: { taskId, originalChatId: rootChatId, activeBranchId: branchId, deliveryGeneration: 0, createdAt: now, updatedAt: now },
      branch: {
        branchId,
        taskId,
        chatId: rootChatId,
        kind: 'original' as const,
        runtimeSnapshot,
        createdAt: now,
        updatedAt: now,
      },
    }
    return created
  })()
}

export function getConversationBranchByChat(chatId: string): ConversationBranchRow | undefined {
  const row = getSoulDb()
    .prepare('SELECT * FROM conversation_branches WHERE chat_id = ?')
    .get(chatId) as Record<string, unknown> | undefined
  return row ? branchFromRow(row) : undefined
}

export function listConversationBranches(taskId: string): ConversationBranchRow[] {
  const rows = getSoulDb()
    .prepare('SELECT * FROM conversation_branches WHERE task_id = ? ORDER BY created_at, branch_id')
    .all(taskId) as Record<string, unknown>[]
  return rows.map(branchFromRow)
}

export function getConversationTask(taskId: string): ConversationTaskRow | undefined {
  const row = getSoulDb().prepare('SELECT * FROM conversation_tasks WHERE task_id = ?').get(taskId) as
    | Record<string, unknown>
    | undefined
  return row ? taskFromRow(row) : undefined
}

export function insertConversationBranch(
  input: Omit<ConversationBranchRow, 'createdAt' | 'updatedAt'>,
  options: { activate?: boolean; deliveryTaskIds?: readonly string[] } = {},
): ConversationBranchRow {
  const now = Date.now()
  const db = getSoulDb()
  return db.transaction(() => {
  db
    .prepare(
      `INSERT INTO conversation_branches
       (branch_id, task_id, chat_id, kind, source_branch_id, anchor_root_chat_id, anchor_node_id,
        context_snapshot_json, runtime_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.branchId,
      input.taskId,
      input.chatId,
      input.kind,
      input.sourceBranchId ?? null,
      input.anchorRootChatId ?? null,
      input.anchorNodeId ?? null,
      input.contextSnapshot === undefined ? null : JSON.stringify(input.contextSnapshot),
      JSON.stringify(input.runtimeSnapshot),
      now,
      now,
    )
  if (options.activate) {
    if (input.kind === 'detail') throw new Error('解释分支不能设为主流程')
    db.prepare(
      `UPDATE conversation_tasks SET active_branch_id = ?, delivery_generation = delivery_generation + 1,
       updated_at = ? WHERE task_id = ?`,
    ).run(input.branchId, now, input.taskId)
    if (options.deliveryTaskIds?.length) {
      const placeholders = options.deliveryTaskIds.map(() => '?').join(',')
      const task = getConversationTask(input.taskId)!
      db.prepare(
        `UPDATE spawn_tasks SET delivery_chat_id = ?, delivery_branch_id = ?, delivery_generation = ?, updated_at = ?
         WHERE task_id IN (${placeholders}) AND status IN ('pending', 'started')`,
      ).run(input.chatId, input.branchId, task.deliveryGeneration, now, ...options.deliveryTaskIds)
    }
  } else {
    db.prepare('UPDATE conversation_tasks SET updated_at = ? WHERE task_id = ?').run(now, input.taskId)
  }
  return { ...input, createdAt: now, updatedAt: now }
  })()
}

export function deleteConversationBranch(branchId: string): void {
  getSoulDb().prepare('DELETE FROM conversation_branches WHERE branch_id = ?').run(branchId)
}

export function getConversationBranch(branchId: string): ConversationBranchRow | undefined {
  const row = getSoulDb().prepare('SELECT * FROM conversation_branches WHERE branch_id = ?').get(branchId) as
    | Record<string, unknown>
    | undefined
  return row ? branchFromRow(row) : undefined
}

/** Switch the unique active mainline and return its monotonic delivery fence. */
export function activateConversationBranch(branchId: string, deliveryTaskIds: readonly string[] = []): {
  task: ConversationTaskRow
  branch: ConversationBranchRow
} {
  const db = getSoulDb()
  return db.transaction(() => {
    const branch = getConversationBranch(branchId)
    if (!branch) throw new Error('分支不存在')
    if (branch.kind === 'detail') throw new Error('解释分支不能设为主流程')
    const now = Date.now()
    db.prepare(
      `UPDATE conversation_tasks
       SET active_branch_id = ?, delivery_generation = delivery_generation + 1, updated_at = ?
       WHERE task_id = ?`,
    ).run(branchId, now, branch.taskId)
    const task = getConversationTask(branch.taskId)!
    if (deliveryTaskIds.length) {
      const placeholders = deliveryTaskIds.map(() => '?').join(',')
      db.prepare(
        `UPDATE spawn_tasks SET delivery_chat_id = ?, delivery_branch_id = ?, delivery_generation = ?, updated_at = ?
         WHERE task_id IN (${placeholders}) AND status IN ('pending', 'started')`,
      ).run(branch.chatId, branch.branchId, task.deliveryGeneration, now, ...deliveryTaskIds)
    }
    return { task, branch }
  })()
}
