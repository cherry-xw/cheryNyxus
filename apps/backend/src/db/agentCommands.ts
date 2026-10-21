import type Database from 'better-sqlite3'
import {
  AgentCommandRecordSchema,
  type AgentCommandRecord,
  type AgentCommandStatus,
} from '@chery/protocol'

export function initAgentCommandTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_commands (
      command_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      backend_instance_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      stored_compressed_bytes INTEGER NOT NULL DEFAULT 0,
      opening_sealed INTEGER NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_commands_chat_time ON agent_commands(chat_id, started_at DESC, command_id);
    CREATE INDEX IF NOT EXISTS idx_agent_commands_end ON agent_commands(ended_at, command_id);
    CREATE INDEX IF NOT EXISTS idx_agent_commands_status ON agent_commands(status, started_at);
    CREATE TABLE IF NOT EXISTS agent_command_log_blocks (
      command_id TEXT NOT NULL REFERENCES agent_commands(command_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      byte_start INTEGER NOT NULL,
      byte_end INTEGER NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      compressed BLOB NOT NULL,
      compressed_bytes INTEGER NOT NULL,
      opening INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(command_id, sequence)
    );
  `)
}

export interface CommandLogBlockRow {
  sequence: number
  byte_start: number
  byte_end: number
  line_start: number
  line_end: number
  compressed: Buffer
  compressed_bytes: number
  opening: number
}

/** Internal repository: callers must apply session authorization before exposing any row. */
export class AgentCommandRepository {
  constructor(readonly db: Database.Database) {}

  create(record: AgentCommandRecord): void {
    const value = AgentCommandRecordSchema.parse(record)
    this.db.prepare(`INSERT INTO agent_commands
      (command_id, chat_id, backend_instance_id, status, started_at, ended_at, stored_compressed_bytes, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(value.commandId, value.chatId, value.backendInstanceId,
      value.status, value.startedAt, value.endedAt, value.storedCompressedBytes, JSON.stringify(value))
  }

  get(commandId: string): AgentCommandRecord | undefined {
    const row = this.db.prepare('SELECT data_json FROM agent_commands WHERE command_id = ?')
      .get(commandId) as { data_json: string } | undefined
    return row ? AgentCommandRecordSchema.parse(JSON.parse(row.data_json)) : undefined
  }

  update(commandId: string, update: (previous: AgentCommandRecord) => AgentCommandRecord): AgentCommandRecord {
    const previous = this.get(commandId)
    if (!previous) throw new Error('命令记录不存在')
    const candidate = update(previous)
    const next = AgentCommandRecordSchema.parse({ ...candidate, version: Math.max(previous.version + 1, candidate.version) })
    if (next.commandId !== previous.commandId || next.chatId !== previous.chatId ||
      next.rootChatId !== previous.rootChatId || next.runId !== previous.runId || next.toolCallId !== previous.toolCallId ||
      next.sourceKind !== previous.sourceKind || next.backendInstanceId !== previous.backendInstanceId || next.startedAt !== previous.startedAt) {
      throw new Error('不能改变命令归属')
    }
    this.db.prepare(`UPDATE agent_commands SET status = ?, ended_at = ?, stored_compressed_bytes = ?, data_json = ?
      WHERE command_id = ?`).run(next.status, next.endedAt, next.storedCompressedBytes, JSON.stringify(next), commandId)
    return next
  }

  list(input: { chatId?: string; includeChildren?: boolean; ownerId?: string; activeOnly?: boolean; historyOnly?: boolean;
    before?: { startedAt: number; commandId: string }; limit?: number } = {}): AgentCommandRecord[] {
    const clauses: string[] = []
    const params: (string | number)[] = []
    const ctes: string[] = []
    if (input.ownerId) {
      ctes.push(`accessible(id) AS (
        SELECT id FROM chats WHERE parent_chat_id IS NULL AND
          CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.fileOwnerId') END = ?
        UNION SELECT c.id FROM chats c JOIN accessible a ON c.parent_chat_id = a.id)`)
      params.push(input.ownerId)
      clauses.push('chat_id IN (SELECT id FROM accessible)')
    }
    if (input.chatId && input.includeChildren) {
      ctes.push(`selected(id) AS (SELECT id FROM chats WHERE id = ?
        UNION SELECT c.id FROM chats c JOIN selected s ON c.parent_chat_id = s.id)`)
      params.push(input.chatId)
      clauses.push('chat_id IN (SELECT id FROM selected)')
    } else if (input.chatId) { clauses.push('chat_id = ?') }
    // CTE placeholders precede the main WHERE placeholders.
    if (input.chatId && !input.includeChildren) params.push(input.chatId)
    if (input.activeOnly) clauses.push('ended_at IS NULL')
    if (input.historyOnly) clauses.push('ended_at IS NOT NULL')
    if (input.before) {
      clauses.push('(started_at < ? OR (started_at = ? AND command_id < ?))')
      params.push(input.before.startedAt, input.before.startedAt, input.before.commandId)
    }
    const rows = this.db.prepare(`${ctes.length ? `WITH RECURSIVE ${ctes.join(', ')} ` : ''}
      SELECT data_json FROM agent_commands ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY started_at DESC, command_id DESC LIMIT ?`).all(...params, Math.max(1, Math.min(input.limit ?? 100, 200))) as { data_json: string }[]
    return rows.map((row) => AgentCommandRecordSchema.parse(JSON.parse(row.data_json)))
  }

  active(): AgentCommandRecord[] {
    return (this.db.prepare('SELECT data_json FROM agent_commands WHERE ended_at IS NULL')
      .all() as { data_json: string }[]).map((row) => AgentCommandRecordSchema.parse(JSON.parse(row.data_json)))
  }

  totalCompressedBytes(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(stored_compressed_bytes), 0) AS total FROM agent_commands')
      .get() as { total: number }).total
  }

  /** Only call after confirming the previous instance no longer owns a live worker. */
  interruptPreviousInstances(instanceId: string, now: number): AgentCommandRecord[] {
    return this.db.transaction(() => this.active().filter((record) => record.backendInstanceId !== instanceId).map((record) =>
      this.update(record.commandId, (previous) => ({
        ...previous, status: 'result_unknown', endedAt: now, logStatus: 'partial_truncated',
        logTailUnconfirmed: true, logIssues: [...new Set([...previous.logIssues, 'restart' as const])],
      }))))()
  }
}

export function isActiveCommandStatus(status: AgentCommandStatus): boolean {
  return status === 'running' || status === 'background' || status === 'cancel_requested'
}
