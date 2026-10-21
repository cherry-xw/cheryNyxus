import { createHash, randomUUID } from 'node:crypto'
import type { IngressContext, IngressSubject } from '@chery/plugin-api'
import { QQImageScopeIdentitySchema, QQImageSourceBudgetMs, type QQConfig, type QQImageScope, type QQImageSource, type QQImageRequestSchemas, type QQEventSubmitRequest } from '@chery/protocol'
import type { z } from 'zod'
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(code: string): never { throw Object.assign(new Error(code), {code}) }
type Registration = { source: QQImageSource; sourceKey: string; sourceEventId: string; permitId: string; conversationKey: string; binding: string; scope: QQImageScope; committed?:boolean; deadlineAt:number; terminal?:boolean; timer?:ReturnType<typeof setTimeout>; controller:AbortController; uploading?:boolean }
export class QQImageSources {
  /** Wait only for admitted exact sources in the already-selected input window. No history fetch. */
  async waitFor(messages:readonly QQEventSubmitRequest[],signal:AbortSignal) {
    const selected=[...this.sources.values()].filter(r=>messages.some(m=>m.selfId===r.scope.selfId && m.senderId===r.source.senderId && m.conversationType===r.source.conversationType && m.targetId===r.source.targetId && m.messageId===r.source.messageId))
    while(selected.some(r=>!r.committed && !r.terminal && this.sources.get(r.sourceKey)===r)) {
      signal.throwIfAborted()
      await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()};const timer=setTimeout(done,10);signal.addEventListener('abort',done,{once:true})})
    }
    signal.throwIfAborted()
  }
  private readonly epoch = randomUUID()
  private scope?: QQImageScope
  private connection?: string
  private acknowledged = false
  private sources = new Map<string, Registration>()
  private expire(r:Registration) {
    if(r.terminal||r.committed)return
    // Remove authority synchronously before asynchronous storage cleanup.
    r.controller.abort();r.terminal=true;clearTimeout(r.timer)
    void this.context.core.abortSources?.([r.sourceKey]).catch(()=>this.context.log('qq.image.cleanup.failed'))
  }
  private clearSources() {for(const r of this.sources.values()){r.controller.abort();r.terminal=true;clearTimeout(r.timer)}this.sources.clear()}
  constructor(private context: IngressContext, private policy: () => { config: QQConfig; revision: number; selfId?: string; enabled: boolean },
    private conversationKey: (self:string,target:string,preset:string)=>string,
    private published: (conversationKey:string,source:QQImageSource,selfId:string,assetId:string,versionId:string)=>void) {}
  refresh(connection?: string): QQImageScope | undefined {
    const p=this.policy()
    if(!connection || !p.selfId) { this.invalidate();return }
    const targets: QQImageScope['targets']=[]
    if(p.enabled) for(const [target,preset] of Object.entries(p.config.bindings)) {
      const group=target.startsWith('group:'),targetId=target.slice(group?6:13)
      if(!(group?p.config.groups:p.config.users).includes(targetId))continue
      try{this.context.core.resolvePreset(preset);targets.push({conversationType:group?'group':'private',targetId,bindingId:preset})}catch{/* Unavailable resources grant nothing. */}
    }
    const allowedTargets:QQImageScope['allowedTargets']=[...p.config.groups.map(targetId=>({conversationType:'group' as const,targetId})),...p.config.users.map(targetId=>({conversationType:'private' as const,targetId}))]
    const semantic={selfId:p.selfId,appliedRevision:p.revision,enabled:p.enabled,allowedTargets,targets,limits:p.config.imageStorage}
    const digest=sha(semantic)
    if(this.connection===connection && this.scope?.scopeDigest===digest)return this.scope
    void this.context.core.abortSources?.([...this.sources.keys()]).catch(()=>this.context.log('qq.image.cleanup.failed'))
    this.clearSources();this.acknowledged=false;this.connection=connection
    this.scope={schemaVersion:1,backendEpoch:this.epoch,connectionGeneration:randomUUID(),sessionId:randomUUID(),...semantic,scopeDigest:digest}
    this.context.connections.send(connection,{kind:'notification',type:'qq.image.scope',data:this.scope})
    return this.scope
  }
  invalidate() { void this.context.core.abortSources?.([...this.sources.keys()]).catch(()=>this.context.log('qq.image.cleanup.failed'));this.clearSources();this.scope=undefined;this.connection=undefined;this.acknowledged=false }

  ack(connection:string,scope:z.infer<typeof QQImageScopeIdentitySchema>) {
    const current=this.refresh(connection)
    if(!current || sha(identity(current))!==sha(scope))fail('STALE_SCOPE')
    this.acknowledged=true
    return {acknowledged:true as const}
  }
  private assert(connection:string,scope:z.infer<typeof QQImageScopeIdentitySchema>) {
    const current=this.refresh(connection)
    if(!current || !this.acknowledged || !this.context.connections.isOpen(connection))fail('SCOPE_UNSYNCED')
    if(sha(identity(current))!==sha(scope))fail('STALE_SCOPE')
    if(!current.enabled)fail('IDENTITY_REJECTED')
    return current
  }
  private registrations = new Map<string, Promise<{sourceEventId:string;permitId:string}>>()
  async register(connection:string,p:z.infer<typeof QQImageRequestSchemas['qq.image.source.register']>):Promise<{sourceEventId:string;permitId:string}> {
    this.assert(connection,p.scope)
    const key=sha([connection,p.scope,p.source.conversationType,p.source.targetId,p.source.nativeMsgId,p.source.elementOrdinal])
    const pending=this.registrations.get(key)
    if(pending) {await pending;return this.register(connection,p)}
    const work=this.registerOne(connection,p)
    this.registrations.set(key,work)
    try{return await work}finally{if(this.registrations.get(key)===work)this.registrations.delete(key)}
  }
  private async registerOne(connection:string,p:z.infer<typeof QQImageRequestSchemas['qq.image.source.register']>) {
    const scope=this.assert(connection,p.scope), s=p.source
    const deadlineAt=p.deadlineAt??Date.now()+QQImageSourceBudgetMs
    if(deadlineAt<=Date.now()||deadlineAt>Date.now()+QQImageSourceBudgetMs)fail('SOURCE_UNAVAILABLE')
    const target=scope.targets.find(t=>t.conversationType===s.conversationType&&t.targetId===s.targetId)
    if(!target || s.senderId===scope.selfId)fail('IDENTITY_REJECTED')
    if(s.size>scope.limits.singleBytes)fail('QUOTA_EXCEEDED')
    const sourceKey=sha([1,scope.selfId,s.conversationType,s.targetId,s.nativeMsgId,s.elementOrdinal])
    const existing=this.sources.get(sourceKey)
    if(existing) { if(sha(existing.source)!==sha(s))fail('SOURCE_CONFLICT');return {sourceEventId:existing.sourceEventId,permitId:existing.permitId} }
    if(this.sources.size>=256) {
      const completed=[...this.sources.values()].find(r=>r.committed||r.terminal)
      if(completed)this.sources.delete(completed.sourceEventId)
      else fail('INPUT_QUEUE_FULL')
    }
    const resource=this.context.core.resolvePreset(target.bindingId)
    const targetKey=s.conversationType==='group'?`group:${s.targetId}`:`private:user:${s.targetId}`
    const conversationKey=this.conversationKey(scope.selfId,targetKey,resource.presetId)
    await this.context.core.ensureConversation(conversationKey,target.bindingId)
    this.assert(connection,p.scope)
    if(deadlineAt<=Date.now())fail('SOURCE_UNAVAILABLE')
    const r:Registration={source:s,sourceKey,sourceEventId:sourceKey,permitId:randomUUID(),conversationKey,binding:target.bindingId,scope,deadlineAt,controller:new AbortController()}
    this.sources.set(sourceKey,r)
    r.timer=setTimeout(()=>this.expire(r),Math.max(1,deadlineAt-Date.now()));r.timer.unref?.()
    try { await this.operate(connection,'reserve',{scope:p.scope,sourceEventId:r.sourceEventId,permitId:r.permitId,size:s.size}) }
    catch(error) {clearTimeout(r.timer);if(this.sources.get(sourceKey)===r)this.sources.delete(sourceKey);throw error}
    return {sourceEventId:r.sourceEventId,permitId:r.permitId}
  }
  verify(input:{connectionId:string;eventId:string;entryId:string;subject:IngressSubject}) {
    const r=this.sources.get(input.eventId)
    if(!r || r.terminal || Date.now()>=r.deadlineAt && !r.committed || input.entryId!=='qq')return false
    try{this.assert(input.connectionId,identity(r.scope))}catch{return false}
    const s=r.source
    return input.subject.selfId===r.scope.selfId && input.subject.userId===s.senderId && input.subject.conversationType===s.conversationType && input.subject.groupId===(s.conversationType==='group'?s.targetId:undefined)
  }
  async operate(connection:string,operation:'reserve'|'begin'|'chunk'|'status'|'commit'|'cancel',p:{scope:z.infer<typeof QQImageScopeIdentitySchema>;sourceEventId:string;permitId:string;uploadId?:string;size?:number;sha256?:string;mimeType?:string;offset?:number;dataBase64?:string}) {
    this.assert(connection,p.scope)
    const r=this.sources.get(p.sourceEventId)
    if(!r || r.permitId!==p.permitId || !this.context.core.publishSource)fail('IDENTITY_REJECTED')
    if(!r.committed&&Date.now()>=r.deadlineAt)this.expire(r)
    if(r.terminal){if(operation==='status')return {state:'aborted' as const,nextOffset:0};fail('SOURCE_UNAVAILABLE')}
    const s=r.source
    const handle=await this.context.identity.bind({purpose:'source',connectionId:connection,entryId:'qq',channel:'qq',eventId:r.sourceKey,
      subject:{selfId:r.scope.selfId,userId:s.senderId,conversationType:s.conversationType,...(s.conversationType==='group'?{groupId:s.targetId}:{})}})
    this.assert(connection,p.scope)
    const result=await this.context.core.publishSource({entryId:'qq',identity:handle,conversationKey:r.conversationKey,sourceKey:r.sourceKey,
      sourceIdentity:JSON.stringify([r.scope.selfId,s,r.binding,r.conversationKey]),targetKey:`${r.scope.selfId}:${s.conversationType}:${s.targetId}`,
      signal:r.controller.signal,limits:r.scope.limits,operation,size:p.size,sha256:p.sha256,mimeType:p.mimeType,uploadId:p.uploadId,offset:p.offset,dataBase64:p.dataBase64})
    this.assert(connection,p.scope)
    if(result.state==='committed' && result.assetId && result.assetVersionId) {r.committed=true;clearTimeout(r.timer);this.published(r.conversationKey,s,r.scope.selfId,result.assetId,result.assetVersionId)}
    if(operation==='cancel' && result.cancelled){r.terminal=true;clearTimeout(r.timer)}
    if(operation==='begin')r.uploading=true
    if(operation==='status' && result.state==='uploading' && !r.uploading)return {...result,state:'queued' as const}
    return result
  }
}
export function identity(s:QQImageScope) { return {backendEpoch:s.backendEpoch,connectionGeneration:s.connectionGeneration,sessionId:s.sessionId,selfId:s.selfId,appliedRevision:s.appliedRevision,scopeDigest:s.scopeDigest} }
