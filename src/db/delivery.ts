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

export interface SpawnTask {
  taskId: string
  childChatId: string
  parentChatId: string
  type: string
  prompt: string
  brain: string
  senseGroup: string
  wait: boolean
  status: 'pending' | 'started' | 'finished'
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
  return write()
}

export function getChatEvents(chatId: string, afterSeq: number): ChatEventPage {
  const db = getMonthlyDb(chatMonth(chatId))
  const bounds = db
    .prepare(
      'SELECT MIN(chat_seq) AS minSeq, MAX(chat_seq) AS latestSeq FROM chat_events WHERE chat_id = ?',
    )
    .get(chatId) as { minSeq: number | null; latestSeq: number | null }
  const minSeq = bounds.minSeq ?? undefined
  const latestSeq = bounds.latestSeq ?? afterSeq
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

export function createSpawnTask(
  input: Omit<SpawnTask, 'taskId' | 'status'> & { taskId?: string },
): SpawnTask {
  const taskId = input.taskId ?? randomUUID()
  const now = Date.now()
  getSoulDb()
    .prepare(
      `INSERT INTO spawn_tasks
      (task_id, child_chat_id, parent_chat_id, type, prompt, brain, sense_group, wait, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(
      taskId,
      input.childChatId,
      input.parentChatId,
      input.type,
      input.prompt,
      input.brain,
      input.senseGroup,
      input.wait ? 1 : 0,
      now,
      now,
    )
  return { ...input, taskId, status: 'pending' }
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
    wait: Number(row.wait) === 1,
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
    .prepare("UPDATE spawn_tasks SET status = 'finished', updated_at = ? WHERE task_id = ?")
    .run(Date.now(), taskId)
}

/** Pending/started tasks are replayed when the event history has expired. */
export function listOpenSpawnTasks(parentChatId: string): SpawnTask[] {
  const rows = getSoulDb()
    .prepare(
      "SELECT * FROM spawn_tasks WHERE parent_chat_id = ? AND status != 'finished' ORDER BY created_at ASC",
    )
    .all(parentChatId) as Record<string, unknown>[]
  return rows.map(toSpawnTask)
}
