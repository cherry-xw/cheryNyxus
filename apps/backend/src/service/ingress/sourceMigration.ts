import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { z } from 'zod'
import {
  SourceConversationKeySchema,
  SourceRecordSchema,
  SourceScopeSchema,
  SourceAttachmentVersionSchema,
  SourceHandlingSchema,
  QQNotificationSchema,
  QQDeliveryResultRequestSchema,
  type SourceRecord,
  type SourceRecordRef,
  type SourceScope,
  type SourcePart,
  type SourceReceiptResult,
} from '@chery/protocol'
import { initSourceContextTables, SourceContextRepository, sourceFingerprint } from '@/db/sourceContext.js'

type SourceParts = SourcePart[]

export interface LegacySourceMigrationConflict {
  kind:
    | 'state_version_invalid'
    | 'group_memory_version_invalid'
    | 'unresolvable_scope'
    | 'record_fingerprint_conflict'
    | 'platform_alias_conflict'
    | 'group_memory_source_missing'
    | 'group_memory_source_mismatch'
    | 'corrupt_file'
  target?: string
  detail: string
}

export interface LegacySourceMigrationReport {
  mode: 'dry-run' | 'apply'
  stateFile: string
  stateSchemaVersionBefore: number
  stateSchemaVersionAfter: number
  alreadyMigrated: boolean
  scopesCreatedOrReused: number
  memberRecordsImported: number
  botDeliveriesImported: number
  jobsLinked: number
  discussionsReset: number
  groupMemoryFilesScanned: number
  groupMemoryFilesMigrated: number
  groupMemoryFactsChecked: number
  conflicts: LegacySourceMigrationConflict[]
  backupManifestPath?: string
  operationId?: string
  publicationState?: 'pending' | 'completed'
}

export interface MigrateLegacyQQSourcesOptions {
  db: Database.Database
  dataDir: string
  ownerId?: string
  channel?: string
  defaultSelfId?: string
  defaultPresetId?: string
  mode?: 'dry-run' | 'apply'
  backupDir?: string
  now?: () => number
}

const deterministicId = (prefix: string, seed: unknown) =>
  `${prefix}-${sourceFingerprint(seed).slice(0, 24)}`

type MigrationFile = { filePath: string; beforeHash: string; content: string }
type MigrationPublication = { files: MigrationFile[]; report: LegacySourceMigrationReport }
const hashBytes = (body: string | Buffer) => createHash('sha256').update(body).digest('hex')

function writeAtomic(filePath: string, body: string): void {
  const temporary = path.join(path.dirname(filePath), `.source-migration-${randomUUID()}`)
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, body)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor); descriptor = undefined
    fs.renameSync(temporary, filePath)
    const directory = fs.openSync(path.dirname(filePath), 'r')
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function publishMigration(db: Database.Database, operationId: string, publication: MigrationPublication): LegacySourceMigrationReport {
  const backup = JSON.parse(fs.readFileSync(publication.report.backupManifestPath!, 'utf8')) as {
    operationId: string; files: { backupPath: string; sha256: string }[]
  }
  if (backup.operationId !== operationId || !backup.files.length ||
    backup.files.some(file => sha256File(file.backupPath) !== file.sha256)) throw new Error('MIGRATION_BACKUP_CONFLICT')
  // Check the whole set first; a partial publication must not overwrite a later manual edit.
  for (const file of publication.files) {
    if (!fs.lstatSync(file.filePath).isFile() || fs.lstatSync(file.filePath).isSymbolicLink()) throw new Error('MIGRATION_FILE_CONFLICT')
    const current = sha256File(file.filePath)
    if (current !== file.beforeHash && current !== hashBytes(file.content)) throw new Error('MIGRATION_FILE_CONFLICT')
  }
  for (const file of publication.files) {
    if (sha256File(file.filePath) !== hashBytes(file.content)) writeAtomic(file.filePath, file.content)
  }
  db.prepare("UPDATE source_legacy_migrations SET state='completed' WHERE operation_id=?").run(operationId)
  return { ...publication.report, publicationState: 'completed' }
}

