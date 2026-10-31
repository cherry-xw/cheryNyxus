import { describe, expect, it } from 'vitest'
import { sourceFixture } from '../helpers/sourceContext.js'

describe('source-backed question continuation', () => {
  it('keeps the parent immutable, uses a new user turn and references the existing answer tool exactly once', () => {
    const f=sourceFixture()
    try {
      const initial=f.start(),before=JSON.stringify(initial.snapshot)
      const answer=f.receive('答案原文',{handling:{kind:'question_answer',requestId:initial.requestId,runId:initial.runId,batchId:'batch',questionId:'question'}})
      const input={parentSnapshotId:initial.snapshot.snapshotId,commandId:'answer-command',runId:initial.runId,batchId:'batch',
        answers:[{questionId:'question',record:answer.record,text:'答案原文'}]}
      const child=f.repo.answerSnapshot(f.authority,input)
      expect(child.sourceInput.turnId).toBe('answer-command')
      expect(child.sourceInput.requestId).toBe(initial.requestId)
      expect(child.sourceInput.actorRecord).toEqual(initial.snapshot.actorRecord)
      expect(child.snapshot.parentSnapshotId).toBe(initial.snapshot.snapshotId)
      expect(child.snapshot.orderedItems.filter(item=>item.type==='message'&&item.recordId===answer.record.recordId)).toEqual([
        {type:'message',...answer.record,selectionReasons:['current'],parts:[{partId:'p0',mode:'tool_result_reference',toolMessageId:'question'}]},
      ])
      expect(JSON.stringify(f.repo.snapshot(f.authority,f.scope.scopeId,initial.snapshot.snapshotId))).toBe(before)
      expect(f.repo.answerSnapshot(f.authority,input)).toEqual(child)
      expect(()=>f.repo.answerSnapshot(f.authority,{...input,answers:[{...input.answers[0]!,text:'changed'}]})).toThrow('SOURCE_CONFLICT')
    } finally { f.db.close() }
  })
  it('requires completed receipt, exact original text and the original member/run/question pairing', () => {
    const f=sourceFixture()
    try {
      const initial=f.start(),answer=f.receive('answer',{pending:true})
      const input={parentSnapshotId:initial.snapshot.snapshotId,commandId:'command',runId:initial.runId,batchId:'batch',
        answers:[{questionId:'question',record:answer.record,text:'answer'}]}
      expect(()=>f.repo.answerSnapshot(f.authority,input)).toThrow('PERMISSION_DENIED')
      answer.complete({kind:'question_answer',requestId:initial.requestId,runId:initial.runId,batchId:'batch',questionId:'question'})
      for (const value of [{...input,runId:'wrong-run'}, {...input,batchId:'wrong-batch'},
        {...input,answers:[{...input.answers[0]!,questionId:'wrong-question'}]}, {...input,answers:[{...input.answers[0]!,text:'not original'}]}])
        expect(()=>f.repo.answerSnapshot(f.authority,value)).toThrow('PERMISSION_DENIED')
      expect(()=>f.repo.answerSnapshot({...f.authority,actorId:'456'},input)).toThrow('PERMISSION_DENIED')
      expect(f.repo.answerSnapshot(f.authority,input).snapshot.turnId).toBe('command')
      f.revoke()
      expect(()=>f.repo.answerSnapshot(f.authority,input)).toThrow('PERMISSION_DENIED')
    } finally { f.db.close() }
  })
})
