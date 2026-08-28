import { randomUUID } from 'node:crypto'
import { getMonthlyDb, getSoulDb } from './index.js'

export type ConfigRevisionStatus = 'candidate' | 'active' | 'rejected' | 'superseded'
export type ChatEpochStatus = 'active' | 'historical' | 'archived'
export type EpochSnapshotQuality = 'exact' | 'partial' | 'reconstructed'
export type ChatLifecycle = 'active' | 'retired' | 'abandoned' | 'archived'

export interface ConfigRevisionRecord {
  revisionId: string
  fingerprint: string
  status: ConfigRevisionStatus
  source: 'structured' | 'manual' | 'startup' | 'legacy' | 'rollback'
  snapshot: Record<string, unknown>
  resources: Record<string, unknown>
  validationError?: string
  createdAt: number
  activatedAt?: number
}

export interface ChatEpochRecord {
  epochId: string
  rootChatId: string
  ordinal: number
  revisionId?: string
  status: ChatEpochStatus
  snapshotQuality: EpochSnapshotQuality
  transitionReason: string
  handoffSummary?: string
  createdAt: number
  activatedAt?: number
  closedAt?: number
}

export interface FrozenChatSnapshot {
  epochId: string
  chatId: string
  roleId?: string
  roleName?: string
  lifecycle: ChatLifecycle
  systemPrompt: string
  tools: Array<{
    name: string
    description: string
    parameters?: Record<string, unknown>
  }>
  runtime?: Record<string, unknown>
  resources: Record<string, unknown>
  invalidationReason?: string
  createdAt: number
  updatedAt: number
}

interface ConfigRevisionRow {
  revision_id: string
  fingerprint: string
  status: ConfigRevisionStatus
  source: ConfigRevisionRecord['source']
  snapshot_json: string
  resources_json: string
  validation_error: string | null
  created_at: number
  activated_at: number | null
}

