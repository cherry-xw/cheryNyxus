import type Database from "better-sqlite3";
import { getDb } from "./index.js";

/**
 * Checkpoint 实体
 */
export interface CheckpointEntity {
  id: string;
  soulId: string;
  chatId: string;
  phase: string;
  pendingSenses: string;
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
  findLatest(soulId: string, chatId: string): Promise<CheckpointEntity | null>;
  findBySoulId(soulId: string): Promise<CheckpointEntity[]>;
  delete(id: string): Promise<void>;
  cleanup(soulId: string, chatId: string): Promise<void>;
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
        soul_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        pending_senses TEXT NOT NULL,
        thinking_accumulated TEXT NOT NULL,
        content_accumulated TEXT NOT NULL,
        messages TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_chat ON checkpoints(chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_soul ON checkpoints(soul_id);
    `);
  }

  async create(entity: CheckpointEntity): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO checkpoints (id, soul_id, chat_id, phase, pending_senses, thinking_accumulated, content_accumulated, messages, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entity.id,
      entity.soulId,
      entity.chatId,
      entity.phase,
      entity.pendingSenses,
      entity.thinkingAccumulated,
      entity.contentAccumulated,
      entity.messages,
      entity.createdAt,
    );
  }

  async findLatest(soulId: string, chatId: string): Promise<CheckpointEntity | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE soul_id = ? AND chat_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(soulId, chatId) as CheckpointRow | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  async findBySoulId(soulId: string): Promise<CheckpointEntity[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE soul_id = ?
      ORDER BY created_at DESC
    `);
    const rows = stmt.all(soulId) as CheckpointRow[];
    return rows.map(this.rowToEntity);
  }

  async delete(id: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM checkpoints WHERE id = ?");
    stmt.run(id);
  }

  async cleanup(soulId: string, chatId: string): Promise<void> {
    const stmt = this.db.prepare(
      "DELETE FROM checkpoints WHERE soul_id = ? AND chat_id = ?",
    );
    stmt.run(soulId, chatId);
  }

  private rowToEntity(row: CheckpointRow): CheckpointEntity {
    return {
      id: row.id,
      soulId: row.soul_id,
      chatId: row.chat_id,
      phase: row.phase,
      pendingSenses: row.pending_senses,
      thinkingAccumulated: row.thinking_accumulated,
      contentAccumulated: row.content_accumulated,
      messages: row.messages,
      createdAt: row.created_at,
    };
  }
}

interface CheckpointRow {
  id: string;
  soul_id: string;
  chat_id: string;
  phase: string;
  pending_senses: string;
  thinking_accumulated: string;
  content_accumulated: string;
  messages: string;
  created_at: number;
}

export const checkpointRepo = new SQLiteCheckpointRepository(getDb());
