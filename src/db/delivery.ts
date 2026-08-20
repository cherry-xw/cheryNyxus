import { createHash, randomUUID } from 'node:crypto'
import { getMonthlyDb, getSoulDb } from './index.js'

const RETENTION_MS = 24 * 60 * 60 * 1000
const RETENTION_EVENTS_PER_CHAT = 10_000

export interface StoredChatEvent {
  seq: number
  [key: string]: unknown
}

export interface ChatEventPage {
  events: StoredChatEvent[]
  latestSeq: number
  minSeq?: number
  reset: boolean
}

export interface RootEventPage {
  events: StoredChatEvent[]
  latestSeq: number
  minSeq?: number
  reset: boolean
}

export interface SpawnTask {
  taskId: string
  childChatId: string
  parentChatId: string
  type: string
  prompt: string
  brain: string
  senseGroup: string
  spawnCallId?: string
  owningBatchId?: string
  deliveryChatId: string
  deliveryBranchId?: string
  deliveryGeneration: number
  status: 'pending' | 'started' | 'finished' | 'timed_out'
}

export type RequestClaim =
  | { state: 'new' }
  | { state: 'completed'; responseJson: string }
  | { state: 'active' }
  | { state: 'mismatch' }

function chatMonth(chatId: string): string {
  const row = getSoulDb().prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as
    { messages_month: string } | undefined
  if (!row) throw new Error(`Chat ${chatId} not found`)
  return row.messages_month
}

function requestFingerprint(method: string, params: unknown): string {
  return createHash('sha256')
    .update(`${method}\n${JSON.stringify(params)}`)
    .digest('hex')
}

/** Claim a client request. A reused id may only carry identical method and params. */
export function claimRequest(requestId: string, method: string, params: unknown): RequestClaim {
  const db = getSoulDb()
  const fingerprint = requestFingerprint(method, params)
  const now = Date.now()
  db.prepare('DELETE FROM request_journal WHERE updated_at < ?').run(now - RETENTION_MS)
  const existing = db
    .prepare(
      'SELECT method, params_hash, status, response_json FROM request_journal WHERE request_id = ?',
    )
    .get(requestId) as
    | {
        method: string
        params_hash: string
        status: string
        response_json: string | null
      }
    | undefined
  if (!existing) {
    db.prepare(
      "INSERT INTO request_journal (request_id, method, params_hash, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
    ).run(requestId, method, fingerprint, now, now)
    return { state: 'new' }
  }
  if (existing.method !== method || existing.params_hash !== fingerprint)
    return { state: 'mismatch' }
  if (existing.status === 'completed' && existing.response_json) {
    return { state: 'completed', responseJson: existing.response_json }
  }
  return { state: 'active' }
}

export function completeRequest(requestId: string, response: unknown): void {
  getSoulDb()
    .prepare(
      "UPDATE request_journal SET status = 'completed', response_json = ?, updated_at = ? WHERE request_id = ?",
    )
    .run(JSON.stringify(response), Date.now(), requestId)
}

/** Release a failed claim so an identical command can be retried safely. */
export function abandonRequest(requestId: string): void {
  getSoulDb()
    .prepare("DELETE FROM request_journal WHERE request_id = ? AND status = 'active'")
    .run(requestId)
}

