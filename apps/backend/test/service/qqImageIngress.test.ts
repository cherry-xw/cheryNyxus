import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { WebSocketServer } from 'ws'
import { IngressHost } from '@/service/ingress/host.js'
import { IngressStore } from '@/service/ingress/store.js'
import { createRouter } from '@/service/message/router.js'
import { createWebSocketServer } from '@/service/websocket/index.js'
import { createIngressConnections, createIngressCoreAdapter } from '@/service/ingress/coreAdapter.js'
import { getAssetStore } from '@/service/media/store.js'
import { getSoulDb } from '@/db/index.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { planFileInputs } from '@/agent/middleware/fileInputPlanning.js'
import { buildOpenAICompatibleMessages } from '@/agent/provider/openaiCompat.js'
import { createMockContext,createMockRuntime } from '../agent/helpers/fakeContext.js'
import sharp from 'sharp'
import { logger } from '@/utils/logger/index.js'
import { QQCapabilities, QQDefaultConfig, QQImageResponseSchemas, type QQImageScope } from '@chery/protocol'
import { NativeImages } from '../../../../platform/napcat-plugin/src/nativeImages.js'
import { BackendWire } from '../../../../platform/napcat-plugin/src/wire.js'
import { prepareQQFileInputs } from '../../../../plugins/qq/src/assetMessages.js'
let host:IngressHost|undefined,server:WebSocketServer|undefined,wire:BackendWire|undefined,root:string|undefined
const token='isolated-image-ingress-token'
afterEach(async()=>{wire?.close();await host?.stop();if(server){for(const c of server.clients)c.terminate();await new Promise<void>(r=>server!.close(()=>r()))}if(root)fs.rmSync(root,{recursive:true,force:true});delete process.env.QQBOT_PLATFORM_TOKEN})
async function setup(submit?:any) {
 await bootstrapAgentRuntime()
 process.env.QQBOT_PLATFORM_TOKEN=token
 root=fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!,'image-ingress-'))
 const store=new IngressStore(root),router=createRouter()
 store.install(path.resolve('plugins/qq/dist'),false,undefined,{grantedCapabilities:['ingress','rpc.business','rpc.management','tools','hooks','channel.identity','manager.ui'],channelGrants:[{channel:'qq',credentialKind:'qq'}]})
 store.setEnabled('cherynyxus-qq-module',true)
 store.saveConfig('cherynyxus-qq-module',{...QQDefaultConfig,messageMergeMs:0,selfId:'123',groups:['456'],bindings:{'group:456':'detail-test'}},0)
 const core=createIngressCoreAdapter()
 if(submit)core.submit=submit

 host=new IngressHost({store,router,core,connections:createIngressConnections()});await host.start()
 server=createWebSocketServer({port:0,host:'127.0.0.1',router,authToken:'isolated-control',channelAuth:{token,credentialKind:'qq',header:'x-qqbot-token'},listener:'local'})
 await new Promise<void>(r=>server!.once('listening',r));const port=(server.address() as {port:number}).port
 wire=new BackendWire(`ws://127.0.0.1:${port}`,token);await wire.connect()
 const call=async(method:string,params:unknown)=>{const response=await wire!.request(method,params);expect(response.success,JSON.stringify(response.error)).toBe(true);return response.data as any}
 await call('qq.plugin.hello',{protocolVersion:1,pluginVersion:'0.2.12',selfId:'123',capabilities:[...QQCapabilities]})
 await call('qq.identity.bind',{selfId:'123',sourceType:'napcat-action',validation:'accepted',verifiedAt:Date.now(),sourceVersion:'napcat'})
 const scope=await call('qq.image.scope.get',{selfId:'123'}) as QQImageScope
 const {schemaVersion,enabled,targets,limits,allowedTargets,...scopeIdentity}=scope
 void schemaVersion;void enabled;void targets;void limits;void allowedTargets
 return {call,scope,scopeIdentity,store,router}
}
it.each([false,true])('merge zero waits for delayed admitted image commit, following text=%s',async following=>{
 const submit=vi.fn(async(..._args:any[])=>({runId:'isolated-no-model'})),s=await setup(submit)
 await s.call('qq.image.scope.ack',s.scopeIdentity);await s.call('qq.request.recover',{selfId:'123'})
 const body=await sharp({create:{width:8,height:8,channels:3,background:'#246898'}}).jpeg().toBuffer(),sha256=createHash('sha256').update(body).digest('hex')
 const source={conversationType:'group',targetId:'456',senderId:'789',nativeMsgId:`delayed-native-${following}`,elementOrdinal:0,elementId:'element',fileUuid:'uuid',messageId:following?'910':'900',occurredAt:Math.floor(Date.now()/1000),size:body.length,nativeMd5:createHash('md5').update(body).digest('hex')}
 const registration=await s.call('qq.image.source.register',{scope:s.scopeIdentity,source}),authority={scope:s.scopeIdentity,...registration}
 const input={eventId:`qq:123:group:456:${source.messageId}`,selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:source.messageId,occurredAt:source.occurredAt,mentionedBot:!following,content:'question',attachments:[{type:'image'}]}
 await s.call('qq.event.submit',input)
 if(following)await s.call('qq.event.submit',{...input,eventId:'qq:123:group:456:901',messageId:'901',mentionedBot:true,attachments:[],content:'arbitrary text'})
 await new Promise(r=>setTimeout(r,80));expect(submit).not.toHaveBeenCalled()
 const begin=await s.call('qq.image.ingest.begin',{...authority,size:body.length,sha256,mimeType:'image/jpeg'})
 await s.call('qq.image.ingest.chunk',{...authority,uploadId:begin.uploadId,offset:0,dataBase64:body.toString('base64')})
 const committed=await s.call('qq.image.ingest.commit',{...authority,uploadId:begin.uploadId,size:body.length,sha256})
 await vi.waitFor(()=>expect(submit).toHaveBeenCalled())
 expect(submit.mock.calls[0]![2].parts).toContainEqual(expect.objectContaining({type:'asset',assetId:committed.assetId,assetVersionId:committed.assetVersionId,...(following?{inputOrigin:'history'}:{})}))
},20000)
it.each(['cancel','unbound'])('merge zero %s source cannot deadlock input or ordinary text',async mode=>{
 const submit=vi.fn(async(..._args:any[])=>({runId:'isolated-no-model'})),s=await setup(submit)
 await s.call('qq.image.scope.ack',s.scopeIdentity);await s.call('qq.request.recover',{selfId:'123'})
 const messageId=mode==='cancel'?'920':'930',input={eventId:`qq:123:group:456:${messageId}`,selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId,occurredAt:Math.floor(Date.now()/1000),mentionedBot:true,content:'ordinary',attachments:mode==='cancel'?[{type:'image'}]:[]}
 if(mode==='cancel'){
  const source={conversationType:'group',targetId:'456',senderId:'789',nativeMsgId:'cancel-native',elementOrdinal:0,elementId:'element',fileUuid:'uuid',messageId,occurredAt:input.occurredAt,size:10,nativeMd5:'a'.repeat(32)}
  const registration=await s.call('qq.image.source.register',{scope:s.scopeIdentity,source}),authority={scope:s.scopeIdentity,...registration}
  await s.call('qq.event.submit',input);await new Promise(r=>setTimeout(r,50));expect(submit).not.toHaveBeenCalled()
  const status=await s.call('qq.image.ingest.status',authority);await s.call('qq.image.ingest.cancel',{...authority,uploadId:status.uploadId,reason:'source_unavailable'})
 }else await s.call('qq.event.submit',input)
 await vi.waitFor(()=>expect(submit).toHaveBeenCalled());expect(submit.mock.calls[0]![2].parts?.some((p:any)=>p.type==='asset')??false).toBe(false)
},20000)
it('real wire high-water mark rejects image data while control RPC remains responsive',async()=>{
 const s=await setup(),socket=(wire as any).socket
 Object.defineProperty(socket,'bufferedAmount',{configurable:true,get:()=>524289})
 try{await expect(wire!.request('qq.image.ingest.status',{})).rejects.toMatchObject({code:'BACKPRESSURE'})
  const start=performance.now();expect((await s.call('qq.image.scope.get',{selfId:'123'})).selfId).toBe('123');expect(performance.now()-start).toBeLessThan(1000)
 }finally{delete socket.bufferedAmount}
})
it('native acquisition over real authenticated WS survives combined dropped ACKs with one asset',async()=>{
 const s=await setup(),body=await sharp({create:{width:8,height:8,channels:3,background:'#246898'}}).jpeg().toBuffer()
 const cache=path.join(root!,'nt_qq_'+'a'.repeat(32),'nt_data','Pic','2026','same-name');fs.mkdirSync(path.dirname(cache),{recursive:true});fs.writeFileSync(cache,body)
 const original=wire!.request.bind(wire),lost=new Set<string>(),calls:string[]=[]
 vi.spyOn(wire!,'request').mockImplementation(async(method,p)=>{calls.push(method);const response=await original(method,p);if(response.success&&['qq.image.scope.ack','qq.image.source.register','qq.image.ingest.begin','qq.image.ingest.chunk','qq.image.ingest.commit'].includes(method)&&!lost.has(method)){lost.add(method);throw Object.assign(Error('response discarded after server completion'),{code:'ACK_UNKNOWN'})}return response})
 let listener:any;const images=new NativeImages({dataPath:root,selfInfo:{uin:'123'},context:{session:{getMsgService:()=>({addKernelMsgListener:(l:any)=>{listener=l;return 'one'},removeKernelMsgListener:()=>{}})}}},wire!,()=> '123')
 try{images.attach();await images.accept(s.scope);listener.onRecvMsg([{chatType:2,peerUid:'456',senderUin:'789',msgId:'native-ack-combination',id:103,msgTime:String(Math.floor(Date.now()/1000)),elements:[{elementType:2,elementId:'element',picElement:{fileUuid:'uuid',fileSize:body.length,md5HexStr:createHash('md5').update(body).digest('hex'),sourcePath:cache}}]}])
  await vi.waitFor(()=>expect(calls.filter(m=>m==='qq.image.ingest.commit')).toHaveLength(2));expect(lost.size).toBe(5)
  const row=getSoulDb().prepare("SELECT source_key,asset_id,version_id,chat_id FROM ingress_image_sources WHERE identity_json LIKE '%native-ack-combination%'").get() as any
  expect(row.asset_id).toBeTruthy();expect((await getAssetStore().read(row.asset_id,{ownerId:'cherynyxus-qq-module',chatId:row.chat_id},row.version_id)).data).toEqual(body)
  expect(getSoulDb().prepare('SELECT count(*) n FROM asset_chat_grants WHERE asset_id=?').get(row.asset_id)).toEqual({n:1});expect(calls).not.toContain('qq.image.ingest.cancel')
 }finally{images.close()}
},20000)
it.each(['partial','committed'])('real WS reconnect rejects old handles and restores %s source under a new scope',async phase=>{
 const s=await setup(),body=Buffer.from([255,216,255,224,0,4,0,0,255,217]),sha256=createHash('sha256').update(body).digest('hex')
 const source={conversationType:'group',targetId:'456',senderId:'789',nativeMsgId:`reconnect-${phase}`,elementOrdinal:0,elementId:'e',fileUuid:'u',messageId:'101',occurredAt:1,size:body.length,nativeMd5:createHash('md5').update(body).digest('hex')}
 await s.call('qq.image.scope.ack',s.scopeIdentity)
 const registrations=await Promise.all(Array.from({length:8},()=>s.call('qq.image.source.register',{scope:s.scopeIdentity,source})))
 expect(new Set(registrations.map(r=>r.permitId)).size).toBe(1)
 const authority={scope:s.scopeIdentity,...registrations[0]},input={...authority,size:body.length,sha256,mimeType:'image/jpeg'}
 const begin=await s.call('qq.image.ingest.begin',input);expect(await s.call('qq.image.ingest.begin',input)).toEqual(begin)
 await s.call('qq.image.ingest.chunk',{...authority,uploadId:begin.uploadId,offset:0,dataBase64:body.subarray(0,4).toString('base64')})
 expect((await wire!.request('qq.image.ingest.chunk',{...authority,uploadId:begin.uploadId,offset:6,dataBase64:body.subarray(6).toString('base64')})).success).toBe(false)
 expect((await wire!.request('qq.image.ingest.chunk',{...authority,uploadId:begin.uploadId,offset:0,dataBase64:Buffer.alloc(4).toString('base64')})).success).toBe(false)
 let previous:any
 if(phase==='committed'){await s.call('qq.image.ingest.chunk',{...authority,uploadId:begin.uploadId,offset:4,dataBase64:body.subarray(4).toString('base64')});previous=await s.call('qq.image.ingest.commit',{...authority,uploadId:begin.uploadId,size:body.length,sha256});expect(await s.call('qq.image.ingest.commit',{...authority,uploadId:begin.uploadId,size:body.length,sha256})).toEqual(previous)}
 const port=(server!.address() as {port:number}).port;wire!.close();await vi.waitFor(()=>expect(server!.clients.size).toBe(0))
 wire=new BackendWire(`ws://127.0.0.1:${port}`,token);await wire.connect()
 await s.call('qq.plugin.hello',{protocolVersion:1,pluginVersion:'0.2.13',selfId:'123',capabilities:[...QQCapabilities]});await s.call('qq.identity.bind',{selfId:'123',sourceType:'napcat-action',validation:'accepted',verifiedAt:Date.now(),sourceVersion:'napcat'})
 const scope=await s.call('qq.image.scope.get',{selfId:'123'}),{schemaVersion,enabled,targets,limits,allowedTargets,...identity}=scope
 expect(identity.connectionGeneration).not.toBe(s.scopeIdentity.connectionGeneration)
 expect((await wire.request('qq.image.ingest.status',authority)).success).toBe(false)
 await s.call('qq.image.scope.ack',identity)
 const registration=await s.call('qq.image.source.register',{scope:identity,source}),fresh={scope:identity,...registration}
 expect(registration.permitId).not.toBe(authority.permitId)
 expect((await wire.request('qq.image.ingest.status',{...authority,scope:identity})).success).toBe(false)
 const resumed=await s.call('qq.image.ingest.begin',{...fresh,size:body.length,sha256,mimeType:'image/jpeg'})
 if(phase==='partial'){
  expect(resumed.uploadId).not.toBe(begin.uploadId);expect(resumed.nextOffset).toBe(0)
  expect((await wire.request('qq.image.ingest.chunk',{...fresh,uploadId:begin.uploadId,offset:4,dataBase64:body.subarray(4).toString('base64')})).success).toBe(false)
  await s.call('qq.image.ingest.chunk',{...fresh,uploadId:resumed.uploadId,offset:0,dataBase64:body.toString('base64')});previous=await s.call('qq.image.ingest.commit',{...fresh,uploadId:resumed.uploadId,size:body.length,sha256})
 }else expect(resumed).toEqual(previous)
 expect(await s.call('qq.image.ingest.status',fresh)).toEqual(previous)
 expect(getSoulDb().prepare('SELECT count(*) n FROM ingress_image_sources WHERE source_key=? AND state=\'committed\'').get(registration.sourceEventId)).toEqual({n:1})
},20000)
it('real authenticated WS → router → host source authority → no-job core publication → asset grant → ordered fixed parts',async()=>{
 const s=await setup(),body=await sharp({create:{width:8,height:8,channels:3,background:'#246898'}}).jpeg().toBuffer(),sha256=createHash('sha256').update(body).digest('hex')
 const source={conversationType:'group',targetId:'456',senderId:'789',nativeMsgId:'native-message',elementOrdinal:0,elementId:'element',fileUuid:'uuid',messageId:'100',occurredAt:1,size:body.length,nativeMd5:createHash('md5').update(body).digest('hex')}
 expect((await wire!.request('qq.image.source.register',{scope:s.scopeIdentity,source})).success).toBe(false)
 await s.call('qq.image.scope.ack',s.scopeIdentity)
 const registration=await s.call('qq.image.source.register',{scope:s.scopeIdentity,source})
 const headerOnly:any={selfId:'123',senderId:'789',conversationType:'group',targetId:'999'}
 let touched=false;Object.defineProperty(headerOnly,'attachments',{get(){touched=true;throw Error('must not parse')}})
 const denied=await s.router.handle({kind:'request',id:'header-denied',method:'qq.event.submit',params:headerOnly} as any,{connectionId:'wrong',credentialKind:'qq',log:logger})
 expect((denied as any).success).toBe(false);expect(touched).toBe(false)
 const forged=await s.router.handle({kind:'request',id:'control-forged',method:'qq.image.source.register',params:{scope:s.scopeIdentity,source}} as any,{connectionId:'control',credentialKind:'control',log:logger})
 expect((forged as any).success).toBe(false)
 const authority={scope:s.scopeIdentity,...registration}
 const begin=await s.call('qq.image.ingest.begin',{...authority,size:body.length,sha256,mimeType:'image/jpeg'})
 expect((await wire!.request('qq.image.ingest.chunk',{...authority,uploadId:begin.uploadId,offset:1,dataBase64:body.toString('base64')})).success).toBe(false)
 await s.call('qq.image.ingest.chunk',{...authority,uploadId:begin.uploadId,offset:0,dataBase64:body.toString('base64')})
 expect((await s.call('qq.image.ingest.status',authority)).nextOffset).toBe(body.length)
 const committed=await s.call('qq.image.ingest.commit',{...authority,uploadId:begin.uploadId,size:body.length,sha256})
 expect(QQImageResponseSchemas['qq.image.ingest.commit'].safeParse(committed).success).toBe(true)
 expect(await s.call('qq.image.ingest.status',authority)).toEqual(committed)
 const freshCore=createIngressCoreAdapter()
 const state=JSON.parse(fs.readFileSync(s.store.safe('data/cherynyxus-qq-module/state.json'),'utf8'))
 expect(state.jobs).toHaveLength(0);expect(Object.keys(state.receipts)).toHaveLength(0)
 const key=Object.keys(state.imageSources)[0]!,known=state.imageSources[key]
 await freshCore.ensureConversation('cherynyxus-qq-module',key,'detail-test')
 const recoveredRefs=await freshCore.sourceReferences!('cherynyxus-qq-module',key)
 expect(Object.values(recoveredRefs)).toContainEqual(expect.objectContaining({assetId:committed.assetId,assetVersionId:committed.assetVersionId}))
 const row=getSoulDb().prepare('SELECT chat_id FROM ingress_image_sources WHERE source_key=?').get(registration.sourceEventId) as {chat_id:string}
 expect((await getAssetStore().read(committed.assetId,{ownerId:'cherynyxus-qq-module',chatId:row.chat_id},committed.assetVersionId)).data).toEqual(body)
 const load=vi.fn(),message:any={eventId:'qq:123:group:456:100',selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:'100',occurredAt:1,mentionedBot:false,content:'beforeafter',attachments:[{type:'image'}],parts:[{type:'text',text:'before'},{type:'attachment',index:0},{type:'text',text:'after'}]}
 const parts=await prepareQQFileInputs([message],load,new AbortController().signal,{messages:[message],known,save(){},validate:async part=>{getAssetStore().get(part.assetId,{ownerId:'cherynyxus-qq-module',chatId:row.chat_id},part.assetVersionId)}})
 expect(parts?.map(p=>p.type)).toEqual(['text','text','asset','text']);expect(load).not.toHaveBeenCalled()
 const ctx=createMockContext({runtime:createMockRuntime({brain:{provider:'openai',protocol:'openai-chat-completions',capabilities:{input:{image:'supported'},imageInput:{formats:['image/jpeg']}}}})});ctx.soul.chatId=row.chat_id
 const plan=await planFileInputs(ctx,[{id:'native-ingress',role:'user',content:'beforeafter',parts,createdAt:1,updateAt:1}])
 const content=buildOpenAICompatibleMessages(plan.history,plan.attachments)[0]!.content as Array<{type:string;image_url?:{url:string}}>
 expect(Buffer.from(content.find(p=>p.type==='image_url')!.image_url!.url.split(',')[1]!,'base64')).toEqual(body)
 expect(JSON.stringify(parts)).not.toContain('url')
 const cfg=s.store.readConfig('cherynyxus-qq-module')!
 await host!.saveConfig('cherynyxus-qq-module',{...cfg.config as any,groups:[],bindings:{}},cfg.revision)
 expect((await wire!.request('qq.image.ingest.status',authority)).success).toBe(false)
 await expect(getAssetStore().read(committed.assetId,{ownerId:'cherynyxus-qq-module',chatId:row.chat_id},committed.assetVersionId)).rejects.toThrow('无权')
 expect(fs.existsSync(s.store.safe('data/cherynyxus-qq-module/state.json'))).toBe(true)
},20000)

