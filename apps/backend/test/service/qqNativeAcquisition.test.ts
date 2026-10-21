import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeImages } from '../../../../platform/napcat-plugin/src/nativeImages.js'
import { QQImagePolicyDefault, type QQImageScope } from '@chery/protocol'
const roots:string[]=[]
it.each(['valid','wrong-group','wrong-sender','wrong-time','wrong-self'])('native callback clone without id resolves running action mapping %s',async mode=>{
 const f=fixture();delete f.message.id
 const lookup=vi.fn(async(nativeMsgId:string)=>{expect(nativeMsgId).toBe('native-msg');return {self_id:mode==='wrong-self'?999:123,user_id:mode==='wrong-sender'?888:789,message_type:'group',group_id:mode==='wrong-group'?999:456,time:Number(f.message.msgTime)+(mode==='wrong-time'?1:0),message_id:100}})
 ;(f.images as any).lookupMessage=lookup
 try{await f.images.accept(f.scope);f.callbacks[0].onRecvMsg([f.message]);
  if(mode==='valid'){await f.images.admit({message_id:100,message_type:'group',group_id:456,user_id:789});await vi.waitFor(()=>expect(f.requests.some(r=>r[0]==='qq.image.ingest.commit')).toBe(true));expect(f.requests.find(r=>r[0]==='qq.image.source.register')[1].source.messageId).toBe('100')}
  else{await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));expect(f.requests.some(r=>r[0]==='qq.image.source.register')).toBe(false);expect(f.calls()).toBe(0)}
  expect(lookup).toHaveBeenCalledTimes(1)
 }finally{f.images.close()}
})
it('OneBot admission waits for exact raw source registration, not acquisition or a guessed filename',async()=>{
 const f=fixture();let release:(v:any)=>void=()=>{};const original=f.wire.request.getMockImplementation()
 f.wire.request.mockImplementation((method:string,p:any)=>method==='qq.image.source.register'?new Promise(r=>{release=r}):original(method,p))
 try{await f.images.accept(f.scope);f.callbacks[0].onRecvMsg([f.message]);let done=false
  const admission=f.images.admit({message_id:100,message_type:'group',group_id:456,user_id:789}).then(()=>{done=true})
  await new Promise(r=>setImmediate(r));expect(done).toBe(false)
  await f.images.admit({message_id:100,message_type:'group',group_id:999,user_id:789})
  release({success:true,data:{sourceEventId:'source',permitId:'permit'}});await admission;expect(done).toBe(true)
 }finally{f.images.close()}
})
it.each(['deadline','reset','scope','reconnect'])('completion with pending action releases global acquisition on %s and another target succeeds',async mode=>{
 let resolveAction:(v:any)=>void=()=>{},started=false
 const f=fixture(true,80,(input,cache,callbacks)=>{started=true;callbacks[0].onRichMediaDownloadComplete({msgId:input.msgId,msgElementId:input.elementId,filePath:cache,fileErrCode:0,fileSrvErrCode:0});return new Promise(r=>{resolveAction=r})})
 const cache=f.message.elements[0].picElement.sourcePath

 try{const scope={...f.scope,targets:[...f.scope.targets,{conversationType:'group' as const,targetId:'999',bindingId:'p'}]};await f.images.accept(scope);f.callbacks[0].onRecvMsg([f.message]);await vi.waitFor(()=>expect(started).toBe(true))
  if(mode==='reset'||mode==='reconnect')f.images.reset()
  if(mode!=='deadline')await f.images.accept({...scope,connectionGeneration:'next',sessionId:'next'})
  fs.writeFileSync(cache,f.body)
  f.callbacks[0].onRecvMsg([{...f.message,msgId:'second',id:101,peerUid:'999'}])
  await vi.waitFor(()=>expect(f.requests.filter(r=>r[0]==='qq.image.ingest.commit')).toHaveLength(1))
  resolveAction({result:0});await new Promise(r=>setImmediate(r));expect(f.requests.filter(r=>r[0]==='qq.image.ingest.begin')).toHaveLength(1)
 }finally{f.images.close()}
})
it('unknown chunk ACK with unchanged durable offset retries the same chunk once',async()=>{
 const f=fixture();const original=f.wire.request.getMockImplementation();let dropped=false
 f.wire.request.mockImplementation(async(method:string,p:any)=>{if(method==='qq.image.ingest.chunk'&&!dropped){dropped=true;throw Object.assign(Error('not processed'),{code:'ACK_UNKNOWN'})}return original(method,p)})
 try{await f.images.accept(f.scope);f.callbacks[0].onRecvMsg([f.message]);await vi.waitFor(()=>expect(f.requests.some(r=>r[0]==='qq.image.ingest.commit')).toBe(true));expect(dropped).toBe(true);expect(f.requests.some(r=>r[0]==='qq.image.ingest.cancel')).toBe(false)}finally{f.images.close()}
})
it('combined lost scope/register/begin/chunk/commit ACKs complete once without cancelling',async()=>{
 const f=fixture();const original=f.wire.request.getMockImplementation(),lost=new Set<string>();let offset=0,committed=false
 f.wire.request.mockImplementation(async(method:string,p:any)=>{
  const response=await original(method,p)
  if(method==='qq.image.ingest.chunk')offset=f.body.length
  if(method==='qq.image.ingest.commit')committed=true
  if(method==='qq.image.ingest.status')return {success:true,data:committed?{state:'committed',nextOffset:offset,uploadId:'upload',assetId:'asset',assetVersionId:'version'}:{state:'uploading',nextOffset:offset,uploadId:'upload'}}
  if(['qq.image.scope.ack','qq.image.source.register','qq.image.ingest.begin','qq.image.ingest.chunk','qq.image.ingest.commit'].includes(method)&&!lost.has(method)){lost.add(method);throw Object.assign(Error('lost'),{code:'ACK_UNKNOWN'})}
  return response
 })
 try{await f.images.accept(f.scope);f.callbacks[0].onRecvMsg([f.message]);await vi.waitFor(()=>expect(f.requests.filter(r=>r[0]==='qq.image.ingest.commit')).toHaveLength(2));expect(lost.size).toBe(5);expect(f.requests.filter(r=>r[0]==='qq.image.ingest.chunk')).toHaveLength(1);expect(f.requests.some(r=>r[0]==='qq.image.ingest.cancel')).toBe(false)}finally{f.images.close()}
})
it.each(['reorder','replace','uuid'])('raw %s while registration waits never reads or publishes a different element',async kind=>{
 const f=fixture(true);let release:(v:any)=>void=()=>{};const original=f.wire.request.getMockImplementation()
 f.wire.request.mockImplementation((method:string,p:any)=>method==='qq.image.source.register'?new Promise(r=>{release=r}):original(method,p))
 try{await f.images.accept(f.scope);f.callbacks[0].onRecvMsg([f.message]);await new Promise(r=>setImmediate(r))
  if(kind==='reorder')f.message.elements.unshift({elementType:2,elementId:'other'})
  if(kind==='replace')f.message.elements[0]={...f.message.elements[0]}
  if(kind==='uuid')f.message.elements[0].picElement.fileUuid='changed'
  release({success:true,data:{sourceEventId:'source',permitId:'permit'}});await new Promise(r=>setImmediate(r));expect(f.calls()).toBe(0);expect(f.requests.some(r=>r[0]==='qq.image.ingest.begin')).toBe(false)
 }finally{f.images.close()}
})
it('bounded queue rotates targets and preserves per-target FIFO under 32 admitted images',async()=>{
 const f=fixture();try{const targets=['456','998','999'];await f.images.accept({...f.scope,targets:targets.map(targetId=>({conversationType:'group' as const,targetId,bindingId:'p'}))})
 const messages=Array.from({length:32},(_,i)=>({...f.message,peerUid:targets[i%3],msgId:`native-${i}`,id:200+i,elements:[{...f.message.elements[0],elementId:`e-${i}`}]}))
 f.callbacks[0].onRecvMsg(messages);await vi.waitFor(()=>expect(f.requests.filter(r=>r[0]==='qq.image.ingest.commit')).toHaveLength(32))
 const sources=f.requests.filter(r=>r[0]==='qq.image.source.register').map(r=>r[1].source);expect(sources.slice(0,3).map(s=>s.targetId)).toEqual(targets)
 for(const target of targets)expect(sources.filter(s=>s.targetId===target).map(s=>s.nativeMsgId)).toEqual(messages.filter(m=>m.peerUid===target).map(m=>m.msgId))
 expect(f.callbacks).toHaveLength(1)
 }finally{f.images.close()}
})
it('late old-scope ACK cannot authorize new scope; old completions cannot publish after reconnect',async()=>{
 const f=fixture();const original=f.wire.request.getMockImplementation();let release:(v:any)=>void=()=>{}
 f.wire.request.mockImplementation((method:string,p:any)=>method==='qq.image.scope.ack'&&p.connectionGeneration==='gen'?new Promise(r=>{release=r}):original(method,p))
 try{const pending=f.images.accept(f.scope);f.images.reset();const next={...f.scope,connectionGeneration:'new',sessionId:'new'};await f.images.accept(next);release({success:true,data:{acknowledged:true}});await pending;f.callbacks[0].onRecvMsg([f.message]);await vi.waitFor(()=>expect(f.requests.some(r=>r[0]==='qq.image.ingest.commit')).toBe(true));expect(f.requests.find(r=>r[0]==='qq.image.source.register')[1].scope.connectionGeneration).toBe('new')}finally{f.images.close()}
})
afterEach(()=>{for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true})})
function fixture(miss=false,acquisitionMs=120000,download?:(input:any,cache:string,callbacks:any[])=>Promise<any>) {
 const root=fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!,'raw-native-'));roots.push(root)
 const body=Buffer.from([255,216,255,224,0,4,0,0,255,217]),cache=path.join(root,'nt_qq_'+'a'.repeat(32),'nt_data','Pic','2026','image');fs.mkdirSync(path.dirname(cache),{recursive:true});if(!miss)fs.writeFileSync(cache,body)
 const callbacks:any[]=[];let calls=0,removed=0
 const core={dataPath:root,selfInfo:{uin:'123'},context:{session:{getMsgService:()=>({addKernelMsgListener:(listener:any)=>{callbacks.push(listener);return 'native-token'},removeKernelMsgListener:()=>{removed++},downloadRichMedia:async(input:any)=>{calls++;if(download)return download(input,cache,callbacks);fs.writeFileSync(cache,body);callbacks[0].onRichMediaDownloadComplete({msgId:input.msgId,msgElementId:input.elementId,filePath:cache,fileErrCode:0,fileSrvErrCode:0});return {result:0}}})}}}
 const requests:any[]=[]
 const wire:any={request:vi.fn(async(method:string,p:any)=>{requests.push([method,p]);return {success:true,data:method==='qq.image.scope.ack'?{acknowledged:true}:method==='qq.image.source.register'?{sourceEventId:'source',permitId:'permit'}:method==='qq.image.ingest.status'?{state:'uploading',nextOffset:0,uploadId:'upload'}:method==='qq.image.ingest.begin'?{state:'uploading',nextOffset:0,uploadId:'upload'}:method==='qq.image.ingest.chunk'?{nextOffset:body.length}:{state:'committed',nextOffset:body.length,uploadId:'upload',assetId:'asset',assetVersionId:'version'}}})}
 const images=new NativeImages(core,wire,()=>core.selfInfo.uin,acquisitionMs)
 const scope:QQImageScope={schemaVersion:1,backendEpoch:'epoch',connectionGeneration:'gen',sessionId:'session',selfId:'123',appliedRevision:1,scopeDigest:'a'.repeat(64),enabled:true,allowedTargets:[{conversationType:'group',targetId:'456'}],limits:QQImagePolicyDefault,targets:[{conversationType:'group',targetId:'456',bindingId:'p'}]}
 const message:any={chatType:2,peerUid:'456',senderUin:'789',msgId:'native-msg',id:100,msgTime:String(Math.floor(Date.now()/1000)),elements:[{elementType:2,elementId:'element',picElement:{fileUuid:'uuid',fileSize:body.length,md5HexStr:createHash('md5').update(body).digest('hex'),sourcePath:cache}}]}
 images.attach()
 return {images,scope,message,requests,callbacks,core,wire,calls:()=>calls,removed:()=>removed,body}
}
it.each([false,true])('native cache hit/miss=%s uses exact source and one dispatcher; never URL/get_file',async miss=>{
 const f=fixture(miss)
 try{await f.images.accept(f.scope);f.callbacks[0].onRecvMsg([f.message]);await vi.waitFor(()=>expect(f.requests.some(r=>r[0]==='qq.image.ingest.commit')).toBe(true))
 expect(f.calls()).toBe(miss?1:0);expect(f.callbacks).toHaveLength(1)
 expect(f.requests.find(r=>r[0]==='qq.image.source.register')[1].source).toMatchObject({nativeMsgId:'native-msg',elementId:'element',messageId:'100',elementOrdinal:0,fileUuid:'uuid'})
 expect(Buffer.from(f.requests.find(r=>r[0]==='qq.image.ingest.chunk')[1].dataBase64,'base64')).toEqual(f.body)
 f.callbacks[0].onRecvMsg([f.message]);await new Promise(r=>setImmediate(r));expect(f.requests.filter(r=>r[0]==='qq.image.source.register')).toHaveLength(1)
 }finally{f.images.close();expect(f.removed()).toBe(1)}
})
it('unacknowledged/unallowed/raw-self headers never touch elements; reset invalidates completion tasks',async()=>{
 const f=fixture()
 try{Object.defineProperty(f.message,'elements',{get(){throw Error('must not inspect')}})
 f.callbacks[0].onRecvMsg([f.message]);await f.images.accept(f.scope)
 f.message.peerUid='999';f.callbacks[0].onRecvMsg([f.message]);f.images.reset();expect(f.requests.filter(r=>r[0]==='qq.image.source.register')).toHaveLength(0)
 }finally{f.images.close()}
})
it.each(['account','self','private-peer','old-message','missing-binding'])('fails closed for %s before image elements',async kind=>{
 const f=fixture();try{await f.images.accept(f.scope);Object.defineProperty(f.message,'elements',{get(){throw Error('must not inspect')}})
  if(kind==='account')f.core.selfInfo.uin='999'
  if(kind==='self')f.message.senderUin='123'
  if(kind==='private-peer'){await f.images.accept({...f.scope,targets:[{conversationType:'private',targetId:'789',bindingId:'p'}]});f.message.chatType=1;f.message.peerUid='other';f.message.senderUid='uid'}
  if(kind==='old-message')f.message.msgTime='1'
  if(kind==='missing-binding')await f.images.accept({...f.scope,targets:[],scopeDigest:'b'.repeat(64)})
  f.callbacks[0].onRecvMsg([f.message]);await new Promise(r=>setImmediate(r));expect(f.requests.filter(r=>r[0]==='qq.image.source.register')).toHaveLength(0)
 }finally{f.images.close()}
})
it('multiple image positions and target round robin retain exact tuples without per-image listeners',async()=>{
 const f=fixture();try{await f.images.accept({...f.scope,targets:[...f.scope.targets,{conversationType:'group',targetId:'999',bindingId:'p'}]})
 const second={...f.message.elements[0],elementId:'element-2',picElement:{...f.message.elements[0].picElement,fileUuid:'uuid-2'}}
 f.message.elements.push(second)
 const other={...f.message,msgId:'other-native',id:101,peerUid:'999',elements:[f.message.elements[0]]}
 f.callbacks[0].onRecvMsg([f.message,other]);await vi.waitFor(()=>expect(f.requests.filter(r=>r[0]==='qq.image.ingest.commit')).toHaveLength(3))
 const sources=f.requests.filter(r=>r[0]==='qq.image.source.register').map(r=>r[1].source)
 expect(sources.map(s=>[s.targetId,s.elementOrdinal,s.elementId])).toEqual([['456',0,'element'],['456',1,'element-2'],['999',0,'element']]);expect(f.callbacks).toHaveLength(1)
 }finally{f.images.close()}
})
it('scope reset during registration discards delayed acquisition before native read',async()=>{
 const f=fixture(true);try{await f.images.accept(f.scope)
  let release:(value:any)=>void=()=>{};const request=f.wire.request.getMockImplementation()
  f.wire.request.mockImplementation((method:string,p:any)=>method==='qq.image.source.register'?new Promise(resolve=>{release=resolve}):request(method,p))
  f.callbacks[0].onRecvMsg([f.message]);await new Promise(r=>setImmediate(r));f.images.reset();release({success:true,data:{sourceEventId:'source',permitId:'permit'}})
  await new Promise(r=>setImmediate(r));expect(f.calls()).toBe(0);expect(f.requests.filter(r=>r[0]==='qq.image.ingest.begin')).toHaveLength(0)
 }finally{f.images.close()}
})
it.each(['backendEpoch','connectionGeneration','sessionId','scopeDigest'])('scope %s change cancels queued raw references and requires fresh ACK',async key=>{
 const f=fixture(true);try{await f.images.accept(f.scope)
  let release:(v:any)=>void=()=>{};const original=f.wire.request.getMockImplementation()
  f.wire.request.mockImplementation((method:string,p:any)=>method==='qq.image.source.register'?new Promise(resolve=>{release=resolve}):original(method,p))
  f.callbacks[0].onRecvMsg([f.message]);await new Promise(r=>setImmediate(r))
  const next={...f.scope,[key]:key==='scopeDigest'?'b'.repeat(64):'new-generation'};await f.images.accept(next)
  release({success:true,data:{sourceEventId:'source',permitId:'permit'}});await new Promise(r=>setImmediate(r));expect(f.calls()).toBe(0)
  expect(f.requests.filter(r=>r[0]==='qq.image.scope.ack')).toHaveLength(2)
 }finally{f.images.close()}
})



