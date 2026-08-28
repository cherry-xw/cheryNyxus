import { getMonthlyDb, getSoulDb } from '@/db/index.js'
import { getChatMetadata, updateChatMetadata } from '@/db/chat.js'
import { markChatEpochSnapshotLifecycle } from '@/db/epoch.js'
import { abortChatRuntime, clearChatRuntime } from '@/service/chat/runtime.js'
import { clearWaitedChild, clearWaitedChildrenByParent } from '@/agent/spawnBroker.js'

export interface RoleLifecycleChangeResult {
  retiredChatIds: string[]
  abandonedChatIds: string[]
  affectedRootChatIds: string[]
}

function roleSemanticProjection(role: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'brain',
    'senseGroup',
    'mcpServers',
    'systemPrompt',
    'skills',
    'plugins',
    'permissions',
    'kind',
  ]
  return Object.fromEntries(keys.filter((key) => key in role).map((key) => [key, role[key]]))
}

export function detectRetiredRoleIdentities(
  before: Record<string, Record<string, unknown>> = {},
  after: Record<string, Record<string, unknown>> = {},
): { ids: string[]; names: string[] } {
  const afterById = new Map(
    Object.entries(after).flatMap(([name, role]) =>
      typeof role.id === 'string' ? [[role.id, { name, role }] as const] : [],
    ),
  )
  const ids: string[] = []
  const names: string[] = []
  for (const [name, role] of Object.entries(before)) {
    if (typeof role.id !== 'string') continue
    const next = afterById.get(role.id)
    if (
      !next ||
      JSON.stringify(roleSemanticProjection(role)) !==
        JSON.stringify(roleSemanticProjection(next.role))
    ) {
      ids.push(role.id)
      names.push(name)
    }
  }
  return { ids, names }
}

export function detectRemovedPresetIds(
  before: Record<string, Record<string, unknown>> = {},
  after: Record<string, Record<string, unknown>> = {},
): string[] {
  const nextIds = new Set(
    Object.values(after).flatMap((preset) =>
      typeof preset.id === 'string' ? [preset.id] : [],
    ),
  )
  return Object.values(before).flatMap((preset) =>
    typeof preset.id === 'string' && !nextIds.has(preset.id) ? [preset.id] : [],
  )
}

function descendantRows(chatId: string): Array<{ id: string; messages_month: string }> {
  return getSoulDb()
    .prepare(
      `WITH RECURSIVE tree(id, messages_month) AS (
         SELECT id, messages_month FROM chats WHERE id = ?
         UNION ALL
         SELECT child.id, child.messages_month
         FROM chats child JOIN tree parent ON child.parent_chat_id = parent.id
       )
       SELECT * FROM tree`,
    )
    .all(chatId) as Array<{ id: string; messages_month: string }>
}

function rootFor(chatId: string): string {
  const db = getSoulDb()
  let current = chatId
  for (let depth = 0; depth < 64; depth += 1) {
    const row = db
      .prepare('SELECT parent_chat_id FROM chats WHERE id = ?')
      .get(current) as { parent_chat_id: string | null } | undefined
    if (!row?.parent_chat_id) return current
    current = row.parent_chat_id
  }
  return current
}

function closeSubtreeActivity(
  rows: Array<{ id: string; messages_month: string }>,
  reason: string,
): void {
  const db = getSoulDb()
  const ids = rows.map((row) => row.id)
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  const now = Date.now()

  db.prepare(
    `UPDATE spawn_tasks SET status = 'abandoned', updated_at = ?
     WHERE child_chat_id IN (${placeholders}) AND status IN ('pending', 'started')`,
  ).run(now, ...ids)
  db.prepare(
    `UPDATE pending_inputs SET state = 'cancelled', consumed_at = ?
     WHERE chat_id IN (${placeholders}) AND state IN ('accepted', 'started', 'queued')`,
  ).run(now, ...ids)
  db.prepare(
    `UPDATE interactions SET status = 'cancelled', result_json = ?, updated_at = ?, completed_at = ?
     WHERE chat_id IN (${placeholders}) AND status IN ('pending', 'resolving', 'blocked')`,
  ).run(JSON.stringify({ reason }), now, now, ...ids)
  db.prepare(
    `UPDATE execution_active_runs SET status = 'failed', updated_at = ?
     WHERE chat_id IN (${placeholders}) AND status IN ('running', 'waiting', 'paused')`,
  ).run(now, ...ids)
  db.prepare(
    `UPDATE tree_control_targets SET status = 'failed', detail = ?, updated_at = ?
     WHERE chat_id IN (${placeholders}) AND status NOT IN ('resumed', 'failed')`,
  ).run(reason, now, ...ids)

  for (const row of rows) {
    const monthly = getMonthlyDb(row.messages_month)
    monthly
      .prepare(
        "UPDATE question_items SET status = 'cancelled', answer_json = ?, answer_text = ?, answered_at = ? WHERE batch_id IN (SELECT batch_id FROM question_batches WHERE chat_id = ?) AND status = 'pending'",
      )
      .run(JSON.stringify({ reason }), reason, now, row.id)
    monthly
      .prepare(
        "UPDATE question_batches SET status = 'cancelled', completed_at = ? WHERE chat_id = ? AND status = 'pending'",
      )
      .run(now, row.id)
    abortChatRuntime(row.id)
    clearWaitedChild(row.id)
    clearWaitedChildrenByParent(row.id)
    clearChatRuntime(row.id)
  }
}

