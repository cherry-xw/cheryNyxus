import type Database from 'better-sqlite3'

export function initBackendResumeTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS backend_resume_gates (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    resume_required INTEGER NOT NULL DEFAULT 0,
    stop_operation_id TEXT,
    before_stop_resume_required INTEGER NOT NULL DEFAULT 0
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS tool_execution_starts (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    call_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY(chat_id, call_id)
  )`)
}

export class BackendResumeRepository {
  constructor(readonly db: Database.Database) {}

  required(chatId: string): boolean {
    return (this.db.prepare('SELECT resume_required FROM backend_resume_gates WHERE chat_id = ?')
      .get(chatId) as { resume_required: number } | undefined)?.resume_required === 1
  }

  continuationRequired(chatId: string, operationId: string): boolean {
    const row = this.db.prepare(`SELECT resume_required, stop_operation_id, before_stop_resume_required
      FROM backend_resume_gates WHERE chat_id = ?`).get(chatId) as {
        resume_required: number; stop_operation_id: string | null; before_stop_resume_required: number
      } | undefined
    return !!row && (row.stop_operation_id === operationId ? row.before_stop_resume_required === 1 : row.resume_required === 1)
  }

  /** A previous process cannot retain in-memory permission to execute this work. */
  recover(chatIds: readonly string[]): void {
    this.db.transaction(() => {
      for (const id of new Set(chatIds)) this.db.prepare(`INSERT INTO backend_resume_gates (chat_id, resume_required)
        VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET resume_required = 1,
        stop_operation_id = NULL, before_stop_resume_required = 1`).run(id)
    })()
  }

  park(chatIds: readonly string[], operationId: string): void {
    this.db.transaction(() => {
      for (const id of new Set(chatIds)) this.db.prepare(`INSERT INTO backend_resume_gates
        (chat_id, resume_required, stop_operation_id, before_stop_resume_required) VALUES (?, 1, ?, 0)
        ON CONFLICT(chat_id) DO UPDATE SET
          before_stop_resume_required = CASE WHEN stop_operation_id = excluded.stop_operation_id
            THEN before_stop_resume_required ELSE resume_required END,
          resume_required = 1, stop_operation_id = excluded.stop_operation_id`).run(id, operationId)
    })()
  }

  cancel(operationId: string): string[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare('SELECT chat_id FROM backend_resume_gates WHERE stop_operation_id = ?')
        .all(operationId) as { chat_id: string }[]
      this.db.prepare(`UPDATE backend_resume_gates SET resume_required = before_stop_resume_required,
        stop_operation_id = NULL WHERE stop_operation_id = ?`).run(operationId)
      return rows.map((row) => row.chat_id)
    })()
  }

  resume(chatId: string): void {
    this.db.prepare(`UPDATE backend_resume_gates SET resume_required = 0, stop_operation_id = NULL,
      before_stop_resume_required = 0 WHERE chat_id = ?`).run(chatId)
  }
}
