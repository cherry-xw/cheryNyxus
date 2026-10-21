
import path from 'node:path'
import { createHash } from 'node:crypto'
import { QQImageScopeSchema, QQImageResponseSchemas, QQImageAcquisitionMs, QQImageQueueCapacity, type QQImageScope, type QQImageSource } from '@chery/protocol'
import type { BackendChannel } from './wire.js'
import { readNativeImage } from './nativeImageRead.js'
const identity=(s:QQImageScope)=>({backendEpoch:s.backendEpoch,connectionGeneration:s.connectionGeneration,sessionId:s.sessionId,selfId:s.selfId,appliedRevision:s.appliedRevision,scopeDigest:s.scopeDigest})
/** One native dispatcher per adapter lifetime, bounded round-robin target queues. */
export class NativeImages {
  private scope?:QQImageScope
  private acknowledged=false
  private generation=0
  private token?:string|number
  private attached=false
  private service:any
  private queues=new Map<string,Array<{ready:boolean;run:()=>Promise<void>}>>()
  private running=false
  private active=true
  private lifetime=new AbortController()
  private admissions=new Map<any,Promise<unknown>[]>()
  private retirees=new Map<any,Array<()=>void>>()
  /** Engineering deadline for one acquisition, not the model task timeout. */
  private readonly acquisitionMs:number
  private bounded<T>(work:Promise<T>,signal:AbortSignal,ms=this.acquisitionMs):Promise<T> {
    return new Promise((resolve,reject)=>{
      const abort=()=>{clean();reject(Error('STALE_SCOPE'))}
      const timer=setTimeout(()=>{clean();reject(Error('SOURCE_UNAVAILABLE'))},ms)
      signal.addEventListener('abort',abort,{once:true})
      const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort)}
      work.then(value=>{clean();resolve(value)},error=>{clean();reject(error)})
      if(signal.aborted)abort()
    })
  }
  private shortIds=new WeakMap<object,Promise<string>>()
  private shortId(m:any):Promise<string> {
    let pending=this.shortIds.get(m)
    if(!pending){pending=(async()=>{
      if(this.lookupMessage){const event=await this.lookupMessage(String(m.msgId))
        if(String(event?.self_id)!==this.self() || String(event?.user_id)!==String(m.senderUin) || event?.message_type!==(m.chatType===2?'group':'private') || String(event?.message_type==='group'?event.group_id:event.user_id)!==String(m.chatType===2?m.peerUid:m.senderUin) || Number(event.time)!==Number(m.msgTime) || !/^-?\d{1,100}$/.test(String(event.message_id)))throw Error('SOURCE_CONFLICT')
        return String(event.message_id)
      }
      if(!/^-?\d{1,100}$/.test(String(m.id)))throw Error('SOURCE_UNAVAILABLE')
      return String(m.id)
    })();this.shortIds.set(m,pending);void pending.catch(()=>undefined)}
    return pending
  }
  /** Resolve identity through this runtime's exact native-ID action, not raw-object mutation. */
  async admit(event:any) {
    await new Promise<void>(resolve=>setImmediate(resolve))
    const candidates=[...this.admissions].filter(([m])=>(event?.time===undefined || Number(m.msgTime)===Number(event.time)) && String(m.senderUin)===String(event?.user_id) &&
      (m.chatType===2?'group':'private')===event?.message_type &&
      String(m.chatType===2?m.peerUid:m.senderUin)===String(event?.message_type==='group'?event.group_id:event.user_id))
    const pending=(await this.bounded(Promise.all(candidates.map(async([m,work])=>await this.shortId(m)===String(event?.message_id)?work:[])),this.lifetime.signal)).flat()
    await this.bounded(Promise.all(pending),this.lifetime.signal,(QQImageQueueCapacity+1)*this.acquisitionMs)
  }
  private readonly startedAt=Math.floor(Date.now()/1000)
  private seen=new Set<string>()
  private completions=new Map<string,{resolve:(v:any)=>void;reject:()=>void;timer:ReturnType<typeof setTimeout>}>()
  constructor(private core:any,private wire:BackendChannel,private self:()=>string|undefined,acquisitionMs=QQImageAcquisitionMs,private lookupMessage?:(nativeMsgId:string)=>Promise<any>,private diagnostic?:(stage:string,code:string)=>void) {this.acquisitionMs=acquisitionMs}
  attach() {
    if(!this.core?.context?.session||this.attached)return
    this.attached=true
    this.service=this.core.context.session.getMsgService()
    const listener=new Proxy({onRecvMsg:(messages:any[])=>{if(this.active&&Array.isArray(messages))for(const m of messages) this.receive(m)},
      onRichMediaDownloadComplete:(info:any)=>{if(!this.active)return;const key=`${info?.msgId}:${info?.msgElementId}`;const waiter=this.completions.get(key);if(waiter){this.completions.delete(key);clearTimeout(waiter.timer);waiter.resolve(info)}}},
      {get:(target,key)=>key==='then'?undefined:(target as any)[key]??(()=>{})})
    const token=this.service.addKernelMsgListener(listener)
    if(typeof token!=='string'&&typeof token!=='number') {this.active=false;throw Error('SOURCE_UNAVAILABLE')}
    this.token=token
  }
  private async acknowledgedRequest(method:string,params:unknown) {
    try{return await this.wire.request(method,params)}catch(error){
      if((error as {code?:string}).code!=='ACK_UNKNOWN')throw error
      return this.wire.request(method,params)
    }
  }
  async accept(value:unknown) {
    const scope=QQImageScopeSchema.parse(value)
    if(scope.selfId!==this.self())return
    if(this.scope?.backendEpoch===scope.backendEpoch && scope.appliedRevision<this.scope.appliedRevision)return
    if(this.scope&&JSON.stringify(scope)===JSON.stringify(this.scope)&&this.acknowledged)return
    this.reset();this.scope=scope
    const generation=this.generation
    const ack=await this.acknowledgedRequest('qq.image.scope.ack',identity(scope))
    if(generation===this.generation && ack.success)this.acknowledged=true
  }
  allows(event:any) {
    const s=this.scope
    if(!s||!this.active||!this.acknowledged||!s.enabled||s.selfId!==this.self()||String(event?.self_id)!==s.selfId||String(event?.user_id)===s.selfId)return false
    return s.allowedTargets.some(t=>t.conversationType===event.message_type&&t.targetId===String(event.message_type==='group'?event.group_id:event.user_id))
  }
  reset() {this.lifetime.abort();this.lifetime=new AbortController();this.shortIds=new WeakMap();this.admissions.clear();for(const entries of this.retirees.values())for(const retire of entries)retire();this.retirees.clear();this.generation++;this.scope=undefined;this.acknowledged=false;this.queues.clear();this.seen.clear();for(const w of this.completions.values()){clearTimeout(w.timer);w.reject()}this.completions.clear()}
  private receive(m:any) {
    const scope=this.scope
    if(!scope||!this.acknowledged||!scope.enabled||scope.selfId!==this.self()||String(this.core?.selfInfo?.uin)!==scope.selfId)return
    const type=m?.chatType===2?'group':m?.chatType===1?'private':undefined
    const targetId=type==='group'?String(m.peerUid):String(m.senderUin)
    if(!type||String(m.senderUin)===scope.selfId||!scope.targets.some(t=>t.conversationType===type&&t.targetId===targetId))return
    if(!Number.isSafeInteger(Number(m.msgTime))||Number(m.msgTime)<this.startedAt)return
    if(type==='private'&&(!m.senderUid || String(m.peerUid)!==String(m.senderUid) || m.peerUin!==undefined&&String(m.peerUin)!==targetId))return
    if(!Array.isArray(m.elements))return
    const generation=this.generation
    let ordinal=0
    for(const element of m.elements) {
      if(![2,3,4,5].includes(element?.elementType))continue
      const index=ordinal++
      if(element.elementType!==2||index>=30)continue
      const p=element.picElement
      const rawIndex=m.elements.indexOf(element)
      const immutable=JSON.stringify([m.msgId,m.peerUid,m.senderUin,element.elementId,p?.fileUuid,p?.fileSize,p?.md5HexStr,p?.sourcePath])
      const key=JSON.stringify([scope.selfId,type,targetId,m.msgId,index])
      if(this.seen.has(key))continue

      if(this.seen.size>=1024)this.seen.delete(this.seen.values().next().value!)
      this.seen.add(key)
      const queue=this.queues.get(targetId)??[]
      const controller=new AbortController()
      const signal=AbortSignal.any([this.lifetime.signal,controller.signal])
      const deadlineAt=Date.now()+(QQImageQueueCapacity+1)*this.acquisitionMs
      // Reserve a position synchronously; registration itself is not in drain.
      const full=[...this.queues.values()].reduce((n,q)=>n+q.length,0)>=QQImageQueueCapacity
      const registrationWork=new Promise<void>(resolve=>setImmediate(resolve)).then(async()=>{
        if(generation!==this.generation)throw Error('STALE_SCOPE')
        const source:QQImageSource={conversationType:type,targetId,senderId:String(m.senderUin),nativeMsgId:String(m.msgId),elementOrdinal:index,
          elementId:String(element.elementId),fileUuid:String(p?.fileUuid??''),messageId:await this.bounded(this.shortId(m),signal),occurredAt:Number(m.msgTime),size:Number(p?.fileSize),nativeMd5:String(p?.md5HexStr??'')}
        const register=await this.acknowledgedRequest('qq.image.source.register',{scope:identity(scope),source,deadlineAt})
        if(!register.success)throw Error(register.error?.code??'SOURCE_UNAVAILABLE')
        const registration=QQImageResponseSchemas['qq.image.source.register'].parse(register.data)
        const authority={scope:identity(scope),...registration}
        if(full || signal.aborted || generation!==this.generation || Date.now()>=deadlineAt){await this.cancel(authority);if(signal.aborted||Date.now()>=deadlineAt)throw Error('STALE_SCOPE')}
        return {source,authority}
      })
      const admission=this.bounded(registrationWork,signal,Math.max(1,deadlineAt-Date.now()))
      const list=this.admissions.get(m)??[];list.push(admission);this.admissions.set(m,list)
      const retirees=this.retirees.get(m)??[];retirees.push(()=>controller.abort());this.retirees.set(m,retirees)
      // Keep settled exact-event results until bounded eviction; no rejection leak.
      void admission.catch(error=>{const code=String(error?.code??error?.message??'');this.diagnostic?.('register',['SOURCE_CONFLICT','SOURCE_UNAVAILABLE','INVALID_PARAMS','STALE_SCOPE','SCOPE_UNSYNCED','IDENTITY_REJECTED','QUOTA_EXCEEDED','INPUT_QUEUE_FULL'].includes(code)?code:'SOURCE_UNAVAILABLE')})
      if(this.admissions.size>1024){const oldest=this.admissions.keys().next().value;for(const retire of this.retirees.get(oldest)??[])retire();this.retirees.delete(oldest);this.admissions.delete(oldest)}
      if(full)continue
      const task={ready:false,run:async()=>{
        // The live raw object carries the same-context MessageUnique short ID after official reception.
        if(generation!==this.generation)return
        const {source,authority}=await this.bounded(admission,signal,Math.max(1,deadlineAt-Date.now()))
        const exact=()=>{if(m.elements?.[rawIndex]!==element||element.picElement!==p||JSON.stringify([m.msgId,m.peerUid,m.senderUin,element.elementId,p?.fileUuid,p?.fileSize,p?.md5HexStr,p?.sourcePath])!==immutable)throw Error('SOURCE_CONFLICT')}
        try{await this.bounded(this.acquire(source,String(p?.sourcePath??''),String(m.peerUid),generation,scope,exact,authority,signal,deadlineAt),signal,Math.max(1,Math.min(this.acquisitionMs,deadlineAt-Date.now())))}catch{await this.bounded(this.cancel(authority),signal).catch(()=>undefined)}
      }}
      queue.push(task)
      this.queues.set(targetId,queue)
      void admission.finally(()=>{task.ready=true;setImmediate(()=>{if(!this.running)void this.drain()})}).catch(()=>undefined)
    }
    if(!this.running)setImmediate(()=>{void this.drain()})
  }
  private async drain() {
    if(this.running)return;this.running=true
    try{while(this.active&&this.queues.size){const next=[...this.queues].find(([,q])=>q[0]?.ready);if(!next)break;const [key,q]=next;const task=q.shift()!;this.queues.delete(key);if(q.length)this.queues.set(key,q);try{await task.run()}catch{/* Unavailable image is not a QQ reply. */}}}finally{this.running=false}
  }
  private async cancel(authority:Record<string,unknown>) {
    const status=await this.wire.request('qq.image.ingest.status',authority).catch(()=>undefined)
    if(status?.success){const current=QQImageResponseSchemas['qq.image.ingest.status'].parse(status.data);if(current.uploadId&&current.state!=='committed')await this.acknowledgedRequest('qq.image.ingest.cancel',{...authority,uploadId:current.uploadId,reason:'source_unavailable'}).catch(()=>undefined)}
  }
  private async acquire(source:QQImageSource,filename:string,peer:string,generation:number,scope:QQImageScope,exact:()=>void,authority:Record<string,unknown>,signal:AbortSignal,deadlineAt:number) {
    const expires=Math.min(deadlineAt,Date.now()+this.acquisitionMs)
    const validate=()=>{exact();if(Date.now()>=expires||signal.aborted||generation!==this.generation||!this.acknowledged||String(this.core?.selfInfo?.uin)!==scope.selfId)throw Error('STALE_SCOPE')}
    validate()

    try {
    validate()
    const known=await this.acknowledgedRequest('qq.image.ingest.status',authority)
    if(known.success && QQImageResponseSchemas['qq.image.ingest.status'].parse(known.data).state==='committed')return
    const base=path.resolve(this.core.dataPath??'')
    const configuredBase=this.core.context?.wrapper?.NodeQQNTWrapperUtil?.getNTUserDataInfoConfig?.()
    if(configuredBase && path.resolve(configuredBase)!==base)throw Error('SOURCE_UNAVAILABLE')
    const relative=path.relative(base,filename).split(path.sep)
    if(!path.isAbsolute(filename)||relative.length<5||!/^nt_qq_[a-f0-9]{32}$/.test(relative[0]??'')||relative[1]!=='nt_data'||relative[2]!=='Pic')throw Error('SOURCE_UNAVAILABLE')
    const root=path.join(base,...relative.slice(0,3))
    let body:Buffer
    try {body=readNativeImage(root,filename,source.size,source.nativeMd5,validate)}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error
      validate()
      const completionKey=`${source.nativeMsgId}:${source.elementId}`
      const completion=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{this.completions.delete(completionKey);reject(Error('SOURCE_UNAVAILABLE'))},120000);this.completions.set(completionKey,{resolve,reject:()=>reject(Error('STALE_SCOPE')),timer})})
      const action=Promise.resolve().then(()=>this.service.downloadRichMedia({fileModelId:'0',downSourceType:0,downloadSourceType:0,triggerType:1,msgId:source.nativeMsgId,
        chatType:source.conversationType==='group'?2:1,peerUid:peer,elementId:source.elementId,thumbSize:0,downloadType:1,filePath:''}))
      let result:any,info:any
      try { [result,info]=await this.bounded(Promise.all([Promise.resolve(action),completion]),signal,Math.max(1,expires-Date.now())) }
      finally {const pending=this.completions.get(completionKey);if(pending){clearTimeout(pending.timer);this.completions.delete(completionKey)}}
      validate()
      if((result?.result!==undefined&&result.result!==0)||String(info.fileErrCode)!=='0'||String(info.fileSrvErrCode)!=='0'||info.filePath!==filename)throw Error('SOURCE_UNAVAILABLE')
      body=readNativeImage(root,filename,source.size,source.nativeMd5,validate)
    }
    const sha256=createHash('sha256').update(body).digest('hex')
    const mimeType=body[0]===255?'image/jpeg':body.subarray(0,3).toString()==='GIF'?'image/gif':body.subarray(0,4).toString()==='RIFF'?'image/webp':'image/png'
    validate()
    const begin=await this.acknowledgedRequest('qq.image.ingest.begin',{...authority,size:body.length,sha256,mimeType})
    if(!begin.success)throw Error('UPLOAD_ABORTED')
    let state=QQImageResponseSchemas['qq.image.ingest.begin'].parse(begin.data)
    if(state.state==='committed')return
    for(let offset=state.nextOffset;offset<body.length;){
      validate()
      const response=await this.wire.request('qq.image.ingest.chunk',{...authority,uploadId:state.uploadId,offset,dataBase64:body.subarray(offset,offset+65536).toString('base64')}).catch(async error=>{
        if((error as {code?:string}).code!=='ACK_UNKNOWN')throw error
        const status=await this.acknowledgedRequest('qq.image.ingest.status',authority)
        if(!status.success)return status
        const current=QQImageResponseSchemas['qq.image.ingest.status'].parse(status.data)
        validate()
        if(current.state==='uploading'&&current.uploadId===state.uploadId&&current.nextOffset===offset)
          return this.wire.request('qq.image.ingest.chunk',{...authority,uploadId:state.uploadId,offset,dataBase64:body.subarray(offset,offset+65536).toString('base64')})
        return {success:true,data:{nextOffset:current.nextOffset}}
      })
      if(!response.success)throw Error('UPLOAD_ABORTED')
      const next=QQImageResponseSchemas['qq.image.ingest.chunk'].parse(response.data).nextOffset
      if(next<=offset||next>body.length)throw Error('OFFSET_MISMATCH')
      offset=next
    }
    validate()
    const commit=await this.acknowledgedRequest('qq.image.ingest.commit',{...authority,uploadId:state.uploadId,size:body.length,sha256})
    if(!commit.success || QQImageResponseSchemas['qq.image.ingest.commit'].parse(commit.data).state!=='committed')throw Error('UPLOAD_ABORTED')
    } catch(error) {
      if(generation===this.generation) {
        const status=await this.wire.request('qq.image.ingest.status',authority).catch(()=>undefined)
        if(status?.success) {const current=QQImageResponseSchemas['qq.image.ingest.status'].parse(status.data);if(current.uploadId&&current.state==='uploading')await this.wire.request('qq.image.ingest.cancel',{...authority,uploadId:current.uploadId,reason:'source_unavailable'}).catch(()=>undefined)}
      }
      throw error
    }
  }
  close() {this.active=false;this.reset();if(this.token!==undefined){this.service.removeKernelMsgListener(this.token);this.token=undefined}}
}
