import { randomUUID } from 'node:crypto'
import { QQSourceRequestSchemas, QQSourceResponseSchemas, SourceModelProjectionSchema, SourceAttemptSchema,
  SourceRecordSchema, SourceSnapshotSchema, SourceDirectoryEntrySchema,
  type SourceManagementQuery, type SourceManagementResult, type SourceContextItem, type SourceRecord,
  type SourceSnapshot, type SourceRecordRef, type SourceTextRef, type SourceVisibleBody, type SourceModelProjection,
  type SourceDirectoryEntry } from '@chery/protocol'
import { SourceContextRepository, sourceContextError as fail, sourceFingerprint, type SourceAuthority } from './sourceContext.js'

export interface SourceManagementAuthority { ownerId: string; principal: string; validate(): void }
type Json = { data_json: string }
type PagePosition={kind:string;key:unknown;selectionId:string;position:number;limit:number}
type PageState=PagePosition&{values:unknown[]}
type TextLocator = { kind: 'record'; source: SourceRecordRef; partId: string } | { kind: 'summary'; summaryId: string }
  | { kind: 'data'; dataId: string } | { kind: 'delivery'; deliveryId: string } | {kind:'generated';textId:string}
const unavailable = (): SourceVisibleBody => ({ state: 'unavailable', reason: 'not_recorded' })
const uid = () => `management-${randomUUID()}`
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const maxBytes = 256 * 1024

