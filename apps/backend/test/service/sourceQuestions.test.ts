import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { sourceFixture } from '../helpers/sourceContext.js'
import { initSourceTaskTables, registerSourceTask, bindSourceQuestions, sourceTaskSessionId, getSourceTask,
  getSourceAnswerCommand, setSourceTaskState } from '@/db/sourceTasks.js'
import { saveSourceQuestions, sourceQuestionStatus, resumeSourceQuestions } from '@/service/ingress/sourceQuestions.js'

let db: Database.Database
const facts = new Map<string, Array<{ questionId: string; status: string; answerText?: string }>>()
const interactions = new Map<string, object>()
let busy = false, failSave = false
vi.mock('@/db/index.js', () => ({ getSoulDb: () => db }))
vi.mock('@/db/chat.js', () => ({ getChat: () => ({ active_epoch_id: 'epoch' }) }))
vi.mock('@/db/interaction.js', () => ({ getInteraction: (id: string) => interactions.get(id) }))
vi.mock('@/db/question.js', () => ({ questionBatchFacts: (_: string, id: string) => facts.get(id) ?? [] }))
vi.mock('@/service/chat/wake.js', () => ({ resolveQuestionBatch: vi.fn(async (_: string, id: string, answers: any[]) => {
  facts.set(id, answers.map(answer => ({ questionId: answer.questionId, status: 'answered', answerText: `用户回答: 其他: ${answer.freeText.trim()}` })))
  if (failSave) { failSave = false; throw new Error('synthetic main-store interruption') }
}) }))
vi.mock('@/service/chat/sourceQuestionRun.js', () => ({ launchSourceQuestionRun: vi.fn(async (_ctx, _chatId, _runId, _meta, claim) => {
  if (busy) return false
  claim(); return true
}) }))
import { launchSourceQuestionRun } from '@/service/chat/sourceQuestionRun.js'