it('registration blocked for one exact message does not delay unrelated text or another target',async()=>{
 const f=fixture();const original=f.wire.request.getMockImplementation();let release:(v:any)=>void=()=>{}
 f.wire.request.mockImplementation((method:string,p:any)=>method==='qq.image.source.register'&&p.source.nativeMsgId==='native-msg'?new Promise(r=>{release=r}):original(method,p))
 try{await f.images.accept({...f.scope,targets:[...f.scope.targets,{conversationType:'group',targetId:'999',bindingId:'p'}]});f.callbacks[0].onRecvMsg([f.message,{...f.message,peerUid:'999',msgId:'fast',id:101}])
 let admitted=false;const wait=f.images.admit({message_id:100,message_type:'group',group_id:456,user_id:789}).then(()=>{admitted=true})
 await f.images.admit({message_id:102,message_type:'group',group_id:456,user_id:789});expect(admitted).toBe(false)
 await vi.waitFor(()=>expect(f.requests.some(r=>r[0]==='qq.image.ingest.commit')).toBe(true));expect(admitted).toBe(false)
 release({success:true,data:{sourceEventId:'slow-source',permitId:'slow-permit'}});await wait
 }finally{f.images.close()}
})
it.each(['reset','close'])('blocked registration admission exits on %s and late registration never reads',async mode=>{
 const f=fixture(true);let release:(v:any)=>void=()=>{};const original=f.wire.request.getMockImplementation()
 f.wire.request.mockImplementation((method:string,p:any)=>method==='qq.image.source.register'?new Promise(r=>{release=r}):original(method,p))
 try{await f.images.accept(f.scope);f.callbacks[0].onRecvMsg([f.message]);const wait=f.images.admit({message_id:100,message_type:'group',group_id:456,user_id:789});const rejected=expect(wait).rejects.toThrow('STALE_SCOPE')
 await new Promise(r=>setImmediate(r));if(mode==='close')f.images.close();else f.images.reset();await rejected
 release({success:true,data:{sourceEventId:'source',permitId:'permit'}});await new Promise(r=>setImmediate(r));expect(f.calls()).toBe(0);expect(f.requests.some(r=>r[0]==='qq.image.ingest.begin')).toBe(false)
 }finally{f.images.close()}
})
it('queue overflow is registered and cancelled, never silently acquired later',async()=>{
 const f=fixture(true,100,()=>new Promise(()=>{}));const original=f.wire.request.getMockImplementation()
 f.wire.request.mockImplementation((method:string,p:any)=>method==='qq.image.ingest.cancel'?Promise.resolve({success:true,data:{cancelled:true}}):original(method,p))
 try{await f.images.accept(f.scope);f.callbacks[0].onRecvMsg(Array.from({length:34},(_,i)=>({...f.message,msgId:`full-${i}`,id:500+i})))
 await f.images.admit({message_id:533,message_type:'group',group_id:456,user_id:789})
 expect(f.requests.filter(r=>r[0]==='qq.image.source.register')).toHaveLength(34)
 expect(f.wire.request.mock.calls.filter(([m]:any[])=>m==='qq.image.ingest.cancel').length).toBeGreaterThanOrEqual(2)
 expect(f.requests.filter(r=>r[0]==='qq.image.ingest.begin')).toHaveLength(0)
 }finally{f.images.close()}
})

