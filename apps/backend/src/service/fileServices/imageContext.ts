import { getSoulDb } from '@/db/index.js'
import { getChatMonthlyDb } from '@/db/chatStorage.js'
import type { LLMResponse } from '@/core/message/adapter.js'
import type { MessageAssetPart } from '@chery/protocol'
import { deriveTextContentFromParts, type FileOperationRecord } from '@chery/protocol'
import { getAssetStore } from '../media/store.js'
import { fileAccessForChat } from '../media/access.js'

export interface ImageDescription {
  ruleVersion?: 1
  text: string
  keywords: string[]
  source: 'observation' | 'user'
  scope: string
  operationId?: string
  sourceMessageId?: string
  createdAt: number
}
export interface ImageReference { assetId: string; assetVersionId: string }
export const imageKey = (ref: ImageReference) => `${ref.assetId}:${ref.assetVersionId}`

function db() {
  const database = getSoulDb()
  database.exec(`CREATE TABLE IF NOT EXISTS image_context_turns (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, message_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL, PRIMARY KEY(chat_id,message_id));
    CREATE TABLE IF NOT EXISTS image_context_reads (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
    asset_id TEXT NOT NULL, version_id TEXT NOT NULL, ordinal INTEGER NOT NULL, part_json TEXT NOT NULL, source_message_id TEXT,
    PRIMARY KEY(chat_id,asset_id,version_id));
    CREATE TABLE IF NOT EXISTS image_context_requests (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
    message_id TEXT NOT NULL, part_json TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(chat_id,message_id));
    CREATE TABLE IF NOT EXISTS image_descriptions (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
    asset_id TEXT NOT NULL, version_id TEXT NOT NULL, data_json TEXT NOT NULL,
    PRIMARY KEY(chat_id,asset_id,version_id));
    CREATE TABLE IF NOT EXISTS image_description_attempts (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
    attempt_key TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
    PRIMARY KEY(chat_id,attempt_key));`)
  return database
}

/** Description lookup always rechecks the fixed version's current access. No image bytes are read. */
export function getImageDescription(chatId: string, ref: ImageReference, ownerId?: string): ImageDescription | undefined {
  const access = fileAccessForChat(chatId, ownerId)
  const asset = getAssetStore().get(ref.assetId, access, ref.assetVersionId)
  if (asset.kind !== 'image' || asset.availability !== 'available') return undefined
  const row = db().prepare('SELECT data_json FROM image_descriptions WHERE chat_id=? AND owner_id=? AND asset_id=? AND version_id=?')
    .get(chatId, access.ownerId, ref.assetId, ref.assetVersionId) as { data_json: string } | undefined
  let description: ImageDescription | undefined = row ? JSON.parse(row.data_json) : undefined
  if (!description && databaseHasOperations()) {
    const operations = db().prepare('SELECT data_json FROM file_operations WHERE chat_id=? AND owner_id=? ORDER BY rowid DESC LIMIT 200').all(chatId, access.ownerId) as Array<{ data_json: string }>
    for (const item of operations) {
      const operation = JSON.parse(item.data_json) as FileOperationRecord
      if (operation.operation !== 'image.inspect' || operation.executionStatus !== 'succeeded' || operation.deliveryStatus !== 'saved' || operation.inputAssets.length !== 1 || imageKey(operation.inputAssets[0]!) !== imageKey(ref)) continue
      const text = deriveTextContentFromParts(operation.outputParts ?? []).slice(0, 4000)
      if (text.trim()) { description = { ruleVersion: 1, text, keywords: literalKeywords(text), source: 'observation', scope: '既有单图理解操作，并非完整图像记录', operationId: operation.operationId, sourceMessageId: operation.sourceCallId, createdAt: operation.updatedAt }; break }
    }
  }
  if (!description) return undefined
  if (!imageDescriptionSourceAllowed(chatId, description)) return undefined
  return description
}

export function imageDescriptionSourceAllowed(chatId: string, description: Pick<ImageDescription, 'sourceMessageId'>): boolean {
  if (!description.sourceMessageId) return true
  const source = getChatMonthlyDb(chatId)?.prepare('SELECT revoked,model_excluded FROM messages WHERE id=? AND chat_id=?').get(description.sourceMessageId, chatId) as { revoked?: number; model_excluded?: number } | undefined
  return !source?.revoked && !source?.model_excluded
}

