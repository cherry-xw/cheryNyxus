import "@/utils/config"; // 确保 dotenv 先加载
import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
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
 * 初始化 souls + chats 表（soul.db）
 */
function initSoulTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS souls (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      sense_group TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      soul_id TEXT NOT NULL,
      messages_month TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (soul_id) REFERENCES souls(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chats_soul ON chats(soul_id);
  `);
}

/**
 * 初始化 messages 表（YYYY-MM.db）
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
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
  `);
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

/**
 * 获取所有月份文件列表
 * 用于扫描所有 pending approvals
 */
export function getAllMonths(): string[] {
  const dbDir = config.global.db_dir;
  if (!existsSync(dbDir)) {
    return [];
  }

  const files = readdirSync(dbDir);
  return files
    .filter(f => f.match(/^\d{4}-\d{2}\.db$/))
    .map(f => f.replace(".db", ""));
}