/** Read-only product data; saved cursor/text locators never authorize a business operation. */
class SourceManagementReader {
  readonly repo: SourceContextRepository
  readonly scopeId: string
  readonly authority: SourceAuthority
  readonly revision: number
  constructor(readonly access: SourceManagementAuthority, readonly requestId: string, repo: SourceContextRepository, readonly generatedReply?:string) {
    this.repo = repo; access.validate()
    const row = repo.db.prepare(`SELECT c.*,s.scope_id,s.data_json FROM source_management_requests r
      JOIN source_scopes s USING(scope_id) JOIN source_conversations c USING(conversation_id)
      WHERE r.request_id=? AND c.owner_id=?`).get(requestId, access.ownerId) as
      (Json & { scope_id: string; channel: string; self_id: string; conversation_type: 'group' | 'private'; target_id: string }) | undefined
    if (!row) fail('NOT_FOUND')
    this.scopeId = row.scope_id
    this.authority = { ownerId: access.ownerId, channel: row.channel, selfId: row.self_id, conversationType: row.conversation_type,
      targetId: row.target_id, purpose: 'management', validate: () => access.validate() }
    this.revision = repo.scope(this.authority, this.scopeId).permissionRevision
  }
  check() { this.access.validate(); if (this.repo.scope(this.authority, this.scopeId).permissionRevision !== this.revision) fail('PERMISSION_DENIED') }
  save(kind: string, key: unknown, value: unknown): string {
    this.check()
    const valueKey = sourceFingerprint(key)
    this.repo.db.prepare(`INSERT OR IGNORE INTO source_management_values VALUES (?,?,?,?,?,?,?)`)
      .run(uid(), this.access.principal, this.requestId, this.revision, kind, valueKey, JSON.stringify(value))
    return (this.repo.db.prepare(`SELECT value_id FROM source_management_values
      WHERE principal=? AND request_id=? AND permission_revision=? AND kind=? AND value_key=?`)
      .get(this.access.principal, this.requestId, this.revision, kind, valueKey) as { value_id: string }).value_id
  }
  load<T>(kind: string, valueId: string): T {
    this.check()
    const row = this.repo.db.prepare(`SELECT data_json FROM source_management_values
      WHERE value_id=? AND principal=? AND request_id=? AND permission_revision=? AND kind=?`)
      .get(valueId, this.access.principal, this.requestId, this.revision, kind) as Json | undefined
    if (!row) fail(kind === 'cursor' ? 'CURSOR_EXPIRED' : 'PERMISSION_DENIED')
    return JSON.parse(row.data_json) as T
  }
  snapshot(snapshotId: string): SourceSnapshot {
    const snapshot = this.repo.snapshot(this.authority, this.scopeId, snapshotId)
    if (snapshot.requestId !== this.requestId || snapshot.maintenancePurpose) fail('INVALID_PARAMS')
    return snapshot
  }
  projection(snapshot: SourceSnapshot, p: { projectionId?: string; modelStepId?: string; attemptId?: string }): SourceModelProjection | undefined {
    if (!p.projectionId) { if (p.modelStepId || p.attemptId) fail('INVALID_PARAMS'); return }
    const row = this.repo.db.prepare('SELECT data_json FROM source_projections WHERE projection_id=? AND request_id=? AND snapshot_id=?')
      .get(p.projectionId, this.requestId, snapshot.snapshotId) as Json | undefined
    if (!row) fail('INVALID_PARAMS')
    const projection = SourceModelProjectionSchema.parse(JSON.parse(row.data_json))
    if (p.modelStepId && projection.modelStepId !== p.modelStepId) fail('INVALID_PARAMS')
    if (p.attemptId && !this.repo.db.prepare('SELECT 1 FROM source_attempts WHERE attempt_id=? AND projection_id=?').get(p.attemptId, p.projectionId)) fail('INVALID_PARAMS')
    return projection
  }
  textValue(locator: TextLocator): string {
    this.check()
    if (locator.kind === 'record') {
      const record = this.repo.read(this.authority, this.scopeId, [locator.source])[0]!
      const part = record.parts.find(p => p.partId === locator.partId)
      if (part?.type !== 'text') fail('NOT_FOUND')
      return part.text
    }
    if (locator.kind === 'summary') return this.repo.summary(this.authority, this.scopeId, locator.summaryId)!.text
    if (locator.kind === 'data') {
      const row = this.repo.db.prepare('SELECT body FROM source_data_snapshots WHERE data_id=? AND scope_id=?').get(locator.dataId, this.scopeId) as { body: string } | undefined
      if (!row) fail('NOT_FOUND')
      return row.body
    }
    if (locator.kind === 'generated') {
      const row=this.repo.db.prepare('SELECT body FROM source_generated_replies WHERE text_id=? AND scope_id=? AND request_id=?')
        .get(locator.textId,this.scopeId,this.requestId) as {body:string}|undefined
      if(!row)fail('NOT_FOUND')
      return row.body
    }
    const row = this.repo.db.prepare('SELECT frame_json FROM source_deliveries WHERE delivery_id=? AND scope_id=? AND request_id=?')
      .get(locator.deliveryId, this.scopeId, this.requestId) as { frame_json: string } | undefined
    if (!row) fail('NOT_FOUND')
    return JSON.parse(row.frame_json).data.text ?? ''
  }
  body(locator: TextLocator, preview: number): SourceVisibleBody {
    const textRefId = this.save('text', locator, locator), points = Array.from(this.textValue(locator)), end = Math.min(points.length, preview)
    const ref: SourceTextRef = { textRefId, revision: 1, totalCodePoints: points.length, preview: points.slice(0, end).join(''),
      previewCodePoints: end, complete: end === points.length, nextCursor: end < points.length ? this.save('cursor', ['text', textRefId, end], {kind:'text',textRefId,position:end}) : null }
    return { state: 'available', text: ref }
  }
  text(textRefId: string, cursor?: string) {
    const locator = this.load<TextLocator>('text', textRefId), points = Array.from(this.textValue(locator))
    const page = cursor ? this.load<{kind:string;textRefId:string;position:number}>('cursor', cursor) : undefined
    if (page && (page.kind !== 'text' || page.textRefId !== textRefId)) fail('INVALID_PARAMS')
    const start = page?.position ?? 0, end = Math.min(points.length, start + 8192)
    if (start > points.length) fail('CURSOR_EXPIRED')
    return { requestId:this.requestId,textRefId,revision:1,startCodePoint:start,endCodePoint:end,text:points.slice(start,end).join(''),totalCodePoints:points.length,
      nextCursor:end < points.length ? this.save('cursor',['text',textRefId,end],{kind:'text',textRefId,position:end}) : null }
  }
  record(record: SourceRecord, preview: number, snapshot?: SourceSnapshot,projection?: SourceModelProjection) {
    return { source:{recordId:record.recordId,revision:record.revision},origin:record.origin,sender:record.sender,platformMessageIds:record.platformMessageIds,
      time:record.platformSentAt !== undefined ? {at:record.platformSentAt,basis:'platform_sent' as const} : record.deliveryConfirmedAt !== undefined
        ? {at:record.deliveryConfirmedAt,basis:'delivery_confirmed' as const} : {at:record.receivedAt,basis:'received' as const},
      parts:record.parts.map(part => {
        if (part.type === 'text') return { partId:part.partId,type:part.type,body:this.body({kind:'record',source:{recordId:record.recordId,revision:record.revision},partId:part.partId},preview) }
        if (part.type === 'reply' && snapshot) {
          const quote = snapshot.quoteRelations.find(q=>q.source.recordId===record.recordId && q.source.partId===part.partId)
          const target = quote?.result.kind === 'resolved' ? quote.result.target : undefined
          const result = target ? snapshot.orderedItems.some(item=>item.type==='message'&&item.recordId===target.recordId) ? 'selected' : 'source_only'
            : quote?.result.kind === 'out_of_scope' ? 'outside_scope' : 'not_retained'
          return {partId:part.partId,type:part.type,relationId:this.save('relation',['quote',snapshot.snapshotId,projection?.projectionId??null,record.recordId,part.partId],
            {snapshotId:snapshot.snapshotId,projectionId:projection?.projectionId,refs:target ? [target] : []}),result}
        }
        if (part.type === 'reply') return {partId:part.partId,type:'unsupported' as const,sourceType:'reply',description:`引用平台消息 ${part.platformMessageId}`}
        if (part.type !== 'attachment') return part
        const fixed=projection?.fileInputs.find(file=>file.source.recordId===record.recordId&&file.source.revision===record.revision&&file.source.partId===part.partId)
        const file = this.repo.attachment(this.authority,this.scopeId,part.attachmentId,fixed?.attachmentVersion)
        return {partId:part.partId,type:part.type,attachmentId:file.attachmentId,version:file.version,originalName:file.originalName,
          mediaKind:file.mediaKind,acquisitionState:file.state.kind,contentRead:false as const}
      }) }
  }
  index(cursor?: string, limit?: number) {
    let generatedReply: SourceVisibleBody | undefined
    if(this.generatedReply!==undefined) {
      const bodyHash=sourceFingerprint(this.generatedReply)
      this.repo.db.prepare('INSERT OR IGNORE INTO source_generated_replies VALUES (?,?,?,?,?,?)')
        .run(uid(),this.scopeId,this.requestId,bodyHash,this.generatedReply,Date.now())
      const row=this.repo.db.prepare('SELECT text_id FROM source_generated_replies WHERE scope_id=? AND request_id=? AND body_hash=?')
        .get(this.scopeId,this.requestId,bodyHash) as {text_id:string}
      generatedReply=this.body({kind:'generated',textId:row.text_id},1024)
    } else {
      const row=this.repo.db.prepare('SELECT text_id FROM source_generated_replies WHERE scope_id=? AND request_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1')
        .get(this.scopeId,this.requestId) as {text_id:string}|undefined
      if(row)generatedReply=this.body({kind:'generated',textId:row.text_id},1024)
    }
    const initial = () => (this.repo.db.prepare(`SELECT p.*,a.data_json AS attempt_json FROM source_projections p
      LEFT JOIN source_attempts a USING(projection_id) WHERE p.request_id=? ORDER BY p.step_sequence DESC,p.projection_sequence DESC`)
      .all(this.requestId) as Array<Json & {model_step_id:string;step_sequence:number;reason:string;projection_id:string;projection_sequence:number;snapshot_id:string;prepared_at:number;attempt_json:string|null}>)
      .map(row=>({modelStepId:row.model_step_id,stepSequence:row.step_sequence,reason:row.reason,projectionId:row.projection_id,
        projectionSequence:row.projection_sequence,snapshotId:row.snapshot_id,preparedAt:row.prepared_at,
        ...(row.attempt_json ? {attempt:this.publicAttempt(JSON.parse(row.attempt_json))} : {})}))
    const state = this.pageState('index',{},cursor,limit,initial), entries = state.values as SourceDirectoryEntry[]
    // Prefer the latest actually invoked version; a later preparation failure must not hide it.
    const preferred = entries.find(e=>e.attempt?.startedAt !== undefined) ?? entries[0]
    const chosen = preferred ? this.directoryEntry(preferred) : undefined
    const snapshot = this.repo.db.prepare('SELECT snapshot_id FROM source_snapshots WHERE request_id=? ORDER BY rowid DESC LIMIT 1')
      .get(this.requestId) as {snapshot_id:string}|undefined
    const summaryIds = new Set<string>()
    for (const row of this.repo.db.prepare('SELECT data_json FROM source_snapshots WHERE request_id=?').all(this.requestId) as Json[])
      for (const item of SourceSnapshotSchema.parse(JSON.parse(row.data_json)).orderedItems) if(item.type==='summary') summaryIds.add(item.summaryId)
    for (const row of this.repo.db.prepare(`SELECT s.summary_id FROM source_summaries s JOIN source_summary_request_links l USING(operation_id)
      WHERE l.request_id=? AND s.scope_id=?`).all(this.requestId,this.scopeId) as {summary_id:string}[])summaryIds.add(row.summary_id)
    const base = {requestId:this.requestId,observedAt:Date.now(),associatedSummaryIds:[...summaryIds],...(generatedReply?{generatedReply}:{}),
      availability:chosen ? 'available' as const : snapshot ? 'snapshot_only' as const : 'not_prepared' as const,
      ...(snapshot ? {snapshotId:snapshot.snapshot_id} : {}),...(chosen ? {defaultSelection:{snapshotId:chosen.snapshotId,modelStepId:chosen.modelStepId,
        projectionId:chosen.projectionId,...(chosen.attempt ? {attemptId:chosen.attempt.attemptId} : {})},selectedEntry:chosen} : {})}
    return this.pageResult(state,base,value=>this.directoryEntry(SourceDirectoryEntrySchema.parse(value)))
  }
  directoryEntry(entry:SourceDirectoryEntry):SourceDirectoryEntry {
    const attempt=this.repo.db.prepare('SELECT data_json FROM source_attempts WHERE projection_id=?').get(entry.projectionId) as Json|undefined
    return {...entry,...(attempt?{attempt:this.publicAttempt(JSON.parse(attempt.data_json))}:{})}
  }
  publicAttempt(value: unknown) {
    const {projectionId:_p,version:_v,responseRef:_r,...publicFields}=SourceAttemptSchema.parse(value)
    return publicFields
  }
  descriptors(snapshot: SourceSnapshot, projection?: SourceModelProjection) {
    const items: Array<{kind:'snapshot';index:number}|{kind:'data';dataId:string}|{kind:'tool';messageId:string}> = []
    const seen=new Set<string>()
    const append=(key:string,item:typeof items[number])=>{if(!seen.has(key)){seen.add(key);items.push(item)}}
    if (!projection) return snapshot.orderedItems.map((_,index)=>({kind:'snapshot' as const,index}))
    for (const entry of projection.orderedInputManifest) {
      const ref=entry.sourceRef
      if(ref.kind==='record') {
        const index=snapshot.orderedItems.findIndex(i=>i.type==='message'&&i.recordId===ref.record.recordId&&i.revision===ref.record.revision)
        if(index>=0)append(`s${index}`,{kind:'snapshot',index})
      } else if(ref.kind==='summary'||ref.kind==='gap') {
        const index=snapshot.orderedItems.findIndex((i,n)=>ref.kind==='summary' ? i.type==='summary'&&i.summaryId===ref.summaryId : `source:${snapshot.snapshotId}:item:${n}`===ref.snapshotItemId)
        if(index>=0)append(`s${index}`,{kind:'snapshot',index})
      } else if(ref.kind==='data') append(ref.data.dataId,{kind:'data',dataId:ref.data.dataId})
      else if(ref.kind==='tool'&&ref.message.kind!=='assistant_call') append(ref.message.messageId,{kind:'tool',messageId:ref.message.messageId})
    }
    return items
  }
  itemId(snapshotId:string,projectionId:string|undefined,descriptor:unknown) {
    return this.save('item',[snapshotId,projectionId??null,descriptor],{snapshotId,projectionId,descriptor})
  }
  view(params: {snapshotId:string;projectionId?:string;modelStepId?:string;attemptId?:string;cursor?:string;limit?:number}) {
    const snapshot=this.snapshot(params.snapshotId),projection=this.projection(snapshot,params)
    const key={snapshotId:snapshot.snapshotId,projectionId:projection?.projectionId??null}
    const state=this.pageState('view',key,params.cursor,params.limit,()=>this.descriptors(snapshot,projection))
    const attempt=projection ? this.repo.db.prepare('SELECT data_json FROM source_attempts WHERE projection_id=?').get(projection.projectionId) as Json|undefined : undefined
    const budget=projection?.budgetSnapshotId ? this.repo.db.prepare("SELECT data_json FROM source_preparation_results WHERE result_id=? AND scope_id=? AND kind='budget'").get(projection.budgetSnapshotId,this.scopeId) as Json|undefined : undefined
    const base={requestId:this.requestId,snapshotId:snapshot.snapshotId,observedAt:Date.now(),ordering:'time_approximate' as const,
      state:projection ? 'available' as const : 'snapshot_only' as const,total:state.values.length,
      ...(projection ? {projectionId:projection.projectionId,modelStepId:projection.modelStepId,model:projection.model,protocol:projection.protocol,runtimeConfigRevision:projection.runtimeConfigRevision,
        ...(attempt ? {attemptId:JSON.parse(attempt.data_json).attemptId,attemptState:JSON.parse(attempt.data_json).state,usage:JSON.parse(attempt.data_json).usage} : {}),
        ...(budget ? {budget:this.publicBudget(JSON.parse(budget.data_json))} : {})} : {})}
    return this.pageResult(state,base,(descriptor,position,preview)=>this.viewItem(snapshot,projection,descriptor as ReturnType<typeof this.descriptors>[number],position,preview),projection?.fileInputs)
  }
  publicBudget(value: Record<string,unknown>) { const {projectionId:_id,payloadBytes:_bytes,preparedAt:_at,...budget}=value;return budget }
  viewItem(snapshot:SourceSnapshot,projection:SourceModelProjection|undefined,descriptor:ReturnType<typeof this.descriptors>[number],position:number,preview:number): SourceContextItem {
    const itemId=this.itemId(snapshot.snapshotId,projection?.projectionId,descriptor),base={itemId,position}
    if(descriptor.kind==='data') {
      const source=projection!.dataContextRefs.find(d=>d.dataId===descriptor.dataId)!
      if(source.kind==='memory')return {...base,type:'restricted',reason:'permission_denied'}
      return {...base,type:'data',source,body:this.body({kind:'data',dataId:source.dataId},preview)}
    }
    if(descriptor.kind==='tool') {
      const reference=projection!.toolHistoryRefs.find(t=>t.messageId===descriptor.messageId)!
      const messages=this.repo.runMessages(this.authority,this.scopeId,this.requestId)
      const message=messages.find(message=>message.ref.runId===reference.runId&&message.ref.messageId===reference.messageId&&message.ref.bodyHash===reference.bodyHash)
      if(!message)fail('NOT_FOUND')
      const call=messages.flatMap(message=>message.body.senseCalls??[]).find(call=>call.id===reference.messageId)
      // Tool parameters, thinking, raw outcomes and private continuation are never public.
      return {...base,type:'tool_result',runId:reference.runId,messageId:reference.messageId,callId:call?.id??reference.messageId,toolName:call?.name??'内部工具过程',
        status:message.state==='completed'?'completed':'unknown',publicResult:unavailable()}
    }
    const item=snapshot.orderedItems[descriptor.index]!
    if(item.type==='message') {
      const record=this.repo.read(this.authority,this.scopeId,[item])[0]!
      return {...base,type:'message',...this.record(record,preview,snapshot,projection),selectionReasons:item.selectionReasons,partSelection:item.parts} as SourceContextItem
    }
    if(item.type==='summary') {
      const summary=this.repo.summary(this.authority,this.scopeId,item.summaryId)!
      return {...base,type:'summary',summaryId:summary.summaryId,revision:summary.revision,purpose:summary.purpose,
        body:this.body({kind:'summary',summaryId:summary.summaryId},preview),coveredRecordCount:summary.evidence.length,committedAt:summary.committedAt,
        relationId:this.save('relation',['summary',snapshot.snapshotId,projection?.projectionId??null,summary.summaryId],{snapshotId:snapshot.snapshotId,projectionId:projection?.projectionId,refs:summary.evidence.map(e=>e.record),evidence:summary.evidence})}
    }
    const refs=item.reason==='omitted_from_context' ? JSON.parse((this.repo.db.prepare('SELECT refs_json FROM source_omitted_sets WHERE set_id=? AND snapshot_id=?')
      .get(item.omittedSetId,snapshot.snapshotId) as {refs_json:string}).refs_json) as SourceRecordRef[] : []
    const completeness=item.reason!=='omitted_from_context' ? this.repo.db.prepare('SELECT observed_at FROM source_completeness WHERE completeness_id=? AND scope_id=?')
      .get(item.completenessRecordId,this.scopeId) as {observed_at:number}|undefined : undefined
    return {...base,type:'gap',reason:item.reason,...(completeness?{observedStartAt:completeness.observed_at}:{}),...(item.reason==='omitted_from_context' ? {knownMessageCount:item.knownMessageCount,
      firstRecord:item.firstRecord,lastRecord:item.lastRecord,partiallySummarizedCount:item.partiallySummarizedCount} : {}),
      relationId:this.save('relation',['gap',snapshot.snapshotId,projection?.projectionId??null,descriptor.index],{snapshotId:snapshot.snapshotId,projectionId:projection?.projectionId,refs})}
  }
  sources(params:{snapshotId:string;relationId:string;cursor?:string;limit?:number}) {
    const snapshot=this.snapshot(params.snapshotId),relation=this.load<{snapshotId:string;projectionId?:string;refs:SourceRecordRef[];evidence?:unknown[]}>('relation',params.relationId)
    if(relation.snapshotId!==snapshot.snapshotId)fail('INVALID_PARAMS')
    const projection=this.projection(snapshot,relation)
    const includedIndices=new Set(this.descriptors(snapshot,projection).flatMap(descriptor=>descriptor.kind==='snapshot'?[descriptor.index]:[]))
    const state=this.pageState('sources',{snapshotId:snapshot.snapshotId,relationId:params.relationId},params.cursor,params.limit,()=>relation.refs)
    return this.pageResult(state,{requestId:this.requestId,snapshotId:snapshot.snapshotId,relationId:params.relationId,observedAt:Date.now()},(value,_n,preview)=>{
      const source=value as SourceRecordRef,item=snapshot.orderedItems.find(i=>i.type==='message'&&i.recordId===source.recordId&&i.revision===source.revision)
      const result=this.repo.readSelection(this.authority,this.scopeId,{kind:'records',refs:[source]}).items[0]!
      const included=!!item&&includedIndices.has(snapshot.orderedItems.indexOf(item))
      return {source,includedInSelectedInput:included,selectionReasons:item?.type==='message'?item.selectionReasons:[],
        ...(included ? {itemId:this.itemId(snapshot.snapshotId,projection?.projectionId,{kind:'snapshot',index:snapshot.orderedItems.indexOf(item!)})} : {}),
        ...(relation.evidence ? {evidence:relation.evidence.find(e=>(e as {record:SourceRecordRef}).record.recordId===source.recordId)} : {}),
        ...(result.state==='available'?{record:this.record(result.record,preview,snapshot,projection)}:{unavailableReason:result.reasonCode==='not_retained'?'not_retained':result.reasonCode})}
    })
  }
  locate(params:{snapshotId:string;projectionId?:string;itemId:string}) {
    const snapshot=this.snapshot(params.snapshotId),projection=this.projection(snapshot,params),descriptor=this.load<{snapshotId:string;projectionId?:string;descriptor:unknown}>('item',params.itemId)
    if(descriptor.snapshotId!==snapshot.snapshotId||descriptor.projectionId!==undefined&&descriptor.projectionId!==projection?.projectionId)fail('INVALID_PARAMS')
    const values=this.descriptors(snapshot,projection),position=values.findIndex(d=>JSON.stringify(d)===JSON.stringify(descriptor.descriptor))
    if(position<0)fail('NOT_FOUND')
    const key={snapshotId:snapshot.snapshotId,projectionId:projection?.projectionId??null}
    const selectionId=this.save('selection',['view',key,values],values)
    const cursor=this.pageCursor({kind:'view',key,values,selectionId,position,limit:25},position)
    return {requestId:this.requestId,snapshotId:snapshot.snapshotId,projectionId:projection?.projectionId,
      itemId:this.itemId(snapshot.snapshotId,projection?.projectionId,descriptor.descriptor),cursor}
  }
  entries(kind:'messages'|'deliveries'|'summaries',cursor?:string,limit?:number) {
    const initial=()=>kind==='messages' ? (this.repo.db.prepare(`SELECT r.data_json FROM source_receipts x JOIN source_records r USING(record_id)
      WHERE x.scope_id=? AND json_extract(x.result_json,'$.handling.requestId')=? ORDER BY r.ingest_ordinal`).all(this.scopeId,this.requestId) as Json[])
      .map(row=>{const record=SourceRecordSchema.parse(JSON.parse(row.data_json));return {source:{recordId:record.recordId,revision:record.revision}}}) : kind==='deliveries'
      ? (this.repo.db.prepare('SELECT delivery_id FROM source_deliveries WHERE scope_id=? AND request_id=? ORDER BY created_at,delivery_id').all(this.scopeId,this.requestId) as {delivery_id:string}[])
      : [...new Set([...(this.repo.db.prepare('SELECT operation_id FROM source_summary_request_links WHERE request_id=?').all(this.requestId) as {operation_id:string}[]).map(row=>row.operation_id),
        ...(this.repo.db.prepare('SELECT data_json FROM source_snapshots WHERE request_id=?').all(this.requestId) as Json[])
          .flatMap(row=>SourceSnapshotSchema.parse(JSON.parse(row.data_json)).orderedItems.flatMap(item=>item.type==='summary'?[this.repo.summary(this.authority,this.scopeId,item.summaryId)!.operationId]:[]))])]
        .map(operationId=>({operationId}))
    const state=this.pageState(`entry:${kind}`,{},cursor,limit,initial)
    return this.pageResult(state,{requestId:this.requestId,kind,observedAt:Date.now(),total:state.values.length},(value,_n,preview)=>{
      const itemId=this.save('entry-item',[kind,value],{kind,value})
      if(kind==='messages')return {itemId,type:'message',...this.record(this.repo.read(this.authority,this.scopeId,[(value as {source:SourceRecordRef}).source])[0]!,preview)}
      if(kind==='summaries') {
        const operation=this.repo.summaryStatus(this.authority,this.scopeId,(value as {operationId:string}).operationId)
        return {itemId,type:'summary',operationId:operation.operationId,summaryId:operation.summaryId,purpose:operation.purpose,
          status:operation.status,phase:operation.phase,reasonCode:operation.reasonCode,
          body:operation.summaryId?this.body({kind:'summary',summaryId:operation.summaryId},preview):unavailable()}
      }
      const deliveryId=(value as {delivery_id:string}).delivery_id,row=this.repo.db.prepare(`SELECT d.frame_json,d.purpose,f.data_json,f.confirmed_at FROM source_deliveries d
        LEFT JOIN source_delivery_facts f ON f.delivery_id=d.delivery_id AND f.revision=(SELECT MAX(revision) FROM source_delivery_facts WHERE delivery_id=d.delivery_id)
        WHERE d.delivery_id=? AND d.scope_id=? AND d.request_id=?`).get(deliveryId,this.scopeId,this.requestId) as
        {frame_json:string;purpose:string;data_json:string|null;confirmed_at:number|null}
      const frame=JSON.parse(row.frame_json),fact=row.data_json?JSON.parse(row.data_json):undefined
      return {itemId,type:'delivery',purpose:row.purpose,sequence:frame.data.seq,status:fact?.status??'pending',body:this.body({kind:'delivery',deliveryId},preview),
        messageIds:fact?.messageIds??[],fileIds:fact?.fileIds??[],fileUploaded:fact?.fileUploaded,confirmedAt:row.confirmed_at??undefined,
        partIndex:frame.data.partIndex,totalParts:frame.data.totalParts}
    })
  }
  pageState(kind:string,key:unknown,cursor:string|undefined,limit:number|undefined,initial:()=>unknown[]) {
    let state:PageState
    if(cursor){const saved=this.load<PagePosition>('cursor',cursor);state={...saved,values:this.load<unknown[]>('selection',saved.selectionId)}}
    else {const values=initial();state={kind,key,values,selectionId:this.save('selection',[kind,key,values],values),position:0,limit:limit??25}}
    if(state.kind!==kind||JSON.stringify(state.key)!==JSON.stringify(key)||limit!==undefined&&limit!==state.limit)fail('INVALID_PARAMS')
    return state
  }
  pageCursor(state:PageState,position:number){
    const {values:_values,...saved}=state
    return this.save('cursor',[state.kind,state.key,position,state.limit,state.selectionId],{...saved,position})
  }
  pageResult<T,B extends object>(state:PageState,base:B,render:(item:unknown,index:number,preview:number)=>T,fileInputs?: SourceModelProjection['fileInputs']) {
    let take=Math.min(state.limit,state.values.length-state.position),preview=1024
    while(true) {
      const items=state.values.slice(state.position,state.position+take).map((value,n)=>render(value,state.position+n,preview)),next=state.position+take
      const recordIds=new Set(items.flatMap(item=>{const value=item as SourceContextItem;return value.type==='message'?[value.source.recordId]:[]}))
      const result={...base,items,...(fileInputs ? {fileInputs:fileInputs.filter(file=>recordIds.has(file.source.recordId))} : {}),
        nextCursor:next<state.values.length?this.pageCursor(state,next):null}
      if(size(result)<=maxBytes){this.check();return result}
      if(take>1)take=Math.max(1,Math.floor(take/2))
      else if(preview>0)preview=Math.floor(preview/2)
      else fail('RESPONSE_TOO_LARGE')
    }
  }
}

