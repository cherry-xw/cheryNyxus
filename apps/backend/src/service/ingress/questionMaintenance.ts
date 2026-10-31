import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { SourceInputSchema, SourceSnapshotSchema, SourceScopeSchema } from '@chery/protocol'
import { StateSchema, JobDataSchema } from '../../../../../plugins/qq/src/state.js'
import { initSourceTaskTables } from '@/db/sourceTaskSchema.js'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const fileHash = (file: string) => hash(fs.readFileSync(file))
type Json = Record<string, any>
type Report = { operationId: string; stateVersion: number; tasks: number; bindings: number; cancelledWaits: number;
  unresolved: Array<{ requestId: string; reasonCode: string }>; conflicts: Array<{ requestId?: string; reasonCode: string }>; phase: string }
type Task = { runId: string; requestId: string; chatId: string; epochId: string; permissionRevision: number;
  identity: Json; input: Json; state: string; batch?: { batchId: string; assistantId: string; ids: string[] }; cancelWait: boolean }
type Plan = { operationId: string; originalStateHash: string; stateJson: string; tasks: Task[]; report: Report; monthlyHashes: Record<string,string> }
const exists = (db: Database.Database, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
const row = (db: Database.Database, sql: string, ...params: string[]) => db.prepare(sql).get(...params) as Json | undefined

function prepare(db: Database.Database, stateFile: string, operationId: string, dbDirectory: string): Plan {
  const original = fs.readFileSync(stateFile, 'utf8'), state = JSON.parse(original) as Json
  const report: Report = { operationId, stateVersion: state.schemaVersion, tasks: 0, bindings: 0, cancelledWaits: 0,
    unresolved: [], conflicts: [], phase: 'preview' }
  if (state.schemaVersion !== 2) throw new Error('QUESTION_STATE_VERSION_INVALID')
  const tasks: Task[] = [], monthlyHashes: Record<string,string> = {}
  let sequence = 0
  for (const raw of state.jobs as Json[]) {
    const old = raw.questions, { questions: _questions, ...data } = raw
    const job = JobDataSchema.parse({ ...data, queueSequence: ++sequence, questionBatches: old ? [{ ...old,
      replies: old.replies ?? [], status: old.commandId ? 'unknown' : 'pending' }] : [] })
    const reject = (reasonCode: string) => {
      report.unresolved.push({ requestId: job.requestId, reasonCode })
      if (!['completed','failed','cancelled'].includes(job.state)) {
        job.state = 'cancelled'; job.outcome = 'cancelled'; job.reason = reasonCode
      }
    }
    delete job.nextWaitAt; delete job.filePreparationPending
    state.jobs[sequence - 1] = job
    if (!job.sourceSnapshot || !job.sourceScopeId || !job.coreRunId) { reject('QUESTION_ASSOCIATION_UNPROVEN'); continue }
    const snapshot = SourceSnapshotSchema.parse(job.sourceSnapshot)
    const source = row(db, 'SELECT * FROM source_runs WHERE run_id=? AND request_id=? AND scope_id=?', job.coreRunId, job.requestId, job.sourceScopeId)
    const scopeRow = row(db, 'SELECT data_json FROM source_scopes WHERE scope_id=?', job.sourceScopeId)
    const scope = scopeRow ? SourceScopeSchema.parse(JSON.parse(scopeRow.data_json)) : undefined
    const storedSnapshot = row(db, 'SELECT data_json FROM source_snapshots WHERE snapshot_id=? AND request_id=? AND scope_id=?', snapshot.snapshotId, job.requestId, job.sourceScopeId)
    if (!source || !scope?.coreBinding || !storedSnapshot || hash(JSON.stringify(SourceSnapshotSchema.parse(JSON.parse(storedSnapshot.data_json)))) !== hash(JSON.stringify(snapshot))) {
      reject('QUESTION_ASSOCIATION_UNPROVEN'); continue
    }
    const conversation = row(db, 'SELECT * FROM source_conversations WHERE conversation_id=?', scope.conversationId)!
    const chatId = scope.coreBinding.chatId, chat = row(db, 'SELECT messages_month FROM chats WHERE id=?', chatId)
    if (!chat || !/^\d{4}-\d{2}$/.test(chat.messages_month)) { reject('QUESTION_ASSOCIATION_UNPROVEN'); continue }
    const input = SourceInputSchema.parse({ kind: 'source_snapshot', requestId: job.requestId, turnId: snapshot.turnId ?? snapshot.requestId,
      scopeId: job.sourceScopeId, snapshotId: snapshot.snapshotId, actorRecord: snapshot.actorRecord, inputRecords: snapshot.inputRecords })
    const actor = row(db, 'SELECT data_json FROM source_records WHERE record_id=?', input.actorRecord.recordId)
    const actorData = actor && JSON.parse(actor.data_json)
    if (!actorData || actorData.sender.id !== job.input.senderId || conversation.self_id !== job.input.selfId ||
      conversation.conversation_type !== job.input.conversationType || conversation.target_id !== job.input.targetId) {
      report.conflicts.push({ requestId: job.requestId, reasonCode: 'QUESTION_IDENTITY_CONFLICT' }); continue
    }
    const task: Task = { runId: job.coreRunId, requestId: job.requestId, chatId, epochId: scope.coreBinding.epochId,
      permissionRevision: scope.permissionRevision, identity: { source: 'plugin', ownerId: conversation.owner_id, entryId: 'qq', channel: 'qq',
        subject: { selfId: job.input.selfId, userId: job.input.senderId, conversationType: job.input.conversationType,
          ...(job.input.conversationType === 'group' ? { groupId: job.input.targetId } : {}) } }, input, state: job.state, cancelWait: false }
    if (old) {
      const monthly = path.join(dbDirectory, `${chat.messages_month}.db`)
      if (!fs.existsSync(monthly)) { reject('QUESTION_ASSOCIATION_UNPROVEN'); continue }
      if (fs.existsSync(`${monthly}-wal`) && fs.statSync(`${monthly}-wal`).size > 0) throw new Error('CHECKPOINT_REQUIRED')
      monthlyHashes[monthly] = fileHash(monthly)
      const month = new Database(monthly, { readonly: true, fileMustExist: true })
      try {
        const batch = row(month, 'SELECT * FROM question_batches WHERE batch_id=? AND chat_id=?', old.batchId, chatId)
        const items = month.prepare('SELECT question_id,status FROM question_items WHERE batch_id=? ORDER BY position').all(old.batchId) as Json[]
        const core = row(db, 'SELECT * FROM execution_active_runs WHERE chat_id=? AND run_id=?', chatId, job.coreRunId)
        const owners = batch && (db.prepare('SELECT payload_json FROM execution_nodes WHERE source_chat_id=? AND source_message_id=?')
          .all(chatId, batch.assistant_message_id) as Array<{payload_json:string}>).map(owner => JSON.parse(owner.payload_json))
        if (!batch || old.runId !== job.coreRunId || !core || !owners?.some(owner => owner.runId === job.coreRunId) ||
          items.length !== old.items.length || items.some(item => !old.items.some((q: Json) => q.questionId === item.question_id))) {
          reject('QUESTION_ASSOCIATION_UNPROVEN'); continue
        }
        for (const item of old.items as Json[]) {
          const output = state.outbox.find((output: Json) => output.frame?.data?.eventId === item.eventId)
          if (output?.status === 'sent' && (!output.messageIds?.length || output.frame.data.requestId !== job.requestId))
            report.conflicts.push({ requestId: job.requestId, reasonCode: 'QUESTION_RECEIPT_CONFLICT' })
          if (output?.sourceDeliveryId) {
            const fact = row(db,'SELECT data_json FROM source_delivery_facts WHERE delivery_id=? ORDER BY revision DESC LIMIT 1',output.sourceDeliveryId)
            if (fact && JSON.parse(fact.data_json).status === 'sent' && output.status !== 'sent')
              report.conflicts.push({ requestId: job.requestId, reasonCode: 'QUESTION_RECEIPT_CONFLICT' })
          }
        }
        task.batch = { batchId: old.batchId, assistantId: batch.assistant_message_id, ids: items.map(item => item.question_id) }
        if (items.some(item => item.status === 'cancelled')) {
          if (items.some(item => item.status !== 'cancelled') || batch.status !== 'completed' ||
            !['waiting','paused','cancelled'].includes(core.status) || job.state !== 'paused' && job.state !== 'cancelled') {
            report.conflicts.push({ requestId: job.requestId, reasonCode: 'QUESTION_CANCEL_FACT_CONFLICT' }); continue
          }
          task.cancelWait = true; report.cancelledWaits++
          job.state = 'cancelled'; job.outcome = 'cancelled'; job.reason = 'QUESTION_CANCELLED'
        } else if (items.some(item => item.status === 'pending') && ['completed','failed'].includes(job.state) ||
          job.state === 'paused' && ['completed','failed'].includes(core.status)) {
          report.conflicts.push({ requestId: job.requestId, reasonCode: 'QUESTION_TERMINAL_FACT_CONFLICT' }); continue
        }
        report.bindings++
      } finally { month.close() }
    }
    if (job.outcome === 'completed') job.state = 'completed'
    if (!['completed','failed','cancelled'].includes(job.state)) {
      job.state = 'cancelled'; job.outcome = 'cancelled'; job.reason = 'BACKEND_STOPPED'
    }
    task.state = job.state; tasks.push(task)
  }
  // No sends are created; unknown deliveries remain unknown.
  for (const output of state.outbox) {
    if (output.status === 'inflight') output.status = 'unknown'
    else if (output.status === 'pending') output.status = 'failed'
  }
  state.schemaVersion = 3; state.nextQueueSequence = sequence + 1
  const validated = StateSchema.parse(state)
  report.tasks = tasks.length
  return { operationId, originalStateHash: hash(original), stateJson: JSON.stringify(validated), tasks, report, monthlyHashes }
}

function verifyBackup(manifestFile: string, roots: string[], allowChanged: Set<string>): void {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { files: Array<{originalPath:string;backupPath:string;sha256:string}> }
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('RECOVERY_BACKUP_INVALID')
  const files = new Map<string,string>()
  for (const item of manifest.files) {
    if (!path.isAbsolute(item.originalPath) || !path.isAbsolute(item.backupPath) || item.originalPath === item.backupPath ||
      files.has(item.originalPath) || !/^[a-f0-9]{64}$/.test(item.sha256) || fileHash(item.backupPath) !== item.sha256) throw new Error('RECOVERY_BACKUP_INVALID')
    files.set(item.originalPath, item.sha256)
  }
  const check = (file: string) => {
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink()) throw new Error('RECOVERY_BACKUP_INVALID')
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file)) check(path.join(file, name)); return }
    // After checkpoint, these SQLite coordination files contain no persistent rows.
    if (file.endsWith('.db-shm') || file.endsWith('.db-wal') && stat.size === 0) return
    if (!stat.isFile() || !allowChanged.has(file) && files.get(file) !== fileHash(file)) throw new Error('RECOVERY_BACKUP_INCOMPLETE')
  }
  for (const root of roots) check(root)
  for (const file of allowChanged) if (!files.has(file)) throw new Error('RECOVERY_BACKUP_INCOMPLETE')
}

