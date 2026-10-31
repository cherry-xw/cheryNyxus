import { describe, expect, it } from 'vitest'
import { readSourceManagement } from '@/db/sourceManagement.js'
import { QQSourceResponseSchemas, type SourceManagementQuery, type SourceModelProjection } from '@chery/protocol'
import { sourceFixture } from '../helpers/sourceContext.js'

function fixture() {
  const f=sourceFixture(),initial=f.start(),access={ownerId:f.authority.ownerId,principal:'admin-one',validate:f.authority.validate}
  const read=(input:SourceManagementQuery,auth=access)=>readSourceManagement(f.repo,auth,input)
  const index=(params:object={})=>QQSourceResponseSchemas['qq.context.index'].parse(read({method:'qq.context.index',params:{requestId:initial.requestId,...params}}))
  const view=(params:object={})=>QQSourceResponseSchemas['qq.context.get'].parse(read({method:'qq.context.get',params:{requestId:initial.requestId,snapshotId:initial.snapshot.snapshotId,...params}}))
  let next=0
  const projection=(stepId?:string)=>{
    const n=++next,p:SourceModelProjection={projectionId:`projection-${n}`,modelStepId:stepId??`step-${n}`,snapshotId:initial.snapshot.snapshotId,
      runtimeConfigRevision:'config-1',registryVersion:1,model:'offline',protocol:'mock',toolNames:[],fileInputs:[],dataContextRefs:[],executionFactRefs:[],toolHistoryRefs:[],
      orderedInputManifest:initial.snapshot.orderedItems.filter(i=>i.type==='message').map((item,index)=>({itemId:`manifest-${n}-${index}`,position:{messageIndex:index,blockIndex:0},
        representation:'text',sourceRef:{kind:'record',record:{recordId:item.recordId,revision:item.revision}},renderedTextRef:f.repo.saveRenderedText(f.authority,f.scope.scopeId,'rendered')})),
      contentFingerprint:'a'.repeat(64)}
    f.repo.saveProjection(f.authority,f.scope.scopeId,p,'initial')
    return p
  }
  return {...f,initial,access,read,index,view,projection}
}

