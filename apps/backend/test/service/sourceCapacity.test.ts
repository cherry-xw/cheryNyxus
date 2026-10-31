import { describe, expect, it } from 'vitest'
import { sourceFixture } from '../helpers/sourceContext.js'

describe('source capacity summaries retain the fixed request selection', () => {
  it('creates an immutable child, keeps current input and unread attachments, and excludes later arrivals', () => {
    const f=sourceFixture()
    try {
      const old=f.receive([{type:'text',partId:'p0',text:'旧文字'.repeat(1000)},
        {type:'attachment',partId:'p1',attachmentId:'unread-attachment'}],{attachments:[{partId:'p1',mediaKind:'image',originalName:'unread.png'}]})
      const request=f.start(),before=JSON.stringify(request.snapshot),late=f.receive('后来入站')
      const auth=f.repo.maintenanceAuthority(f.authority,f.scope.scopeId)
      const prepared=f.repo.prepareMaintenanceSummary(auth,f.scope.scopeId,{operationId:'capacity-op',purpose:'capacity',qqConfigRevision:1,
        parentSnapshotId:request.snapshot.snapshotId})
      expect(prepared.records.map(record=>record.recordId)).toEqual([old.record.recordId])
      expect(prepared.operation.evidence[0].textPartIds).toEqual(['p0'])
      const summary=f.repo.commitSummary(auth,f.scope.scopeId,{operationId:'capacity-op',text:'旧资料摘要',prerequisiteReceipt:'receipt'},()=>true)
      const child=f.repo.capacitySnapshot(f.authority,f.scope.scopeId,request.snapshot.snapshotId,'capacity-op')
      expect(child.parentSnapshotId).toBe(request.snapshot.snapshotId)
      expect(child.throughIngestOrdinal).toBe(request.snapshot.throughIngestOrdinal)
      expect(child.inputRecords).toEqual(request.snapshot.inputRecords)
      expect(child.actorRecord).toEqual(request.snapshot.actorRecord)
      expect(child.orderedItems).toContainEqual({type:'summary',summaryId:summary.summaryId,revision:summary.revision})
      expect(child.orderedItems.find(item=>item.type==='message'&&item.recordId===old.record.recordId)).toMatchObject({parts:[
        {partId:'p0',mode:'summary_reference',summaryId:summary.summaryId},{partId:'p1',mode:'expand'},
      ]})
      expect(child.orderedItems.find(item=>item.type==='message'&&item.recordId===request.snapshot.actorRecord!.recordId)).toEqual(
        request.snapshot.orderedItems.find(item=>item.type==='message'&&item.recordId===request.snapshot.actorRecord!.recordId))
      expect(JSON.stringify(child)).not.toContain(late.record.recordId)
      expect(JSON.stringify(f.repo.snapshot(f.authority,f.scope.scopeId,request.snapshot.snapshotId))).toBe(before)
      expect(f.repo.capacitySnapshot(f.authority,f.scope.scopeId,request.snapshot.snapshotId,'capacity-op')).toEqual(child)
      // Capacity summary only replaces the scope's active summary head when the rebuilt request actually enters model invocation.
      expect(f.repo.summary(f.authority,f.scope.scopeId)).toBeUndefined()
      expect(f.repo.summaryStatus(auth,f.scope.scopeId,'capacity-op')).toMatchObject({status:'running',phase:'commit',summaryId:summary.summaryId})
      const textRef=f.repo.saveRenderedText(f.authority,f.scope.scopeId,summary.text)
      const projection=f.repo.saveProjection(f.authority,f.scope.scopeId,{projectionId:'proj-cap-1',modelStepId:'step-1',snapshotId:child.snapshotId,
        runtimeConfigRevision:'rev-1',registryVersion:1,model:'test-model',protocol:'mock',toolNames:[],fileInputs:[],dataContextRefs:[],executionFactRefs:[],toolHistoryRefs:[],
        orderedInputManifest:[{itemId:'item-1',sourceRef:{kind:'summary',summaryId:summary.summaryId,revision:summary.revision},position:{messageIndex:0,blockIndex:0},representation:'text',renderedTextRef:textRef}],
        contentFingerprint:'a'.repeat(64)},'initial')
      const attempt=f.repo.prepareAttempt(f.authority,f.scope.scopeId,projection.projectionId,'att-cap-1')
      expect(f.repo.summary(f.authority,f.scope.scopeId)).toBeUndefined()
      f.repo.invokeAttempt(f.authority,f.scope.scopeId,attempt.attemptId,request.requestId)
      expect(f.repo.summary(f.authority,f.scope.scopeId)?.summaryId).toBe(summary.summaryId)
      expect(f.repo.summaryStatus(auth,f.scope.scopeId,'capacity-op')).toMatchObject({status:'completed',phase:'commit',summaryId:summary.summaryId})
      const answer=f.receive('问题答案',{handling:{kind:'question_answer',requestId:request.requestId,runId:request.runId,batchId:'batch-1',questionId:'q-1'}})
      const answerSnap=f.repo.answerSnapshot(f.authority,{parentSnapshotId:request.snapshot.snapshotId,commandId:'cmd-1',runId:request.runId,batchId:'batch-1',
        answers:[{questionId:'q-1',record:answer.record,text:'问题答案'}]})
      expect(answerSnap.snapshot.parentSnapshotId).toBe(child.snapshotId)
      expect(answerSnap.snapshot.orderedItems).toContainEqual({type:'summary',summaryId:summary.summaryId,revision:summary.revision})
    } finally {f.db.close()}
  })
  it('does not compact explicit quotes, borrow a different summary, or use another member authority', () => {
    const f=sourceFixture()
    try {
      const quoted=f.receive('必须明确引用的原文')
      const old=f.receive('其他旧文字')
      const current=f.receive([{type:'reply',partId:'p0',platformMessageId:'1'},{type:'text',partId:'p1',text:'本次输入'}],{handling:{kind:'queued',requestId:'request'}})
      const request=f.start('request','run',current.record),auth=f.repo.maintenanceAuthority(f.authority,f.scope.scopeId)
      const prepared=f.repo.prepareMaintenanceSummary(auth,f.scope.scopeId,{operationId:'capacity-op',purpose:'capacity',qqConfigRevision:1,parentSnapshotId:request.snapshot.snapshotId})
      expect(prepared.records.map(record=>record.recordId)).toEqual([old.record.recordId])
      expect(()=>f.repo.capacitySnapshot(f.authority,f.scope.scopeId,request.snapshot.snapshotId,'capacity-op')).toThrow('SUMMARY_CONFLICT')
      f.repo.commitSummary(auth,f.scope.scopeId,{operationId:'capacity-op',text:'摘要',prerequisiteReceipt:'receipt'},()=>true)
      expect(()=>f.repo.capacitySnapshot({...f.authority,actorId:'456'},f.scope.scopeId,request.snapshot.snapshotId,'capacity-op')).toThrow('PERMISSION_DENIED')
      const child=f.repo.capacitySnapshot(f.authority,f.scope.scopeId,request.snapshot.snapshotId,'capacity-op')
      expect(child.orderedItems.find(item=>item.type==='message'&&item.recordId===quoted.record.recordId)).toEqual(
        request.snapshot.orderedItems.find(item=>item.type==='message'&&item.recordId===quoted.record.recordId))
      expect(()=>f.repo.prepareMaintenanceSummary(auth,f.scope.scopeId,{operationId:'capacity-op',purpose:'capacity',qqConfigRevision:1,parentSnapshotId:'wrong'})).toThrow('SOURCE_CONFLICT')
      f.revoke()
      expect(()=>f.repo.capacitySnapshot(f.authority,f.scope.scopeId,request.snapshot.snapshotId,'capacity-op')).toThrow('PERMISSION_DENIED')
    } finally {f.db.close()}
  })
})
