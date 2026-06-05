import Database from "better-sqlite3";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const cheryDir = process.env.CHERY_DIR || process.cwd();
    const dbPath = join(cheryDir, ".chery", "data.db");
    const dbDir = join(cheryDir, ".chery");

    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    initTables(db);
  }
  return db;
}

function initTables(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tool_group TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      thinking TEXT,
      tool_calls TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS interrupts (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      tool_calls TEXT NOT NULL,
      context_snapshot TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
    CREATE INDEX IF NOT EXISTS idx_interrupts_session ON interrupts(session_id);
    CREATE INDEX IF NOT EXISTS idx_interrupts_status ON interrupts(status);
  `);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}