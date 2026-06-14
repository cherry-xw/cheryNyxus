import "@/utils/config"; // 确保 dotenv 先加载
import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import config from "@/utils/config.js";

// 缓存管理
const dbCache = {
  soulDb: null as Database.Database | null,
  monthlyDbs: new Map<string, Database.Database>(),
};

/**
 * 获取 soul.db 实例（单例）
 * 包含 souls + chats 表
 */
export function getSoulDb(): Database.Database {
  if (!dbCache.soulDb) {
    const dbDir = config.global.db_dir;
    const dbPath = join(dbDir, "soul.db");

    // 确保目录存在
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // 确保文件存在
    if (!existsSync(dbPath)) {
      writeFileSync(dbPath, "");
    }

    dbCache.soulDb = new Database(dbPath);
    dbCache.soulDb.pragma("foreign_keys = ON");
    dbCache.soulDb.pragma("journal_mode = WAL");
    initSoulTables(dbCache.soulDb);
  }
  return dbCache.soulDb;
}

/**
 * 获取 YYYY-MM.db 实例（动态，缓存）
 * 包含 messages 表
 * 注：messages_month 在 createChat 时按 chat 创建月固定分片，跨月不迁移（见 db/chat.ts）
 */
export function getMonthlyDb(yearMonth: string): Database.Database {
  if (!dbCache.monthlyDbs.has(yearMonth)) {
    const dbDir = config.global.db_dir;
    const dbPath = join(dbDir, `${yearMonth}.db`);

    // 确保目录存在
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // 确保文件存在
    if (!existsSync(dbPath)) {
      writeFileSync(dbPath, "");
    }

    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    initMonthlyTables(db);
    dbCache.monthlyDbs.set(yearMonth, db);
  }
  return dbCache.monthlyDbs.get(yearMonth)!;
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
      metadata TEXT
    );
  `);
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
      sense_calls TEXT,
      hash TEXT,
      replace_state INTEGER DEFAULT 0,
      replace_by TEXT,
      replace_content TEXT,
      original_content TEXT,
      revoked INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
  `);

  ensureMessageColumn(db, "revoked", "INTEGER DEFAULT 0");
}

/**
 * 列存在性检查 + 缺失补列。
 * PRAGMA table_info 返回行无该列名时 ALTER TABLE ADD COLUMN。
 */
function ensureMessageColumn(
  db: Database.Database,
  column: string,
  definition: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as
    { name: string }[];
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * 关闭所有数据库实例
 */
export function closeAllDbs(): void {
  if (dbCache.soulDb) {
    dbCache.soulDb.close();
    dbCache.soulDb = null;
  }
  for (const [month, db] of dbCache.monthlyDbs) {
    db.close();
  }
  dbCache.monthlyDbs.clear();
}