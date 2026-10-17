import type { FileOperationRecord, MessageAssetPart, MessagePart } from '@chery/protocol'
import { defaultDeliverableAssetIds } from '@chery/protocol'
export { defaultDeliverableAssetIds } from '@chery/protocol'
import { getSoulDb } from './index.js'
import { getMessages, parseMessageRow } from './message.js'

export interface SpawnTaskResult {
  summaryParts: MessagePart[]
  deliverableAssetIds: string[]
  operationIds: string[]
  status: 'completed' | 'failed' | 'timed_out' | 'abandoned'
  selection: 'explicit' | 'system'
}

/** Task input, explicit selection and completion survive independently of event retention. */
function storage() {
  const db = getSoulDb()
  db.exec(`CREATE TABLE IF NOT EXISTS spawn_file_results (
    task_id TEXT PRIMARY KEY REFERENCES spawn_tasks(task_id) ON DELETE CASCADE,
    input_parts_json TEXT,
    selection_json TEXT,
    result_json TEXT,
    updated_at INTEGER NOT NULL
  )`)
  return db
}

export function setSpawnInputParts(taskId: string, parts: readonly MessagePart[]): void {
  storage().prepare(`INSERT INTO spawn_file_results (task_id, input_parts_json, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET
    input_parts_json = excluded.input_parts_json, updated_at = excluded.updated_at`)
    .run(taskId, JSON.stringify(parts), Date.now())
}

export function getSpawnInputParts(taskId: string): MessagePart[] | undefined {
  const row = storage().prepare('SELECT input_parts_json FROM spawn_file_results WHERE task_id = ?')
    .get(taskId) as { input_parts_json: string | null } | undefined
  return row?.input_parts_json ? JSON.parse(row.input_parts_json) as MessagePart[] : undefined
}

export function getSpawnTaskResult(taskId: string): SpawnTaskResult | undefined {
  const row = storage().prepare('SELECT result_json FROM spawn_file_results WHERE task_id = ?')
    .get(taskId) as { result_json: string | null } | undefined
  return row?.result_json ? JSON.parse(row.result_json) as SpawnTaskResult : undefined
}

export function saveSpawnTaskResult(taskId: string, result: SpawnTaskResult): SpawnTaskResult {
  storage().prepare(`INSERT INTO spawn_file_results (task_id, result_json, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET
    result_json = COALESCE(spawn_file_results.result_json, excluded.result_json),
    updated_at = excluded.updated_at`).run(taskId, JSON.stringify(result), Date.now())
  return getSpawnTaskResult(taskId)!
}

export function getSpawnDeliverableSelection(taskId: string): string[] | undefined {
  const row = storage().prepare('SELECT selection_json FROM spawn_file_results WHERE task_id = ?')
    .get(taskId) as { selection_json: string | null } | undefined
  return row?.selection_json ? JSON.parse(row.selection_json) as string[] : undefined
}

/** Callers must validate every selected asset against authorized task outputs first. */
export function saveSpawnDeliverableSelection(taskId: string, assetIds: readonly string[]): void {
  const db = storage()
  db.transaction(() => {
    if (getSpawnTaskResult(taskId)) throw new Error('任务已完成，不能更改正式成果')
    db.prepare(`INSERT INTO spawn_file_results (task_id, selection_json, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET
      selection_json = excluded.selection_json, updated_at = excluded.updated_at`)
      .run(taskId, JSON.stringify([...new Set(assetIds)]), Date.now())
  })()
}

export interface TaskOutputSet {
  assets: MessageAssetPart[]
  operations: FileOperationRecord[]
  defaultAssetIds: string[]
}

function operationOutputIds(op: FileOperationRecord): string[] {
  return [...new Set([...(op.outputAssetIds ?? []), ...(op.outputParts ?? [])
    .filter((part) => part.type === 'asset').map((part) => part.assetId)])]
}

/** Read durable output facts only; user inputs and URLs are not task outputs. */
export function collectTaskOutputs(chatId: string): TaskOutputSet {
  const assets = new Map<string, MessageAssetPart>()
  const operations = new Map<string, FileOperationRecord>()
  const unregistered = new Set<string>()
  const add = (parts: readonly MessagePart[]) => {
    for (const part of parts) if (part.type === 'asset') assets.set(part.assetId, part)
  }
  for (const row of getMessages(chatId)) {
    if (row.revoked || !['assistant', 'sense', 'role'].includes(row.role)) continue
    const msg = parseMessageRow(row)
    add(msg.parts ?? [])
    for (const part of msg.parts ?? []) if (part.type === 'asset') unregistered.add(part.assetId)
    for (const op of msg.fileOperations ?? []) operations.set(op.operationId, op)
  }
  const db = getSoulDb()
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_operations'").get()) {
    const rows = db.prepare('SELECT data_json FROM file_operations WHERE chat_id = ?').all(chatId) as { data_json: string }[]
    for (const row of rows) {
      const op = JSON.parse(row.data_json) as FileOperationRecord
      operations.set(op.operationId, op)
    }
  }
  for (const op of operations.values()) {
    add(op.outputParts ?? [])
    for (const id of operationOutputIds(op)) {
      unregistered.delete(id)
      if (assets.has(id)) continue
      const version = db.prepare(`SELECT v.id, v.variant FROM asset_versions v
        JOIN asset_chat_grants g ON g.asset_id = v.asset_id
        WHERE v.asset_id = ? AND g.chat_id = ? AND v.variant = 'original'`).get(id, chatId) as
        { id: string; variant: 'original' } | undefined
      if (version) assets.set(id, { type: 'asset', partId: `output:${id}`, assetId: id,
        assetVersionId: version.id, variant: version.variant, usage: 'reference-only' })
    }
  }
  return { assets: [...assets.values()], operations: [...operations.values()],
    defaultAssetIds: [...new Set([...defaultDeliverableAssetIds([...operations.values()]), ...unregistered])] }
}