function databaseHasOperations(): boolean {
  return !!db().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_operations'").get()
}
function literalKeywords(text: string): string[] {
  return [...new Set((text.match(/[\p{L}\p{N}]{2,24}/gu) ?? []).slice(0, 12))]
}

export function saveImageDescription(chatId: string, ref: ImageReference, description: Omit<ImageDescription, 'createdAt' | 'keywords'> & { keywords?: string[] }): void {
  const access = fileAccessForChat(chatId)
  const asset = getAssetStore().get(ref.assetId, access, ref.assetVersionId)
  if (asset.kind !== 'image' || !description.text.trim()) return
  const existing = getImageDescription(chatId, ref)
  if (existing?.source === 'observation' && description.source === 'user') return
  const text = description.text.slice(0, 4000)
  // Extract literal terms only; these are search hints, never new visual claims.
  const keywords = (description.keywords ?? literalKeywords(text)).slice(0, 12).map(word => word.slice(0, 40))
  const record: ImageDescription = { ...description, ruleVersion: 1, text, keywords: [...new Set(keywords)], createdAt: Date.now() }
  db().prepare('INSERT OR REPLACE INTO image_descriptions VALUES (?,?,?,?,?)').run(chatId, access.ownerId, ref.assetId, ref.assetVersionId, JSON.stringify(record))
}

