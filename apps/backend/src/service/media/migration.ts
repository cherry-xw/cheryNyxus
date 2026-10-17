import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { AssetRecord, MessagePart } from '@chery/protocol'
import { getMonthlyDb, getSoulDb } from '@/db/index.js'
import config from '@/utils/config.js'
import { normalizeMessageParts, parseStoredParts } from '@/utils/messageParts.js'
import type { AssetStore } from './assetStore.js'
import { getAssetStore } from './store.js'
import { identifyFile } from './fileFormat.js'

const PREFIX = 'files-v1:'
const UNCLAIMED = 'migration:unclaimed'
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/
const FILENAME = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.[a-z0-9]+'
const legacyFilename = new RegExp(`^${FILENAME}$`, 'i')
const legacyReferences = () => new RegExp(`\\[\\[media:(${FILENAME})\\]\\]|!?\\[[^\\]\\n]*\\]\\((/api/media/(${FILENAME}))\\)|(?<![a-z0-9_:/])(/api/media/(${FILENAME}))(?=$|[\\s)\\]"'])`, 'gi')
type Row = Record<string, unknown>
type ReferenceKind = 'message' | 'pending' | 'operation' | 'branch'

export interface FileMigrationReport {
  version: 1
  records: Array<{ key: string; status: string; details: Row }>
}

function stableId(value: string) {
  const hash = createHash('sha256').update(PREFIX + value).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function object(value: unknown): Row {
  const parsed = json(value)
  if (parsed == null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('迁移数据必须为对象')
  return parsed as Row
}

function record(db: Database.Database, key: string, status: string, details: Row) {
  db.prepare(`INSERT INTO file_migration_records (record_key, status, details_json, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(record_key) DO UPDATE SET
    status = excluded.status, details_json = excluded.details_json, updated_at = excluded.updated_at`)
    .run(PREFIX + key, status, JSON.stringify(details), Date.now())
}

function columns(db: Database.Database, table: string) {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name))
}

function report(db: Database.Database): FileMigrationReport {
  return { version: 1, records: (db.prepare('SELECT * FROM file_migration_records WHERE record_key LIKE ? ORDER BY record_key')
    .all(`${PREFIX}%`) as { record_key: string; status: string; details_json: string }[])
    .map((row) => ({ key: row.record_key, status: row.status, details: object(row.details_json) })) }
}