it.each([false,true])('queued raw admission fixes the third asset only after commit; following text=%s',async following=>{
 const submit=vi.fn(async(..._args:any[])=>({runId:'isolated-no-model'})),s=await setup(submit)
 await s.call('qq.request.recover',{selfId:'123'})
 const body=await sharp({create:{width:8,height:8,channels:3,background:'#246898'}}).jpeg().toBuffer()
 const dir=path.join(root!,'nt_qq_'+'a'.repeat(32),'nt_data','Pic','2026');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'third'),body)
 let listener:any;const requests:string[]=[];const original=wire!.request.bind(wire!)
 vi.spyOn(wire!,'request').mockImplementation((method,p)=>{requests.push(method);return original(method,p)})
 const images=new NativeImages({dataPath:root,selfInfo:{uin:'123'},context:{session:{getMsgService:()=>({addKernelMsgListener:(l:any)=>{listener=l;return 'one'},removeKernelMsgListener(){},downloadRichMedia:()=>new Promise(()=>{})})}}},wire!,()=> '123',350)
 try{images.attach();await images.accept(s.scope)
 const messages=['first','second','third'].map((name,i)=>({chatType:2,peerUid:'456',senderUin:'789',msgId:`queued-${following}-${name}`,id:1200+i,msgTime:String(Math.floor(Date.now()/1000)),elements:[{elementType:2,elementId:name,picElement:{fileUuid:name,fileSize:body.length,md5HexStr:createHash('md5').update(body).digest('hex'),sourcePath:path.join(dir,name)}}]}))
 listener.onRecvMsg(messages)
 await images.admit({message_id:1202,message_type:'group',group_id:456,user_id:789})
 const thirdBefore=getSoulDb().prepare('SELECT state FROM ingress_image_sources WHERE identity_json LIKE ?').get(`%queued-${following}-third%`)
 expect(thirdBefore).toMatchObject({state:'uploading'})
 expect(requests.filter(m=>m==='qq.image.source.register')).toHaveLength(3)
 await s.call('qq.event.submit',{eventId:'qq:123:group:456:1202',selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:'1202',occurredAt:Math.floor(Date.now()/1000),mentionedBot:!following,content:'third cached image',attachments:[{type:'image'}]})
 if(following)await s.call('qq.event.submit',{eventId:'qq:123:group:456:1203',selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:'1203',occurredAt:Math.floor(Date.now()/1000),mentionedBot:true,content:'arbitrary following text',attachments:[]})
 await new Promise(r=>setTimeout(r,80));expect(submit).not.toHaveBeenCalled()
 await vi.waitFor(()=>expect(submit).toHaveBeenCalled(),{timeout:4000})
 const fixed=submit.mock.calls[0]![2].parts
 const late=getSoulDb().prepare('SELECT state,asset_id,version_id,chat_id FROM ingress_image_sources WHERE identity_json LIKE ?').get(`%queued-${following}-third%`) as any
 expect(late.state).toBe('committed');expect(late.asset_id).toBeTruthy()
 expect(fixed).toContainEqual(expect.objectContaining({type:'asset',assetId:late.asset_id,assetVersionId:late.version_id}))
 expect((await getAssetStore().read(late.asset_id,{ownerId:'cherynyxus-qq-module',chatId:late.chat_id},late.version_id)).data).toEqual(body)
 console.log('QUEUED_REGRESSION',JSON.stringify({thirdBeforeAdmission:thirdBefore,fixedParts:fixed,finalThird:late,following}))
 }finally{images.close()}
},20000)

