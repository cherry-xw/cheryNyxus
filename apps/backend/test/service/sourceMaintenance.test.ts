import { describe, expect, it } from 'vitest'
import { sourceFixture } from '../helpers/sourceContext.js'
import { sourceMaintenanceCall } from '@/service/ingress/sourceMaintenanceCall.js'
import { trackTextInput } from '@/core/message/inputOrigins.js'
import type { SourceModelProjection } from '@chery/protocol'

function fixture() {
  const f = sourceFixture()
  f.receive('需要保留的来源文字')
  const auth = f.repo.maintenanceAuthority(f.authority, f.scope.scopeId)
  const prepared = f.repo.prepareMaintenanceSummary(auth, f.scope.scopeId, { operationId: 'summary-op', purpose: 'discussion', qqConfigRevision: 1 })
  const content = '固定来源片段😀'
  const input = { scopeId: f.scope.scopeId, operationId: prepared.operation.operationId, contentMessageId: 'maintenance-content',
    content, runtimeConfigRevision: 'runtime-revision', registryVersion: 1 }
  const wire = trackTextInput({ role: 'user', content }, { id: input.contentMessageId, role: 'user', content, createdAt: 1, updateAt: 1 })
  const body = { model: 'offline-model', messages: [{ role: 'system', content: '只整理，不执行' }, wire], tools: [] }
  return { ...f, auth, prepared, input, body }
}
const attempt = (f: ReturnType<typeof fixture>) => JSON.parse((f.db.prepare('SELECT data_json FROM source_attempts').get() as {data_json:string}).data_json)

