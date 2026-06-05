import Database from "better-sqlite3";
import { SQLiteInterruptRepository } from "@/db/interrupt.js";

export function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata TEXT
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

    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_threads_session ON threads(session_id);
  `);

  return db;
}

export function createTestInterruptRepo(db: Database.Database): SQLiteInterruptRepository {
  return new SQLiteInterruptRepository(db);
}

export function closeTestDb(db: Database.Database): void {
  db.close();
}