interface ChatEpochRow {
  epoch_id: string
  root_chat_id: string
  ordinal: number
  revision_id: string | null
  status: ChatEpochStatus
  snapshot_quality: EpochSnapshotQuality
  transition_reason: string
  handoff_summary: string | null
  created_at: number
  activated_at: number | null
  closed_at: number | null
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function toConfigRevision(row: ConfigRevisionRow): ConfigRevisionRecord {
  return {
    revisionId: row.revision_id,
    fingerprint: row.fingerprint,
    status: row.status,
    source: row.source,
    snapshot: parseObject(row.snapshot_json),
    resources: parseObject(row.resources_json),
    ...(row.validation_error ? { validationError: row.validation_error } : {}),
    createdAt: row.created_at,
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
  }
}

function toEpoch(row: ChatEpochRow): ChatEpochRecord {
  return {
    epochId: row.epoch_id,
    rootChatId: row.root_chat_id,
    ordinal: row.ordinal,
    ...(row.revision_id ? { revisionId: row.revision_id } : {}),
    status: row.status,
    snapshotQuality: row.snapshot_quality,
    transitionReason: row.transition_reason,
    ...(row.handoff_summary ? { handoffSummary: row.handoff_summary } : {}),
    createdAt: row.created_at,
    ...(row.activated_at ? { activatedAt: row.activated_at } : {}),
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
  }
}

export function upsertConfigRevision(input: {
  fingerprint: string
  source: ConfigRevisionRecord['source']
  snapshot: Record<string, unknown>
  resources?: Record<string, unknown>
  status?: ConfigRevisionStatus
  validationError?: string
}): ConfigRevisionRecord {
  const db = getSoulDb()
  const existing = db
    .prepare('SELECT * FROM config_revisions WHERE fingerprint = ?')
    .get(input.fingerprint) as ConfigRevisionRow | undefined
  if (existing) return toConfigRevision(existing)

  const revisionId = randomUUID()
  const now = Date.now()
  const status = input.status ?? 'candidate'
  db.prepare(
    `INSERT INTO config_revisions
      (revision_id, fingerprint, status, source, snapshot_json, resources_json,
       validation_error, created_at, activated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    revisionId,
    input.fingerprint,
    status,
    input.source,
    JSON.stringify(input.snapshot),
    JSON.stringify(input.resources ?? {}),
    input.validationError ?? null,
    now,
    status === 'active' ? now : null,
  )
  return getConfigRevision(revisionId)!
}

export function getConfigRevision(revisionId: string): ConfigRevisionRecord | undefined {
  const row = getSoulDb()
    .prepare('SELECT * FROM config_revisions WHERE revision_id = ?')
    .get(revisionId) as ConfigRevisionRow | undefined
  return row ? toConfigRevision(row) : undefined
}

export function getActiveConfigRevision(): ConfigRevisionRecord | undefined {
  const row = getSoulDb()
    .prepare(
      "SELECT * FROM config_revisions WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1",
    )
    .get() as ConfigRevisionRow | undefined
  return row ? toConfigRevision(row) : undefined
}

export function activateConfigRevision(revisionId: string): ConfigRevisionRecord {
  const db = getSoulDb()
  const now = Date.now()
  const tx = db.transaction(() => {
    const target = db
      .prepare('SELECT revision_id FROM config_revisions WHERE revision_id = ?')
      .get(revisionId) as { revision_id: string } | undefined
    if (!target) throw new Error(`配置修订不存在：${revisionId}`)
    db.prepare("UPDATE config_revisions SET status = 'superseded' WHERE status = 'active'").run()
    db.prepare(
      "UPDATE config_revisions SET status = 'active', activated_at = ?, validation_error = NULL WHERE revision_id = ?",
    ).run(now, revisionId)
  })
  tx()
  return getConfigRevision(revisionId)!
}

export function rejectConfigRevision(revisionId: string, validationError: string): void {
  const result = getSoulDb()
    .prepare(
      "UPDATE config_revisions SET status = 'rejected', validation_error = ? WHERE revision_id = ? AND status != 'active'",
    )
    .run(validationError, revisionId)
  if (result.changes === 0) throw new Error(`无法拒绝配置修订：${revisionId}`)
}

export function getRootChatIdForEpoch(chatId: string): string {
  const db = getSoulDb()
  let current = chatId
  const seen = new Set<string>()
  for (let depth = 0; depth < 64; depth += 1) {
    if (seen.has(current)) throw new Error(`会话父链存在循环：${chatId}`)
    seen.add(current)
    const row = db
      .prepare('SELECT parent_chat_id FROM chats WHERE id = ?')
      .get(current) as { parent_chat_id: string | null } | undefined
    if (!row) throw new Error(`会话不存在：${chatId}`)
    if (!row.parent_chat_id) return current
    current = row.parent_chat_id
  }
  throw new Error(`会话父链过深：${chatId}`)
}

function listTreeChats(rootChatId: string): Array<{
  id: string
  messages_month: string
  message_count: number
}> {
  return getSoulDb()
    .prepare(
      `WITH RECURSIVE tree AS (
         SELECT id, messages_month, message_count FROM chats WHERE id = ?
         UNION ALL
         SELECT child.id, child.messages_month, child.message_count
         FROM chats child JOIN tree parent ON child.parent_chat_id = parent.id
       )
       SELECT * FROM tree`,
    )
    .all(rootChatId) as Array<{ id: string; messages_month: string; message_count: number }>
}

function setTreeActiveEpoch(rootChatId: string, epochId: string): void {
  getSoulDb()
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM chats WHERE id = ?
         UNION ALL
         SELECT child.id FROM chats child JOIN tree parent ON child.parent_chat_id = parent.id
       )
       UPDATE chats SET active_epoch_id = ? WHERE id IN (SELECT id FROM tree)`,
    )
    .run(rootChatId, epochId)
}

function assignUnversionedMessages(
  chats: Array<{ id: string; messages_month: string }>,
  epochId: string,
): void {
  for (const chat of chats) {
    getMonthlyDb(chat.messages_month)
      .prepare('UPDATE messages SET epoch_id = ? WHERE chat_id = ? AND epoch_id IS NULL')
      .run(epochId, chat.id)
  }
}

function insertEpoch(input: {
  rootChatId: string
  ordinal: number
  revisionId?: string
  status: ChatEpochStatus
  snapshotQuality: EpochSnapshotQuality
  transitionReason: string
  handoffSummary?: string
}): ChatEpochRecord {
  const db = getSoulDb()
  const epochId = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO chat_epochs
      (epoch_id, root_chat_id, ordinal, revision_id, status, snapshot_quality,
       transition_reason, handoff_summary, created_at, activated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    epochId,
    input.rootChatId,
    input.ordinal,
    input.revisionId ?? null,
    input.status,
    input.snapshotQuality,
    input.transitionReason,
    input.handoffSummary ?? null,
    now,
    input.status === 'active' ? now : null,
    input.status === 'active' ? null : now,
  )
  return getChatEpoch(epochId)!
}

export function getChatEpoch(epochId: string): ChatEpochRecord | undefined {
  const row = getSoulDb()
    .prepare('SELECT * FROM chat_epochs WHERE epoch_id = ?')
    .get(epochId) as ChatEpochRow | undefined
  return row ? toEpoch(row) : undefined
}

export function getActiveChatEpoch(chatId: string): ChatEpochRecord | undefined {
  const rootChatId = getRootChatIdForEpoch(chatId)
  const row = getSoulDb()
    .prepare("SELECT * FROM chat_epochs WHERE root_chat_id = ? AND status = 'active'")
    .get(rootChatId) as ChatEpochRow | undefined
  return row ? toEpoch(row) : undefined
}

export function listChatEpochs(chatId: string): ChatEpochRecord[] {
  const rootChatId = getRootChatIdForEpoch(chatId)
  return (
    getSoulDb()
      .prepare('SELECT * FROM chat_epochs WHERE root_chat_id = ? ORDER BY ordinal ASC')
      .all(rootChatId) as ChatEpochRow[]
  ).map(toEpoch)
}

export function getChatEpochStats(chatId: string): {
  activeEpochId?: string
  epochCount: number
} {
  const rootChatId = getRootChatIdForEpoch(chatId)
  const row = getSoulDb()
    .prepare(
      `SELECT COUNT(*) AS epoch_count,
              MAX(CASE WHEN status = 'active' THEN epoch_id END) AS active_epoch_id
       FROM chat_epochs WHERE root_chat_id = ?`,
    )
    .get(rootChatId) as { epoch_count: number; active_epoch_id: string | null }
  return {
    ...(row.active_epoch_id ? { activeEpochId: row.active_epoch_id } : {}),
    epochCount: row.epoch_count,
  }
}

/**
 * Ensure that a chat tree has exactly one executable epoch for the supplied
 * validated configuration revision. Existing unversioned history is never
 * presented as an exact snapshot: it is assigned to historical legacy-0 and
 * a clean executable epoch is created beside it.
 */
export function ensureActiveChatEpoch(input: {
  chatId: string
  revisionId: string
  transitionReason?: string
  handoffSummary?: string
}): { epoch: ChatEpochRecord; created: boolean; legacyEpoch?: ChatEpochRecord } {
  const db = getSoulDb()
  const rootChatId = getRootChatIdForEpoch(input.chatId)
  const existing = getActiveChatEpoch(input.chatId)
  if (existing?.revisionId === input.revisionId) {
    setTreeActiveEpoch(rootChatId, existing.epochId)
    return { epoch: existing, created: false }
  }

  const tree = listTreeChats(rootChatId)
  const priorRows = db
    .prepare('SELECT * FROM chat_epochs WHERE root_chat_id = ? ORDER BY ordinal ASC')
    .all(rootChatId) as ChatEpochRow[]
  let legacyEpoch: ChatEpochRecord | undefined
  let epoch: ChatEpochRecord
  const tx = db.transaction(() => {
    const now = Date.now()
    db.prepare(
      "UPDATE chat_epochs SET status = 'historical', closed_at = COALESCE(closed_at, ?) WHERE root_chat_id = ? AND status = 'active'",
    ).run(now, rootChatId)

    let nextOrdinal = priorRows.length
    if (priorRows.length === 0 && tree.some((chat) => chat.message_count > 0)) {
      legacyEpoch = insertEpoch({
        rootChatId,
        ordinal: 0,
        status: 'historical',
        snapshotQuality: 'reconstructed',
        transitionReason: 'legacy-migration',
        handoffSummary:
          '此纪元由版本化功能启用前的历史数据重建；配置、提示词和工具定义并非精确快照，仅供只读审计。',
      })
      nextOrdinal = 1
    }

    epoch = insertEpoch({
      rootChatId,
      ordinal: nextOrdinal,
      revisionId: input.revisionId,
      status: 'active',
      snapshotQuality: 'exact',
      transitionReason:
        input.transitionReason ?? (priorRows.length > 0 ? 'configuration-changed' : 'created'),
      handoffSummary: input.handoffSummary,
    })
    setTreeActiveEpoch(rootChatId, epoch.epochId)
  })
  tx()

  if (legacyEpoch) assignUnversionedMessages(tree, legacyEpoch.epochId)
  const treeIds = tree.map((chat) => chat.id)
  if (treeIds.length > 0) {
    const placeholders = treeIds.map(() => '?').join(',')
    db.prepare(
      `UPDATE pending_inputs SET epoch_id = ?
       WHERE chat_id IN (${placeholders}) AND epoch_id IS NULL
         AND state IN ('accepted', 'started', 'queued')`,
    ).run(epoch!.epochId, ...treeIds)
  }
  return { epoch: epoch!, created: true, ...(legacyEpoch ? { legacyEpoch } : {}) }
}

/** Force a semantic boundary while retaining the validated deployment revision. */
export function rotateActiveChatEpoch(input: {
  chatId: string
  transitionReason: string
  handoffSummary: string
}): ChatEpochRecord {
  const db = getSoulDb()
  const rootChatId = getRootChatIdForEpoch(input.chatId)
  const active = getActiveChatEpoch(input.chatId)
  if (!active?.revisionId) throw new Error('会话尚未建立可执行配置纪元')
  let next: ChatEpochRecord
  const tx = db.transaction(() => {
    const now = Date.now()
    db.prepare(
      "UPDATE chat_epochs SET status = 'historical', closed_at = ? WHERE epoch_id = ? AND status = 'active'",
    ).run(now, active.epochId)
    const max = db
      .prepare('SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM chat_epochs WHERE root_chat_id = ?')
      .get(rootChatId) as { ordinal: number }
    next = insertEpoch({
      rootChatId,
      ordinal: max.ordinal + 1,
      revisionId: active.revisionId,
      status: 'active',
      snapshotQuality: 'exact',
      transitionReason: input.transitionReason,
      handoffSummary: input.handoffSummary,
    })
    setTreeActiveEpoch(rootChatId, next.epochId)
    const treeIds = listTreeChats(rootChatId).map((chat) => chat.id)
    if (treeIds.length > 0) {
      const placeholders = treeIds.map(() => '?').join(',')
      db.prepare(
        `UPDATE pending_inputs SET epoch_id = ? WHERE chat_id IN (${placeholders})
         AND epoch_id = ? AND state IN ('accepted', 'queued')`,
      ).run(next.epochId, ...treeIds, active.epochId)
    }
  })
  tx()
  return next!
}

export function freezeChatEpochSnapshot(input: {
  epochId: string
  chatId: string
  roleId?: string
  roleName?: string
  lifecycle?: ChatLifecycle
  systemPrompt: string
  tools: FrozenChatSnapshot['tools']
  runtime?: Record<string, unknown>
  resources?: Record<string, unknown>
}): FrozenChatSnapshot {
  const db = getSoulDb()
  const epoch = getChatEpoch(input.epochId)
  if (!epoch) throw new Error(`纪元不存在：${input.epochId}`)
  if (getRootChatIdForEpoch(input.chatId) !== epoch.rootChatId) {
    throw new Error(`会话 ${input.chatId} 不属于纪元根 ${epoch.rootChatId}`)
  }
  const now = Date.now()
  db.prepare(
    `INSERT INTO chat_epoch_snapshots
      (epoch_id, chat_id, role_id, role_name, lifecycle, prompt_snapshot_json,
       runtime_snapshot_json, resource_manifest_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(epoch_id, chat_id) DO UPDATE SET
       role_id = COALESCE(chat_epoch_snapshots.role_id, excluded.role_id),
       role_name = COALESCE(chat_epoch_snapshots.role_name, excluded.role_name),
       prompt_snapshot_json = COALESCE(chat_epoch_snapshots.prompt_snapshot_json, excluded.prompt_snapshot_json),
       runtime_snapshot_json = COALESCE(chat_epoch_snapshots.runtime_snapshot_json, excluded.runtime_snapshot_json),
       resource_manifest_json = CASE
         WHEN chat_epoch_snapshots.prompt_snapshot_json IS NULL THEN excluded.resource_manifest_json
         ELSE chat_epoch_snapshots.resource_manifest_json
       END,
       updated_at = excluded.updated_at`,
  ).run(
    input.epochId,
    input.chatId,
    input.roleId ?? null,
    input.roleName ?? null,
    input.lifecycle ?? 'active',
    JSON.stringify({ systemPrompt: input.systemPrompt, tools: input.tools }),
    input.runtime ? JSON.stringify(input.runtime) : null,
    JSON.stringify(input.resources ?? {}),
    now,
    now,
  )
  return getFrozenChatSnapshot(input.epochId, input.chatId)!
}

export function getFrozenChatSnapshot(
  epochId: string,
  chatId: string,
): FrozenChatSnapshot | undefined {
  const row = getSoulDb()
    .prepare('SELECT * FROM chat_epoch_snapshots WHERE epoch_id = ? AND chat_id = ?')
    .get(epochId, chatId) as
    | {
        epoch_id: string
        chat_id: string
        role_id: string | null
        role_name: string | null
        lifecycle: ChatLifecycle
        prompt_snapshot_json: string | null
        runtime_snapshot_json: string | null
        resource_manifest_json: string
        invalidation_reason: string | null
        created_at: number
        updated_at: number
      }
    | undefined
  if (!row) return undefined
  const prompt = parseObject(row.prompt_snapshot_json)
  return {
    epochId: row.epoch_id,
    chatId: row.chat_id,
    ...(row.role_id ? { roleId: row.role_id } : {}),
    ...(row.role_name ? { roleName: row.role_name } : {}),
    lifecycle: row.lifecycle,
    systemPrompt: typeof prompt.systemPrompt === 'string' ? prompt.systemPrompt : '',
    tools: Array.isArray(prompt.tools) ? (prompt.tools as FrozenChatSnapshot['tools']) : [],
    ...(row.runtime_snapshot_json
      ? { runtime: parseObject(row.runtime_snapshot_json) }
      : {}),
    resources: parseObject(row.resource_manifest_json),
    ...(row.invalidation_reason ? { invalidationReason: row.invalidation_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function markChatEpochSnapshotLifecycle(
  chatId: string,
  lifecycle: Exclude<ChatLifecycle, 'active'>,
  reason: string,
): void {
  const db = getSoulDb()
  db.prepare('UPDATE chats SET lifecycle = ? WHERE id = ?').run(lifecycle, chatId)
  db.prepare(
    'UPDATE chat_epoch_snapshots SET lifecycle = ?, invalidation_reason = ?, updated_at = ? WHERE chat_id = ?',
  ).run(lifecycle, reason, Date.now(), chatId)
}

export function assertEpochExecutable(chatId: string, epochId?: string): ChatEpochRecord {
  const active = getActiveChatEpoch(chatId)
  if (!active || (epochId && active.epochId !== epochId)) {
    throw new Error('历史纪元为只读，不能执行或恢复')
  }
  const chat = getSoulDb()
    .prepare('SELECT lifecycle FROM chats WHERE id = ?')
    .get(chatId) as { lifecycle: ChatLifecycle } | undefined
  if (!chat || chat.lifecycle !== 'active') {
    throw new Error(`会话已${chat?.lifecycle === 'abandoned' ? '废弃' : '归档'}，不能执行或恢复`)
  }
  return active
}