/** SQLite 在线备份包括 WAL；不能直接复制正在使用的 .db 文件。调用期间必须停止业务写入。 */
async function backupDatabases(files: string[], directory: string) {
  const root = join(directory, 'file-migration-backups')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const manifest = join(root, 'files-v1.json')
  let manifestText: string | undefined
  try { manifestText = await readFile(manifest, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (manifestText !== undefined) {
    const previous = object(manifestText)
    const backedUp = previous.files as string[]
    if (previous.version !== 1 || !Array.isArray(backedUp)) throw new Error('文件迁移备份记录无效')
    for (const file of backedUp) {
      if (!files.includes(file)) continue
      const info = await lstat(join(root, String(previous.directory), file))
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('文件迁移备份不可用')
    }
    if (files.every((file) => backedUp.includes(file))) return
    // 新出现的历史分片必须先备份；已备份的主库和分片不覆盖。
    for (const file of files.filter((file) => !backedUp.includes(file))) {
      const source = new Database(join(directory, file), { readonly: true, fileMustExist: true })
      try { await source.backup(join(root, String(previous.directory), file)) } finally { source.close() }
      await chmod(join(root, String(previous.directory), file), 0o600)
    }
    await atomicJson(manifest, { ...previous, files: [...new Set([...backedUp, ...files])] })
    return
  }
  const name = randomUUID()
  const destination = join(root, name)
  await mkdir(destination, { mode: 0o700 })
  for (const file of files) {
    const source = new Database(join(directory, file), { readonly: true, fileMustExist: true })
    try { await source.backup(join(destination, file)) } finally { source.close() }
    await chmod(join(destination, file), 0o600)
  }
  await atomicJson(manifest, { version: 1, directory: name, files })
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
  } finally { await unlink(temporary).catch(() => undefined) }
}

class Migration {
  readonly db = getSoulDb()
  readonly store: AssetStore = getAssetStore()
  readonly base = resolve(process.env.CHERY_DIR || process.cwd(), '.chery')

  constructor(private readonly legacyOwnerId?: string) {}

  owner(chatId: string): string {
    const chat = this.db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as { metadata: string | null } | undefined
    if (!chat) return UNCLAIMED
    const owner = object(chat?.metadata).fileOwnerId
    return typeof owner === 'string' && owner.trim() && owner !== UNCLAIMED ? owner : this.legacyOwnerId ?? UNCLAIMED
  }

  async asset(filename: string, chatId?: string): Promise<AssetRecord> {
    const ownerId = chatId ? this.owner(chatId) : UNCLAIMED
    // 每个会话独立所有权，不能因同名文件或物理去重合并权限。
    const id = stableId(`asset:${chatId ?? 'orphan'}:${filename}`)
    const existing = this.db.prepare('SELECT owner_id FROM assets WHERE id = ?').get(id) as { owner_id: string } | undefined
    if (existing) {
      if (existing.owner_id === UNCLAIMED && ownerId !== UNCLAIMED) this.claimAsset(id, ownerId)
      return this.store.get(id, { ownerId: existing.owner_id === UNCLAIMED ? ownerId : existing.owner_id })
    }
    let bytes: Buffer | undefined
    const path = join(this.base, 'media', filename)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`旧文件不是普通文件：${filename}`)
      bytes = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const sha256 = createHash('sha256').update(bytes ?? `missing:${id}`).digest('hex')
    if (bytes) await this.publish(bytes, sha256)
    const versionId = stableId(`original:${id}`)
    const availability = !bytes ? 'missing' : ownerId === UNCLAIMED ? 'unclaimed' : 'available'
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO assets
        (id, owner_id, original_name, source, created_at, unreferenced_at, migration_unresolved, availability)
        VALUES (?, ?, ?, 'migration', ?, ?, ?, ?)`).run(id, ownerId, filename, Date.now(), Date.now(), ownerId === UNCLAIMED ? 1 : 0, availability)
      const format = bytes ? identifyFile(bytes, 'application/octet-stream') : { mimeType: 'application/octet-stream', kind: 'file' }
      this.db.prepare(`INSERT INTO asset_versions
        (id, asset_id, variant, sha256, mime_type, kind, size_bytes, created_at, transform_json, transform_key)
        VALUES (?, ?, 'original', ?, ?, ?, ?, ?, '{"variant":"original"}', 'original')`)
        .run(versionId, id, sha256, format.mimeType, format.kind, bytes?.length ?? 0, Date.now())
      record(this.db, `asset:${id}`, !chatId ? 'orphan' : availability === 'available' ? 'migrated' : availability,
        { assetId: id, versionId, filename, chatId: chatId ?? null, ownerId, availability, orphan: !chatId })
    }).immediate()
    return this.store.get(id, { ownerId })
  }

  private async publish(bytes: Buffer, sha256: string) {
    const root = join(this.base, 'assets')
    await mkdir(join(root, 'staging'), { recursive: true, mode: 0o700 })
    await mkdir(join(root, 'blobs'), { recursive: true, mode: 0o700 })
    const path = join(root, 'staging', randomUUID())
    try {
      const file = await open(path, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      const destination = join(root, 'blobs', sha256)
      try { await link(path, destination) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await readFile(destination)
        if (createHash('sha256').update(existing).digest('hex') !== sha256) throw new Error('文件仓库摘要不匹配')
      }
    } finally { await unlink(path).catch(() => undefined) }
  }

  claimAsset(id: string, ownerId: string) {
    this.db.prepare(`UPDATE assets SET owner_id = ?, migration_unresolved = 0,
      availability = CASE WHEN availability = 'unclaimed' THEN 'available' ELSE availability END
      WHERE id = ? AND owner_id = ? AND source = 'migration'`).run(ownerId, id, UNCLAIMED)
    const row = this.db.prepare('SELECT availability FROM assets WHERE id = ?').get(id) as { availability: string }
    const previous = this.db.prepare('SELECT details_json FROM file_migration_records WHERE record_key = ?')
      .get(`${PREFIX}asset:${id}`) as { details_json: string } | undefined
    if (previous) record(this.db, `asset:${id}`, row.availability === 'missing' ? 'missing' : 'claimed',
      { ...object(previous.details_json), ownerId, availability: row.availability })
  }

  async parts(content: string | undefined, stored: unknown, key: string, chatId: string) {
    const existing = stored == null ? undefined : typeof stored === 'string'
      ? parseStoredParts(stored) : normalizeMessageParts(undefined, stored as MessagePart[]).parts
    // 已有结构化消息是权威；不能用旧 content 覆盖。
    if (existing?.some((part) => part.type !== 'text')) return { parts: existing, changed: false, content }
    const text = existing ? existing.map((part) => part.type === 'text' ? part.text : '').join('') : content
    if (text === undefined || !legacyReferences().test(text)) return { parts: existing ?? [], changed: false, content }
    const parts: MessagePart[] = []
    let offset = 0
    for (const match of text.matchAll(legacyReferences())) {
      if (match.index! > offset) parts.push({ partId: stableId(`${key}:text:${offset}`), type: 'text', text: text.slice(offset, match.index) })
      const asset = await this.asset((match[1] ?? match[3] ?? match[5])!, chatId)
      parts.push({ partId: stableId(`${key}:asset:${match.index}`), type: 'asset', assetId: asset.id,
        assetVersionId: asset.versionId, originalName: asset.originalName, mimeType: asset.mimeType, kind: asset.kind, availability: asset.availability, variant: 'original', usage: 'content' })
      offset = match.index! + match[0].length
    }
    if (offset < text.length) parts.push({ partId: stableId(`${key}:text:${offset}`), type: 'text', text: text.slice(offset) })
    return { ...normalizeMessageParts(undefined, parts), changed: true }
  }

  references(chatId: string, kind: ReferenceKind, refId: string, value: unknown) {
    const references: Array<{ assetId: string; versionId: string }> = []
    const collect = (item: unknown) => {
      if (Array.isArray(item)) { item.forEach(collect); return }
      if (!item || typeof item !== 'object') return
      const row = item as Row
      if (typeof row.assetId === 'string' && typeof row.assetVersionId === 'string')
        references.push({ assetId: row.assetId, versionId: row.assetVersionId })
      if (Array.isArray(row.outputAssetIds)) for (const assetId of row.outputAssetIds) {
        if (typeof assetId !== 'string') throw new Error('文件操作输出资产标识无效')
        const version = this.db.prepare("SELECT id FROM asset_versions WHERE asset_id = ? AND variant = 'original'")
          .get(assetId) as { id: string } | undefined
        if (!version) throw new Error(`文件操作输出资产不存在：${assetId}`)
        references.push({ assetId, versionId: version.id })
      }
      for (const child of Object.values(row)) if (child && typeof child === 'object') collect(child)
    }
    collect(value)
    if (!references.length) return
    const chat = this.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)
    if (!chat) {
      record(this.db, `${kind}:${refId}:orphan`, 'orphan', { chatId, references })
      return
    }
    this.db.transaction(() => {
      for (const ref of references) {
        const row = this.db.prepare(`SELECT a.owner_id, a.source, v.variant FROM assets a
          JOIN asset_versions v ON v.asset_id = a.id WHERE a.id = ? AND v.id = ?`)
          .get(ref.assetId, ref.versionId) as { owner_id: string; source: string; variant: 'original' | 'adapted' } | undefined
        if (!row) throw new Error(`迁移引用的文件版本不存在：${ref.versionId}`)
        if (row.owner_id === UNCLAIMED && row.source === 'migration' && this.owner(chatId) !== UNCLAIMED) {
          this.claimAsset(ref.assetId, this.owner(chatId))
          row.owner_id = this.owner(chatId)
        }
        const granted = this.db.prepare('SELECT 1 FROM asset_chat_grants WHERE asset_id = ? AND chat_id = ?').get(ref.assetId, chatId)
        if (!granted && (row.source !== 'migration' || row.owner_id !== this.owner(chatId)))
          throw new Error('迁移不能为不属于当前会话的文件增加授权')
        // 未认领资产也登记引用以防清理，但 availability 阻止远程读取。
        const part: MessagePart = { partId: stableId(ref.versionId), type: 'asset', assetId: ref.assetId,
          assetVersionId: ref.versionId, variant: row.variant, usage: 'reference-only' }
        this.store.attachOwned([part], { ownerId: row.owner_id, chatId }, kind, refId)
      }
    }).immediate()
  }

  async messageRows(db: Database.Database, month: string) {
    // 每次重查已迁移行，以修复跨库提交中断后的引用；固定 ID 保证重复执行不增项。
    for (const row of db.prepare('SELECT id, chat_id, content, parts, file_operations FROM messages ORDER BY id').all() as Row[]) {
      const key = `message:${month}:${row.id}`
      const converted = await this.parts(row.content == null ? undefined : String(row.content), row.parts, key, String(row.chat_id))
      const operations = row.file_operations == null ? [] : json(row.file_operations)
      if (!Array.isArray(operations)) throw new Error('消息文件操作必须为数组')
      let changedOperations = false
      for (const operation of operations) {
        const data = object(operation)
        if (typeof data.operationId !== 'string') throw new Error('消息文件操作缺少稳定标识')
        const output = await this.parts(undefined, data.outputParts, `operation:${data.operationId}`, String(row.chat_id))
        if (output.changed) { data.outputParts = output.parts; changedOperations = true }
        this.references(String(row.chat_id), 'operation', data.operationId, data)
      }
      this.references(String(row.chat_id), 'message', String(row.id), [converted.parts, operations])
      if (converted.changed || changedOperations) db.transaction(() => {
        if (converted.changed) db.prepare('UPDATE messages SET parts = ?, content = ? WHERE id = ?')
          .run(JSON.stringify(converted.parts), converted.content, row.id)
        if (changedOperations) db.prepare('UPDATE messages SET file_operations = ? WHERE id = ?')
          .run(JSON.stringify(operations), row.id)
      })()
      record(this.db, key, 'committed', { chatId: row.chat_id, migrated: converted.changed || converted.parts.some((part) => part.type === 'asset') })
    }
    record(this.db, `shard:${month}`, 'committed', { month })
  }

  async pending() {
    if (!columns(this.db, 'pending_inputs').has('parts')) return
    for (const row of this.db.prepare('SELECT * FROM pending_inputs ORDER BY input_id').all() as Row[]) {
      const key = `pending:${row.input_id}`
      const converted = await this.parts(String(row.content ?? ''), row.parts, key, String(row.chat_id))
      this.db.transaction(() => {
        this.references(String(row.chat_id), 'pending', String(row.input_id), converted.parts)
        if (converted.changed) this.db.prepare('UPDATE pending_inputs SET parts = ?, content = ? WHERE input_id = ?')
          .run(JSON.stringify(converted.parts), converted.content, row.input_id)
        record(this.db, key, 'committed', { chatId: row.chat_id })
      })()
    }
  }

  async operations() {
    const fields = columns(this.db, 'file_operations')
    if (!fields.size) return
    const payload = ['record_json', 'data_json', 'operation_json'].find((name) => fields.has(name))
    const id = fields.has('operation_id') ? 'operation_id' : fields.has('id') ? 'id' : undefined
    if (!payload || !id || !fields.has('chat_id')) throw new Error('独立文件操作表结构无法迁移，请核对保存入口')
    for (const row of this.db.prepare(`SELECT ${id} AS id, chat_id, ${payload} AS payload FROM file_operations`).all() as Row[]) {
      const data = object(row.payload)
      const converted = await this.parts(undefined, data.outputParts, `operation:${row.id}`, String(row.chat_id))
      if (converted.changed) data.outputParts = converted.parts
      this.db.transaction(() => {
        this.references(String(row.chat_id), 'operation', String(row.id), data)
        if (converted.changed) this.db.prepare(`UPDATE file_operations SET ${payload} = ? WHERE ${id} = ?`).run(JSON.stringify(data), row.id)
        record(this.db, `operation:${row.id}`, 'committed', { chatId: row.chat_id })
      })()
    }
  }

  async branches() {
    if (!columns(this.db, 'conversation_branches').has('context_snapshot_json')) return
    for (const row of this.db.prepare('SELECT branch_id, chat_id, context_snapshot_json FROM conversation_branches').all() as Row[]) {
      if (row.context_snapshot_json == null) continue
      const chatId = String(row.chat_id)
      const walk = async (value: unknown, path: string): Promise<unknown> => {
        if (Array.isArray(value)) {
          const result: unknown[] = []
          for (const [index, item] of value.entries()) result.push(await walk(item, `${path}:${index}`))
          return result
        }
        if (!value || typeof value !== 'object') return value
        const node = value as Row
        const copy: Row = { ...node }
        if (typeof node.content === 'string' || Array.isArray(node.parts)) {
          const converted = await this.parts(typeof node.content === 'string' ? node.content : undefined, node.parts, path, chatId)
          if (converted.changed) { copy.content = converted.content; copy.parts = converted.parts }
        }
        for (const [key, item] of Object.entries(copy)) {
          if (key !== 'parts' && item && typeof item === 'object') copy[key] = await walk(item, `${path}:${key}`)
        }
        return copy
      }
      const snapshot = await walk(json(row.context_snapshot_json), `branch:${row.branch_id}`)
      this.db.transaction(() => {
        this.references(chatId, 'branch', String(row.branch_id), snapshot)
        this.db.prepare('UPDATE conversation_branches SET context_snapshot_json = ? WHERE branch_id = ?')
          .run(JSON.stringify(snapshot), row.branch_id)
        record(this.db, `branch:${row.branch_id}`, 'committed', { chatId })
      })()
    }
  }

  async orphans() {
    let names: string[]
    try { names = await readdir(join(this.base, 'media')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const records = this.db.prepare('SELECT details_json FROM file_migration_records WHERE record_key LIKE ?').all(`${PREFIX}asset:%`) as { details_json: string }[]
    const linked = new Set(records.map((row) => object(row.details_json)).filter((row) => row.chatId).map((row) => row.filename))
    for (const name of names) {
      if (!legacyFilename.test(name) || linked.has(name)) continue
      await this.asset(name)
    }
  }
}

let running: Promise<FileMigrationReport> | undefined

/** 启动时在接受消息/清理文件之前 await；错误必须阻止业务写入，不能吞掉后继续启动。 */
export function migrateFileStorage(options: { legacyOwnerId?: string } = {}): Promise<FileMigrationReport> {
  if (options.legacyOwnerId !== undefined && (!options.legacyOwnerId.trim() || options.legacyOwnerId === UNCLAIMED))
    return Promise.reject(new Error('历史文件认领身份无效'))
  if (running) return Promise.reject(new Error('文件迁移正在执行'))
  running = (async () => {
    const migration = new Migration(options.legacyOwnerId)
    const previous = migration.db.prepare('SELECT status FROM file_migration_records WHERE record_key = ?').get(`${PREFIX}run`) as { status: string } | undefined
    if (previous?.status === 'committed' && options.legacyOwnerId === undefined) return report(migration.db)
    const directory = resolve(config.global.db_dir)
    const names = await readdir(directory)
    const months = new Set(names.filter((name) => name.endsWith('.db') && MONTH.test(name.slice(0, -3))).map((name) => name.slice(0, -3)))
    for (const row of migration.db.prepare('SELECT messages_month FROM chats').all() as { messages_month: string }[]) {
      if (!MONTH.test(row.messages_month)) throw new Error('会话消息分片月份无效')
      if (names.includes(`${row.messages_month}.db`)) months.add(row.messages_month)
      else throw new Error(`会话消息分片缺失：${row.messages_month}`)
    }
    await backupDatabases(['soul.db', ...[...months].sort().map((month) => `${month}.db`)], directory)
    record(migration.db, 'run', 'running', { months: [...months].sort() })
    try {
      for (const month of [...months].sort()) await migration.messageRows(getMonthlyDb(month), month)
      await migration.pending()
      await migration.operations()
      await migration.branches()
      await migration.orphans()
      record(migration.db, 'run', 'committed', { months: [...months].sort() })
    } catch (error) {
      record(migration.db, 'run', 'failed', { message: error instanceof Error ? error.message : String(error) })
      throw error
    }
    return report(migration.db)
  })().finally(() => { running = undefined })
  return running
}

/** 只供已完成管理员确认的入口调用；调用者负责身份与会话管理权限检查。 */
export async function claimLegacyChatFiles(chatId: string, ownerId: string): Promise<{ claimed: number }> {
  if (!ownerId.trim() || ownerId === UNCLAIMED) throw new Error('历史文件认领身份无效')
  if (running) throw new Error('请等待文件迁移完成后认领')
  const migration = new Migration()
  const chat = migration.db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as { metadata: string | null } | undefined
  if (!chat) throw new Error('会话不存在')
  const metadata = object(chat.metadata)
  if (metadata.fileOwnerId && metadata.fileOwnerId !== UNCLAIMED && metadata.fileOwnerId !== ownerId) throw new Error('不能覆盖已确认的会话所有者')
  // 认领也是首次写入入口时，先完成整个迁移与一致备份。
  await migrateFileStorage()
  return migration.db.transaction(() => {
    const current = migration.db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as { metadata: string | null } | undefined
    if (!current) throw new Error('会话不存在')
    const latestMetadata = object(current.metadata)
    if (latestMetadata.fileOwnerId && latestMetadata.fileOwnerId !== UNCLAIMED && latestMetadata.fileOwnerId !== ownerId)
      throw new Error('不能覆盖已确认的会话所有者')
    const assets = migration.db.prepare(`SELECT DISTINCT a.id FROM assets a
      JOIN asset_chat_grants g ON g.asset_id = a.id
      WHERE g.chat_id = ? AND a.source = 'migration' AND a.owner_id = ?`).all(chatId, UNCLAIMED) as { id: string }[]
    for (const asset of assets) migration.claimAsset(asset.id, ownerId)
    migration.db.prepare('UPDATE chats SET metadata = ? WHERE id = ?').run(JSON.stringify({ ...latestMetadata, fileOwnerId: ownerId }), chatId)
    record(migration.db, `claim:${chatId}`, 'committed', { chatId, ownerId, claimed: assets.length })
    return { claimed: assets.length }
  }).immediate()
}
