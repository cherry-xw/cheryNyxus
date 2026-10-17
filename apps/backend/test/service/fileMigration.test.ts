import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initAssetTables } from '@/db/assets.js'
import { AssetStore } from '@/service/media/assetStore.js'
import { normalizeMessageParts } from '@/utils/messageParts.js'
import type { MessagePart } from '@chery/protocol'

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database,
  months: new Map<string, Database.Database>(), directory: '', root: '',
}))
vi.mock('@/utils/config.js', () => ({ default: { global: { get db_dir() { return state.directory } } } }))
vi.mock('@/db/index.js', () => ({
  getSoulDb: () => state.db,
  getMonthlyDb: (month: string) => {
    const db = state.months.get(month)
    if (!db) throw new Error(`unexpected shard: ${month}`)
    return db
  },
}))
vi.mock('@/service/media/store.js', () => ({
  getAssetStore: () => new AssetStore(state.db, join(state.root, '.chery', 'assets')),
}))
import { claimLegacyChatFiles, migrateFileStorage } from '@/service/media/migration.js'

const FILE = '12345678-1234-4234-a234-123456789abc.txt'
const MISSING = '87654321-1234-4234-a234-123456789abc.txt'
const ORPHAN = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa.txt'
const marker = (filename = FILE) => `[[media:${filename}]]`
let previousDirectory: string | undefined

function shard(month: string) {
  const db = new Database(join(state.directory, `${month}.db`))
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT, content TEXT, parts TEXT, file_operations TEXT)')
  state.months.set(month, db)
  return db
}

function chat(id: string, owner?: string) {
  state.db.prepare('INSERT INTO chats VALUES (?, ?, ?)').run(id, '2026-10', JSON.stringify(owner ? { fileOwnerId: owner, keep: true } : { keep: true }))
}

function message(db: Database.Database, id: string, chatId: string, content: string, parts?: MessagePart[]) {
  db.prepare('INSERT INTO messages (id, chat_id, content, parts) VALUES (?, ?, ?, ?)').run(id, chatId, content, parts ? JSON.stringify(parts) : null)
}

function saved(db: Database.Database, id: string) {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as { content: string; parts: string }
  return { ...row, parts: JSON.parse(row.parts) as MessagePart[] }
}

function assetParts(parts: MessagePart[]) { return parts.filter((part) => part.type === 'asset') }
function count(table: string) { return (state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n }

beforeEach(async () => {
  state.root = await mkdtemp('/tmp/opencode/file-migration-')
  previousDirectory = process.env.CHERY_DIR
  process.env.CHERY_DIR = state.root
  state.directory = join(state.root, '.chery', 'db')
  await mkdir(state.directory, { recursive: true })
  await mkdir(join(state.root, '.chery', 'media'))
  state.db = new Database(join(state.directory, 'soul.db'))
  state.db.pragma('foreign_keys = ON')
  state.db.pragma('journal_mode = WAL')
  state.db.exec(`CREATE TABLE chats (id TEXT PRIMARY KEY, messages_month TEXT, metadata TEXT);
    CREATE TABLE pending_inputs (input_id TEXT PRIMARY KEY, chat_id TEXT, content TEXT, parts TEXT);
    CREATE TABLE conversation_branches (branch_id TEXT PRIMARY KEY, chat_id TEXT, context_snapshot_json TEXT);
    CREATE TABLE file_operations (operation_id TEXT PRIMARY KEY, chat_id TEXT, record_json TEXT);`)
  initAssetTables(state.db)
  shard('2026-10')
  await writeFile(join(state.root, '.chery', 'media', FILE), 'plain text historical file')
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of state.months.values()) db.close()
  state.months.clear()
  state.db.close()
  if (previousDirectory === undefined) delete process.env.CHERY_DIR
  else process.env.CHERY_DIR = previousDirectory
  await rm(state.root, { recursive: true, force: true })
})

