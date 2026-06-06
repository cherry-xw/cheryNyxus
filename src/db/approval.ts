import type Database from "better-sqlite3";
import { getDb } from "./index.js";
import { safeJsonParse } from "@/utils/json.js";

/**
 * 审批中的感官调用数据
 */
export interface ApprovalSenseCall {
  id: string;
  name: string;
  arguments: string;
  approved: boolean;
  triggeredAt: number;
}

/**
 * 审批实体
 */
export interface ApprovalEntity {
  id: string;
  chatId: string;
  soulId: string;
  status: "pending" | "acknowledged" | "completed" | "timeout";
  senseCalls: ApprovalSenseCall[];
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
  brain: {
    provider: string;
    model: string;
  };
}

/**
 * Repository 接口（可替换实现）
 */
interface ApprovalRepository {
  create(entity: ApprovalEntity): Promise<void>;
  findById(id: string): Promise<ApprovalEntity | null>;
  findBySoulId(soulId: string): Promise<ApprovalEntity[]>;
  findByStatus(status: ApprovalEntity["status"]): Promise<ApprovalEntity[]>;
  update(id: string, changes: Partial<ApprovalEntity>): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * SQLite Repository 实现
 */
export class SQLiteApprovalRepository implements ApprovalRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        soul_id TEXT NOT NULL,
        status TEXT NOT NULL,
        sense_calls TEXT NOT NULL,
        context_snapshot TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_soul ON approvals(soul_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    `);
  }

  async create(entity: ApprovalEntity): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO approvals (id, chat_id, soul_id, status, sense_calls, context_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entity.id,
      entity.chatId,
      entity.soulId,
      entity.status,
      JSON.stringify(entity.senseCalls),
      entity.contextSnapshot ? JSON.stringify(entity.contextSnapshot) : null,
      entity.createdAt,
      entity.updatedAt,
    );
  }

  async findById(id: string): Promise<ApprovalEntity | null> {
    const stmt = this.db.prepare("SELECT * FROM approvals WHERE id = ?");
    const row = stmt.get(id) as ApprovalRow | undefined;
    if (!row) return null;
    return this.rowToEntity(row);
  }

  async findBySoulId(soulId: string): Promise<ApprovalEntity[]> {
    const stmt = this.db.prepare("SELECT * FROM approvals WHERE soul_id = ? ORDER BY created_at DESC");
    const rows = stmt.all(soulId) as ApprovalRow[];
    return rows.map(this.rowToEntity);
  }

  async findByStatus(status: ApprovalEntity["status"]): Promise<ApprovalEntity[]> {
    const stmt = this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC");
    const rows = stmt.all(status) as ApprovalRow[];
    return rows.map(this.rowToEntity);
  }

  async update(id: string, changes: Partial<ApprovalEntity>): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (changes.status !== undefined) {
      fields.push("status = ?");
      values.push(changes.status);
    }
    if (changes.senseCalls !== undefined) {
      fields.push("sense_calls = ?");
      values.push(JSON.stringify(changes.senseCalls));
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
    const stmt = this.db.prepare(`UPDATE approvals SET ${fields.join(", ")} WHERE id = ?`);
    stmt.run(...values);
  }

  async delete(id: string): Promise<void> {
    const stmt = this.db.prepare("DELETE FROM approvals WHERE id = ?");
    stmt.run(id);
  }

  private rowToEntity(row: ApprovalRow): ApprovalEntity {
    return {
      id: row.id,
      chatId: row.chat_id,
      soulId: row.soul_id,
      status: row.status as ApprovalEntity["status"],
      senseCalls: safeJsonParse(row.sense_calls, []),
      contextSnapshot: row.context_snapshot ? safeJsonParse(row.context_snapshot, null) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

interface ApprovalRow {
  id: string;
  chat_id: string;
  soul_id: string;
  status: string;
  sense_calls: string;
  context_snapshot: string | null;
  created_at: number;
  updated_at: number;
}

// 导出统一实例
export const approvalRepo = new SQLiteApprovalRepository(getDb());