it('admission deadline aborts queued source before fixation and rejects late upload',async()=>{
 const submit=vi.fn(async(..._args:any[])=>({runId:'isolated-no-model'})),s=await setup(submit)
 await s.call('qq.image.scope.ack',s.scopeIdentity);await s.call('qq.request.recover',{selfId:'123'})
 const source={conversationType:'group',targetId:'456',senderId:'789',nativeMsgId:'deadline-source',elementOrdinal:0,elementId:'e',fileUuid:'u',messageId:'1400',occurredAt:Math.floor(Date.now()/1000),size:10,nativeMd5:'a'.repeat(32)}
 const registration=await s.call('qq.image.source.register',{scope:s.scopeIdentity,source,deadlineAt:Date.now()+250}),authority={scope:s.scopeIdentity,...registration}
 expect((await s.call('qq.image.ingest.status',authority)).state).toBe('queued')
 await s.call('qq.event.submit',{eventId:'qq:123:group:456:1400',selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:'1400',occurredAt:source.occurredAt,mentionedBot:true,content:'deadline',attachments:[{type:'image'}]})
 await new Promise(r=>setTimeout(r,40));expect(submit).not.toHaveBeenCalled()
 await vi.waitFor(()=>expect(submit).toHaveBeenCalled())
 expect(submit.mock.calls[0]![2].parts.some((p:any)=>p.type==='asset')).toBe(false)
 expect((await s.call('qq.image.ingest.status',authority)).state).toBe('aborted')
 expect(getSoulDb().prepare('SELECT state FROM ingress_image_sources WHERE source_key=?').get(registration.sourceEventId)).toEqual({state:'aborted'})
 expect((await wire!.request('qq.image.ingest.begin',{...authority,size:10,sha256:'a'.repeat(64),mimeType:'image/jpeg'})).success).toBe(false)
},20000)

