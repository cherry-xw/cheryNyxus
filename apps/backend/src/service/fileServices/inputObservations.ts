import { getSoulDb } from '@/db/index.js'
import { fileAccessForChat } from '../media/access.js'
import { getAssetStore } from '../media/store.js'
import { getImageDescription, imageDescriptionSourceAllowed, type ImageDescription } from './imageContext.js'
function db() {
  const database = getSoulDb()
  database.exec(`CREATE TABLE IF NOT EXISTS file_input_observations (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    cache_key TEXT NOT NULL, owner_id TEXT NOT NULL, output_json TEXT NOT NULL,
    PRIMARY KEY(chat_id, cache_key));
    CREATE TABLE IF NOT EXISTS file_request_plans (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL);`)
  return database
}
export function getFileInputObservation(chatId: string, key: string): unknown {
  const access = fileAccessForChat(chatId)
  const row = db().prepare('SELECT output_json FROM file_input_observations WHERE chat_id = ? AND cache_key = ? AND owner_id = ?').get(chatId, key, access.ownerId) as { output_json: string } | undefined
  return row ? JSON.parse(row.output_json) : undefined
}
export function saveFileInputObservation(chatId: string, key: string, output: unknown): void {
  const access = fileAccessForChat(chatId)
  db().prepare('INSERT OR REPLACE INTO file_input_observations (chat_id, cache_key, owner_id, output_json) VALUES (?,?,?,?)').run(chatId, key, access.ownerId, JSON.stringify(output))
}
export function saveFileRequestPlan(chatId: string, data: unknown): void {
  const access = fileAccessForChat(chatId)
  db().prepare('INSERT OR REPLACE INTO file_request_plans (chat_id,owner_id,data_json,updated_at) VALUES (?,?,?,?)').run(chatId, access.ownerId, JSON.stringify(data), Date.now())
}
export function getFileRequestPlan(chatId: string, ownerId: string): unknown {
  fileAccessForChat(chatId, ownerId)
  const row = db().prepare('SELECT data_json, updated_at FROM file_request_plans WHERE chat_id = ? AND owner_id = ?').get(chatId, ownerId) as { data_json: string; updated_at: number } | undefined
  if (!row) return { plan: [], usage: null, status: 'not_prepared' }
  const data = JSON.parse(row.data_json)
  data.plan = (data.plan ?? []).map((item: { assetId: string; assetVersionId: string; description?: ImageDescription }) => {
    try {
      getAssetStore().get(item.assetId, fileAccessForChat(chatId, ownerId), item.assetVersionId)
      return { ...item, ...(item.description ? { description: getImageDescription(chatId, item, ownerId) && imageDescriptionSourceAllowed(chatId, item.description) ? item.description : undefined } : {}) }
    } catch { return { assetId: item.assetId, assetVersionId: item.assetVersionId, action: 'omit', reason: '文件缺失或无权访问', binaryBytes: 0, extractedChars: 0 } }
  })
  return { ...data, updatedAt: row.updated_at }
}

/** Patch only the same request; late provider/preflight events cannot overwrite a newer plan. */
export function patchFileRequestPlan(chatId: string, requestId: string, patch: Record<string, unknown>): void {
  const access = fileAccessForChat(chatId)
  const row = db().prepare('SELECT data_json FROM file_request_plans WHERE chat_id=? AND owner_id=?').get(chatId, access.ownerId) as { data_json: string } | undefined
  if (!row) return
  const current = JSON.parse(row.data_json)
  if (current.requestId !== requestId) return
  saveFileRequestPlan(chatId, { ...current, ...patch })
}
