import type Database from 'better-sqlite3'

/** Also used by stopped-process maintenance; no environment or service initialization. */
export function initSourceTaskTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_tasks (
      run_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
      epoch_id TEXT NOT NULL, permission_revision INTEGER NOT NULL, identity_json TEXT NOT NULL, input_json TEXT NOT NULL,
      session_id TEXT NOT NULL, state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS source_tasks_chat ON source_tasks(chat_id);
    CREATE TABLE IF NOT EXISTS source_question_bindings (
      batch_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES source_tasks(run_id), assistant_message_id TEXT NOT NULL, question_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_answer_commands (
      command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES source_tasks(run_id),
      batch_id TEXT NOT NULL UNIQUE REFERENCES source_question_bindings(batch_id),
      fingerprint TEXT NOT NULL, parent_snapshot_id TEXT NOT NULL, state TEXT NOT NULL, source_input_json TEXT
    );
  `)
}