it('lost register ACK delayed past one acquisition still admits exact queued source before input',async()=>{
 const submit=vi.fn(async(..._args:any[])=>({runId:'isolated-no-model'})),s=await setup(submit)
 await s.call('qq.request.recover',{selfId:'123'})
 const body=await sharp({create:{width:8,height:8,channels:3,background:'#246898'}}).jpeg().toBuffer(),dir=path.join(root!,'nt_qq_'+'b'.repeat(32),'nt_data','Pic','2026');fs.mkdirSync(dir,{recursive:true});const cache=path.join(dir,'ack');fs.writeFileSync(cache,body)
 const original=wire!.request.bind(wire!);let lost=false;const trace:string[]=[]
 vi.spyOn(wire!,'request').mockImplementation(async(method,p)=>{const response=await original(method,p);if(method==='qq.image.source.register'&&response.success&&!lost){lost=true;trace.push('host-registration-complete');await new Promise(r=>setTimeout(r,180));throw Object.assign(Error('ACK lost'),{code:'ACK_UNKNOWN'})}if(method==='qq.image.ingest.commit'&&response.success)trace.push('host-commit-complete');return response})
 let listener:any;const images=new NativeImages({dataPath:root,selfInfo:{uin:'123'},context:{session:{getMsgService:()=>({addKernelMsgListener:(l:any)=>{listener=l;return 'one'},removeKernelMsgListener(){}})}}},wire!,()=> '123',80)
 try{images.attach();await images.accept(s.scope);listener.onRecvMsg([{chatType:2,peerUid:'456',senderUin:'789',msgId:'register-ack-late',id:1500,msgTime:String(Math.floor(Date.now()/1000)),elements:[{elementType:2,elementId:'e',picElement:{fileUuid:'u',fileSize:body.length,md5HexStr:createHash('md5').update(body).digest('hex'),sourcePath:cache}}]}])
 let done=false;const wait=images.admit({message_id:1500,message_type:'group',group_id:456,user_id:789}).then(()=>{done=true;trace.push('event-admitted')})
 await new Promise(r=>setTimeout(r,100));expect(done).toBe(false);expect(submit).not.toHaveBeenCalled();await wait
 await s.call('qq.event.submit',{eventId:'qq:123:group:456:1500',selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:'1500',occurredAt:Math.floor(Date.now()/1000),mentionedBot:true,content:'late ack',attachments:[{type:'image'}]})
 await vi.waitFor(()=>expect(submit).toHaveBeenCalled());expect(submit.mock.calls[0]![2].parts).toContainEqual(expect.objectContaining({type:'asset'}));expect(trace.indexOf('event-admitted')).toBeGreaterThan(trace.indexOf('host-registration-complete'));console.log('ACK_ORDER',trace)
 }finally{images.close()}
},20000)
it('revoking scope releases a pending fixed-input waiter without late publication',async()=>{
 const submit=vi.fn(async(..._args:any[])=>({runId:'isolated-no-model'})),s=await setup(submit)
 await s.call('qq.image.scope.ack',s.scopeIdentity);await s.call('qq.request.recover',{selfId:'123'})
 const source={conversationType:'group',targetId:'456',senderId:'789',nativeMsgId:'revoke-waiter',elementOrdinal:0,elementId:'e',fileUuid:'u',messageId:'1600',occurredAt:Math.floor(Date.now()/1000),size:10,nativeMd5:'b'.repeat(32)}
 const registration=await s.call('qq.image.source.register',{scope:s.scopeIdentity,source})
 await s.call('qq.event.submit',{eventId:'qq:123:group:456:1600',selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:'1600',occurredAt:source.occurredAt,mentionedBot:true,content:'pending revoke',attachments:[{type:'image'}]})
 await new Promise(r=>setTimeout(r,50));expect(submit).not.toHaveBeenCalled()
 const cfg=s.store.readConfig('cherynyxus-qq-module')!;await host!.saveConfig('cherynyxus-qq-module',{...cfg.config as any,groups:[],bindings:{}},cfg.revision)
 await vi.waitFor(()=>expect(getSoulDb().prepare('SELECT state FROM ingress_image_sources WHERE source_key=?').get(registration.sourceEventId)).toEqual({state:'aborted'}))
 expect((await wire!.request('qq.image.ingest.status',{scope:s.scopeIdentity,...registration})).success).toBe(false)
},20000)