/** Persist an event before it is put on a socket. `seq` is monotonic for every chat. */
export function appendChatEvent(chatId: string, event: Record<string, unknown>): number {
  const db = getMonthlyDb(chatMonth(chatId))
  const now = Date.now()
  const write = db.transaction(() => {
    const next = db
      .prepare(
        'SELECT COALESCE(MAX(chat_seq), 0) + 1 AS nextSeq FROM chat_events WHERE chat_id = ?',
      )
      .get(chatId) as { nextSeq: number }
    const seq = next.nextSeq
    const inserted = db
      .prepare(
        'INSERT INTO chat_events (chat_id, chat_seq, event_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(chatId, seq, JSON.stringify(event), now)
    const stored = { ...event, seq }
    db.prepare('UPDATE chat_events SET event_json = ? WHERE rowid = ?').run(
      JSON.stringify(stored),
      inserted.lastInsertRowid,
    )
    db.prepare('DELETE FROM chat_events WHERE chat_id = ? AND created_at < ?').run(
      chatId,
      now - RETENTION_MS,
    )
    const cutoff = db
      .prepare(
        'SELECT chat_seq FROM chat_events WHERE chat_id = ? ORDER BY chat_seq DESC LIMIT 1 OFFSET ?',
      )
      .get(chatId, RETENTION_EVENTS_PER_CHAT) as { seq: number } | undefined
    if (cutoff)
      db.prepare('DELETE FROM chat_events WHERE chat_id = ? AND chat_seq <= ?').run(
        chatId,
        cutoff.seq,
      )
    return seq
  })
  const seq = write()
  const rootChatId = rootChatIdOf(chatId)
  const rootEventSeq = appendRootEvent(rootChatId, {
    ...event,
    chatId,
    sourceChatId: chatId,
    sourceEventSeq: seq,
  })
  // Call sites route the same object after persistence. Enrich it in place so
  // root subscriptions can use the root sequence without reconstructing it.
  event.rootChatId = rootChatId
  event.rootEventSeq = rootEventSeq
  return seq
}

function rootChatIdOf(chatId: string): string {
  const db = getSoulDb()
  let current = chatId
  const seen = new Set<string>()
  while (!seen.has(current)) {
    seen.add(current)
    const row = db.prepare('SELECT parent_chat_id FROM chats WHERE id = ?').get(current) as
      { parent_chat_id?: string | null } | undefined
    if (!row?.parent_chat_id) return current
    current = row.parent_chat_id
  }
  return current
}

function appendRootEvent(rootChatId: string, event: Record<string, unknown>): number {
  const db = getSoulDb()
  const now = Date.now()
  return db.transaction(() => {
    const next = db
      .prepare(
        'SELECT COALESCE(MAX(root_seq), 0) + 1 AS nextSeq FROM root_events WHERE root_chat_id = ?',
      )
      .get(rootChatId) as { nextSeq: number }
    const stored = { ...event, rootChatId, rootEventSeq: next.nextSeq }
    db.prepare(
      'INSERT INTO root_events (root_chat_id, root_seq, event_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(rootChatId, next.nextSeq, JSON.stringify(stored), now)
    db.prepare('DELETE FROM root_events WHERE root_chat_id = ? AND created_at < ?').run(
      rootChatId,
      now - RETENTION_MS,
    )
    const cutoff = db
      .prepare(
        'SELECT root_seq FROM root_events WHERE root_chat_id = ? ORDER BY root_seq DESC LIMIT 1 OFFSET ?',
      )
      .get(rootChatId, RETENTION_EVENTS_PER_CHAT) as { root_seq: number } | undefined
    if (cutoff)
      db.prepare('DELETE FROM root_events WHERE root_chat_id = ? AND root_seq <= ?').run(
        rootChatId,
        cutoff.root_seq,
      )
    return next.nextSeq
  })()
}

export function getRootEvents(rootChatId: string, afterSeq: number): RootEventPage {
  const db = getSoulDb()
  const bounds = db
    .prepare(
      'SELECT MIN(root_seq) AS minSeq, MAX(root_seq) AS latestSeq FROM root_events WHERE root_chat_id = ?',
    )
    .get(rootChatId) as { minSeq: number | null; latestSeq: number | null }
  const minSeq = bounds.minSeq ?? undefined
  // latestSeq is the journal's persisted high-water mark, not an echo of the
  // caller's cursor. An empty journal starts at boundary 0 so its first event
  // (seq 1) is not mistaken for an event already covered by a snapshot fence.
  const latestSeq = bounds.latestSeq ?? 0
  const reset = minSeq !== undefined && afterSeq < minSeq - 1
  if (reset) return { events: [], latestSeq, minSeq, reset: true }
  const rows = db
    .prepare(
      'SELECT event_json FROM root_events WHERE root_chat_id = ? AND root_seq > ? ORDER BY root_seq ASC',
    )
    .all(rootChatId, afterSeq) as { event_json: string }[]
  return {
    events: rows.map((row) => JSON.parse(row.event_json) as StoredChatEvent),
    latestSeq,
    minSeq,
    reset: false,
  }
}

export function getChatEvents(chatId: string, afterSeq: number): ChatEventPage {
  const db = getMonthlyDb(chatMonth(chatId))
  const bounds = db
    .prepare(
      'SELECT MIN(chat_seq) AS minSeq, MAX(chat_seq) AS latestSeq FROM chat_events WHERE chat_id = ?',
    )
    .get(chatId) as { minSeq: number | null; latestSeq: number | null }
  const minSeq = bounds.minSeq ?? undefined
  // Keep the response boundary independent from the requested cursor. Internal
  // callers use MAX_SAFE_INTEGER to read only the high-water mark; an empty
  // journal must still report 0 because the first persisted event uses seq 1.
  const latestSeq = bounds.latestSeq ?? 0
  const reset = minSeq !== undefined && afterSeq < minSeq - 1
  if (reset) return { events: [], latestSeq, minSeq, reset: true }
  const rows = db
    .prepare(
      'SELECT event_json FROM chat_events WHERE chat_id = ? AND chat_seq > ? ORDER BY chat_seq ASC',
    )
    .all(chatId, afterSeq) as { event_json: string }[]
  return {
    events: rows.map((row) => JSON.parse(row.event_json) as StoredChatEvent),
    latestSeq,
    minSeq,
    reset: false,
  }
}

/**
 * 取该 chat 最近 N 条 chat 事件（按 seq 升序），不受超窗 reset 影响。
 * 供 currentState 快照扫描（pending approval / running tools / current todo）--
 * 这些态仅依赖近期事件，且 run 在跑时事件必在留存窗内。
 */
export function getRecentChatEvents(chatId: string, limit = 500): StoredChatEvent[] {
  const db = getMonthlyDb(chatMonth(chatId))
  const rows = db
    .prepare('SELECT event_json FROM chat_events WHERE chat_id = ? ORDER BY chat_seq DESC LIMIT ?')
    .all(chatId, limit) as { event_json: string }[]
  return rows.map((row) => JSON.parse(row.event_json) as StoredChatEvent).reverse()
}

export function createSpawnTask(
  input: Omit<SpawnTask, 'taskId' | 'status' | 'deliveryChatId' | 'deliveryGeneration'> & {
    taskId?: string
    deliveryChatId?: string
    deliveryGeneration?: number
  },
): SpawnTask {
  const taskId = input.taskId ?? randomUUID()
  const now = Date.now()
  getSoulDb()
    .prepare(
      `INSERT INTO spawn_tasks
      (task_id, child_chat_id, parent_chat_id, type, prompt, brain, sense_group, spawn_call_id, owning_batch_id,
       delivery_chat_id, delivery_branch_id, delivery_generation, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      taskId,
      input.childChatId,
      input.parentChatId,
      input.type,
      input.prompt,
      input.brain,
      input.senseGroup,
      input.spawnCallId ?? null,
      input.owningBatchId ?? null,
      input.deliveryChatId ?? input.parentChatId,
      input.deliveryBranchId ?? null,
      input.deliveryGeneration ?? 0,
      now,
      now,
    )
  return {
    ...input,
    taskId,
    status: 'pending',
    deliveryChatId: input.deliveryChatId ?? input.parentChatId,
    deliveryGeneration: input.deliveryGeneration ?? 0,
  }
}

function toSpawnTask(row: Record<string, unknown>): SpawnTask {
  return {
    taskId: String(row.task_id),
    childChatId: String(row.child_chat_id),
    parentChatId: String(row.parent_chat_id),
    type: String(row.type),
    prompt: String(row.prompt),
    brain: String(row.brain),
    senseGroup: String(row.sense_group),
    ...(row.spawn_call_id ? { spawnCallId: String(row.spawn_call_id) } : {}),
    ...(row.owning_batch_id ? { owningBatchId: String(row.owning_batch_id) } : {}),
    deliveryChatId: String(row.delivery_chat_id ?? row.parent_chat_id),
    ...(row.delivery_branch_id ? { deliveryBranchId: String(row.delivery_branch_id) } : {}),
    deliveryGeneration: Number(row.delivery_generation ?? 0),
    status: row.status as SpawnTask['status'],
  }
}

export function getSpawnTask(taskId: string): SpawnTask | undefined {
  const row = getSoulDb().prepare('SELECT * FROM spawn_tasks WHERE task_id = ?').get(taskId) as
    Record<string, unknown> | undefined
  return row ? toSpawnTask(row) : undefined
}

export function getSpawnTaskByChild(childChatId: string): SpawnTask | undefined {
  const row = getSoulDb()
    .prepare('SELECT * FROM spawn_tasks WHERE child_chat_id = ?')
    .get(childChatId) as Record<string, unknown> | undefined
  return row ? toSpawnTask(row) : undefined
}

/** Atomically reserve the first launch; later calls are recovery attempts, never another first send. */
export function claimSpawnTask(taskId: string): { task?: SpawnTask; firstStart: boolean } {
  const db = getSoulDb()
  const task = getSpawnTask(taskId)
  if (!task || task.status === 'finished') return { task, firstStart: false }
  if (task.status === 'pending') {
    const changed = db
      .prepare(
        "UPDATE spawn_tasks SET status = 'started', updated_at = ? WHERE task_id = ? AND status = 'pending'",
      )
      .run(Date.now(), taskId)
    if (changed.changes === 1) return { task: { ...task, status: 'started' }, firstStart: true }
  }
  return { task: getSpawnTask(taskId), firstStart: false }
}

export function finishSpawnTask(taskId: string): void {
  getSoulDb()
    .prepare(
      "UPDATE spawn_tasks SET status = 'finished', updated_at = ? WHERE task_id = ? AND status IN ('pending', 'started')",
    )
    .run(Date.now(), taskId)
}

export function setSpawnTaskOwnership(
  taskId: string,
  spawnCallId: string,
  owningBatchId?: string,
): void {
  getSoulDb()
    .prepare(
      'UPDATE spawn_tasks SET spawn_call_id = ?, owning_batch_id = COALESCE(?, owning_batch_id), updated_at = ? WHERE task_id = ?',
    )
    .run(spawnCallId, owningBatchId ?? null, Date.now(), taskId)
}

export function timeoutSpawnTask(childChatId: string): {
  task?: SpawnTask
  firstTimeout: boolean
} {
  const db = getSoulDb()
  const task = getSpawnTaskByChild(childChatId)
  if (!task) return { firstTimeout: false }
  if (task.status === 'timed_out') return { task, firstTimeout: false }
  const changed = db
    .prepare(
      "UPDATE spawn_tasks SET status = 'timed_out', updated_at = ? WHERE task_id = ? AND status IN ('pending', 'started')",
    )
    .run(Date.now(), task.taskId)
  return {
    task: getSpawnTask(task.taskId),
    firstTimeout: changed.changes === 1,
  }
}

/** Pending/started tasks are replayed when the event history has expired. */
export function listOpenSpawnTasks(parentChatId: string): SpawnTask[] {
  const rows = getSoulDb()
    .prepare(
      "SELECT * FROM spawn_tasks WHERE parent_chat_id = ? AND status IN ('pending', 'started') ORDER BY created_at ASC",
    )
    .all(parentChatId) as Record<string, unknown>[]
  return rows.map(toSpawnTask)
}

/**
 * Startup recovery reads only spawn tasks that may still require parent wake
 * reconstruction. Completed historical children with an injected result stay
 * on disk and are not materialized into the startup catalog.
 */
export function listSpawnTasksNeedingWakeRecovery(): SpawnTask[] {
  const rows = getSoulDb()
    .prepare(
      `SELECT task.* FROM spawn_tasks task
       JOIN chats child ON child.id = task.child_chat_id
       WHERE child.parent_chat_id IS NOT NULL
         AND COALESCE(json_extract(child.metadata, '$.roleInjected'), 0) != 1
         AND COALESCE(json_extract(child.metadata, '$.abandoned'), 0) != 1
       ORDER BY task.created_at, task.task_id`,
    )
    .all() as Record<string, unknown>[]
  return rows.map(toSpawnTask)
}

export function listSpawnTasksByParents(parentChatIds: readonly string[]): SpawnTask[] {
  if (!parentChatIds.length) return []
  const placeholders = parentChatIds.map(() => '?').join(',')
  const rows = getSoulDb()
    .prepare(
      `SELECT * FROM spawn_tasks WHERE parent_chat_id IN (${placeholders}) ORDER BY created_at, task_id`,
    )
    .all(...parentChatIds) as Record<string, unknown>[]
  return rows.map(toSpawnTask)
}

export function rerouteSpawnTasks(
  taskIds: readonly string[],
  deliveryChatId: string,
  deliveryBranchId: string,
  generation: number,
): void {
  if (!taskIds.length) return
  const placeholders = taskIds.map(() => '?').join(',')
  getSoulDb()
    .prepare(
      `UPDATE spawn_tasks SET delivery_chat_id = ?, delivery_branch_id = ?, delivery_generation = ?, updated_at = ?
     WHERE task_id IN (${placeholders}) AND status IN ('pending', 'started')`,
    )
    .run(deliveryChatId, deliveryBranchId, generation, Date.now(), ...taskIds)
}