describe('authorized source management without executing business',()=>{
  it('keeps generated text immutable and separate from delivery text and input adoption',()=>{
    const f=fixture()
    try{
      const input={method:'qq.context.index' as const,params:{requestId:f.initial.requestId}}
      const first=QQSourceResponseSchemas['qq.context.index'].parse(readSourceManagement(f.repo,f.access,input,'生成😀'.repeat(1000)))
      const next=QQSourceResponseSchemas['qq.context.index'].parse(readSourceManagement(f.repo,f.access,input,'后续生成'))
      if(first.generatedReply?.state!=='available'||next.generatedReply?.state!=='available')throw new Error('Missing generated text')
      expect(first.generatedReply.text.textRefId).not.toBe(next.generatedReply.text.textRefId)
      const full=QQSourceResponseSchemas['qq.context.text'].parse(f.read({method:'qq.context.text',params:{requestId:f.initial.requestId,textRefId:first.generatedReply.text.textRefId}}))
      expect(full.text).toBe('生成😀'.repeat(1000))
      const entries=QQSourceResponseSchemas['qq.entry.items'].parse(f.read({method:'qq.entry.items',params:{requestId:f.initial.requestId,kind:'deliveries'}}))
      expect(entries.total).toBe(0)
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_turns').get()).toEqual({n:0})
    }finally{f.db.close()}
  })
  it('uses the selected file provision version rather than newer acquisition results',()=>{
    const f=fixture()
    try{
      const auth={...f.authority,purpose:'record' as const}
      const receipt=f.repo.beginReceipt(auth,f.scope.scopeId,{eventId:'file-event',messageId:'777',sender:{id:'123',name:'成员123'},
        parts:[{type:'attachment',partId:'p0',attachmentId:'pending'}],attachments:[{partId:'p0',originalName:'archive.zip',mediaKind:'file'}]})
      if(receipt.state!=='pending')throw new Error('Missing receipt')
      f.repo.completeReceipt(auth,receipt.receiptId,receipt.version,{kind:'queued',requestId:'file-request'},f.scope.scopeId,'file-event')
      const frozen=f.start('file-request','file-run',receipt.record)
      const attachment=f.repo.receiptContent(auth,f.scope.scopeId,'file-event').attachments[0]!
      const projection:SourceModelProjection={...f.projection(),projectionId:'fixed-file-projection',modelStepId:'file-step',snapshotId:frozen.snapshot.snapshotId,
        fileInputs:[{provisionId:'fixed-file',source:attachment.source,attachmentVersion:1,acquisitionState:'pending',inputOrigin:'current',modelStepId:'file-step',representation:'metadata_only',reasonCode:'not_acquired'}],
        orderedInputManifest:[{itemId:'file-item',sourceRef:{kind:'record',record:receipt.record},position:{messageIndex:0,blockIndex:0},representation:'reference'}]}
      f.repo.saveProjection(f.authority,f.scope.scopeId,projection,'initial')
      f.repo.updateAttachment(auth,f.scope.scopeId,attachment.attachmentId,1,{kind:'unavailable',reasonCode:'ACQUISITION_TIMEOUT'})
      const view=QQSourceResponseSchemas['qq.context.get'].parse(f.read({method:'qq.context.get',params:{requestId:'file-request',snapshotId:frozen.snapshot.snapshotId,projectionId:projection.projectionId}}))
      expect(view.fileInputs?.[0]?.attachmentVersion).toBe(1)
      const item=view.items[0]
      if(item?.type!=='message')throw new Error('Missing source message')
      const file=item.parts[0]
      expect(file).toMatchObject({type:'attachment',version:1,acquisitionState:'pending'})
    }finally{f.db.close()}
  })
  it('reads queued/snapshot-only data and remembers request ownership independently of the plugin job window',()=>{
    const f=fixture()
    try{
      expect(f.index().availability).toBe('snapshot_only')
      const view=f.view()
      expect(view.state).toBe('snapshot_only');expect(view.fileInputs).toBeUndefined();expect(view.attemptId).toBeUndefined()
      expect(view.items.some(item=>item.type==='message'&&item.source.recordId===f.initial.snapshot.actorRecord!.recordId)).toBe(true)
      const queued=f.receive('queued',{handling:{kind:'queued',requestId:'new-request'}})
      expect(queued.record.recordId).toBeTruthy()
      const index=QQSourceResponseSchemas['qq.context.index'].parse(f.read({method:'qq.context.index',params:{requestId:'new-request'}}))
      expect(index.availability).toBe('not_prepared')
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_attempts').get()).toEqual({n:0})
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_turns').get()).toEqual({n:0})
    }finally{f.db.close()}
  })
  it('chooses the latest invoked version rather than a later uninvoked preparation and freezes the directory bound',()=>{
    const f=fixture()
    try{
      const first=f.projection(),attempt=f.repo.prepareAttempt(f.authority,f.scope.scopeId,first.projectionId,'attempt-one')
      f.repo.invokeAttempt(f.authority,f.scope.scopeId,attempt.attemptId,f.initial.requestId)
      const second=f.projection(first.modelStepId),third=f.projection()
      const page=f.index({limit:1})
      expect(page.defaultSelection?.projectionId).toBe(first.projectionId)
      expect(page.selectedEntry?.projectionId).toBe(first.projectionId)
      expect(page.items.map(item=>item.projectionId)).toEqual([third.projectionId])
      const later=f.projection()
      const next=f.index({cursor:page.nextCursor!,limit:1})
      expect(next.items.map(item=>item.projectionId)).toEqual([second.projectionId])
      expect(next.items.some(item=>item.projectionId===later.projectionId)).toBe(false)
      expect(f.index().items[0]?.projectionId).toBe(later.projectionId)
      expect(()=>f.view({projectionId:first.projectionId,attemptId:'wrong'})).toThrow('INVALID_PARAMS')
      expect(()=>f.view({projectionId:first.projectionId,modelStepId:'wrong'})).toThrow('INVALID_PARAMS')
      expect(f.view({projectionId:first.projectionId}).attemptState).toBe('invoking')
      expect(f.view().state).toBe('snapshot_only')
    }finally{f.db.close()}
  })
  it('continues fixed Unicode text, binds refs and cursors to the authenticated administrator and request',()=>{
    const f=fixture()
    try{
      const original='中😀é\n'.repeat(7000),receipt=f.receive(original,{handling:{kind:'queued',requestId:'long-request'}})
      const long=f.start('long-request','long-run',receipt.record)
      const data=QQSourceResponseSchemas['qq.context.get'].parse(f.read({method:'qq.context.get',params:{requestId:'long-request',snapshotId:long.snapshot.snapshotId}}))
      const message=data.items.find(item=>item.type==='message'&&item.source.recordId===receipt.record.recordId)
      if(message?.type!=='message')throw new Error('Missing source')
      const part=message.parts.find(part=>part.type==='text')
      if(part?.type!=='text'||part.body.state!=='available')throw new Error('Missing text')
      const reference=part.body.text;let text=reference.preview,cursor=reference.nextCursor,end=reference.previewCodePoints
      while(cursor){
        const page=QQSourceResponseSchemas['qq.context.text'].parse(f.read({method:'qq.context.text',params:{requestId:'long-request',textRefId:reference.textRefId,cursor}}))
        expect(page.startCodePoint).toBe(end);text+=page.text;end=page.endCodePoint;cursor=page.nextCursor
      }
      expect(text).toBe(original)
      expect(()=>f.read({method:'qq.context.text',params:{requestId:'long-request',textRefId:reference.textRefId}},{...f.access,principal:'admin-two'})).toThrow('PERMISSION_DENIED')
      expect(()=>f.read({method:'qq.context.text',params:{requestId:f.initial.requestId,textRefId:reference.textRefId}})).toThrow('PERMISSION_DENIED')
      expect(()=>f.read({method:'qq.context.get',params:{requestId:f.initial.requestId,snapshotId:long.snapshot.snapshotId}})).toThrow('INVALID_PARAMS')
      f.revoke()
      expect(()=>f.read({method:'qq.context.text',params:{requestId:'long-request',textRefId:reference.textRefId}})).toThrow('PERMISSION_DENIED')
    }finally{f.db.close()}
  })
  it('reads retired scopes for authorized management but not other owners, and never publishes internal tool output',()=>{
    const f=fixture()
    try{
      const tool=f.repo.saveRunMessage(f.authority,f.scope.scopeId,f.initial.runId,{id:'private-tool',role:'sense',content:'SECRET RAW RESULT',thinking:'SECRET THINKING',createdAt:1,updateAt:1},'completed')
      const p=f.projection()
      const next={...p,projectionId:'private-projection',toolHistoryRefs:[tool],orderedInputManifest:[...p.orderedInputManifest,
        {itemId:'private-item',position:{messageIndex:1,blockIndex:0},representation:'text' as const,sourceRef:{kind:'tool' as const,message:tool},renderedTextRef:f.repo.saveRenderedText(f.authority,f.scope.scopeId,'SECRET RAW RESULT')}]}
      f.repo.saveProjection(f.authority,f.scope.scopeId,next,'tool_continue')
      f.repo.applyScopes(f.authority,2,[{...f.target,presetId:'new'}])
      const data=f.view({projectionId:next.projectionId})
      expect(data.items.some(item=>item.type==='tool_result'&&item.publicResult.state==='unavailable')).toBe(true)
      expect(JSON.stringify(data)).not.toContain('SECRET')
      expect(()=>f.read({method:'qq.context.index',params:{requestId:f.initial.requestId}},{...f.access,ownerId:'foreign-owner'})).toThrow('NOT_FOUND')
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM source_attempts').get()).toEqual({n:0})
    }finally{f.db.close()}
  })
  it('bounds large record pages and can locate a relation target without scanning all pages',()=>{
    const f=fixture()
    try{
      for(let i=0;i<30;i++)f.receive(`message ${i}`)
      const original=f.receive('target'),reply=f.receive([{type:'reply',partId:'p0',platformMessageId:'32'},{type:'text',partId:'p1',text:'quote'}],{handling:{kind:'queued',requestId:'quoted'}})
      const frozen=f.start('quoted','quoted-run',reply.record)
      const page=QQSourceResponseSchemas['qq.context.get'].parse(f.read({method:'qq.context.get',params:{requestId:'quoted',snapshotId:frozen.snapshot.snapshotId,limit:1}}))
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256*1024)
      let all=page.items,cursor=page.nextCursor
      while(cursor){const next=QQSourceResponseSchemas['qq.context.get'].parse(f.read({method:'qq.context.get',params:{requestId:'quoted',snapshotId:frozen.snapshot.snapshotId,cursor}}));all.push(...next.items);cursor=next.nextCursor}
      const quoted=all.find(item=>item.type==='message'&&item.source.recordId===reply.record.recordId)
      if(quoted?.type!=='message')throw new Error('Missing quote')
      const part=quoted.parts.find(part=>part.type==='reply')
      if(part?.type!=='reply')throw new Error('Missing relation')
      const sources=QQSourceResponseSchemas['qq.context.sources'].parse(f.read({method:'qq.context.sources',params:{requestId:'quoted',snapshotId:frozen.snapshot.snapshotId,relationId:part.relationId}}))
      expect(sources.items[0]?.source).toEqual(original.record)
      const targetId=sources.items[0]!.itemId!
      const located=QQSourceResponseSchemas['qq.context.locate'].parse(f.read({method:'qq.context.locate',params:{requestId:'quoted',snapshotId:frozen.snapshot.snapshotId,itemId:targetId}}))
      const target=QQSourceResponseSchemas['qq.context.get'].parse(f.read({method:'qq.context.get',params:{requestId:'quoted',snapshotId:frozen.snapshot.snapshotId,cursor:located.cursor}}))
      expect(target.items[0]?.itemId).toBe(located.itemId)
    }finally{f.db.close()}
  })
})