it('real host records overflowing native sources as aborted before event submission',async()=>{
 const s=await setup();const body=await sharp({create:{width:8,height:8,channels:3,background:'#246898'}}).jpeg().toBuffer(),dir=path.join(root!,'nt_qq_'+'c'.repeat(32),'nt_data','Pic','2026');fs.mkdirSync(dir,{recursive:true})
 let listener:any;const images=new NativeImages({dataPath:root,selfInfo:{uin:'123'},context:{session:{getMsgService:()=>({addKernelMsgListener:(l:any)=>{listener=l;return 'one'},removeKernelMsgListener(){},downloadRichMedia:()=>new Promise(()=>{})})}}},wire!,()=> '123',100)
 try{images.attach();await images.accept(s.scope);listener.onRecvMsg(Array.from({length:34},(_,i)=>({chatType:2,peerUid:'456',senderUin:'789',msgId:`host-overflow-${i}`,id:1700+i,msgTime:String(Math.floor(Date.now()/1000)),elements:[{elementType:2,elementId:'e',picElement:{fileUuid:'u',fileSize:body.length,md5HexStr:createHash('md5').update(body).digest('hex'),sourcePath:path.join(dir,`missing-${i}`)}}]})))
 await images.admit({message_id:1733,message_type:'group',group_id:456,user_id:789})
 const rows=getSoulDb().prepare("SELECT identity_json,state,asset_id FROM ingress_image_sources WHERE identity_json LIKE '%host-overflow-%'").all() as any[]
 expect(rows).toHaveLength(34)
 for(const i of [32,33])expect(rows.find(r=>r.identity_json.includes(`host-overflow-${i}`))).toMatchObject({state:'aborted',asset_id:null})
 }finally{images.close()}
},20000)