/** Standalone stopped-process command: no config, runtime, model, or transport imports. */
export function runQuestionMaintenance(args: readonly string[]) {
  const options = new Map<string,string>(); let stopped = false
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!
    if (key === '--stopped' && !stopped) { stopped = true; continue }
    if (!['--db','--data-dir','--assets-dir','--recovery-manifest','--operation-id','--mode'].includes(key) || options.has(key)) throw new Error('INVALID_ARGUMENTS')
    const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS'); options.set(key,value)
  }
  if (!stopped) throw new Error('STOPPED_BACKEND_REQUIRED')
  const absolute = (key: string) => { const value = options.get(key); if (!value || !path.isAbsolute(value)) throw new Error('ABSOLUTE_PATH_REQUIRED'); return path.resolve(value) }
  const database = absolute('--db'), data = absolute('--data-dir'), stateFile = path.join(data, 'state.json')
  const operationId = options.get('--operation-id')
  if (!operationId || !/^[a-zA-Z0-9_-]{1,100}$/.test(operationId)) throw new Error('INVALID_OPERATION_ID')
  const mode = options.get('--mode') ?? 'dry-run'
  if (!['dry-run','apply'].includes(mode)) throw new Error('INVALID_ARGUMENTS')
  if (fs.existsSync(`${database}-wal`) && fs.statSync(`${database}-wal`).size > 0) throw new Error('CHECKPOINT_REQUIRED')
  const db = new Database(database, { readonly: mode === 'dry-run', fileMustExist: true })
  try {
    const saved = exists(db,'source_question_maintenance') ? row(db, 'SELECT * FROM source_question_maintenance WHERE operation_id=?', operationId) : undefined
    if (saved && saved.fingerprint !== hash(saved.plan_json)) throw new Error('MAINTENANCE_CONFLICT')
    const plan: Plan = saved ? JSON.parse(saved.plan_json) : prepare(db, stateFile, operationId, path.dirname(database))
    const currentHash = fileHash(stateFile), finalHash = hash(plan.stateJson)
    if (currentHash !== plan.originalStateHash && currentHash !== finalHash) throw new Error('MAINTENANCE_STATE_CONFLICT')
    for (const [file, expected] of Object.entries(plan.monthlyHashes)) if (fileHash(file) !== expected) throw new Error('MAINTENANCE_MONTH_CONFLICT')
    if (mode === 'dry-run' || plan.report.conflicts.length) return { ...plan.report, phase: saved?.phase ?? 'preview' }
    verifyBackup(absolute('--recovery-manifest'), [path.dirname(database), data, absolute('--assets-dir')],
      saved ? new Set([database, ...(currentHash === finalHash ? [stateFile] : [])]) : new Set())
    if (!saved) {
      db.exec('CREATE TABLE IF NOT EXISTS source_question_maintenance(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,plan_json TEXT NOT NULL,phase TEXT NOT NULL)')
      db.prepare("INSERT INTO source_question_maintenance VALUES (?,?,?,'prepared')").run(operationId, hash(JSON.stringify(plan)), JSON.stringify(plan))
    }
    if (!saved || saved.phase === 'prepared') db.transaction(() => {
      initSourceTaskTables(db)
      for (const task of plan.tasks) {
        if (row(db,'SELECT 1 FROM source_tasks WHERE run_id=?',task.runId)) throw new Error('MAINTENANCE_TASK_CONFLICT')
        db.prepare('INSERT INTO source_tasks VALUES (?,?,?,?,?,?,?,?,?)').run(task.runId, task.requestId, task.chatId, task.epochId,
          task.permissionRevision, JSON.stringify(task.identity), JSON.stringify(task.input), `maintenance:${operationId}`, task.state)
        if (task.batch) db.prepare('INSERT INTO source_question_bindings VALUES (?,?,?,?)')
          .run(task.batch.batchId, task.runId, task.batch.assistantId, JSON.stringify(task.batch.ids))
        if (task.cancelWait) {
          const changed = db.prepare("UPDATE execution_active_runs SET status='cancelled' WHERE chat_id=? AND run_id=? AND status IN ('waiting','paused','cancelled')")
            .run(task.chatId,task.runId)
          if (changed.changes !== 1) throw new Error('QUESTION_CANCEL_FACT_CONFLICT')
          if (exists(db,'interactions')) db.prepare("UPDATE interactions SET status='cancelled',revision=revision+1 WHERE interaction_id=? AND chat_id=? AND status IN ('pending','resolving','blocked')")
            .run(task.batch!.batchId,task.chatId)
        }
      }
      db.prepare("UPDATE source_question_maintenance SET phase='database' WHERE operation_id=?").run(operationId)
    })()
    if (currentHash !== finalHash) {
      const temporary = `${stateFile}.${operationId}.tmp`
      const fd = fs.openSync(temporary,'w',0o600)
      try {
        try { fs.writeFileSync(fd,plan.stateJson); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
        fs.renameSync(temporary,stateFile)
      } catch (error) { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); throw error }
      const directory = fs.openSync(data,'r'); try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    }
    db.prepare("UPDATE source_question_maintenance SET phase='completed' WHERE operation_id=?").run(operationId)
    return { ...plan.report, phase: 'completed' }
  } finally { db.close() }
}