it('acquisition rotates targets after a slow source, while registration remains independent',async()=>{
 const f=fixture(true,60,()=>new Promise(()=>{}));const original=f.wire.request.getMockImplementation(),sources=new Map<string,string>(),begins:string[]=[]
 f.wire.request.mockImplementation(async(method:string,p:any)=>{
 if(method==='qq.image.source.register'){const id=p.source.nativeMsgId;sources.set(id,p.source.targetId);return {success:true,data:{sourceEventId:id,permitId:id}}}
 if(method==='qq.image.ingest.begin')begins.push(p.sourceEventId)
 return original(method,p)
 })
 try{await f.images.accept({...f.scope,targets:[...f.scope.targets,{conversationType:'group',targetId:'999',bindingId:'p'}]});f.callbacks[0].onRecvMsg([f.message]);await vi.waitFor(()=>expect(f.calls()).toBe(1))
 fs.writeFileSync(f.message.elements[0].picElement.sourcePath,f.body)
 f.callbacks[0].onRecvMsg([{...f.message,msgId:'same-1',id:201},{...f.message,msgId:'same-2',id:202},{...f.message,peerUid:'999',msgId:'other-1',id:203}])
 await f.images.admit({message_id:203,message_type:'group',group_id:999,user_id:789});expect(sources.size).toBe(4)
 await vi.waitFor(()=>expect(begins).toHaveLength(3));expect(begins).toEqual(['same-1','other-1','same-2'])
 }finally{f.images.close()}
})
