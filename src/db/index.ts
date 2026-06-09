import "@/utils/config"; // 确保 dotenv 先加载
import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const cheryDir = process.env.CHERY_DIR || process.cwd();
    const dbPath = join(cheryDir, ".chery", "data.db");
    const dbDir = join(cheryDir, ".chery");

    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    if (!existsSync(dbPath)) {
      writeFileSync(dbPath, "");
    }

    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    initTables(db);
  }
  return db;
}

function initTables(database: Database.Database): void {
  database.exec(`
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (soul_id) REFERENCES souls(id) ON DELETE CASCADE
    );

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
      created_at INTEGER NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      soul_id TEXT NOT NULL,
      status TEXT NOT NULL,
      sense_calls TEXT NOT NULL,
      context_snapshot TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (soul_id) REFERENCES souls(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_chats_soul ON chats(soul_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_soul ON approvals(soul_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
