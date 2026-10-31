import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { sourceFixture } from '../helpers/sourceContext.js'
import { emptyState, readState } from '../../../../plugins/qq/src/state.js'
import { QQDefaultConfig } from '@chery/protocol'
import { runQuestionMaintenance } from '@/service/ingress/questionMaintenance.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root,{ recursive:true,force:true }) })
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function fixture(status = 'cancelled') {
  const root = fs.mkdtempSync('/tmp/opencode/question-maintenance-'); roots.push(root)
  const data = path.join(root,'qq'), databaseDir = path.join(root,'db'), assets = path.join(root,'assets'), backup = path.join(root,'backup')
  for (const directory of [data,databaseDir,assets,backup]) fs.mkdirSync(directory)
  const f = sourceFixture(), start = f.start('request-a','run-a')
  f.repo.bindCore(f.authority,f.scope.scopeId,{chatId:'chat',epochId:'epoch'})
  f.db.exec(`CREATE TABLE chats(id TEXT PRIMARY KEY,messages_month TEXT);
    INSERT INTO chats VALUES ('chat','2026-10');
    CREATE TABLE execution_active_runs(chat_id TEXT,run_id TEXT,status TEXT);
    INSERT INTO execution_active_runs VALUES ('chat','run-a','waiting'),('chat','run-b','completed');
    CREATE TABLE execution_nodes(source_chat_id TEXT,source_message_id TEXT,payload_json TEXT);
    INSERT INTO execution_nodes VALUES ('chat','assistant-a','{"runId":"run-a"}');`)
  const database = path.join(databaseDir,'soul.db'); fs.writeFileSync(database,f.db.serialize()); f.db.close()
  const month = new Database(path.join(databaseDir,'2026-10.db'))
  month.exec(`CREATE TABLE question_batches(batch_id TEXT,chat_id TEXT,assistant_message_id TEXT,status TEXT);
    INSERT INTO question_batches VALUES ('batch-a','chat','assistant-a','completed');
    CREATE TABLE question_items(batch_id TEXT,question_id TEXT,status TEXT,position INTEGER);`)
  month.prepare('INSERT INTO question_items VALUES (?,?,?,0)').run('batch-a','question-a',status); month.close()
  const input = { eventId:'qq:100:group:999:1',selfId:'100',senderId:'123',targetId:'999',conversationType:'group',messageId:'1',
    content:'private task',mentionedBot:true,occurredAt:1,sourceParts:[{partId:'p0',type:'text',text:'private task'}] }
  const stateFile = path.join(data,'state.json'), base = emptyState() as Record<string,any>
  delete base.nextQueueSequence
  fs.writeFileSync(stateFile,JSON.stringify({ ...base,schemaVersion:2,jobs:[{requestId:'request-a',coreRunId:'run-a',coreRequestId:'run-a',
    conversationKey:'conversation',sourceScopeId:f.scope.scopeId,sourceSnapshot:start.snapshot,input,target:'group:999',
    snapshot:{revision:1,config:QQDefaultConfig,preset:'p',presetId:'preset-1',brain:'b',senseGroup:'s'},
    state:'paused',reason:'WAITING_FOR_ANSWER',acceptedAt:1,reply:'',toolIds:[],waits:0,
    questions:{batchId:'batch-a',runId:'run-a',items:[{questionId:'question-a',question:'private question',options:[],multiSelect:false,eventId:'out-a'}],replies:[]}}] }))
  fs.writeFileSync(path.join(assets,'preserved'),'asset contents')
  const files: any[] = []
  for (const directory of [data,databaseDir,assets]) for (const name of fs.readdirSync(directory)) {
    const originalPath = path.join(directory,name), backupPath=path.join(backup,`${files.length}.backup`)
    fs.copyFileSync(originalPath,backupPath); files.push({ originalPath,backupPath,sha256:sha(backupPath) })
  }
  const manifest = path.join(backup,'manifest.json'); fs.writeFileSync(manifest,JSON.stringify({files}))
  const args=['--db',database,'--data-dir',data,'--assets-dir',assets,'--operation-id','verify-a','--stopped']
  return {database,stateFile,args,manifest,files,apply:()=>runQuestionMaintenance([...args,'--mode','apply','--recovery-manifest',manifest])}
}
it('previews read-only, verifies backup, and cancels only the proven old wait without execution', () => {
  const f=fixture(), hashes=[sha(f.database),sha(f.stateFile)]
  expect(runQuestionMaintenance(f.args)).toMatchObject({tasks:1,bindings:1,cancelledWaits:1,conflicts:[],phase:'preview'})
  expect([sha(f.database),sha(f.stateFile)]).toEqual(hashes)
  expect(f.apply()).toMatchObject({phase:'completed',cancelledWaits:1})
  const state=readState(f.stateFile), db=new Database(f.database)
  expect(state.schemaVersion).toBe(3); expect(state.jobs[0]).toMatchObject({state:'cancelled',reason:'QUESTION_CANCELLED',queueSequence:1})
  expect(state.outbox).toHaveLength(0)
  expect(db.prepare('SELECT run_id,status FROM execution_active_runs ORDER BY run_id').all()).toEqual([
    {run_id:'run-a',status:'cancelled'}, {run_id:'run-b',status:'completed'}])
  expect(db.prepare('SELECT state FROM source_tasks').get()).toEqual({state:'cancelled'})
  expect(db.prepare('SELECT count(*) AS n FROM source_answer_commands').get()).toEqual({n:0}); db.close()
  expect(f.apply().phase).toBe('completed')
  for (const file of f.files) expect(sha(file.backupPath)).toBe(file.sha256)
  expect(JSON.stringify(runQuestionMaintenance(f.args))).not.toContain('private')
})
it('resumes the same operation after database commit and failed state publication', () => {
  const f=fixture(), rename=fs.renameSync
  vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw new Error('controlled publication interruption')})
  expect(f.apply).toThrow('controlled publication interruption')
  expect(JSON.parse(fs.readFileSync(f.stateFile,'utf8')).schemaVersion).toBe(2)
  vi.mocked(fs.renameSync).mockImplementation(rename)
  expect(f.apply().phase).toBe('completed')
  expect(readState(f.stateFile).jobs[0]?.state).toBe('cancelled')
})
it('refuses incomplete backup without changing state', () => {
  const f=fixture()
  const manifest=JSON.parse(fs.readFileSync(f.manifest,'utf8')); manifest.files.pop();fs.writeFileSync(f.manifest,JSON.stringify(manifest))
  expect(f.apply).toThrow('RECOVERY_BACKUP_INCOMPLETE')
  expect(JSON.parse(fs.readFileSync(f.stateFile,'utf8')).schemaVersion).toBe(2)
})
it('blocks contradictory cancellation instead of rewriting a completed run', () => {
  const f=fixture(), db=new Database(f.database)
  db.prepare("UPDATE execution_active_runs SET status='completed' WHERE run_id='run-a'").run(); db.close()
  expect(f.apply()).toMatchObject({phase:'preview',conflicts:[{requestId:'request-a',reasonCode:'QUESTION_CANCEL_FACT_CONFLICT'}]})
  expect(JSON.parse(fs.readFileSync(f.stateFile,'utf8')).schemaVersion).toBe(2)
})
it('requires explicit stopped state and rejects normal version-2 loading', () => {
  const f=fixture()
  expect(()=>runQuestionMaintenance(f.args.filter(value=>value!=='--stopped'))).toThrow('STOPPED_BACKEND_REQUIRED')
  expect(()=>readState(f.stateFile)).toThrow('question maintenance')
})