export function abandonChatSubtree(chatId: string, reason: string): string[] {
  const db = getSoulDb()
  const rows = descendantRows(chatId)
  const ids = rows.map((row) => row.id)
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const now = Date.now()

  closeSubtreeActivity(rows, reason)
  db.prepare(
    `UPDATE chats
     SET lifecycle = 'abandoned',
         metadata = json_set(COALESCE(metadata, '{}'), '$.abandoned', json('true'),
                             '$.finished', json('true'), '$.invalidationReason', ?),
         updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(reason, now, ...ids)
  for (const row of rows) {
    markChatEpochSnapshotLifecycle(row.id, 'abandoned', reason)
  }
  return ids
}

function isFinishedBranch(rows: Array<{ id: string }>): boolean {
  const db = getSoulDb()
  return rows.every((row) => {
    const metadata = getChatMetadata(row.id)
    const task = db
      .prepare('SELECT status FROM spawn_tasks WHERE child_chat_id = ?')
      .get(row.id) as { status: string } | undefined
    return (
      metadata.finished === true ||
      task?.status === 'finished' ||
      task?.status === 'timed_out'
    )
  })
}

function retireCompletedSubtree(chatId: string, reason: string): string[] {
  const rows = descendantRows(chatId)
  if (rows.length === 0) return []
  closeSubtreeActivity(rows, reason)
  const now = Date.now()
  for (const row of rows) {
    getSoulDb()
      .prepare("UPDATE chats SET lifecycle = 'retired', updated_at = ? WHERE id = ?")
      .run(now, row.id)
    updateChatMetadata(row.id, {
      retired: true,
      roleInjected: true,
      retirementReason: reason,
    })
    markChatEpochSnapshotLifecycle(row.id, 'retired', reason)
  }
  return rows.map((row) => row.id)
}

/**
 * Retire every historical child whose stable role identity disappeared or
 * changed semantically. Completed branches stay readable; unfinished branches
 * and every descendant are recursively abandoned and can never resume.
 */
export function applyRetiredRoles(input: {
  roleIds: readonly string[]
  roleNames?: readonly string[]
  rootChatIds?: readonly string[]
  reason: string
}): RoleLifecycleChangeResult {
  const ids = new Set(input.roleIds)
  const names = new Set(input.roleNames ?? [])
  const scopedRoots = input.rootChatIds ? new Set(input.rootChatIds) : undefined
  const db = getSoulDb()
  const childRows = db
    .prepare('SELECT id, metadata FROM chats WHERE parent_chat_id IS NOT NULL')
    .all() as Array<{ id: string; metadata: string | null }>
  const matched = childRows.filter((row) => {
    if (scopedRoots && !scopedRoots.has(rootFor(row.id))) return false
    const metadata = getChatMetadata(row.id)
    return (
      (typeof metadata.roleId === 'string' && ids.has(metadata.roleId)) ||
      (typeof metadata.type === 'string' && names.has(metadata.type))
    )
  })
  const matchedIds = new Set(matched.map((row) => row.id))
  const topLevelMatches = matched.filter((row) => {
    const parent = db
      .prepare('SELECT parent_chat_id FROM chats WHERE id = ?')
      .get(row.id) as { parent_chat_id: string | null }
    return !parent.parent_chat_id || !matchedIds.has(parent.parent_chat_id)
  })

  const retiredChatIds: string[] = []
  const abandoned = new Set<string>()
  const roots = new Set<string>()
  for (const row of topLevelMatches) {
    roots.add(rootFor(row.id))
    const subtree = descendantRows(row.id)
    if (isFinishedBranch(subtree)) {
      retiredChatIds.push(...retireCompletedSubtree(row.id, input.reason))
      continue
    }
    for (const id of abandonChatSubtree(row.id, input.reason)) abandoned.add(id)
  }
  return {
    retiredChatIds,
    abandonedChatIds: [...abandoned],
    affectedRootChatIds: [...roots],
  }
}

export function archivePresetRoots(presetIds: readonly string[], reason: string): string[] {
  if (presetIds.length === 0) return []
  const ids = new Set(presetIds)
  const db = getSoulDb()
  const roots = db
    .prepare('SELECT id FROM chats WHERE parent_chat_id IS NULL')
    .all() as Array<{ id: string }>
  const archived: string[] = []
  for (const root of roots) {
    const metadata = getChatMetadata(root.id)
    if (typeof metadata.presetId !== 'string' || !ids.has(metadata.presetId)) continue
    const rows = descendantRows(root.id)
    closeSubtreeActivity(rows, reason)
    for (const row of rows) {
      db.prepare("UPDATE chats SET lifecycle = 'archived', updated_at = ? WHERE id = ?").run(
        Date.now(),
        row.id,
      )
      updateChatMetadata(row.id, { archived: true, archiveReason: reason })
      markChatEpochSnapshotLifecycle(row.id, 'archived', reason)
    }
    db.prepare(
      "UPDATE chat_epochs SET status = 'archived', closed_at = COALESCE(closed_at, ?) WHERE root_chat_id = ?",
    ).run(Date.now(), root.id)
    archived.push(root.id)
  }
  return archived
}