export function readSourceManagement(repo:SourceContextRepository,access:SourceManagementAuthority,input:SourceManagementQuery,generatedReply?:string):SourceManagementResult {
  const query=QQSourceRequestSchemas[input.method].parse(input.params)
  return repo.db.transaction(()=>{
    const reader=new SourceManagementReader(access,query.requestId,repo,generatedReply)
    let result: unknown
    switch(input.method) {
      case 'qq.context.index': { const p=QQSourceRequestSchemas[input.method].parse(query);result=reader.index(p.cursor,p.limit);break }
      case 'qq.context.get': result=reader.view(QQSourceRequestSchemas[input.method].parse(query));break
      case 'qq.context.text': {const p=QQSourceRequestSchemas[input.method].parse(query);result=reader.text(p.textRefId,p.cursor);break}
      case 'qq.context.sources': result=reader.sources(QQSourceRequestSchemas[input.method].parse(query));break
      case 'qq.context.locate': result=reader.locate(QQSourceRequestSchemas[input.method].parse(query));break
      case 'qq.entry.items': {const p=QQSourceRequestSchemas[input.method].parse(query);result=reader.entries(p.kind,p.cursor,p.limit);break}
    }
    reader.check()
    const checked=QQSourceResponseSchemas[input.method].parse(result)
    if(size(checked)>maxBytes)fail('RESPONSE_TOO_LARGE')
    return checked
  })()
}
