import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initAssetTables } from '@/db/assets.js'
import { AssetStore } from '@/service/media/assetStore.js'
import { SourcePublicationStore, type SourcePublicationContext } from '@/service/media/sourcePublication.js'
import { readNativeImage } from '../../../../platform/napcat-plugin/src/nativeImageRead.js'
import { QQImageRequestSchemas, QQImagePolicyDefault } from '@chery/protocol'
import { spawnSync } from 'node:child_process'
const roots:string[]=[]
afterEach(()=>{for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true})})
function fixture() {
 const root=fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!,'native-source-'));roots.push(root)
 const db=new Database(path.join(root,'db'));db.pragma('foreign_keys=ON');db.exec("CREATE TABLE chats(id TEXT PRIMARY KEY);INSERT INTO chats VALUES('chat'),('other')");initAssetTables(db)
 const assets=new AssetStore(db,path.join(root,'assets')),store=new SourcePublicationStore(db,path.join(root,'staging'),assets)
 const body=Buffer.from([255,216,255,224,0,4,0,0,255,217]),sha256=createHash('sha256').update(body).digest('hex')
 let allowed=true
 const c:SourcePublicationContext={ownerId:'owner',chatId:'chat',sourceKey:'source',sourceIdentity:'exact-source',targetKey:'group:123',limits:QQImagePolicyDefault,validate:()=>{if(!allowed)throw Error('IDENTITY_REJECTED')}}
 return {root,db,assets,store,body,sha256,c,revoke:()=>{allowed=false},begin:()=>store.begin(c,{size:body.length,sha256,mimeType:'image/jpeg'})}
}
describe('host image source publication',()=>{
 it('recovery during two real asynchronous publications cannot remove either live copy',async()=>{
  const f=fixture();try{
   const publish=(sourceKey:string)=>f.assets.publishSource(f.body,{ownerId:'owner',chatId:'chat',originalName:'fixture',mimeType:'image/jpeg',kind:'image',sourceKey,validate(){},published(){}})
   const one=publish('one'),two=publish('two'),done=Promise.all([one,two])
   for(let i=0;i<8;i++){await new Promise(r=>setImmediate(r));new AssetStore(f.db,path.join(f.root,'assets')).recoverPublications()}
   const results=await done;expect(results).toHaveLength(2)
   for(const asset of results)expect((await f.assets.read(asset.id,{ownerId:'owner',chatId:'chat'},asset.versionId)).data).toEqual(f.body)
   expect(fs.readdirSync(path.join(f.root,'assets','staging'))).toEqual([])
  }finally{f.db.close()}
 })
 it('asset recovery preserves live publication journals, unknown files and symlink targets',async()=>{
  const f=fixture();try{
   const dir=path.join(f.root,'assets','staging');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'user-file'),'keep')
   const id='11111111-1111-1111-1111-111111111111',link='22222222-2222-2222-2222-222222222222'
   fs.writeFileSync(path.join(dir,id),'live');fs.symlinkSync(path.join(dir,'user-file'),path.join(dir,link))
   const start=fs.readFileSync(`/proc/${process.pid}/stat`,'utf8').split(') ').pop()!.split(' ')[19]!
   const insert=f.db.prepare('INSERT INTO asset_staging_publications VALUES (?,?,?,?)');insert.run(id,process.pid,start,f.sha256);insert.run(link,2147483647,'dead',f.sha256)
   new AssetStore(f.db,path.join(f.root,'assets')).recoverPublications()
   expect(fs.readFileSync(path.join(dir,id),'utf8')).toBe('live');expect(fs.readFileSync(path.join(dir,'user-file'),'utf8')).toBe('keep');expect(fs.lstatSync(path.join(dir,link)).isSymbolicLink()).toBe(true)
   expect(f.db.prepare('SELECT file_id FROM asset_staging_publications').all()).toEqual([{file_id:id}])
  }finally{f.db.close()}
 })
 it('global and target quotas release independently; cancelled handles cannot resume',()=>{
  const f=fixture();try{
   const c={...f.c,limits:{singleBytes:20,totalBytes:30,perTargetBytes:20}},b={...c,sourceKey:'b'},other={...c,sourceKey:'other',targetKey:'group:999'}
   const input={size:10,sha256:f.sha256,mimeType:'image/jpeg'},a=f.store.begin(c,input),second=f.store.begin(b,input)
   expect(()=>f.store.begin({...c,sourceKey:'third'},input)).toThrow('QUOTA_EXCEEDED')
   f.store.begin(other,input);expect(()=>f.store.begin({...other,sourceKey:'fourth'},input)).toThrow('QUOTA_EXCEEDED')
   f.store.cancel(b,second.uploadId!);expect(f.store.begin({...other,sourceKey:'fourth'},input).state).toBe('uploading')
   expect(()=>f.store.chunk(b,{uploadId:second.uploadId!,offset:0,dataBase64:f.body.toString('base64')})).toThrow('UPLOAD_ABORTED')
   f.store.cancel(c,a.uploadId!);expect(f.store.begin({...c,sourceKey:'third'},input).state).toBe('uploading')
  }finally{f.db.close()}
 })
 it('concurrent commits cancelled during asynchronous publication cannot grant or duplicate assets',async()=>{
  const f=fixture();try{const a=f.begin();f.store.chunk(f.c,{uploadId:a.uploadId!,offset:0,dataBase64:f.body.toString('base64')})
   let resume:()=>void=()=>{};const gate=new Promise<void>(r=>{resume=r}),original=f.assets.publishSource.bind(f.assets)
   vi.spyOn(f.assets,'publishSource').mockImplementation(async(body,options)=>{await gate;return original(body,options)})
   const input={uploadId:a.uploadId!,size:f.body.length,sha256:f.sha256},one=f.store.commit(f.c,input),two=f.store.commit(f.c,input)
   const settled=Promise.allSettled([one,two]);f.store.cancel(f.c,a.uploadId!);resume();expect((await settled).every(r=>r.status==='rejected')).toBe(true)
   expect(f.store.status(f.c).state).toBe('aborted');expect(f.db.prepare('SELECT count(*) n FROM assets').get()).toEqual({n:0});expect(f.db.prepare('SELECT count(*) n FROM asset_chat_grants').get()).toEqual({n:0})
  }finally{f.db.close()}
 })
 it.each(['reserve','chunk','assetcopy','asset','source','ack'])('survives real SIGKILL at %s without duplicate publication',async stage=>{
  const f=fixture();f.db.close()
  const child=spawnSync(process.execPath,['--import','tsx',path.resolve('docs/plan/qq-image-context/verify/crash-publication.mts'),f.root,stage],{cwd:process.cwd(),encoding:'utf8',env:process.env})
  expect(child.signal,child.stderr).toBe('SIGKILL');expect(fs.readFileSync(path.join(f.root,'reached'),'utf8')).toBe(stage)
  const db=new Database(path.join(f.root,'db'));db.pragma('foreign_keys=ON');const assets=new AssetStore(db,path.join(f.root,'assets')),store=new SourcePublicationStore(db,path.join(f.root,'staging'),assets)
  try{store.recover();expect(fs.existsSync(path.join(f.root,'assets','staging'))?fs.readdirSync(path.join(f.root,'assets','staging')):[]).toEqual([]);expect(db.prepare('SELECT count(*) n FROM asset_staging_publications').get()).toEqual({n:0});const c={...f.c,sourceIdentity:'identity',targetKey:'group:1'};const state=store.status(c)
   if(stage==='ack')expect(state.state).toBe('committed')
   else {expect(state.state).toBe('uploading');expect(db.prepare('SELECT count(*) n FROM assets').get()).toEqual({n:0});const started=store.begin(c,{size:f.body.length,sha256:f.sha256,mimeType:'image/jpeg'});if(started.nextOffset===0)store.chunk(c,{uploadId:started.uploadId!,offset:0,dataBase64:f.body.toString('base64')});await store.commit(c,{uploadId:started.uploadId!,size:f.body.length,sha256:f.sha256})}
   expect(db.prepare('SELECT count(*) n FROM assets').get()).toEqual({n:1});expect(db.prepare('SELECT count(*) n FROM asset_chat_grants').get()).toEqual({n:1})
   expect(fs.readdirSync(path.join(f.root,'staging'))).toEqual(['owned.json'])
  }finally{db.close()}
 },15000)
 it('publishes one fixed asset and grant atomically; ACK loss and restart reuse same mapping',async()=>{
  const f=fixture();try{
   const begin=f.begin(),dataBase64=f.body.toString('base64');const uploadId=begin.uploadId!
   expect(f.store.chunk(f.c,{uploadId,offset:0,dataBase64})).toEqual({nextOffset:f.body.length})
   expect(f.store.chunk(f.c,{uploadId,offset:0,dataBase64})).toEqual({nextOffset:f.body.length})
   const result=await f.store.commit(f.c,{uploadId,size:f.body.length,sha256:f.sha256})
   expect(result.state).toBe('committed');expect((await f.assets.read(result.assetId!,{ownerId:'owner',chatId:'chat'},result.assetVersionId)).data).toEqual(f.body)
   const reopened=new SourcePublicationStore(f.db,path.join(f.root,'staging'),f.assets);reopened.recover()
   expect(reopened.status(f.c)).toEqual(result);expect(f.begin()).toEqual(result)
   expect(await reopened.commit(f.c,{uploadId,size:f.body.length,sha256:f.sha256})).toEqual(result)
   expect(reopened.cancel(f.c,uploadId)).toEqual({cancelled:false})
   expect(f.db.prepare('SELECT count(*) n FROM assets').get()).toEqual({n:1})
   expect(f.db.prepare('SELECT count(*) n FROM asset_chat_grants').get()).toEqual({n:1})
   f.db.prepare('DELETE FROM asset_references').run();expect(f.assets.cleanup(Date.now()+1000*86400000)).toBe(0)
   expect(()=>f.assets.get(result.assetId!,{ownerId:'other',chatId:'chat'})).toThrow()
   expect(()=>f.assets.get(result.assetId!,{ownerId:'owner',chatId:'other'})).toThrow()
  }finally{f.db.close()}
 })
 it('quota reserves before chunks, cancellation releases but committed bytes remain charged',async()=>{
  const f=fixture();try{
   f.c.limits={singleBytes:20,totalBytes:15,perTargetBytes:15};const a=f.begin()
   expect(()=>f.store.begin({...f.c,sourceKey:'second'},{size:10,sha256:f.sha256,mimeType:'image/jpeg'})).toThrow('QUOTA_EXCEEDED')
   f.store.cancel(f.c,a.uploadId!);expect(f.begin().state).toBe('uploading')
  }finally{f.db.close()}
 })
 it('rejects offsets, noncanonical bytes, conflicting source digest and cross owner without leaking asset',async()=>{
  const f=fixture();try{const a=f.begin(),uploadId=a.uploadId!
   expect(()=>f.store.chunk(f.c,{uploadId,offset:1,dataBase64:f.body.toString('base64')})).toThrow('OFFSET_MISMATCH')
   expect(()=>f.store.chunk(f.c,{uploadId,offset:0,dataBase64:'!!!!'})).toThrow('FILE_INVALID')
   expect(()=>f.store.chunk({...f.c,ownerId:'other'},{uploadId,offset:0,dataBase64:'AAAA'})).toThrow('SOURCE_CONFLICT')
   expect(()=>f.store.begin(f.c,{size:f.body.length,sha256:'0'.repeat(64),mimeType:'image/jpeg'})).toThrow('SOURCE_CONFLICT')
   await expect(f.store.commit(f.c,{uploadId,size:f.body.length,sha256:f.sha256})).rejects.toThrow('OFFSET_MISMATCH')
   f.store.chunk(f.c,{uploadId,offset:0,dataBase64:Buffer.alloc(f.body.length).toString('base64')})
   await expect(f.store.commit(f.c,{uploadId,size:f.body.length,sha256:f.sha256})).rejects.toThrow('DIGEST_MISMATCH')
   expect(f.db.prepare('SELECT count(*) n FROM assets').get()).toEqual({n:0})
  }finally{f.db.close()}
 })
 it('revocation at final save rolls back asset/grant/source transaction',async()=>{
  const f=fixture();try{const a=f.begin(),uploadId=a.uploadId!;f.store.chunk(f.c,{uploadId,offset:0,dataBase64:f.body.toString('base64')})
   const original=f.assets.publishSource.bind(f.assets)
   vi.spyOn(f.assets,'publishSource').mockImplementation(async(body,options)=>{f.revoke();return original(body,options)})
   await expect(f.store.commit(f.c,{uploadId,size:f.body.length,sha256:f.sha256})).rejects.toThrow('IDENTITY_REJECTED')
   expect(f.db.prepare('SELECT count(*) n FROM assets').get()).toEqual({n:0})
   expect(f.db.prepare('SELECT count(*) n FROM asset_chat_grants').get()).toEqual({n:0})
  }finally{f.db.close()}
 })
 it('recovery truncates disk-ahead unacknowledged bytes, rejects missing and symbolic staging',()=>{
  const f=fixture();try{const a=f.begin(),filename=path.join(f.root,'staging',a.uploadId!);fs.appendFileSync(filename,'unacknowledged');f.store.recover();expect(fs.statSync(filename).size).toBe(0)
   fs.unlinkSync(filename);fs.symlinkSync(path.join(f.root,'db'),filename);f.store.recover();expect(f.store.status(f.c).state).toBe('aborted');expect(fs.lstatSync(filename).isSymbolicLink()).toBe(true)
  }finally{f.db.close()}
 })
})
it('disk exhaustion never publishes or acknowledges unwritten chunks',()=>{
 const f=fixture();try{const a=f.begin();const write=vi.spyOn(fs,'writeSync').mockImplementation(()=>{throw Object.assign(Error('disk'),{code:'ENOSPC'})})
  try{expect(()=>f.store.chunk(f.c,{uploadId:a.uploadId!,offset:0,dataBase64:f.body.toString('base64')})).toThrow();expect(f.store.status(f.c).nextOffset).toBe(0);expect(f.db.prepare('SELECT count(*) n FROM assets').get()).toEqual({n:0})}finally{write.mockRestore()}
 }finally{f.db.close()}
})
describe('anchored native image reads',()=>{
 it.each([8,16,32])('bounded %s-target multi-image load preserves FD, reservations and recovery',async count=>{
  const f=fixture();try{
   const beforeFd=fs.readdirSync('/proc/self/fd').length,beforeRss=process.memoryUsage().rss
   const chunk=Buffer.alloc(65536,7),size=1048576,digest=createHash('sha256');for(let n=0;n<16;n++)digest.update(chunk);const sha256=digest.digest('hex')
   const targets=Array.from({length:count*2},(_,i)=>({...f.c,sourceKey:`load-${i}`,sourceIdentity:`identity-${i}`,targetKey:`group:${Math.floor(i/2)}`}))
   const uploads=targets.map(c=>f.store.begin(c,{size,sha256,mimeType:'image/jpeg'}))
   const start=performance.now();for(let offset=0;offset<size;offset+=chunk.length)for(const [i,c] of targets.entries())f.store.chunk(c,{uploadId:uploads[i]!.uploadId!,offset,dataBase64:chunk.toString('base64')})
   expect(f.db.prepare("SELECT SUM(size) reserved,SUM(received) received FROM ingress_image_sources WHERE state='uploading'").get()).toEqual({reserved:count*2*size,received:count*2*size})
   expect(fs.readdirSync('/proc/self/fd').length).toBe(beforeFd)
   const elapsedMs=performance.now()-start,rssDelta=process.memoryUsage().rss-beforeRss
   f.store.recover();expect(f.store.status(targets[0]!).nextOffset).toBe(size)
   expect(rssDelta).toBeLessThan(256*1024*1024)
   for(const [i,c] of targets.entries())f.store.cancel(c,uploads[i]!.uploadId!)
   expect(f.db.prepare("SELECT COUNT(*) n FROM ingress_image_sources WHERE state='uploading'").get()).toEqual({n:0})
   if(process.env.QQ_IMAGE_RESOURCE_EVIDENCE)fs.appendFileSync(process.env.QQ_IMAGE_RESOURCE_EVIDENCE,JSON.stringify({targets:count,images:count*2,bytes:size*count*2,chunkBytes:65536,elapsedMs,rssDelta,beforeFd,afterFd:fs.readdirSync('/proc/self/fd').length})+'\n')
  }finally{f.db.close()}
 },20000)
 it('real low-FD child exhausts descriptors and closes partially walked directories',()=>{
  const f=fixture();try{const cache=path.join(f.root,'cache');fs.mkdirSync(cache);const filename=path.join(cache,'image');fs.writeFileSync(filename,f.body)
   const script=`import fs from 'node:fs';import {readNativeImage} from ${JSON.stringify(path.resolve('platform/napcat-plugin/src/nativeImageRead.ts'))};const baseline=fs.readdirSync('/proc/self/fd').length;const held=[];try{while(true)held.push(fs.openSync('/dev/null','r'))}catch(e){if(e.code!=='EMFILE')throw e}for(let i=0;i<3;i++)fs.closeSync(held.pop());let failed=false;try{readNativeImage(${JSON.stringify(cache)},${JSON.stringify(filename)},10,'${createHash('md5').update(f.body).digest('hex')}',()=>{})}catch(e){failed=e.code==='EMFILE'}for(const fd of held)fs.closeSync(fd);if(!failed)process.exit(2);const before=fs.readdirSync('/proc/self/fd').length;if(before!==baseline)process.exit(4);readNativeImage(${JSON.stringify(cache)},${JSON.stringify(filename)},10,'${createHash('md5').update(f.body).digest('hex')}',()=>{});if(fs.readdirSync('/proc/self/fd').length!==before)process.exit(3);console.log('real EMFILE recovered')`
   const result=spawnSync('bash',['-c','ulimit -n 64; exec "$@"','bash',process.execPath,'--import','tsx','--input-type=module','-e',script],{encoding:'utf8',env:process.env});expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('real EMFILE recovered')
  }finally{f.db.close()}
 })
 it('matches exact size and native MD5 without leaking descriptors; rejects parents, leaf symlinks and mutation',()=>{
  const f=fixture();try{const cache=path.join(f.root,'cache');fs.mkdirSync(cache);const file=path.join(cache,'image');fs.writeFileSync(file,f.body);const md5=createHash('md5').update(f.body).digest('hex')
   expect(readNativeImage(cache,file,f.body.length,md5,()=>{})).toEqual(f.body)
   expect(()=>readNativeImage(cache,file,f.body.length+1,md5,()=>{})).toThrow()
   expect(()=>readNativeImage(cache,file,f.body.length,'0'.repeat(32),()=>{})).toThrow()
   fs.symlinkSync(file,path.join(cache,'alias'));expect(()=>readNativeImage(cache,path.join(cache,'alias'),f.body.length,md5,()=>{})).toThrow()
   fs.symlinkSync(cache,path.join(f.root,'alias'));expect(()=>readNativeImage(path.join(f.root,'alias'),path.join(f.root,'alias','image'),f.body.length,md5,()=>{})).toThrow()
   const fifo=path.join(cache,'fifo');expect(spawnSync('mkfifo',[fifo]).status).toBe(0);expect(()=>readNativeImage(cache,fifo,f.body.length,md5,()=>{})).toThrow()
   let calls=0;expect(()=>readNativeImage(cache,file,f.body.length,md5,()=>{if(++calls===2)fs.writeFileSync(file,Buffer.alloc(f.body.length,1))})).toThrow()
   fs.writeFileSync(file,f.body)
   expect(()=>readNativeImage(cache,path.join(f.root,'db'),f.body.length,md5,()=>{})).toThrow()
   expect(()=>readNativeImage(cache,file,f.body.length,md5,()=>{throw Error('cancelled')})).toThrow('cancelled')
  }finally{f.db.close()}
 })
 it('shared schema rejects arbitrary paths, URL, unsafe offsets and invalid base64',()=>{
  const scope={backendEpoch:'epoch',connectionGeneration:'generation',sessionId:'session',selfId:'123',appliedRevision:1,scopeDigest:'a'.repeat(64)}
  const p={scope,sourceEventId:'source',permitId:'permit',uploadId:'upload',offset:0,dataBase64:'AAAA'}
  expect(QQImageRequestSchemas['qq.image.ingest.chunk'].safeParse(p).success).toBe(true)
  for(const extra of [{path:'/cache/file'},{url:'https://example.invalid'},{offset:Number.MAX_SAFE_INTEGER+1},{offset:-1},{dataBase64:'!!!!'}])expect(QQImageRequestSchemas['qq.image.ingest.chunk'].safeParse({...p,...extra}).success).toBe(false)
 })
})
