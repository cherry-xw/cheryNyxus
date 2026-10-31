import { createHash, randomUUID } from 'node:crypto'
import type { IngressRequestIdentity } from '@chery/plugin-api'
import type { SourceInput } from '@chery/protocol'
import { getSoulDb } from './index.js'
export { initSourceTaskTables } from './sourceTaskSchema.js'

/** A saved identity describes ownership; callers still need current host authority. */
export interface SourceTask {
  runId: string
  requestId: string
  chatId: string
  epochId: string
  permissionRevision: number
  identity: IngressRequestIdentity
  input: SourceInput
  sessionId: string
  state: 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled'
}
export interface SourceAnswerCommand {
  commandId: string
  runId: string
  batchId: string
  fingerprint: string
  parentSnapshotId: string
  state: 'saving' | 'saved' | 'started'
  sourceInput?: SourceInput
}
export const sourceTaskSessionId = randomUUID()
export function sourceTaskError(code: string): never {
  throw Object.assign(new Error(code), { code })
}
export function registerSourceTask(task: SourceTask): void {
  const db = getSoulDb(), saved = getSourceTask(task.runId)
  if (saved && JSON.stringify(saved) !== JSON.stringify(task)) sourceTaskError('SOURCE_CONFLICT')
  if (!saved) db.prepare(`INSERT INTO source_tasks
    (run_id,request_id,chat_id,epoch_id,permission_revision,identity_json,input_json,session_id,state) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(task.runId, task.requestId, task.chatId, task.epochId, task.permissionRevision, JSON.stringify(task.identity), JSON.stringify(task.input), task.sessionId, task.state)
}
export function getSourceTask(runId: string): SourceTask | undefined {
  const row = getSoulDb().prepare('SELECT * FROM source_tasks WHERE run_id=?').get(runId) as {
    run_id: string; request_id: string; chat_id: string; epoch_id: string; permission_revision: number; identity_json: string
    input_json: string; session_id: string; state: SourceTask['state']
  } | undefined
  return row ? { runId: row.run_id, requestId: row.request_id, chatId: row.chat_id, epochId: row.epoch_id,
    permissionRevision: row.permission_revision, identity: JSON.parse(row.identity_json), input: JSON.parse(row.input_json), sessionId: row.session_id, state: row.state } : undefined
}
export function setSourceTaskState(runId: string, state: SourceTask['state']): void {
  // A late done/error must never reopen a cancelled or already terminal task.
  getSoulDb().prepare(`UPDATE source_tasks SET state=? WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')`).run(state, runId)
}
export function bindSourceQuestions(runId: string, batchId: string, questionIds: string[], assistantMessageId: string): void {
  const db = getSoulDb(), ids = JSON.stringify(questionIds)
  const old = db.prepare('SELECT run_id,assistant_message_id,question_ids_json FROM source_question_bindings WHERE batch_id=?').get(batchId) as { run_id: string; assistant_message_id: string; question_ids_json: string } | undefined
  if (old && (old.run_id !== runId || old.assistant_message_id !== assistantMessageId || old.question_ids_json !== ids)) sourceTaskError('SOURCE_CONFLICT')
  db.prepare('INSERT OR IGNORE INTO source_question_bindings(batch_id,run_id,assistant_message_id,question_ids_json) VALUES (?,?,?,?)').run(batchId, runId, assistantMessageId, ids)
}
export function sourceQuestionBatches(runId: string): Array<{ batchId: string; questionIds: string[] }> {
  return (getSoulDb().prepare('SELECT batch_id,question_ids_json FROM source_question_bindings WHERE run_id=? ORDER BY rowid').all(runId) as
    Array<{ batch_id: string; question_ids_json: string }>).map(row => ({ batchId: row.batch_id, questionIds: JSON.parse(row.question_ids_json) }))
}
export function getSourceAnswerCommand(commandId: string): SourceAnswerCommand | undefined {
  const row = getSoulDb().prepare('SELECT * FROM source_answer_commands WHERE command_id=?').get(commandId) as {
    command_id: string; run_id: string; batch_id: string; fingerprint: string; parent_snapshot_id: string
    state: SourceAnswerCommand['state']; source_input_json: string | null
  } | undefined
  return row ? { commandId: row.command_id, runId: row.run_id, batchId: row.batch_id, fingerprint: row.fingerprint,
    parentSnapshotId: row.parent_snapshot_id, state: row.state, ...(row.source_input_json ? { sourceInput: JSON.parse(row.source_input_json) } : {}) } : undefined
}
export function claimSourceAnswer(input: { commandId: string; runId: string; batchId: string; parentSnapshotId: string; body: unknown }): SourceAnswerCommand {
  return getSoulDb().transaction(() => {
    const fingerprint = createHash('sha256').update(JSON.stringify(input.body)).digest('hex')
    const saved = getSourceAnswerCommand(input.commandId)
    if (saved) {
      if (saved.runId !== input.runId || saved.batchId !== input.batchId || saved.fingerprint !== fingerprint) sourceTaskError('SOURCE_CONFLICT')
      return saved
    }
    if (getSoulDb().prepare('SELECT 1 FROM source_answer_commands WHERE batch_id=?').get(input.batchId)) sourceTaskError('SOURCE_CONFLICT')
    getSoulDb().prepare(`INSERT INTO source_answer_commands(command_id,run_id,batch_id,fingerprint,parent_snapshot_id,state)
      VALUES (?,?,?,?,?,'saving')`).run(input.commandId, input.runId, input.batchId, fingerprint, input.parentSnapshotId)
    return getSourceAnswerCommand(input.commandId)!
  })()
}
export function saveSourceAnswer(commandId: string, sourceInput: SourceInput): void {
  getSoulDb().transaction(() => {
    const command = getSourceAnswerCommand(commandId)
    if (!command || command.state !== 'saving') sourceTaskError('SOURCE_CONFLICT')
    getSoulDb().prepare("UPDATE source_answer_commands SET state='saved',source_input_json=? WHERE command_id=?").run(JSON.stringify(sourceInput), commandId)
    getSoulDb().prepare('UPDATE source_tasks SET input_json=? WHERE run_id=?').run(JSON.stringify(sourceInput), command.runId)
  })()
}
export function startSourceAnswer(commandId: string): boolean {
  return getSoulDb().prepare("UPDATE source_answer_commands SET state='started' WHERE command_id=? AND state='saved'").run(commandId).changes === 1
}
