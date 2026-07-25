import '@/utils/config' // 确保 dotenv 先加载
import Database from 'better-sqlite3'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import config from '@/utils/config.js'

// 缓存管理
const dbCache = {
  soulDb: null as Database.Database | null,
  monthlyDbs: new Map<string, Database.Database>(),
}

/**
 * 获取 soul.db 实例（单例）
 * 包含 souls + chats 表
 */
export function getSoulDb(): Database.Database {
  if (!dbCache.soulDb) {
    const dbDir = config.global.db_dir
    const dbPath = join(dbDir, 'soul.db')

    // 确保目录存在
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    // 确保文件存在
    if (!existsSync(dbPath)) {
      writeFileSync(dbPath, '')
    }

    dbCache.soulDb = new Database(dbPath)
    dbCache.soulDb.pragma('foreign_keys = ON')
    dbCache.soulDb.pragma('journal_mode = WAL')
    initSoulTables(dbCache.soulDb)
  }
  return dbCache.soulDb
}

/**
 * 获取 YYYY-MM.db 实例（动态，缓存）
 * 包含 messages 表
 * 注：messages_month 在 createChat 时按 chat 创建月固定分片，跨月不迁移（见 db/chat.ts）
 */
export function getMonthlyDb(yearMonth: string): Database.Database {
  if (!dbCache.monthlyDbs.has(yearMonth)) {
    const dbDir = config.global.db_dir
    const dbPath = join(dbDir, `${yearMonth}.db`)

    // 确保目录存在
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true })
    }

    // 确保文件存在
    if (!existsSync(dbPath)) {
      writeFileSync(dbPath, '')
    }

    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    initMonthlyTables(db)
    dbCache.monthlyDbs.set(yearMonth, db)
  }
  return dbCache.monthlyDbs.get(yearMonth)!
}

/**
 * 初始化 chats 表（soul.db）
 * 仅保留 chats 表，souls 表已废弃
 */
function initSoulTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      messages_month TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      parent_chat_id TEXT
    );

    CREATE TABLE IF NOT EXISTS request_journal (
      request_id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_request_journal_updated ON request_journal(updated_at);

    CREATE TABLE IF NOT EXISTS spawn_tasks (
      task_id TEXT PRIMARY KEY,
      child_chat_id TEXT NOT NULL UNIQUE,
      parent_chat_id TEXT NOT NULL,
      type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      brain TEXT NOT NULL,
      sense_group TEXT NOT NULL,
      wait INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_spawn_tasks_parent_status ON spawn_tasks(parent_chat_id, status);
  `)
  // P1-8：旧库 chats 表无 message_count，CREATE IF NOT EXISTS 跳过建表，按列检查补 ALTER。
  ensureChatColumn(db, 'message_count', 'INTEGER NOT NULL DEFAULT 0')
  // CP1 主从 Agent：旧库缺 parent_chat_id 列，按列检查补 ALTER（TEXT 缺省 NULL，无需回填）。
  ensureChatColumn(db, 'parent_chat_id', 'TEXT')
}

/**
 * chats 列存在性检查 + 缺失补列（P1-8 冗余计数列迁移）。
 * message_count 加列时一次性回填已有 chat 的消息数（按各自 messages_month 路由 COUNT）。
 */
function ensureChatColumn(db: Database.Database, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[]
  if (cols.some((c) => c.name === column)) return

  db.exec(`ALTER TABLE chats ADD COLUMN ${column} ${definition}`)

  if (column === 'message_count') {
    const chats = db.prepare('SELECT id, messages_month FROM chats').all() as {
      id: string
      messages_month: string
    }[]
    for (const c of chats) {
      const monthlyDb = getMonthlyDb(c.messages_month)
      const row = monthlyDb
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
        .get(c.id) as { n: number }
      db.prepare('UPDATE chats SET message_count = ? WHERE id = ?').run(row.n, c.id)
    }
  }
}

/**
 * 初始化 messages 表（YYYY-MM.db）
 *
 * schema migration：旧 db 文件（revoked 列加入前创建）messages 表缺列，
 * CREATE TABLE IF NOT EXISTS 对已存在表跳过建表 → 列永久缺失。
 * 建表后按列检查补 ALTER TABLE ADD COLUMN，保证旧库自动升级。
 */
function initMonthlyTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      thinking TEXT,
      thinking_blocks TEXT,
      sense_calls TEXT,
      hash TEXT,
      replace_state INTEGER DEFAULT 0,
      replace_by TEXT,
      replace_content TEXT,
      original_content TEXT,
      revoked INTEGER DEFAULT 0,
      runtime TEXT,
      context_compaction INTEGER DEFAULT 0,
      context_compaction_tokens INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);

    // schema migration：旧 db 缺 thinking_blocks 列 → ADD COLUMN 兜底（与 revoked 列同源模式）
    const msgCols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map(
      (r) => r.name,
    )
    if (!msgCols.includes('thinking_blocks')) {
      db.exec('ALTER TABLE messages ADD COLUMN thinking_blocks TEXT')
    }

    CREATE TABLE IF NOT EXISTS chat_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      chat_seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(chat_id, chat_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_events_created ON chat_events(created_at);

    CREATE TABLE IF NOT EXISTS question_batches (
      batch_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(chat_id, assistant_message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_question_batches_chat_status
      ON question_batches(chat_id, status, created_at);

    CREATE TABLE IF NOT EXISTS question_items (
      question_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      question TEXT NOT NULL,
      header TEXT,
      options_json TEXT NOT NULL,
      multi_select INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      answer_json TEXT,
      answer_text TEXT,
      created_at INTEGER NOT NULL,
      answered_at INTEGER,
      UNIQUE(batch_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_question_items_batch_position
      ON question_items(batch_id, position);

    CREATE TABLE IF NOT EXISTS question_projection_meta (
      chat_id TEXT PRIMARY KEY,
      legacy_backfill_version INTEGER NOT NULL
    );
  `)

  ensureMessageColumn(db, 'revoked', 'INTEGER DEFAULT 0')
  ensureMessageColumn(db, 'runtime', 'TEXT')
  ensureMessageColumn(db, 'context_compaction', 'INTEGER DEFAULT 0')
  ensureMessageColumn(db, 'context_compaction_tokens', 'INTEGER')
  ensureChatEventColumn(db, 'chat_seq', 'INTEGER')
  // Development builds created before per-chat sequence migration used the
  // global row id as `seq`. Backfill deterministic per-chat cursors so those
  // databases can upgrade without a destructive table rebuild.
  db.exec(`
    WITH numbered AS (
      SELECT rowid AS event_id, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY rowid) AS n
      FROM chat_events
      WHERE chat_seq IS NULL
    )
    UPDATE chat_events
    SET chat_seq = (SELECT n FROM numbered WHERE numbered.event_id = chat_events.rowid)
    WHERE rowid IN (SELECT event_id FROM numbered)
  `)
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_chat_events_chat_seq_v2 ON chat_events(chat_id, chat_seq)',
  )
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_events_chat_seq_unique ON chat_events(chat_id, chat_seq)',
  )
}

/**
 * 列存在性检查 + 缺失补列。
 * PRAGMA table_info 返回行无该列名时 ALTER TABLE ADD COLUMN。
 */
function ensureMessageColumn(db: Database.Database, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
  const exists = cols.some((c) => c.name === column)
  if (!exists) {
    db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`)
  }
}

/** chat_events 独立演进，不能复用 messages 的列检查。 */
function ensureChatEventColumn(db: Database.Database, column: string, definition: string): void {
  const cols = db.prepare('PRAGMA table_info(chat_events)').all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE chat_events ADD COLUMN ${column} ${definition}`)
  }
}

/**
 * 关闭所有数据库实例
 */
export function closeAllDbs(): void {
  if (dbCache.soulDb) {
    dbCache.soulDb.close()
    dbCache.soulDb = null
  }
  for (const db of dbCache.monthlyDbs.values()) {
    db.close()
  }
  dbCache.monthlyDbs.clear()
}
