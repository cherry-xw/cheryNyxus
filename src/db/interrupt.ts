import type Database from "better-sqlite3";
import { getDb } from "./index.js";
import { safeJsonParse } from "@/utils/json.js";

/**
 * 中断中的工具调用数据
 */
export interface InterruptToolCall {
  id: string;
  name: string;
  arguments: string;
  approved: boolean;
  triggeredAt: number;
}

/**
 * 中断实体
 */
export interface InterruptEntity {
  id: string;
  threadId: string;
  sessionId: string;
  status: "pending" | "acknowledged" | "completed" | "timeout";
  toolCalls: InterruptToolCall[];
  contextSnapshot: ContextSnapshot | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 上下文快照（用于恢复）
 */
export interface ContextSnapshot {
  messages: string | null;
  userInputs: Array<{ content: string; time: number }>;
  aiServer: {
    provider: string;
    model: string;
  };
}

/**
 * Repository 接口（可替换实现）
 */
interface InterruptRepository {
  create(entity: InterruptEntity): Promise<void>;
  findById(id: string): Promise<InterruptEntity | null>;
  findBySessionId(sessionId: string): Promise<InterruptEntity[]>;
  findByStatus(status: InterruptEntity["status"]): Promise<InterruptEntity[]>;
  update(id: string, changes: Partial<InterruptEntity>): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * SQLite Repository 实现
 */
export class SQLiteInterruptRepository implements InterruptRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interrupts (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        tool_calls TEXT NOT NULL,
        context_snapshot TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_interrupts_session ON interrupts(session_id);
      CREATE INDEX IF NOT EXISTS idx_interrupts_status ON interrupts(status);
    `);
  }

  async create(entity: InterruptEntity): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO interrupts (id, thread_id, session_id, status, tool_calls, context_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entity.id,
      entity.threadId,
      entity.sessionId,
      entity.status,
      JSON.stringify(entity.toolCalls),
      entity.contextSnapshot ? JSON.stringify(entity.contextSnapshot) : null,
      entity.createdAt,
      entity.updatedAt,
    );
  }

  async findById(id: string): Promise<InterruptEntity | null> {
    const stmt = this.db.prepare("SELECT * FROM interrupts WHERE id = ?");
    const row = stmt.get(id) as InterruptRow | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  async findBySessionId(sessionId: string): Promise<InterruptEntity[]> {
    const stmt = this.db.prepare("SELECT * FROM interrupts WHERE session_id = ? ORDER BY created_at DESC");
    const rows = stmt.all(sessionId) as InterruptRow[];
    return rows.map(this.rowToEntity);
  }

  async findByStatus(status: InterruptEntity["status"]): Promise<InterruptEntity[]> {
    const stmt = this.db.prepare("SELECT * FROM interrupts WHERE status = ? ORDER BY created_at DESC");
    const rows = stmt.all(status) as InterruptRow[];
    return rows.map(this.rowToEntity);
  }

  async update(id: string, changes: Partial<InterruptEntity>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (changes.status !== undefined) {
      fields.push("status = ?");
      values.push(changes.status);
    }
    if (changes.toolCalls !== undefined) {
      fields.push("tool_calls = ?");
      values.push(JSON.stringify(changes.toolCalls));
    }
    if (changes.contextSnapshot !== undefined) {
      fields.push("context_snapshot = ?");
      values.push(changes.contextSnapshot ? JSON.stringify(changes.contextSnapshot) : null);
    }
    if (changes.updatedAt !== undefined) {
      fields.push("updated_at = ?");
      values.push(changes.updatedAt);
    }

    if (fields.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(`UPDATE interrupts SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  async delete(id: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM interrupts WHERE id = ?");
    stmt.run(id);
  }

  private rowToEntity(row: InterruptRow): InterruptEntity {
    return {
      id: row.id,
      threadId: row.thread_id,
      sessionId: row.session_id,
      status: row.status as InterruptEntity["status"],
      toolCalls: safeJsonParse(row.tool_calls, []),
      contextSnapshot: row.context_snapshot ? safeJsonParse(row.context_snapshot, null) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

interface InterruptRow {
  id: string;
  thread_id: string;
  session_id: string;
  status: string;
  tool_calls: string;
  context_snapshot: string | null;
  created_at: number;
  updated_at: number;
}

// 导出统一实例
export const interruptRepo = new SQLiteInterruptRepository(getDb());