export function listImageDescriptions(chatId: string, query = '', limit = 20) {
  const access = fileAccessForChat(chatId)
  const rows = db().prepare('SELECT asset_id,version_id,data_json FROM image_descriptions WHERE chat_id=? AND owner_id=? ORDER BY rowid DESC LIMIT 200')
    .all(chatId, access.ownerId) as Array<{ asset_id: string; version_id: string; data_json: string }>
  return rows.flatMap(row => {
    try {
      const description = getImageDescription(chatId, { assetId: row.asset_id, assetVersionId: row.version_id })
      if (!description) return []
      if (query && !`${description.text} ${description.keywords.join(' ')}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return []
      return [{ assetId: row.asset_id, assetVersionId: row.version_id, description }]
    } catch { return [] }
  }).slice(0, Math.min(50, limit))
}

/** A successful tool call schedules an explicit read; it does not claim the model has received it. */
export function requestImageRead(chatId: string, messageId: string, refs: ImageReference[]): void {
  const access = fileAccessForChat(chatId)
  const parts = refs.map((ref, index): MessageAssetPart => {
    const asset = getAssetStore().get(ref.assetId, access, ref.assetVersionId)
    if (asset.kind !== 'image' || asset.availability !== 'available') throw new Error('所选图片不可用')
    return { type: 'asset', assetId: ref.assetId, assetVersionId: ref.assetVersionId, partId: `reread-${messageId}-${index}`, variant: asset.transform?.variant ?? 'original', usage: 'content', originalName: asset.originalName, mimeType: asset.mimeType }
  })
  db().prepare('INSERT OR IGNORE INTO image_context_requests(chat_id,owner_id,message_id,part_json) VALUES (?,?,?,?)').run(chatId, access.ownerId, messageId, JSON.stringify(parts))
}

export interface ImageTurnView {
  sourceScopeId?: string
  sourceTurnId?: string
  sourcePositions?: Record<string, { recordId: string; revision: number; partIds: Record<string, string> }>
  ordinal: number
  turns: Array<{ id: string; ordinal: number; turnId?: string }>
  activeOrdinals: number[]
  images: Array<{ part: MessageAssetPart; ordinal: number }>
  requested: MessageAssetPart[]
  requestedMessageIds?: string[]
  requestSources?: Record<string, string>
}

/** Read-only preparation. Pending/new user turns are committed only at a provider request boundary. */
export function imageTurnView(chatId: string, history: LLMResponse[]): ImageTurnView {
  const access = fileAccessForChat(chatId)
  const scopeIds = [...new Set(history.flatMap(message => message.sourceRecord ? [message.sourceRecord.scopeId] : []))]
  if (scopeIds.length > 1) throw new Error('SOURCE_CONFLICT')
  const scopeId = scopeIds[0]
  const currentSource = history.findLast(message => message.sourceRecord?.origin === 'current')?.sourceRecord
  if (scopeId && !currentSource) throw new Error('SOURCE_CONTEXT_UNAVAILABLE')
  const rows = (scopeId
    ? db().prepare('SELECT turn_id AS message_id,ordinal FROM source_turns WHERE scope_id=? ORDER BY ordinal').all(scopeId)
    : db().prepare('SELECT message_id,ordinal FROM image_context_turns WHERE chat_id=? ORDER BY ordinal').all(chatId)) as Array<{ message_id: string; ordinal: number }>
  const known = new Map(rows.map(row => [row.message_id, row.ordinal]))
  let ordinal = rows.at(-1)?.ordinal ?? 0
  const turns: ImageTurnView['turns'] = []
  for (const message of history) {
    if (message.role !== 'user' || message.ephemeral || message.revoked || message.modelExcluded) continue
    // Source background, summary and tool-result renderings are not new user turns.
    if (scopeId && message.sourceRecord?.origin !== 'current') continue
    const turnId = message.sourceRecord?.turnId ?? message.id
    const value = known.get(turnId) ?? ++ordinal
    known.set(turnId, value)
    turns.push({ id: message.id, ordinal: value, turnId })
  }
  const latest = Math.max(ordinal, ...turns.map(turn => turn.ordinal))
  // Already adopted turns remain counted even if later hidden/revoked; only unadopted ones are skipped.
  const activeOrdinals = [...new Set([...rows.map(row => row.ordinal), ...turns.map(turn => turn.ordinal)])]
  const images = ((scopeId
    ? db().prepare(`SELECT t.ordinal,a.part_json,a.source_message_id FROM source_file_adoptions a
        JOIN source_turns t ON t.scope_id=a.scope_id AND t.turn_id=a.effective_turn_id
        WHERE a.scope_id=? AND a.owner_id=? ORDER BY t.ordinal DESC`).all(scopeId, access.ownerId)
    : db().prepare('SELECT ordinal,part_json,source_message_id FROM image_context_reads WHERE chat_id=? AND owner_id=? ORDER BY ordinal DESC')
        .all(chatId, access.ownerId)) as Array<{ ordinal: number; part_json: string; source_message_id?: string }>).filter(row => {
      if (!row.source_message_id) return true
      const source = getChatMonthlyDb(chatId)?.prepare('SELECT revoked,model_excluded FROM messages WHERE id=? AND chat_id=?').get(row.source_message_id, chatId) as { revoked?: number; model_excluded?: number } | undefined
      return !source?.revoked && !source?.model_excluded && !history.some(message => message.id === row.source_message_id && (message.revoked || message.modelExcluded))
    }).map(row => ({ ordinal: row.ordinal, part: JSON.parse(row.part_json) as MessageAssetPart }))
  const visible = new Set(history.filter(message => !message.revoked && !message.modelExcluded && message.role === 'sense' && message.content.includes('image_read_prepared')).map(message => message.id))
  const requestSources: Record<string, string> = {}
  const requestRows = (db().prepare('SELECT message_id,part_json FROM image_context_requests WHERE chat_id=? AND owner_id=? AND consumed=0')
    .all(chatId, access.ownerId) as Array<{ message_id: string; part_json: string }>).filter(row => visible.has(row.message_id))
  const requested = requestRows.flatMap(row => {
      const refs = JSON.parse(row.part_json) as MessageAssetPart[]
      for (const ref of refs) requestSources[imageKey(ref)] = row.message_id
      return refs
    })
  return { ordinal: latest, turns, activeOrdinals, images, requested, requestSources, requestedMessageIds: requestRows.map(row => row.message_id),
    ...(scopeId ? { sourceScopeId: scopeId, sourceTurnId: currentSource!.turnId,
      sourcePositions: Object.fromEntries(history.flatMap(message => message.sourceRecord ? [[message.id, {
        recordId: message.sourceRecord.recordId, revision: message.sourceRecord.revision, partIds: message.sourcePartIds ?? {},
      }]] : [])) } : {}) }
}

export function commitImageInputs(chatId: string, view: ImageTurnView, images: Array<{ part: MessageAssetPart; refresh: boolean; ordinal?: number; sourceMessageId?: string; sourcePosition?: NonNullable<ImageTurnView['sourcePositions']>[string] }>): void {
  const access = fileAccessForChat(chatId)
  const database = db()
  database.transaction(() => {
    if (view.sourceScopeId) {
      const turn = database.prepare('SELECT ordinal FROM source_turns WHERE scope_id=? AND turn_id=?').get(view.sourceScopeId, view.sourceTurnId) as { ordinal: number } | undefined
      if (!turn || turn.ordinal !== view.ordinal) throw new Error('SOURCE_CONFLICT')
    } else for (const turn of view.turns) database.prepare('INSERT OR IGNORE INTO image_context_turns VALUES (?,?,?)').run(chatId, turn.turnId ?? turn.id, turn.ordinal)
    for (const { part, refresh, ordinal, sourceMessageId, sourcePosition } of images) {
      getAssetStore().get(part.assetId, access, part.assetVersionId)
      if (view.sourceScopeId) {
        database.prepare(`INSERT INTO source_file_adoptions
          (scope_id,owner_id,asset_id,asset_version_id,first_turn_id,effective_turn_id,part_json,source_message_id)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope_id,owner_id,asset_id,asset_version_id) DO NOTHING`)
          .run(view.sourceScopeId, access.ownerId, part.assetId, part.assetVersionId, view.sourceTurnId, view.sourceTurnId, JSON.stringify(part), sourceMessageId ?? null)
        if (refresh) database.prepare(`UPDATE source_file_adoptions SET effective_turn_id=?,part_json=?,source_message_id=?
          WHERE scope_id=? AND owner_id=? AND asset_id=? AND asset_version_id=?`)
          .run(view.sourceTurnId, JSON.stringify(part), sourceMessageId ?? null, view.sourceScopeId, access.ownerId, part.assetId, part.assetVersionId)
        const position = sourcePosition ?? (sourceMessageId ? view.sourcePositions?.[sourceMessageId] : undefined)
        const partId = position?.partIds[part.partId]
        if (position && partId) database.prepare(`INSERT OR IGNORE INTO source_file_positions
          (scope_id,record_id,record_revision,part_id,asset_id,asset_version_id,first_turn_id) VALUES (?,?,?,?,?,?,?)`)
          .run(view.sourceScopeId, position.recordId, position.revision, partId, part.assetId, part.assetVersionId, view.sourceTurnId)
      } else database.prepare(`INSERT OR ${refresh ? 'REPLACE' : 'IGNORE'} INTO image_context_reads VALUES (?,?,?,?,?,?,?)`)
          .run(chatId, access.ownerId, part.assetId, part.assetVersionId, refresh ? view.ordinal : ordinal ?? view.ordinal, JSON.stringify(part), sourceMessageId ?? null)
    }
    // Consume only the exact explicit reads included in this request.
    const requested = new Set(images.filter(item => item.refresh).map(item => imageKey(item.part)))
    const rows = database.prepare('SELECT message_id,part_json FROM image_context_requests WHERE chat_id=? AND owner_id=? AND consumed=0').all(chatId, access.ownerId) as Array<{ message_id: string; part_json: string }>
    for (const row of rows) if (view.requestedMessageIds?.includes(row.message_id) &&
      (JSON.parse(row.part_json) as MessageAssetPart[]).every(part => requested.has(imageKey(part))))
      database.prepare('UPDATE image_context_requests SET consumed=1 WHERE chat_id=? AND message_id=?').run(chatId, row.message_id)
  })()
}

export function beginDescriptionAttempt(chatId: string, key: string): boolean {
  const access = fileAccessForChat(chatId)
  return db().prepare("INSERT OR IGNORE INTO image_description_attempts VALUES (?,?,?,'started',NULL)").run(chatId, access.ownerId, key).changes === 1
}
export function finishDescriptionAttempt(chatId: string, key: string, error?: string): void {
  const access = fileAccessForChat(chatId)
  db().prepare('UPDATE image_description_attempts SET status=?,error=? WHERE chat_id=? AND owner_id=? AND attempt_key=?').run(error ? 'failed' : 'completed', error?.slice(0, 300) ?? null, chatId, access.ownerId, key)
}

export function imageDescriptionIssue(chatId: string, ref: ImageReference, ownerId?: string): string | undefined {
  const access = fileAccessForChat(chatId, ownerId)
  getAssetStore().get(ref.assetId, access, ref.assetVersionId)
  const key = `${ref.assetId}:${ref.assetVersionId}:%`
  const attempt = db().prepare('SELECT status FROM image_description_attempts WHERE chat_id=? AND owner_id=? AND attempt_key LIKE ? ORDER BY rowid DESC LIMIT 1').get(chatId, access.ownerId, key) as { status: string } | undefined
  return attempt && attempt.status !== 'completed' ? '自动补描述未完成，结果未确认；不会自动重试。可使用明确重新读图。' : undefined
}
