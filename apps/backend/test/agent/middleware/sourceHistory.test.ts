import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceFixture } from '../../helpers/sourceContext.js'
import type { SourceInput } from '@chery/protocol'
import type { LLMResponse } from '@/core/message/adapter.js'
import type { MiddlewareContext } from '@/core/middleware/types.js'

let database: Database.Database
vi.mock('@/db/index.js',()=>({getSoulDb:()=>database}))
vi.mock('@/service/media/store.js',()=>({getAssetStore:vi.fn()}))
import { prepareSourceHistory } from '@/agent/middleware/sourceHistory.js'

afterEach(()=>database?.close())
function context(input: SourceInput): MiddlewareContext {
  return {requestExecution:{sourceInput:input,validate(){}},requestView:{identity:{source:'plugin',ownerId:'qq-fixture',channel:'qq',
    subject:{selfId:'100',userId:'123',conversationType:'group',groupId:'999'}},tools:[]}} as unknown as MiddlewareContext
}
const message=(id:string,role:LLMResponse['role'],content:string):LLMResponse=>({id,role,content,createdAt:1,updateAt:1})
describe('source history replaces display copies and preserves question outcomes',()=>{
  it('renders an answered question only in its checkpoint tool result, never as another user text',()=>{
    const f=sourceFixture();database=f.db
    const initial=f.start(),answer=f.receive('独一份答案',{handling:{kind:'question_answer',requestId:initial.requestId,runId:initial.runId,batchId:'batch',questionId:'question'}})
    const child=f.repo.answerSnapshot(f.authority,{parentSnapshotId:initial.snapshot.snapshotId,commandId:'command',runId:initial.runId,batchId:'batch',
      answers:[{questionId:'question',record:answer.record,text:'独一份答案'}]})
    const sourceInput={...child.sourceInput,snapshotId:initial.snapshot.snapshotId,turnId:initial.requestId}
    const history=[message('system','system','rules'),message('old','assistant','old duplicate discussion'),
      {...message('anchor','user','display copy must not be sent'),sourceInput},message('question','sense','独一份答案')]
    f.repo.saveRunMessage(f.authority, f.scope.scopeId, initial.runId,
      { ...message('ask', 'assistant', ''), senseCalls: [{ id: 'question', name: 'ask_user_question', arguments: '{}' }] }, 'completed')
    f.repo.saveRunMessage(f.authority, f.scope.scopeId, initial.runId, history.at(-1)!, 'completed')
    const prepared=prepareSourceHistory(context(child.sourceInput),history)
    expect(prepared.source?.snapshot.snapshotId).toBe(child.snapshot.snapshotId)
    const text=prepared.history.map(message=>message.content).join('\n')
    expect(text.match(/独一份答案/g)).toHaveLength(1)
    expect(text).not.toContain('display copy');expect(text).not.toContain('old duplicate')
    expect(text).toContain('tool_result_reference')
    expect(prepared.history.at(-1)).toEqual(history.at(-1))
    // Display copies and another task's trailing tools are never execution evidence.
    expect(prepareSourceHistory(context(child.sourceInput), history.slice(0,-1)).history).toEqual(prepared.history)
    expect(prepareSourceHistory(context(child.sourceInput), [...history,message('question','sense','duplicate')]).history).toEqual(prepared.history)
    database.prepare("UPDATE source_run_messages SET state='unknown' WHERE message_id='question'").run()
    expect(()=>prepareSourceHistory(context(child.sourceInput),history)).toThrow('SOURCE_TOOL_OUTCOME_UNKNOWN')
  })
  it('explains summary overlap when an earlier summarized message is explicitly quoted',()=>{
    const f=sourceFixture();database=f.db
    const old=f.receive('以前讨论过的方案')
    const auth=f.repo.maintenanceAuthority(f.authority,f.scope.scopeId)
    f.repo.prepareMaintenanceSummary(auth,f.scope.scopeId,{operationId:'sum-op',purpose:'discussion',qqConfigRevision:1})
    f.repo.commitSummary(auth,f.scope.scopeId,{operationId:'sum-op',text:'摘要了以前的方案',prerequisiteReceipt:'ok'},()=>true)
    const cur=f.receive([{type:'reply',partId:'p0',platformMessageId:'1'},{type:'text',partId:'p1',text:'再确认下这条原文'}],{handling:{kind:'queued',requestId:'req-quote'}})
    const snap=f.repo.freeze(f.authority,f.scope.scopeId,{requestId:'req-quote',actorRecord:cur.record,inputRecords:[cur.record],
      expectedSelectionRevision:f.repo.scope(f.authority,f.scope.scopeId).selectionRevision,
      policy:{historyLimit:10,backgroundMaxAgeMs:100000,backgroundMaxChars:100000,qqConfigRevision:1}})
    f.repo.ensureRun(f.authority,f.scope.scopeId,'req-quote','run-quote')
    const sourceInput: SourceInput={kind:'source_snapshot',requestId:'req-quote',turnId:'req-quote',scopeId:f.scope.scopeId,snapshotId:snap.snapshotId,actorRecord:cur.record,inputRecords:[cur.record]}
    const prepared=prepareSourceHistory(context(sourceInput),[message('system','system','rules'),{...message('anchor','user','display'),sourceInput}])
    const rendered=prepared.history.map(m=>m.content).join('\n')
    expect(rendered).toContain('此消息已包含在较早摘要中，本次因明确引用提供原文。')
    expect(rendered).toContain('以前讨论过的方案')
  })
})
