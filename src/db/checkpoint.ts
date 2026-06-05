import type Database from "better-sqlite3";
import { getDb } from "./index.js";

/**
 * Checkpoint 实体
 */
export interface CheckpointEntity {
  id: string;
  sessionId: string;
  threadId: string;
  phase: string;
  pendingTools: string;
  thinkingAccumulated: string;
  contentAccumulated: string;
  messages: string;
  createdAt: number;
}

/**
 * Checkpoint Repository 接口
 */
interface CheckpointRepository {
  create(entity: CheckpointEntity): Promise<void>;
  findLatest(sessionId: string, threadId: string): Promise<CheckpointEntity | null>;
  findBySessionId(sessionId: string): Promise<CheckpointEntity[]>;
  delete(id: string): Promise<void>;
  cleanup(sessionId: string, threadId: string): Promise<void>;
}

/**
 * SQLite Checkpoint Repository 实现
 */
export class SQLiteCheckpointRepository implements CheckpointRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        pending_tools TEXT NOT NULL,
        thinking_accumulated TEXT NOT NULL,
        content_accumulated TEXT NOT NULL,
        messages TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
    `);
  }

  async create(entity: CheckpointEntity): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (id, session_id, thread_id, phase, pending_tools, thinking_accumulated, content_accumulated, messages, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entity.id,
      entity.sessionId,
      entity.threadId,
      entity.phase,
      entity.pendingTools,
      entity.thinkingAccumulated,
      entity.contentAccumulated,
      entity.messages,
      entity.createdAt,
    );
  }

  async findLatest(sessionId: string, threadId: string): Promise<CheckpointEntity | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE session_id = ? AND thread_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(sessionId, threadId) as CheckpointRow | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  async findBySessionId(sessionId: string): Promise<CheckpointEntity[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE session_id = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(sessionId) as CheckpointRow[];
    return rows.map(this.rowToEntity);
  }

  async delete(id: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM checkpoints WHERE id = ?");
    stmt.run(id);
  }

  async cleanup(sessionId: string, threadId: string): Promise<void> {
    const stmt = this.db.prepare(
      "DELETE FROM checkpoints WHERE session_id = ? AND thread_id = ?",
    );
    stmt.run(sessionId, threadId);
  }

  private rowToEntity(row: CheckpointRow): CheckpointEntity {
    return {
      id: row.id,
      sessionId: row.session_id,
      threadId: row.thread_id,
      phase: row.phase,
      pendingTools: row.pending_tools,
      thinkingAccumulated: row.thinking_accumulated,
      contentAccumulated: row.content_accumulated,
      messages: row.messages,
      createdAt: row.created_at,
    };
  }
}

interface CheckpointRow {
  id: string;
  session_id: string;
  thread_id: string;
  phase: string;
  pending_tools: string;
  thinking_accumulated: string;
  content_accumulated: string;
  messages: string;
  created_at: number;
}

export const checkpointRepo = new SQLiteCheckpointRepository(getDb());