function backupMigration(options: MigrateLegacyQQSourcesOptions, operationId: string, files: MigrationFile[], database: Buffer): string {
  const directory = path.join(options.backupDir ?? path.join(options.dataDir, 'migration-backup-v1-to-v2'), operationId)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const backedUp: { originalPath: string; backupPath: string; sha256: string }[] = []
  const save = (originalPath: string, name: string, bytes: Buffer) => {
    const destination = path.join(directory, name), expected = hashBytes(bytes)
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
    try { fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    if (sha256File(destination) !== expected) throw new Error('MIGRATION_BACKUP_CONFLICT')
    const fd = fs.openSync(destination, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    backedUp.push({ originalPath, backupPath: destination, sha256: expected })
  }
  save(options.db.name, 'soul.db', database)
  for (const file of files) {
    const body = fs.readFileSync(file.filePath)
    if (hashBytes(body) !== file.beforeHash) throw new Error('MIGRATION_FILE_CONFLICT')
    save(file.filePath, path.relative(options.dataDir, file.filePath), body)
  }
  const manifest = path.join(directory, 'backup-manifest.json')
  const text = JSON.stringify({ operationId, files: backedUp }, null, 2)
  try { fs.writeFileSync(manifest, text, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  if (fs.readFileSync(manifest, 'utf8') !== text) throw new Error('MIGRATION_BACKUP_CONFLICT')
  const fd = fs.openSync(manifest, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  return manifest
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function legacyPartsToSourceParts(
  conversationId: string,
  messageId: string,
  rawInput: Record<string, unknown>,
): {
  parts: SourceParts
  attachments: Array<{
    partId: string
    nativeSourceId?: string
    originalName?: string
    declaredMimeType?: string
    mediaKind: 'image' | 'audio' | 'video' | 'document' | 'file'
  }>
} {
  if (Array.isArray(rawInput.sourceParts) && rawInput.sourceParts.length > 0) {
    const rawAttachments = Array.isArray(rawInput.attachments) ? (rawInput.attachments as Array<Record<string, unknown>>) : []
    const parts = (rawInput.sourceParts as SourceParts).map((part) =>
      part.type === 'attachment'
        ? {
            ...part,
            attachmentId: `attachment-${sourceFingerprint([conversationId, messageId, part.partId])}`,
          }
        : part,
    )
    const attachments = parts
      .filter((p): p is Extract<SourceParts[number], { type: 'attachment' }> => p.type === 'attachment')
      .map((part) => {
        const meta = rawAttachments.find((a) => a.partId === part.partId) ?? {}
        const rawType = typeof meta.type === 'string' ? meta.type : 'file'
        const mediaKind: 'image' | 'audio' | 'video' | 'document' | 'file' =
          rawType === 'image' || rawType === 'audio' || rawType === 'video' || rawType === 'document'
            ? rawType
            : 'file'
        return {
          partId: part.partId,
          ...(typeof meta.nativeSourceId === 'string' ? { nativeSourceId: meta.nativeSourceId } : {}),
          ...(typeof meta.name === 'string' ? { originalName: meta.name } : {}),
          ...(typeof meta.mimeType === 'string' ? { declaredMimeType: meta.mimeType } : {}),
          mediaKind,
        }
      })
    return { parts, attachments }
  }
  const parts: SourceParts = []
  const attachments: Array<{
    partId: string
    nativeSourceId?: string
    originalName?: string
    declaredMimeType?: string
    mediaKind: 'image' | 'audio' | 'video' | 'document' | 'file'
  }> = []
  if (typeof rawInput.replyToMessageId === 'string' && /^-?\d{1,100}$/.test(rawInput.replyToMessageId)) {
    parts.push({
      partId: `p${parts.length}`,
      type: 'reply',
      platformMessageId: rawInput.replyToMessageId,
    })
  }
  if (rawInput.mentionedBot === true && typeof rawInput.selfId === 'string' && /^[1-9]\d{0,19}$/.test(rawInput.selfId)) {
    parts.push({
      partId: `p${parts.length}`,
      type: 'mention',
      target: rawInput.selfId,
    })
  }
  const rawAttachments = Array.isArray(rawInput.attachments) ? (rawInput.attachments as Array<Record<string, unknown>>) : []
  const rawParts = Array.isArray(rawInput.parts) ? (rawInput.parts as Array<Record<string, unknown>>) : []
  for (const item of rawParts) {
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      parts.push({ partId: `p${parts.length}`, type: 'text', text: item.text })
    } else if (item.type === 'attachment' && typeof item.index === 'number') {
      const partId = `p${parts.length}`
      const attachmentId = `attachment-${sourceFingerprint([conversationId, messageId, partId])}`
      parts.push({ partId, type: 'attachment', attachmentId })
      const meta = rawAttachments[item.index] ?? {}
      const rawType = typeof meta.type === 'string' ? meta.type : 'file'
      const mediaKind: 'image' | 'audio' | 'video' | 'document' | 'file' =
        rawType === 'image' || rawType === 'audio' || rawType === 'video' || rawType === 'document'
          ? rawType
          : 'file'
      attachments.push({
        partId,
        ...(typeof meta.nativeSourceId === 'string' ? { nativeSourceId: meta.nativeSourceId } : {}),
        ...(typeof meta.name === 'string' ? { originalName: meta.name } : {}),
        ...(typeof meta.mimeType === 'string' ? { declaredMimeType: meta.mimeType } : {}),
        mediaKind,
      })
    }
  }
  if (!parts.some((p) => p.type === 'text' || p.type === 'attachment')) {
    const fallbackText =
      typeof rawInput.content === 'string' && rawInput.content.length > 0
        ? rawInput.content
        : typeof rawInput.text === 'string' && rawInput.text.length > 0
          ? rawInput.text
          : ''
    if (fallbackText.length > 0) {
      parts.push({ partId: `p${parts.length}`, type: 'text', text: fallbackText })
    }
  }
  if (parts.length === 0) {
    parts.push({
      partId: 'p0',
      type: 'unsupported',
      sourceType: 'legacy_empty',
      description: '历史可信记录未携带可解析正文分片。',
    })
  }
  return { parts, attachments }
}

function normalizeLegacyInput(rawInput: Record<string, unknown>, conversationId: string): Record<string, unknown> {
  const messageId = String(rawInput.messageId ?? '')
  const { parts } = legacyPartsToSourceParts(conversationId, messageId, rawInput)
  const rawAttachments = Array.isArray(rawInput.attachments) ? (rawInput.attachments as Array<Record<string, unknown>>) : undefined
  const attachmentParts = parts.filter((p) => p.type === 'attachment')
  const normalizedAttachments = rawAttachments?.map((att, index) => ({
    ...att,
    partId: typeof att.partId === 'string' ? att.partId : (attachmentParts[index]?.partId ?? `p${index}`),
  }))
  const joinedText = parts.filter((p): p is Extract<SourceParts[number], { type: 'text' }> => p.type === 'text').map((p) => p.text).join('')
  const next: Record<string, unknown> = {
    ...rawInput,
    content: joinedText,
    sourceParts: Array.isArray(rawInput.sourceParts) && rawInput.sourceParts.length > 0 ? rawInput.sourceParts : parts,
    ...(normalizedAttachments ? { attachments: normalizedAttachments } : {}),
  }
  delete next.text
  return next
}

export function migrateLegacyQQSources(options: MigrateLegacyQQSourcesOptions): LegacySourceMigrationReport {
  if ((options.mode ?? 'dry-run') === 'apply') return migrateLegacyQQSourcesInDatabase(options)
  // Even table initialization belongs to the private preview copy, not the supplied database.
  // SQLite refuses to open a serialized buffer whose header still marks WAL mode (bytes 18..19 = 2).
  const serialized = Buffer.from(options.db.serialize())
  if (serialized.length >= 20 && serialized.subarray(0, 16).toString('utf8') === 'SQLite format 3\u0000') {
    if (serialized[18] === 2) serialized[18] = 1
    if (serialized[19] === 2) serialized[19] = 1
  }
  const preview = new Database(serialized)
  try { return migrateLegacyQQSourcesInDatabase({ ...options, db: preview }) }
  finally { preview.close() }
}

function migrateLegacyQQSourcesInDatabase(options: MigrateLegacyQQSourcesOptions): LegacySourceMigrationReport {
  const ownerId = options.ownerId ?? 'cherynyxus-qq-module'
  const channel = options.channel ?? 'qq'
  const mode = options.mode ?? 'dry-run'
  const now = options.now ?? Date.now
  const stateFile = path.join(options.dataDir, 'state.json')
  const conflicts: LegacySourceMigrationConflict[] = []

  if (options.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_legacy_migrations'").get()) {
    const pending = options.db.prepare("SELECT operation_id,data_json FROM source_legacy_migrations WHERE data_dir=? AND state='pending'")
      .get(path.resolve(options.dataDir)) as { operation_id: string; data_json: string } | undefined
    if (pending) {
      const publication = JSON.parse(pending.data_json) as MigrationPublication
      return mode === 'apply' ? publishMigration(options.db, pending.operation_id, publication)
        : { ...publication.report, mode: 'dry-run', publicationState: 'pending' }
    }
  }

  if (!fs.existsSync(stateFile)) {
    return {
      mode,
      stateFile,
      stateSchemaVersionBefore: 2,
      stateSchemaVersionAfter: 2,
      alreadyMigrated: true,
      scopesCreatedOrReused: 0,
      memberRecordsImported: 0,
      botDeliveriesImported: 0,
      jobsLinked: 0,
      discussionsReset: 0,
      groupMemoryFilesScanned: 0,
      groupMemoryFilesMigrated: 0,
      groupMemoryFactsChecked: 0,
      conflicts,
    }
  }

  let rawState: Record<string, unknown>
  try {
    rawState = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, unknown>
  } catch (error) {
    conflicts.push({
      kind: 'corrupt_file',
      target: stateFile,
      detail: `Failed to parse state.json: ${error instanceof Error ? error.message : String(error)}`,
    })
    return {
      mode,
      stateFile,
      stateSchemaVersionBefore: -1,
      stateSchemaVersionAfter: -1,
      alreadyMigrated: false,
      scopesCreatedOrReused: 0,
      memberRecordsImported: 0,
      botDeliveriesImported: 0,
      jobsLinked: 0,
      discussionsReset: 0,
      groupMemoryFilesScanned: 0,
      groupMemoryFilesMigrated: 0,
      groupMemoryFactsChecked: 0,
      conflicts,
    }
  }

  const schemaVersionBefore = typeof rawState.schemaVersion === 'number' ? rawState.schemaVersion : -1
  if (schemaVersionBefore !== 1 && schemaVersionBefore !== 2) {
    conflicts.push({
      kind: 'state_version_invalid',
      target: stateFile,
      detail: `Unsupported state.json schemaVersion: ${String(rawState.schemaVersion)}`,
    })
  }

  const topicsDir = path.join(options.dataDir, 'memory', 'topics')
  const topicFiles = fs.existsSync(topicsDir)
    ? fs
        .readdirSync(topicsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(topicsDir, f))
    : []

  const parsedTopicFiles: Array<{ filePath: string; data: Record<string, unknown> }> = []
  for (const filePath of topicFiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
      if (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) {
        conflicts.push({
          kind: 'group_memory_version_invalid',
          target: filePath,
          detail: `Unsupported group memory schemaVersion: ${String(parsed.schemaVersion)}`,
        })
      }
      parsedTopicFiles.push({ filePath, data: parsed })
    } catch (error) {
      conflicts.push({
        kind: 'corrupt_file',
        target: filePath,
        detail: `Failed to parse group memory file: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  if (conflicts.length > 0) {
    return {
      mode,
      stateFile,
      stateSchemaVersionBefore: schemaVersionBefore,
      stateSchemaVersionAfter: schemaVersionBefore,
      alreadyMigrated: false,
      scopesCreatedOrReused: 0,
      memberRecordsImported: 0,
      botDeliveriesImported: 0,
      jobsLinked: 0,
      discussionsReset: 0,
      groupMemoryFilesScanned: topicFiles.length,
      groupMemoryFilesMigrated: 0,
      groupMemoryFactsChecked: 0,
      conflicts,
    }
  }

  if (schemaVersionBefore === 2 && parsedTopicFiles.every(topic => topic.data.schemaVersion === 3)) {
    return { mode, stateFile, stateSchemaVersionBefore: 2, stateSchemaVersionAfter: 2, alreadyMigrated: true,
      scopesCreatedOrReused: 0, memberRecordsImported: 0, botDeliveriesImported: 0, jobsLinked: 0, discussionsReset: 0,
      groupMemoryFilesScanned: topicFiles.length, groupMemoryFilesMigrated: 0, groupMemoryFactsChecked: 0, conflicts }
  }
  const originalDatabase = mode === 'apply' ? options.db.serialize() : undefined
  const beforeHashes = new Map([stateFile, ...topicFiles].map(file => [file, sha256File(file)]))
  const operationId = deterministicId('migration', { files: [...beforeHashes], database: hashBytes(originalDatabase ?? options.db.serialize()) })
  initSourceContextTables(options.db)
  if (mode === 'apply') options.db.exec(`CREATE TABLE IF NOT EXISTS source_legacy_migrations (
    operation_id TEXT PRIMARY KEY, data_dir TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','completed')), data_json TEXT NOT NULL
  )`)

  const identitySelfId =
    (typeof (rawState.identityBinding as Record<string, unknown> | undefined)?.selfId === 'string'
      ? ((rawState.identityBinding as Record<string, unknown>).selfId as string)
      : undefined) ?? options.defaultSelfId

  const rawJobs = Array.isArray(rawState.jobs) ? (rawState.jobs as Array<Record<string, unknown>>) : []
  const rawOutbox = Array.isArray(rawState.outbox) ? (rawState.outbox as Array<Record<string, unknown>>) : []
  const rawDiscussions =
    typeof rawState.discussions === 'object' && rawState.discussions !== null
      ? (rawState.discussions as Record<string, Record<string, unknown>>)
      : {}
  const contextEpoch = typeof rawState.contextEpoch === 'string' ? rawState.contextEpoch : ''

  // Map target ("group:123" or "private:user:456") -> { selfId, conversationType, targetId, presetId, qqContextEpoch }
  const targetConfigs = new Map<
    string,
    {
      selfId: string
      conversationType: 'group' | 'private'
      targetId: string
      presetId: string
      qqContextEpoch: string
    }
  >()

  const registerTarget = (
    targetKey: string,
    selfId: string | undefined,
    conversationType: 'group' | 'private',
    targetId: string,
    presetId: string | undefined,
  ) => {
    const resolvedSelf = selfId ?? identitySelfId
    const resolvedPreset = presetId ?? options.defaultPresetId ?? 'default'
    if (!resolvedSelf || !/^[1-9]\d{0,19}$/.test(resolvedSelf) || !/^[1-9]\d{0,19}$/.test(targetId)) {
      conflicts.push({
        kind: 'unresolvable_scope',
        target: targetKey,
        detail: `Cannot resolve selfId (${String(resolvedSelf)}) or targetId (${targetId}) for ${targetKey}`,
      })
      return
    }
    const existing = targetConfigs.get(targetKey)
    if (existing && (existing.selfId !== resolvedSelf || presetId && existing.presetId !== resolvedPreset)) {
      conflicts.push({ kind: 'unresolvable_scope', target: targetKey,
        detail: 'Trusted inputs disagree on the robot or preset for this target; explicit scope resolution is required' })
      return
    }
    if (!existing) {
      targetConfigs.set(targetKey, {
        selfId: resolvedSelf,
        conversationType,
        targetId,
        presetId: resolvedPreset,
        qqContextEpoch: contextEpoch,
      })
    }
  }

  for (const job of rawJobs) {
    const input = (job.input ?? {}) as Record<string, unknown>
    const snapshot = (job.snapshot ?? {}) as Record<string, unknown>
    const convType = input.conversationType === 'private' ? 'private' : 'group'
    const targetId = String(input.targetId ?? '')
    const targetKey = typeof job.target === 'string' ? job.target : convType === 'group' ? `group:${targetId}` : `private:user:${targetId}`
    registerTarget(
      targetKey,
      typeof input.selfId === 'string' ? input.selfId : undefined,
      convType,
      targetId,
      typeof snapshot.presetId === 'string'
        ? snapshot.presetId
        : typeof snapshot.preset === 'string'
          ? snapshot.preset
          : undefined,
    )
  }

  for (const [targetKey, disc] of Object.entries(rawDiscussions)) {
    const events = Array.isArray(disc.events) ? (disc.events as Array<Record<string, unknown>>) : []
    for (const ev of events) {
      const convType = ev.conversationType === 'private' ? 'private' : 'group'
      const targetId = String(ev.targetId ?? (targetKey.startsWith('group:') ? targetKey.slice(6) : targetKey.replace(/^private:user:/, '')))
      registerTarget(targetKey, typeof ev.selfId === 'string' ? ev.selfId : undefined, convType, targetId, undefined)
    }
    if (!targetConfigs.has(targetKey)) {
      const isGroup = targetKey.startsWith('group:')
      const targetId = isGroup ? targetKey.slice(6) : targetKey.replace(/^private:user:/, '')
      if (identitySelfId && /^[1-9]\d{0,19}$/.test(targetId)) {
        registerTarget(targetKey, identitySelfId, isGroup ? 'group' : 'private', targetId, undefined)
      }
    }
  }

  for (const { data } of parsedTopicFiles) {
    const groupId = typeof data.groupId === 'string' ? data.groupId : ''
    const targetKey = `group:${groupId}`
    if (!targetConfigs.has(targetKey) && identitySelfId && /^[1-9]\d{0,19}$/.test(groupId)) {
      registerTarget(targetKey, identitySelfId, 'group', groupId, undefined)
    }
  }

  if (conflicts.length > 0) {
    return {
      mode,
      stateFile,
      stateSchemaVersionBefore: schemaVersionBefore,
      stateSchemaVersionAfter: schemaVersionBefore,
      alreadyMigrated: false,
      scopesCreatedOrReused: 0,
      memberRecordsImported: 0,
      botDeliveriesImported: 0,
      jobsLinked: 0,
      discussionsReset: 0,
      groupMemoryFilesScanned: topicFiles.length,
      groupMemoryFilesMigrated: 0,
      groupMemoryFactsChecked: 0,
      conflicts,
    }
  }

  let scopesCreatedOrReused = 0
  let memberRecordsImported = 0
  let botDeliveriesImported = 0
  let jobsLinked = 0
  let discussionsReset = 0
  let groupMemoryFilesMigrated = 0
  let groupMemoryFactsChecked = 0

  const nextScopes: Record<string, SourceScope> = {
    ...(typeof rawState.sourceScopes === 'object' && rawState.sourceScopes !== null
      ? (rawState.sourceScopes as Record<string, SourceScope>)
      : {}),
  }
  const nextSourceReceipts: Record<string, unknown> = {
    ...(typeof rawState.sourceReceipts === 'object' && rawState.sourceReceipts !== null
      ? (rawState.sourceReceipts as Record<string, unknown>)
      : {}),
  }

  const migratedTopicContents = new Map<string, string>()
  let publication: MigrationPublication | undefined

  const runMigrationTx = options.db.transaction(() => {
    options.db
      .prepare('INSERT INTO source_owner_access(owner_id,enabled) VALUES (?,1) ON CONFLICT(owner_id) DO UPDATE SET enabled=1')
      .run(ownerId)

    const scopeByTarget = new Map<string, SourceScope>()

    for (const [targetKey, cfg] of targetConfigs.entries()) {
      const key = SourceConversationKeySchema.parse({
        ownerId,
        channel,
        selfId: cfg.selfId,
        conversationType: cfg.conversationType,
        targetId: cfg.targetId,
      })
      const conversationId = `source-${sourceFingerprint(key)}`
      options.db
        .prepare(
          `INSERT OR IGNORE INTO source_conversations(conversation_id,owner_id,channel,self_id,conversation_type,target_id)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(conversationId, key.ownerId, key.channel, key.selfId, key.conversationType, key.targetId)

      const head = options.db
        .prepare('SELECT scope_id,generation,permission_revision,state FROM source_scope_heads WHERE conversation_id=?')
        .get(conversationId) as
        | { scope_id: string; generation: number; permission_revision: number; state: string }
        | undefined

      let scope: SourceScope | undefined
      if (head) {
        const row = options.db
          .prepare('SELECT data_json FROM source_scopes WHERE scope_id=?')
          .get(head.scope_id) as { data_json: string } | undefined
        if (row) {
          const parsed = SourceScopeSchema.parse(JSON.parse(row.data_json))
          if (parsed.state === 'active' && parsed.presetId === cfg.presetId && parsed.qqContextEpoch === cfg.qqContextEpoch) scope = parsed
          else conflicts.push({ kind: 'unresolvable_scope', target: targetKey, detail: 'Existing scope does not match the trusted migration scope' })
        }
      }
      if (!scope) {
        const generation = (head?.generation ?? 0) + 1
        const permissionRevision = (head?.permission_revision ?? 0) + 1
        const createdAt = now()
        scope = SourceScopeSchema.parse({
          scopeId: deterministicId('scope', [conversationId, generation, cfg.presetId, cfg.qqContextEpoch]),
          conversationId,
          presetId: cfg.presetId,
          qqContextEpoch: cfg.qqContextEpoch,
          generation,
          permissionRevision,
          selectionRevision: 0,
          state: 'active',
          createdAt,
        })
        options.db
          .prepare('INSERT INTO source_scopes(scope_id,conversation_id,generation,state,data_json) VALUES (?,?,?,?,?)')
          .run(scope.scopeId, conversationId, scope.generation, scope.state, JSON.stringify(scope))
        options.db
          .prepare(
            `INSERT INTO source_scope_heads(conversation_id,scope_id,generation,permission_revision,applied_config_revision,state)
             VALUES (?,?,?,?,0,'active') ON CONFLICT(conversation_id) DO UPDATE SET
             scope_id=excluded.scope_id,generation=excluded.generation,permission_revision=excluded.permission_revision,state='active'`,
          )
          .run(conversationId, scope.scopeId, scope.generation, scope.permissionRevision)
        const completenessId = deterministicId('completeness', [scope.scopeId, 'history_start'])
        options.db
          .prepare(
            `INSERT OR IGNORE INTO source_completeness(completeness_id,scope_id,kind,observed_at,data_json)
             VALUES (?,?,'history_start',?,?)`,
          )
          .run(completenessId, scope.scopeId, createdAt, JSON.stringify({ observedAt: createdAt }))
      }
      scopeByTarget.set(targetKey, scope)
      nextScopes[targetKey] = scope
      scopesCreatedOrReused++
    }

    // Collect all legacy member messages and legacy assistant background messages
    type CandidateEvent = {
      targetKey: string
      raw: Record<string, unknown>
      handling: z.infer<typeof SourceHandlingSchema>
      orderTime: number
    }
    const candidates: CandidateEvent[] = []
    const jobHandlingByEventId = new Map<string, z.infer<typeof SourceHandlingSchema>>()

    for (const job of rawJobs) {
      const requestId = String(job.requestId ?? '')
      const inputs = Array.isArray(job.mergedInputs) && job.mergedInputs.length > 0
        ? (job.mergedInputs as Array<Record<string, unknown>>)
        : [job.input as Record<string, unknown>].filter(Boolean)
      inputs.forEach((inp, idx) => {
        const eventId = String(inp.eventId ?? '')
        if (!eventId) return
        const state = String(job.state ?? 'completed')
        const handling: z.infer<typeof SourceHandlingSchema> =
          state === 'failed' || state === 'cancelled'
            ? { kind: 'rejected', reasonCode: String(job.reason ?? 'NOT_EXECUTED') }
            : { kind: idx === 0 ? 'queued' : 'merged', requestId }
        jobHandlingByEventId.set(eventId, handling)
        const convType = inp.conversationType === 'private' ? 'private' : 'group'
        const targetId = String(inp.targetId ?? '')
        const targetKey = typeof job.target === 'string' ? job.target : convType === 'group' ? `group:${targetId}` : `private:user:${targetId}`
        candidates.push({
          targetKey,
          raw: inp,
          handling,
          orderTime: typeof inp.occurredAt === 'number' ? inp.occurredAt : typeof job.acceptedAt === 'number' ? job.acceptedAt : 0,
        })
      })
      const questions = job.questions as { runId?: string; batchId?: string; replies?: Record<string, unknown>[];
        items?: { questionId: string; eventId: string }[] } | undefined
      for (const reply of questions?.replies ?? []) {
        const eventId = String(reply.eventId ?? '')
        if (!eventId || jobHandlingByEventId.has(eventId)) continue
        const question = questions?.items?.find(item => rawOutbox.some(output => {
          const frame = output.frame as { data?: { eventId?: string } } | undefined
          return frame?.data?.eventId === item.eventId && output.status === 'sent' && Array.isArray(output.messageIds) && output.messageIds.includes(reply.replyToMessageId)
        }))
        const handling: z.infer<typeof SourceHandlingSchema> = question && questions?.runId && questions.batchId
          ? { kind: 'question_answer', requestId, runId: questions.runId, batchId: questions.batchId, questionId: question.questionId }
          : { kind: 'background' }
        jobHandlingByEventId.set(eventId, handling)
        candidates.push({ targetKey: String(job.target), raw: reply, handling,
          orderTime: typeof reply.occurredAt === 'number' ? reply.occurredAt : 0 })
      }
    }

    for (const [targetKey, disc] of Object.entries(rawDiscussions)) {
      const events = Array.isArray(disc.events) ? (disc.events as Array<Record<string, unknown>>) : []
      for (const ev of events) {
        const eventId = String(ev.eventId ?? '')
        if (!eventId || jobHandlingByEventId.has(eventId) || ev.senderId === ev.selfId ||
          ev.truncated === true || ev.contentTruncated === true ||
          !Array.isArray(ev.sourceParts) && !Array.isArray(ev.parts)) continue
        const handling = jobHandlingByEventId.get(eventId) ?? { kind: 'background' as const }
        candidates.push({
          targetKey,
          raw: ev,
          handling,
          orderTime: typeof ev.occurredAt === 'number' ? ev.occurredAt : 0,
        })
      }
    }

    candidates.sort((a, b) => a.orderTime - b.orderTime || String(a.raw.messageId ?? '').localeCompare(String(b.raw.messageId ?? '')))

    const recordRefByConvAndMsgId = new Map<string, { record: SourceRecord; ref: SourceRecordRef }>()

    for (const item of candidates) {
      const scope = scopeByTarget.get(item.targetKey)
      if (!scope) continue
      const ev = item.raw
      const selfId = String(ev.selfId ?? '')
      const senderId = String(ev.senderId ?? '')
      const senderName = typeof ev.senderName === 'string' && ev.senderName.trim() ? ev.senderName : senderId
      const messageId = String(ev.messageId ?? '')
      const eventId = String(ev.eventId ?? '')
      const occurredAt = typeof ev.occurredAt === 'number' ? ev.occurredAt : now()

      if (!/^-?\d{1,100}$/.test(messageId)) continue

      if (senderId === selfId) continue

      const { parts, attachments } = legacyPartsToSourceParts(scope.conversationId, messageId, ev)
      const fingerprint = sourceFingerprint({
        senderId,
        messageId,
        parts,
        attachments: [...attachments].sort((a, b) => a.partId.localeCompare(b.partId)),
      })

      const existingRow = options.db
        .prepare('SELECT record_id,fingerprint,data_json FROM source_records WHERE conversation_id=? AND source_key=?')
        .get(scope.conversationId, `member:${messageId}`) as
        | { record_id: string; fingerprint: string; data_json: string }
        | undefined

      if (existingRow) {
        if (existingRow.fingerprint !== fingerprint) {
          conflicts.push({
            kind: 'record_fingerprint_conflict',
            target: `${scope.conversationId}:member:${messageId}`,
            detail: `Existing source record for messageId ${messageId} has conflicting content or sender`,
          })
          continue
        }
        const record = SourceRecordSchema.parse(JSON.parse(existingRow.data_json))
        options.db
          .prepare('INSERT OR IGNORE INTO source_scope_members(scope_id,record_id) VALUES (?,?)')
          .run(scope.scopeId, record.recordId)
        recordRefByConvAndMsgId.set(`${scope.conversationId}:${messageId}`, {
          record,
          ref: { recordId: record.recordId, revision: record.revision },
        })
        continue
      }

      const aliasConflict = options.db
        .prepare('SELECT record_id FROM source_aliases WHERE conversation_id=? AND platform_message_id=?')
        .get(scope.conversationId, messageId) as { record_id: string } | undefined
      if (aliasConflict) {
        conflicts.push({
          kind: 'platform_alias_conflict',
          target: `${scope.conversationId}:${messageId}`,
          detail: `Platform messageId ${messageId} is already bound to another record ${aliasConflict.record_id}`,
        })
        continue
      }

      const nextOrd = (
        options.db
          .prepare('SELECT next_ordinal FROM source_conversations WHERE conversation_id=?')
          .get(scope.conversationId) as { next_ordinal: number }
      ).next_ordinal
      const record = SourceRecordSchema.parse({
        recordId: deterministicId('record', [scope.conversationId, 'member', messageId]),
        conversationId: scope.conversationId,
        revision: 1,
        ingestOrdinal: nextOrd,
        sourceKey: `member:${messageId}`,
        origin: 'member',
        sender: { id: senderId, name: senderName },
        platformMessageIds: [messageId],
        receivedAt: occurredAt,
        platformSentAt: occurredAt,
        parts,
      })

      options.db
        .prepare('UPDATE source_conversations SET next_ordinal=next_ordinal+1 WHERE conversation_id=?')
        .run(scope.conversationId)
      options.db
        .prepare(
          `INSERT INTO source_records(record_id,conversation_id,source_key,revision,ingest_ordinal,fingerprint,data_json)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          record.recordId,
          scope.conversationId,
          record.sourceKey,
          record.revision,
          record.ingestOrdinal,
          fingerprint,
          JSON.stringify(record),
        )
      options.db
        .prepare('INSERT INTO source_aliases(conversation_id,platform_message_id,record_id) VALUES (?,?,?)')
        .run(scope.conversationId, messageId, record.recordId)
      options.db
        .prepare('INSERT OR IGNORE INTO source_scope_members(scope_id,record_id) VALUES (?,?)')
        .run(scope.scopeId, record.recordId)

      for (const att of attachments) {
        const part = parts.find((p) => p.type === 'attachment' && p.partId === att.partId)
        if (!part || part.type !== 'attachment') continue
        const version = SourceAttachmentVersionSchema.parse({
          attachmentId: part.attachmentId,
          version: 1,
          source: { recordId: record.recordId, revision: record.revision, partId: att.partId },
          sourceId: `source-${sourceFingerprint([record.recordId, att.partId])}`,
          ...(att.originalName ? { originalName: att.originalName } : {}),
          ...(att.declaredMimeType ? { declaredMimeType: att.declaredMimeType } : {}),
          mediaKind: att.mediaKind,
          state: { kind: 'unavailable', reasonCode: 'LEGACY_UNRECORDED_ATTACHMENT' },
        })
        options.db
          .prepare('INSERT INTO source_attachment_versions(attachment_id,version,record_id,data_json) VALUES (?,?,?,?)')
          .run(version.attachmentId, version.version, record.recordId, JSON.stringify(version))
      }

      const receiptId = deterministicId('receipt', [scope.conversationId, eventId || messageId])
      const receiptResult: SourceReceiptResult = {
        receiptId,
        version: 2,
        eventId: eventId || `qq:${selfId}:${scope.conversationId}:${messageId}`,
        record: { recordId: record.recordId, revision: record.revision },
        storage: 'stored',
        handling: item.handling,
      }
      if (item.handling.kind === 'queued' || item.handling.kind === 'merged') {
        options.db
          .prepare('INSERT OR IGNORE INTO source_management_requests VALUES (?,?,?)')
          .run(item.handling.requestId, scope.scopeId, occurredAt)
      }
      options.db
        .prepare(
          `INSERT OR IGNORE INTO source_receipts(receipt_id,conversation_id,scope_id,event_id,record_id,fingerprint,state,version,result_json)
           VALUES (?,?,?,?,?,?,'completed',2,?)`,
        )
        .run(
          receiptId,
          scope.conversationId,
          scope.scopeId,
          receiptResult.eventId,
          record.recordId,
          fingerprint,
          JSON.stringify(receiptResult),
        )
      options.db
        .prepare('INSERT OR IGNORE INTO source_receipt_events(conversation_id,event_id,receipt_id) VALUES (?,?,?)')
        .run(scope.conversationId, receiptResult.eventId, receiptId)

      if (eventId) {
        nextSourceReceipts[eventId] = {
          receiptId,
          scopeId: scope.scopeId,
          version: 2,
          record: { recordId: record.recordId, revision: record.revision },
          subject: {
            selfId,
            userId: senderId,
            conversationType: ev.conversationType === 'private' ? 'private' : 'group',
            ...(ev.conversationType === 'group' ? { groupId: String(ev.targetId ?? '') } : {}),
          },
          handling: item.handling,
          result: receiptResult,
          pendingReceipt: false,
        }
      }

      recordRefByConvAndMsgId.set(`${scope.conversationId}:${messageId}`, {
        record,
        ref: { recordId: record.recordId, revision: record.revision },
      })
      memberRecordsImported++
    }

    // Import confirmed outbox deliveries
    const repo = new SourceContextRepository(options.db, now)
    for (const out of rawOutbox) {
      const frameParsed = QQNotificationSchema.safeParse(out.frame)
      if (!frameParsed.success) continue
      const frame = frameParsed.data
      const targetKey =
        frame.data.conversationType === 'group'
          ? `group:${frame.data.targetId}`
          : `private:user:${frame.data.targetId}`
      const scope = scopeByTarget.get(targetKey)
      if (!scope) continue
      const status = out.status
      const messageIds = Array.isArray(out.messageIds) ? (out.messageIds as string[]) : []
      const isTerminal =
        (['qq.reply.action', 'qq.reply.file'].includes(frame.type) && frame.data.completeReply === true) ||
        ['qq.request.failed', 'qq.reply.video', 'qq.reply.images'].includes(frame.type) ||
        (frame.type === 'qq.reply.part' && frame.data.partIndex === frame.data.totalParts)
      const isActivity = frame.type !== 'qq.message.ack'
      const confirmedTime =
        typeof out.confirmedAt === 'number'
          ? out.confirmedAt
          : typeof out.updatedAt === 'number'
            ? out.updatedAt
            : now()
      const receipt =
        out.result && QQDeliveryResultRequestSchema.safeParse(out.result).success
          ? QQDeliveryResultRequestSchema.safeParse(out.result)
          : status === 'sent' || status === 'failed' || status === 'unknown'
            ? QQDeliveryResultRequestSchema.safeParse({
                eventId: frame.data.eventId,
                requestId: frame.data.requestId,
                selfId: frame.data.selfId,
                conversationType: frame.data.conversationType,
                targetId: frame.data.targetId,
                seq: frame.data.seq,
                status,
                messageIds: status === 'sent' ? messageIds : [],
                ...(status === 'sent' ? { sentAt: confirmedTime } : {}),
                activity: isActivity,
                terminal: isTerminal,
                ...(typeof out.reason === 'string' ? { reason: out.reason } : {}),
              })
            : undefined
      try {
        repo.recordDelivery(
          {
            ownerId,
            channel,
            selfId: frame.data.selfId,
            conversationType: frame.data.conversationType,
            targetId: frame.data.targetId,
            validate: () => {},
          },
          scope.scopeId,
          frame,
          receipt?.success ? receipt.data : undefined,
          confirmedTime,
        )
        if (status === 'sent' && messageIds.length > 0) {
          for (const mid of messageIds) {
            const alias = options.db
              .prepare('SELECT record_id FROM source_aliases WHERE conversation_id=? AND platform_message_id=?')
              .get(scope.conversationId, mid) as { record_id: string } | undefined
            if (alias) {
              const row = options.db
                .prepare('SELECT data_json FROM source_records WHERE record_id=?')
                .get(alias.record_id) as { data_json: string }
              const rec = SourceRecordSchema.parse(JSON.parse(row.data_json))
              recordRefByConvAndMsgId.set(`${scope.conversationId}:${mid}`, {
                record: rec,
                ref: { recordId: rec.recordId, revision: rec.revision },
              })
            }
          }
          botDeliveriesImported++
        }
      } catch (error) {
        conflicts.push({
          kind: 'platform_alias_conflict',
          target: `${scope.conversationId}:${frame.data.eventId}`,
          detail: `Outbox delivery ${frame.data.eventId} conflict: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    // Link existing jobs & normalize legacy inputs
    for (const job of rawJobs) {
      const input = (job.input ?? {}) as Record<string, unknown>
      const convType = input.conversationType === 'private' ? 'private' : 'group'
      const targetId = String(input.targetId ?? '')
      const targetKey =
        typeof job.target === 'string'
          ? job.target
          : convType === 'group'
            ? `group:${targetId}`
            : `private:user:${targetId}`
      const scope = scopeByTarget.get(targetKey)
      if (!scope) continue
      job.input = normalizeLegacyInput(input, scope.conversationId)
      if (Array.isArray(job.mergedInputs)) {
        job.mergedInputs = (job.mergedInputs as Array<Record<string, unknown>>).map((inp) =>
          normalizeLegacyInput(inp, scope.conversationId),
        )
      }
      if (!Array.isArray(job.toolIds)) job.toolIds = []
      if (typeof job.waits !== 'number') job.waits = 0
      if (Array.isArray(job.background)) {
        job.background = (job.background as Array<Record<string, unknown>>).map((bg) =>
          normalizeLegacyInput(bg, scope.conversationId),
        )
      }
      const questions = job.questions as { replies?: Record<string, unknown>[]; items?: { questionId: string; eventId: string; answerRecord?: SourceRecordRef }[] } | undefined
      if (questions?.replies) {
        questions.replies = questions.replies.map(reply => normalizeLegacyInput(reply, scope.conversationId))
        for (const item of questions.items ?? []) {
          const reply = questions.replies.find(reply => rawOutbox.some(output => {
            const frame = output.frame as { data?: { eventId?: string } } | undefined
            return frame?.data?.eventId === item.eventId && output.status === 'sent' && Array.isArray(output.messageIds) && output.messageIds.includes(reply.replyToMessageId)
          }))
          const found = reply && recordRefByConvAndMsgId.get(`${scope.conversationId}:${String(reply.messageId ?? '')}`)
          if (found) item.answerRecord = found.ref
        }
      }
      if (!job.sourceScopeId) {
        job.sourceScopeId = scope.scopeId
        jobsLinked++
      }
      if (!Array.isArray(job.sourceRecords) || job.sourceRecords.length === 0) {
        const inputs = Array.isArray(job.mergedInputs) && job.mergedInputs.length > 0
          ? (job.mergedInputs as Array<Record<string, unknown>>)
          : [job.input as Record<string, unknown>]
        const refs: SourceRecordRef[] = []
        for (const inp of inputs) {
          const mid = String(inp.messageId ?? '')
          const found = recordRefByConvAndMsgId.get(`${scope.conversationId}:${mid}`)
          if (found) refs.push(found.ref)
        }
        if (refs.length > 0) job.sourceRecords = refs
      }
    }

    // Convert discussions to new format (remove legacy events array & reset legacy maintenance)
    for (const [targetKey, disc] of Object.entries(rawDiscussions)) {
      const scope = scopeByTarget.get(targetKey)
      if (!scope) {
        delete rawDiscussions[targetKey]
        continue
      }
      if ('events' in disc || !('sourceScopeId' in disc) || typeof disc.sourceScopeId !== 'string') {
        const lastActivity =
          typeof disc.lastActivity === 'number'
            ? disc.lastActivity
            : typeof disc.lastEventAt === 'number'
              ? disc.lastEventAt
              : now()
        const startedAt = typeof disc.startedAt === 'number' ? disc.startedAt : lastActivity
        const closedAt = typeof disc.closedAt === 'number' ? disc.closedAt : lastActivity
        rawDiscussions[targetKey] = {
          active: Boolean(disc.active),
          lastActivity,
          startedAt,
          closedAt,
          sourceScopeId: scope.scopeId,
          summaryPending: Boolean(disc.summaryPending),
          summaryRetryAt: typeof disc.summaryRetryAt === 'number' ? disc.summaryRetryAt : 0,
        }
        discussionsReset++
      }
    }

    // Check and convert group memory files (schemaVersion 2 -> 3)
    for (const { filePath, data } of parsedTopicFiles) {
      const groupId = String(data.groupId ?? '')
      const scope = scopeByTarget.get(`group:${groupId}`)
      if (!scope) {
        conflicts.push({
          kind: 'unresolvable_scope',
          target: filePath,
          detail: `No active group scope resolved for groupId ${groupId}`,
        })
        continue
      }
      const records = Array.isArray(data.records) ? (data.records as Array<Record<string, unknown>>) : []
      const convertedRecords: Array<Record<string, unknown>> = []
      for (const fact of records) {
        groupMemoryFactsChecked++
        const sources = Array.isArray(fact.sources) ? (fact.sources as Array<Record<string, unknown>>) : []
        const nextSources: Array<Record<string, unknown>> = []
        for (const src of sources) {
          const messageId = String(src.messageId ?? '')
          const userId = String(src.userId ?? '')
          const occurredAt = typeof src.occurredAt === 'number' ? src.occurredAt : 0
          // Look up in memory map or DB
          let found = recordRefByConvAndMsgId.get(`${scope.conversationId}:${messageId}`)
          if (!found) {
            const alias = options.db
              .prepare('SELECT record_id FROM source_aliases WHERE conversation_id=? AND platform_message_id=?')
              .get(scope.conversationId, messageId) as { record_id: string } | undefined
            if (alias) {
              const row = options.db
                .prepare('SELECT data_json FROM source_records WHERE record_id=?')
                .get(alias.record_id) as { data_json: string }
              const rec = SourceRecordSchema.parse(JSON.parse(row.data_json))
              found = { record: rec, ref: { recordId: rec.recordId, revision: rec.revision } }
            }
          }
          if (!found) {
            conflicts.push({
              kind: 'group_memory_source_missing',
              target: `${filePath}#${String(fact.id ?? '')}`,
              detail: `Group fact "${String(fact.id ?? '')}" references missing messageId ${messageId} in group ${groupId}`,
            })
            continue
          }
          if (found.record.sender.id !== userId) {
            conflicts.push({
              kind: 'group_memory_source_mismatch',
              target: `${filePath}#${String(fact.id ?? '')}`,
              detail: `Group fact "${String(fact.id ?? '')}" messageId ${messageId} sender (${found.record.sender.id}) does not match fact source userId (${userId})`,
            })
            continue
          }
          const textPartIds = found.record.parts.filter((p) => p.type === 'text').map((p) => p.partId)
          const partIds =
            Array.isArray(src.partIds) && src.partIds.length > 0
              ? (src.partIds as string[])
              : textPartIds.length > 0
                ? textPartIds
                : [found.record.parts[0]?.partId ?? 'p0']
          nextSources.push({
            source: found.ref,
            partIds,
            messageId,
            userId,
            occurredAt,
          })
        }
        convertedRecords.push({
          ...fact,
          sources: nextSources,
        })
      }
      if (data.schemaVersion === 2 || convertedRecords.length > 0) {
        const nextStore = {
          ...data,
          schemaVersion: 3,
          records: convertedRecords,
        }
        migratedTopicContents.set(filePath, JSON.stringify(nextStore))
        if (data.schemaVersion === 2) groupMemoryFilesMigrated++
      }
    }

    if (mode === 'dry-run' || conflicts.length > 0) {
      throw Object.assign(new Error('ROLLBACK_MIGRATION_PREVIEW'), { rollbackPreview: true })
    }

    const files: MigrationFile[] = [...migratedTopicContents].map(([filePath, content]) => ({ filePath, content, beforeHash: beforeHashes.get(filePath)! }))
    const nextState = { ...rawState, schemaVersion: 2, jobs: rawJobs, discussions: rawDiscussions,
      sourceScopes: nextScopes, sourceReceipts: nextSourceReceipts }
    // Publish the runtime version last, after all group memory files.
    files.push({ filePath: stateFile, beforeHash: beforeHashes.get(stateFile)!, content: JSON.stringify(nextState) })
    const backupManifestPath = backupMigration(options, operationId, files, originalDatabase!)
    publication = { files, report: { mode, stateFile, stateSchemaVersionBefore: schemaVersionBefore, stateSchemaVersionAfter: 2,
      alreadyMigrated: false, scopesCreatedOrReused, memberRecordsImported, botDeliveriesImported, jobsLinked, discussionsReset,
      groupMemoryFilesScanned: topicFiles.length, groupMemoryFilesMigrated, groupMemoryFactsChecked, conflicts,
      backupManifestPath, operationId, publicationState: 'pending' } }
    options.db.prepare("INSERT INTO source_legacy_migrations(operation_id,data_dir,state,data_json) VALUES (?,?,'pending',?)")
      .run(operationId, path.resolve(options.dataDir), JSON.stringify(publication))
  })

  try {
    runMigrationTx()
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'rollbackPreview' in error)) {
      throw error
    }
  }

  if (mode === 'dry-run' || conflicts.length > 0) {
    return {
      mode,
      stateFile,
      stateSchemaVersionBefore: schemaVersionBefore,
      stateSchemaVersionAfter: conflicts.length === 0 ? 2 : schemaVersionBefore,
      alreadyMigrated:
        schemaVersionBefore === 2 &&
        parsedTopicFiles.every((t) => t.data.schemaVersion === 3) &&
        conflicts.length === 0,
      scopesCreatedOrReused,
      memberRecordsImported,
      botDeliveriesImported,
      jobsLinked,
      discussionsReset,
      groupMemoryFilesScanned: topicFiles.length,
      groupMemoryFilesMigrated,
      groupMemoryFactsChecked,
      conflicts,
    }
  }

  return publishMigration(options.db, operationId, publication!)
}