describe('fixed QQ source maintenance without a member execution identity', () => {
  it('records the final maintenance input and call outcome without creating runs or advancing user adoption', () => {
    const f = fixture()
    try {
      expect(f.auth.actorId).toBeUndefined()
      const call = sourceMaintenanceCall(f.repo, f.auth, f.input)
      call.sourceCall!.prepare(f.body, 'openai-chat-completions')
      expect(attempt(f).state).toBe('prepared')
      call.observation!.start('offline-model');call.observation!.start('offline-model')
      expect(attempt(f).state).toBe('invoking')
      call.observation!.response({ usage: { prompt_tokens: 21, completion_tokens: 4, total_tokens: 25 } })
      call.observation!.finish('completed')
      expect(attempt(f)).toMatchObject({state:'responded',outcomeKnown:true,usage:{inputTokens:21,outputTokens:4,totalTokens:25}})
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_turns').get()).toEqual({n:0})
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_runs').get()).toEqual({n:0})
      const projection = JSON.parse((f.db.prepare('SELECT data_json FROM source_projections').get() as {data_json:string}).data_json) as SourceModelProjection
      expect(projection.fileInputs).toEqual([])
      expect(projection.orderedInputManifest).toMatchObject([{sourceRef:{kind:'data'},position:{messageIndex:1,blockIndex:0},representation:'text'}])
      expect(projection.dataContextRefs[0].kind).toBe('memory')
      expect(JSON.stringify(f.body)).not.toContain('maintenance-content')
    } finally { f.db.close() }
  })
  it('rejects missing final input mappings or business tools and leaves no partial projection', () => {
    const f = fixture()
    try {
      const call=sourceMaintenanceCall(f.repo,f.auth,f.input)
      expect(()=>call.sourceCall!.prepare({...f.body,messages:[{role:'user',content:f.input.content}]},'openai-chat-completions')).toThrow('SOURCE_INPUT_MAPPING_UNAVAILABLE')
      expect(()=>call.sourceCall!.prepare({...f.body,tools:[{function:{name:'execute_command'}}]},'openai-chat-completions')).toThrow('PERMISSION_DENIED')
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_projections').get()).toEqual({n:0})
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_rendered_texts').get()).toEqual({n:0})
    } finally { f.db.close() }
  })
  it('cannot promote a maintenance attempt into user execution and distinguishes cancellation before transport', () => {
    const f=fixture(),controller=new AbortController()
    try {
      const call=sourceMaintenanceCall(f.repo,f.auth,{...f.input,signal:controller.signal})
      call.sourceCall!.prepare(f.body,'openai-chat-completions')
      const saved=attempt(f)
      expect(()=>f.repo.invokeAttempt(f.authority,f.scope.scopeId,saved.attemptId,'fake-user-turn')).toThrow('PERMISSION_DENIED')
      controller.abort()
      expect(()=>call.observation!.start('offline-model')).toThrow()
      call.observation!.finish('cancelled')
      expect(attempt(f)).toMatchObject({state:'cancelled',outcomeKnown:true})
      expect(attempt(f).startedAt).toBeUndefined()
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_turns').get()).toEqual({n:0})
    } finally {f.db.close()}
  })
  it('records a real late result after revocation but cannot start another call or read more content', () => {
    const f=fixture()
    try {
      const call=sourceMaintenanceCall(f.repo,f.auth,f.input)
      call.sourceCall!.prepare(f.body,'openai-chat-completions');call.observation!.start('offline-model')
      f.revoke()
      call.observation!.response({choices:[{message:{content:'真实摘要'}}]});call.observation!.finish('completed')
      expect(attempt(f)).toMatchObject({state:'responded',outcomeKnown:true})
      expect(()=>call.sourceCall!.prepare(f.body,'openai-chat-completions')).toThrow('PERMISSION_DENIED')
      expect(()=>f.repo.snapshot(f.auth,f.scope.scopeId,f.prepared.snapshot.snapshotId)).toThrow('PERMISSION_DENIED')
    } finally {f.db.close()}
  })
  it('persists progress with revision checks and does not let a late failure replace a completed summary', () => {
    const f=fixture()
    try {
      const first=f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:1,status:'running',phase:'memory'})
      expect(first).toMatchObject({version:2,status:'running',phase:'memory'})
      expect(()=>f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:1,status:'failed',phase:'summary',reasonCode:'SUMMARY_INVALID'})).toThrow('REVISION_CONFLICT')
      const failed=f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:2,status:'failed',phase:'summary',reasonCode:'SUMMARY_INVALID'})
      expect(f.repo.summary(f.auth,f.scope.scopeId)).toBeUndefined()
      f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:failed.version,status:'running',phase:'commit'})
      const summary=f.repo.commitSummary(f.auth,f.scope.scopeId,{operationId:'summary-op',text:'真实候选',prerequisiteReceipt:'memory-saved'},()=>true)
      const done=f.repo.summaryStatus(f.auth,f.scope.scopeId,'summary-op')
      expect(done.status).toBe('completed')
      expect(()=>f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:done.version,status:'failed',phase:'commit',reasonCode:'SUMMARY_INVALID'})).toThrow('SOURCE_CONFLICT')
      expect(f.repo.summary(f.auth,f.scope.scopeId)?.summaryId).toBe(summary.summaryId)
      expect(f.repo.commitSummary(f.auth,f.scope.scopeId,{operationId:'summary-op',text:'真实候选',prerequisiteReceipt:'memory-saved'},()=>true).summaryId).toBe(summary.summaryId)
    } finally {f.db.close()}
  })
  it('records a late completed maintenance response after cancellation without restarting maintenance or adopting a user turn', () => {
    const f=fixture()
    try {
      const call=sourceMaintenanceCall(f.repo,f.auth,f.input)
      call.sourceCall!.prepare(f.body,'openai');call.observation!.start();call.observation!.finish('cancelled')
      expect(attempt(f)).toMatchObject({state:'cancelled',outcomeKnown:false})
      f.revoke()
      call.observation!.response({choices:[{message:{content:'迟到的真实结果'}}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6}})
      expect(attempt(f)).toMatchObject({state:'responded',outcomeKnown:true,usage:{totalTokens:6}})
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_turns').get()).toEqual({n:0})
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_summaries').get()).toEqual({n:0})
    } finally {f.db.close()}
  })
  it('resumes the same fixed input after foreground priority and rejects stale or unrelated restarts', () => {
    const f=fixture()
    try {
      const cancelled=f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:1,
        status:'cancelled',phase:'summary',reasonCode:'SUMMARY_FOREGROUND_PRIORITY'})
      f.receive('摘要运行后才收到的消息')
      expect(()=>f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:1,status:'running',phase:'history'})).toThrow('REVISION_CONFLICT')
      const resumed=f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:cancelled.version,status:'running',phase:'history'})
      expect(resumed.reasonCode).toBeUndefined()
      const prepared=f.repo.prepareMaintenanceSummary(f.auth,f.scope.scopeId,{operationId:'summary-op',purpose:'discussion',qqConfigRevision:1})
      expect(prepared.snapshot.snapshotId).toBe(f.prepared.snapshot.snapshotId)
      expect(prepared.records).toEqual(f.prepared.records)
      const stopped=f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:resumed.version,status:'cancelled',phase:'summary',reasonCode:'SUMMARY_CANCELLED'})
      expect(()=>f.repo.updateSummaryProgress(f.auth,f.scope.scopeId,{operationId:'summary-op',expectedVersion:stopped.version,status:'running',phase:'history'})).toThrow('SOURCE_CONFLICT')
    } finally {f.db.close()}
  })
  it('enforces attachment evidence rules, keeps unread attachments expanded, and explains overlap when explicitly quoted', () => {
    const f=sourceFixture()
    try {
      const msg1=f.receive([{type:'text',partId:'p0',text:'第一条文字'},
        {type:'attachment',partId:'p1',attachmentId:'img-1'}],{attachments:[{partId:'p1',mediaKind:'image',originalName:'pic.png'}]})
      const msg2=f.receive([{type:'text',partId:'p0',text:'第二条带文档'},
        {type:'attachment',partId:'p1',attachmentId:'doc-1'}],{attachments:[{partId:'p1',mediaKind:'document',originalName:'spec.pdf'}]})
      const auth=f.repo.maintenanceAuthority(f.authority,f.scope.scopeId)
      const prep=f.repo.prepareMaintenanceSummary(auth,f.scope.scopeId,{operationId:'sum-1',purpose:'discussion',qqConfigRevision:1})
      // Reject claiming native or extracted_text evidence without a responded maintenance projection.
      expect(()=>f.repo.prepareSummary(auth,f.scope.scopeId,{operationId:'sum-bad',snapshotId:prep.snapshot.snapshotId,purpose:'discussion',
        evidence:[{record:{recordId:msg2.record.recordId,revision:msg2.record.revision},textPartIds:['p0'],
          attachments:[{partId:'p1',attachmentVersion:1,representation:'extracted_text',evidenceRef:'missing-proj',range:{unit:'page',start:2,end:4}}]}]})).toThrow('SUMMARY_CONFLICT')
      // Record a responded maintenance projection providing pages 2-4 of doc-1.
      const fullMsg2=f.repo.read(auth,f.scope.scopeId,[msg2.record])[0]!
      const docAtt=f.repo.attachment(auth,f.scope.scopeId,fullMsg2.parts[1]!.type==='attachment'?fullMsg2.parts[1]!.attachmentId:'')
      const proj=f.repo.saveProjection(auth,f.scope.scopeId,{projectionId:'maint-proj-1',modelStepId:'m-step-1',snapshotId:prep.snapshot.snapshotId,
        runtimeConfigRevision:'rev-1',registryVersion:1,model:'test',protocol:'mock',toolNames:[],dataContextRefs:[],executionFactRefs:[],toolHistoryRefs:[],
        fileInputs:[{provisionId:'prov-doc-1',source:{recordId:msg2.record.recordId,revision:msg2.record.revision,partId:'p1'},
          attachmentVersion:docAtt.version,acquisitionState:'stored',inputOrigin:'history',modelStepId:'m-step-1',
          assetId:'asset-pdf',assetVersionId:'ver-pdf',representation:'extracted_text',extractionId:'ext-1',
          textRef:'t-1',range:{unit:'page',start:2,end:4},truncated:false}],
        orderedInputManifest:[],contentFingerprint:'b'.repeat(64)},'initial')
      const att=f.repo.prepareAttempt(auth,f.scope.scopeId,proj.projectionId,'maint-att-1')
      f.repo.invokeMaintenanceAttempt(auth,f.scope.scopeId,att.attemptId)
      f.repo.attemptCompletion(auth,f.scope.scopeId,att.attemptId)('completed',true,undefined)
      f.repo.prepareSummary(auth,f.scope.scopeId,{operationId:'sum-rich',snapshotId:prep.snapshot.snapshotId,purpose:'discussion',
        evidence:[
          {record:{recordId:msg1.record.recordId,revision:msg1.record.revision},textPartIds:['p0'],attachments:[{partId:'p1',attachmentVersion:1,representation:'metadata_only'}]},
          {record:{recordId:msg2.record.recordId,revision:msg2.record.revision},textPartIds:['p0'],attachments:[{partId:'p1',attachmentVersion:docAtt.version,representation:'extracted_text',evidenceRef:'maint-proj-1',range:{unit:'page',start:2,end:4}}]},
        ]})
      const committed=f.repo.commitSummary(auth,f.scope.scopeId,{operationId:'sum-rich',text:'包含文字和第2-4页摘要',prerequisiteReceipt:'ok'},()=>true)
      // Neither metadata_only image nor partial page extract replaces the whole attachment part.
      expect(committed.replacement).toEqual([
        {record:{recordId:msg1.record.recordId,revision:msg1.record.revision},partIds:['p0']},
        {record:{recordId:msg2.record.recordId,revision:msg2.record.revision},partIds:['p0']},
      ])
      // Next request quotes msg2 and keeps msg1 in recent history.
      const cur=f.receive([{type:'reply',partId:'p0',platformMessageId:'2'},{type:'text',partId:'p1',text:'看下整份文档'}],{handling:{kind:'queued',requestId:'req-next'}})
      const snap=f.repo.freeze(f.authority,f.scope.scopeId,{requestId:'req-next',actorRecord:cur.record,inputRecords:[cur.record],
        expectedSelectionRevision:f.repo.scope(f.authority,f.scope.scopeId).selectionRevision,
        policy:{historyLimit:10,backgroundMaxAgeMs:100000,backgroundMaxChars:100000,qqConfigRevision:1}})
      const item1=snap.orderedItems.find(i=>i.type==='message'&&i.recordId===msg1.record.recordId)
      expect(item1).toMatchObject({parts:[{partId:'p0',mode:'summary_reference',summaryId:committed.summaryId},{partId:'p1',mode:'expand'}]})
      const item2=snap.orderedItems.find(i=>i.type==='message'&&i.recordId===msg2.record.recordId)
      expect(item2).toMatchObject({selectionReasons:['explicit_quote'],parts:[{partId:'p0',mode:'expand'},{partId:'p1',mode:'expand'}]})
    } finally {f.db.close()}
  })
})