describe('历史文件、消息和引用迁移', () => {
  it('备份失败时不写文件、消息或迁移进度', async () => {
    chat('chat', 'alice')
    const db = state.months.get('2026-10')!
    message(db, 'one', 'chat', marker())
    vi.spyOn(Database.prototype, 'backup').mockRejectedValueOnce(new Error('backup failed'))
    await expect(migrateFileStorage()).rejects.toThrow('backup failed')
    expect(count('assets')).toBe(0)
    expect(count('file_migration_records')).toBe(0)
    expect((db.prepare('SELECT content FROM messages').get() as { content: string }).content).toBe(marker())
  })

  it('备份包含迁移前数据；有序转换纯文字标记，扫描未被 chats 指向的真实分片', async () => {
    chat('chat', 'alice')
    const db = state.months.get('2026-10')!
    const content = `前文${marker()}后文 [[media:example.png]] https://example.test/output.png`
    message(db, 'one', 'chat', content, [{ partId: 'legacy-text', type: 'text', text: content }])
    const historic = shard('2001-02')
    message(historic, 'old', 'chat', marker())
    await writeFile(join(state.directory, '2026-13.db'), 'not a sqlite database')
    const structured: MessagePart[] = [{ partId: 'keep', type: 'directive', command: '/check' }]
    message(db, 'structured', 'chat', marker(), structured)
    const report = await migrateFileStorage()
    const row = saved(db, 'one')
    expect(row.parts.map((part) => part.type)).toEqual(['text', 'asset', 'text'])
    expect(row.content).toBe(normalizeMessageParts(undefined, row.parts).content)
    expect(row.content).toContain('[[media:example.png]] https://example.test/output.png')
    expect(assetParts(saved(historic, 'old').parts)[0]!.assetId).toBe(assetParts(row.parts)[0]!.assetId)
    expect(saved(db, 'structured').parts).toEqual(structured)
    const backupRoot = join(state.directory, 'file-migration-backups')
    const manifest = JSON.parse(await readFile(join(backupRoot, 'files-v1.json'), 'utf8'))
    expect(manifest.files).toEqual(['soul.db', '2001-02.db', '2026-10.db'])
    const backup = new Database(join(backupRoot, manifest.directory, '2026-10.db'), { readonly: true })
    try { expect((backup.prepare('SELECT content FROM messages WHERE id = ?').get('one') as { content: string }).content).toBe(content) } finally { backup.close() }
    const first = JSON.stringify(row.parts)
    const refs = count('asset_references')
    await migrateFileStorage()
    expect(JSON.stringify(saved(db, 'one').parts)).toBe(first)
    expect(count('assets')).toBe(1)
    expect(count('asset_versions')).toBe(1)
    expect(count('asset_references')).toBe(refs)
    expect(report.records.some((item) => item.key.endsWith('shard:2001-02'))).toBe(true)
    expect(await readFile(join(state.root, '.chery', 'media', FILE), 'utf8')).toBe('plain text historical file')
  })

  it('未知归属不可读取，缺失文件有固定版本，孤立文件保留，管理员仅认领未知资产', async () => {
    chat('unknown')
    chat('known', 'known-owner')
    const db = state.months.get('2026-10')!
    message(db, 'unknown-message', 'unknown', `${marker()}${marker(MISSING)}`)
    message(db, 'known-message', 'known', marker())
    await writeFile(join(state.root, '.chery', 'media', ORPHAN), 'orphan plain text')
    const report = await migrateFileStorage()
    const [present, missing] = assetParts(saved(db, 'unknown-message').parts)
    const store = new AssetStore(state.db, join(state.root, '.chery', 'assets'))
    expect(store.get(present!.assetId, { ownerId: 'migration:unclaimed' }).availability).toBe('unclaimed')
    await expect(store.read(present!.assetId, { ownerId: 'migration:unclaimed', chatId: 'unknown' })).rejects.toThrow()
    expect(store.get(missing!.assetId, { ownerId: 'migration:unclaimed' })).toMatchObject({ availability: 'missing', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(report.records.some((item) => item.status === 'orphan' && item.details.filename === ORPHAN)).toBe(true)
    const version = missing!.assetVersionId
    expect(await claimLegacyChatFiles('unknown', 'alice')).toEqual({ claimed: 2 })
    expect((await store.read(present!.assetId, { ownerId: 'alice', chatId: 'unknown' })).data.toString()).toBe('plain text historical file')
    await expect(store.read(missing!.assetId, { ownerId: 'alice', chatId: 'unknown' })).rejects.toThrow()
    expect(assetParts(saved(db, 'unknown-message').parts)[1]!.assetVersionId).toBe(version)
    await expect(claimLegacyChatFiles('known', 'alice')).rejects.toThrow('所有者')
    expect(store.get(assetParts(saved(db, 'known-message').parts)[0]!.assetId, { ownerId: 'known-owner' }).ownerId).toBe('known-owner')
    expect(count('assets')).toBe(4)
    expect((await readdir(join(state.root, '.chery', 'media'))).sort()).toEqual([FILE, ORPHAN].sort())
    const orphan = state.db.prepare('SELECT owner_id, migration_unresolved FROM assets WHERE original_name = ?').get(ORPHAN)
    expect(orphan).toEqual({ owner_id: 'migration:unclaimed', migration_unresolved: 1 })
  })

  it('中途失败后保留已提交记录，重新执行不重复文件或版本', async () => {
    chat('chat', 'alice')
    const db = state.months.get('2026-10')!
    message(db, 'a', 'chat', marker())
    message(db, 'b', 'chat', marker())
    db.prepare("UPDATE messages SET parts = '{broken' WHERE id = 'b'").run()
    await expect(migrateFileStorage()).rejects.toThrow()
    const first = saved(db, 'a').parts
    expect(count('assets')).toBe(1)
    expect(state.db.prepare('SELECT status FROM file_migration_records WHERE record_key = ?').get('files-v1:run')).toEqual({ status: 'failed' })
    db.prepare("UPDATE messages SET parts = NULL WHERE id = 'b'").run()
    await migrateFileStorage()
    expect(saved(db, 'a').parts).toEqual(first)
    expect(count('assets')).toBe(1)
    expect(count('asset_versions')).toBe(1)
    expect(count('asset_references')).toBe(2)
    expect(assetParts(saved(db, 'b').parts)[0]!.assetId).toBe(assetParts(first)[0]!.assetId)
  })

  it('显式旧身份只认领未知归属，不替换已知所有者', async () => {
    chat('unknown')
    chat('known', 'bob')
    const db = state.months.get('2026-10')!
    message(db, 'one', 'unknown', marker())
    message(db, 'two', 'known', marker())
    await migrateFileStorage()
    await migrateFileStorage({ legacyOwnerId: 'alice' })
    const rows = state.db.prepare('SELECT owner_id FROM assets ORDER BY owner_id').all()
    expect(rows).toEqual([{ owner_id: 'alice' }, { owner_id: 'bob' }])
    expect(count('asset_versions')).toBe(2)
  })

  it.each(['pending', 'operation', 'branch', 'orphan'] as const)('%s 阶段中断后重跑不重复此前已提交的消息、资产或引用', async stage => {
    chat('chat', 'alice')
    const db = state.months.get('2026-10')!
    message(db, 'one', 'chat', marker())
    state.db.prepare('INSERT INTO pending_inputs VALUES (?, ?, ?, NULL)').run('pending', 'chat', marker())
    state.db.prepare('INSERT INTO file_operations VALUES (?, ?, ?)').run('operation', 'chat', JSON.stringify({ operationId: 'operation', outputParts: [{ type: 'text', partId: 'old', text: marker() }] }))
    state.db.prepare('INSERT INTO conversation_branches VALUES (?, ?, ?)').run('branch', 'chat', JSON.stringify([{ content: marker() }]))
    if (stage === 'pending') state.db.prepare("UPDATE pending_inputs SET parts = '{bad'").run()
    if (stage === 'operation') state.db.prepare("UPDATE file_operations SET record_json = '{bad'").run()
    if (stage === 'branch') state.db.prepare("UPDATE conversation_branches SET context_snapshot_json = '{bad'").run()
    if (stage === 'orphan') await mkdir(join(state.root, '.chery', 'media', ORPHAN))
    await expect(migrateFileStorage()).rejects.toThrow()
    const first = saved(db, 'one').parts
    expect(count('assets')).toBe(1)
    expect(count('asset_versions')).toBe(1)
    if (stage === 'pending') state.db.prepare('UPDATE pending_inputs SET parts = NULL').run()
    if (stage === 'operation') state.db.prepare('UPDATE file_operations SET record_json = ?').run(JSON.stringify({ operationId: 'operation', outputParts: [{ type: 'text', partId: 'old', text: marker() }] }))
    if (stage === 'branch') state.db.prepare('UPDATE conversation_branches SET context_snapshot_json = ?').run(JSON.stringify([{ content: marker() }]))
    if (stage === 'orphan') await rm(join(state.root, '.chery', 'media', ORPHAN), { recursive: true })
    await migrateFileStorage()
    expect(saved(db, 'one').parts).toEqual(first)
    expect(count('assets')).toBe(1)
    expect(count('asset_versions')).toBe(1)
    expect(count('asset_references')).toBe(4)
    await migrateFileStorage()
    expect(count('asset_references')).toBe(4)
    expect(state.db.prepare('SELECT status FROM file_migration_records WHERE record_key = ?').get('files-v1:run')).toEqual({ status: 'committed' })
  })

  it('消息内的旧操作结果保存为资产，操作和消息各自保留引用', async () => {
    chat('chat', 'alice')
    const db = state.months.get('2026-10')!
    message(db, 'tool-message', 'chat', '工具正文保留')
    db.prepare('UPDATE messages SET file_operations = ? WHERE id = ?').run(JSON.stringify([
      { operationId: 'embedded-op', inputAssets: [], outputParts: [{ partId: 'legacy', type: 'text', text: marker() }] },
    ]), 'tool-message')
    await migrateFileStorage()
    const row = db.prepare('SELECT content, file_operations FROM messages').get() as { content: string; file_operations: string }
    expect(row.content).toBe('工具正文保留')
    expect(JSON.parse(row.file_operations)[0].outputParts[0].type).toBe('asset')
    expect(state.db.prepare('SELECT ref_kind, ref_id FROM asset_references ORDER BY ref_kind').all())
      .toEqual([{ ref_kind: 'message', ref_id: 'tool-message' }, { ref_kind: 'operation', ref_id: 'embedded-op' }])
  })

  it('排队、历史分支快照和独立操作登记固定引用', async () => {
    chat('chat', 'alice')
    state.db.prepare('INSERT INTO pending_inputs VALUES (?, ?, ?, NULL)').run('pending', 'chat', marker())
    state.db.prepare('INSERT INTO conversation_branches VALUES (?, ?, ?)').run('branch', 'chat', JSON.stringify([
      { id: 'historical-node', content: `旧记录${marker(MISSING)}` },
      { id: 'current-node', content: marker() },
    ]))
    state.db.prepare('INSERT INTO file_operations VALUES (?, ?, ?)').run('operation', 'chat', JSON.stringify({
      operationId: 'operation', inputAssets: [], outputParts: [{ partId: 'old', type: 'text', text: marker() }],
    }))
    await migrateFileStorage()
    const refs = state.db.prepare('SELECT DISTINCT ref_kind FROM asset_references ORDER BY ref_kind').all()
    expect(refs).toEqual([{ ref_kind: 'branch' }, { ref_kind: 'operation' }, { ref_kind: 'pending' }])
    expect(count('assets')).toBe(2)
    const snapshot = JSON.parse((state.db.prepare('SELECT context_snapshot_json FROM conversation_branches').get() as { context_snapshot_json: string }).context_snapshot_json)
    expect(snapshot[0].parts.map((part: MessagePart) => part.type)).toEqual(['text', 'asset'])
    expect(snapshot[0].content).not.toContain('[[media:')
  })

  it('无 chat 行的分片消息也迁移，但不猜测所有者或创建可读取授权', async () => {
    const db = shard('2000-01')
    message(db, 'old', 'removed-chat', marker())
    const report = await migrateFileStorage({ legacyOwnerId: 'alice' })
    expect(assetParts(saved(db, 'old').parts)).toHaveLength(1)
    expect(state.db.prepare('SELECT owner_id, availability, migration_unresolved FROM assets').get())
      .toEqual({ owner_id: 'migration:unclaimed', availability: 'unclaimed', migration_unresolved: 1 })
    expect(count('asset_chat_grants')).toBe(0)
    expect(report.records.some((item) => item.status === 'orphan')).toBe(true)
  })
})