beforeEach(() => { busy = false; failSave = false; facts.clear(); interactions.clear(); vi.clearAllMocks() })
afterEach(() => db?.close())
function fixture() {
  const f = sourceFixture(); db = f.db; initSourceTaskTables(db)
  f.repo.bindCore(f.authority, f.scope.scopeId, { chatId: 'chat', epochId: 'epoch' })
  const identity = { source: 'plugin' as const, ownerId: 'qq-fixture', entryId: 'qq', channel: 'qq',
    subject: { selfId: '100', userId: '123', conversationType: 'group' as const, groupId: '999' } }
  function task(name: string, count = 1) {
    const started = f.start(name, `run-${name}`)
    const sourceInput = { kind: 'source_snapshot' as const, requestId: name, turnId: name, scopeId: f.scope.scopeId,
      snapshotId: started.snapshot.snapshotId, actorRecord: started.snapshot.actorRecord!, inputRecords: started.snapshot.inputRecords }
    registerSourceTask({ runId: started.runId, requestId: name, chatId: 'chat', epochId: 'epoch', permissionRevision: f.scope.permissionRevision,
      sessionId: sourceTaskSessionId, input: sourceInput, identity, state: 'waiting' })
    const batchId = `batch-${name}`, ids = Array.from({ length: count }, (_, n) => `question-${name}-${n}`)
    bindSourceQuestions(started.runId, batchId, ids, `ask-${name}`)
    interactions.set(batchId, { chatId: 'chat', kind: 'question_batch', status: 'pending' })
    facts.set(batchId, ids.map(questionId => ({ questionId, status: 'pending' })))
    f.repo.saveRunMessage(f.authority, f.scope.scopeId, started.runId, { id: `ask-${name}`, role: 'assistant', content: '',
      createdAt: 1, updateAt: 1, senseCalls: ids.map(id => ({ id, name: 'ask_user_question', arguments: '{}' })) }, 'completed')
    for (const id of ids) f.repo.saveRunMessage(f.authority, f.scope.scopeId, started.runId,
      { id, role: 'sense', content: '(等待用户回答…)', createdAt: 1, updateAt: 1 }, 'planned')
    const records = ids.map(questionId => ({ questionId, record: f.receive(`answer-${questionId}`, {
      handling: { kind: 'question_answer', requestId: name, runId: started.runId, batchId, questionId } }).record }))
    const input = { entryId: 'qq', runId: started.runId, batchId, commandId: randomUUID(), requestIdentity: identity,
      validateIdentity: f.authority.validate, sourceAnswers: { snapshotId: started.snapshot.snapshotId, records },
      answers: ids.map(questionId => ({ questionId, selectedLabels: [], freeText: `answer-${questionId}` })) }
    return { ...started, input, ids, batchId }
  }
  return { f, task }
}
describe('request-owned saved answers and explicit startup', () => {
  it('saves A without running or changing B, then resumes only A after B releases', async () => {
    const { task } = fixture(), a = task('A'), b = task('B')
    setSourceTaskState(b.runId, 'running'); busy = true
    expect(await saveSourceQuestions('qq-fixture', 'chat', a.input)).toMatchObject({ status: 'saved', canQueue: true, runId: a.runId })
    expect(launchSourceQuestionRun).not.toHaveBeenCalled()
    expect(getSourceTask(b.runId)?.state).toBe('running')
    expect(await resumeSourceQuestions('qq-fixture', 'chat', a.input)).toMatchObject({ status: 'saved', reasonCode: 'PREVIOUS_WORK_PENDING' })
    expect(getSourceAnswerCommand(a.input.commandId)?.state).toBe('saved')
    busy = false
    expect(await resumeSourceQuestions('qq-fixture', 'chat', a.input)).toMatchObject({ status: 'started', runId: a.runId })
    const calls = vi.mocked(launchSourceQuestionRun).mock.calls
    expect(calls.at(-1)?.[3]).toMatchObject({ requestId: a.runId, requestIdentity: a.input.requestIdentity,
      requestExecution: { sourceInput: { requestId: 'A' } } })
    await resumeSourceQuestions('qq-fixture', 'chat', a.input)
    expect(launchSourceQuestionRun).toHaveBeenCalledTimes(2) // busy + the only admitted run
    expect(getSourceTask(b.runId)?.state).toBe('running')
  })
  it('repairs a partial save under the same fingerprint without claiming startup', async () => {
    const { task } = fixture(), a = task('A', 2)
    failSave = true
    await expect(saveSourceQuestions('qq-fixture', 'chat', a.input)).rejects.toThrow('interruption')
    expect(sourceQuestionStatus('qq-fixture', 'chat', a.input)).toMatchObject({ status: 'saving', canQueue: false })
    await expect(saveSourceQuestions('qq-fixture', 'chat', a.input)).resolves.toMatchObject({ status: 'saved', canQueue: true })
    await expect(saveSourceQuestions('qq-fixture', 'chat', { ...a.input, answers: a.input.answers.map(answer => ({ ...answer, freeText: 'changed' })) })).rejects.toThrow('SOURCE_CONFLICT')
    expect(launchSourceQuestionRun).not.toHaveBeenCalled()
  })
  it('rejects other members, targets and unknown tool results without relaxing authority', async () => {
    const { task, f } = fixture(), a = task('A')
    for (const subject of [{ ...a.input.requestIdentity.subject, userId: '456' }, { ...a.input.requestIdentity.subject, groupId: '998' }])
      await expect(saveSourceQuestions('qq-fixture', 'chat', { ...a.input, requestIdentity: { ...a.input.requestIdentity, subject } })).rejects.toThrow('IDENTITY_REJECTED')
    await saveSourceQuestions('qq-fixture', 'chat', a.input)
    db.prepare("UPDATE source_run_messages SET state='unknown' WHERE run_id=?").run(a.runId)
    await expect(resumeSourceQuestions('qq-fixture', 'chat', a.input)).rejects.toThrow('SOURCE_TOOL_OUTCOME_UNKNOWN')
    expect(getSourceAnswerCommand(a.input.commandId)?.state).toBe('saved')
    f.revoke()
    await expect(resumeSourceQuestions('qq-fixture', 'chat', a.input)).rejects.toThrow('PERMISSION_DENIED')
  })
  it('does not revive cancelled or previous-process tasks', async () => {
    const { task } = fixture(), a = task('A')
    await saveSourceQuestions('qq-fixture', 'chat', a.input)
    db.prepare('UPDATE source_tasks SET session_id=? WHERE run_id=?').run('old-process', a.runId)
    expect(await resumeSourceQuestions('qq-fixture', 'chat', a.input)).toMatchObject({ status: 'cancelled', canQueue: false })
    expect(launchSourceQuestionRun).not.toHaveBeenCalled()
  })
})
