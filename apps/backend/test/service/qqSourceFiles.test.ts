import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireSourceZips, readSourceFile } from '../../../../platform/napcat-plugin/src/sourceFiles.js'
import type { BackendChannel } from '../../../../platform/napcat-plugin/src/wire.js'
import type { QQEventSubmitRequest } from '@chery/protocol'

const roots:string[]=[]
afterEach(()=>{vi.unstubAllGlobals();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true})})
const body=Buffer.concat([Buffer.from([80,75,3,4]),Buffer.alloc(70000,65)])
function fixture(type:'group'|'private'='group') {
  const root=fs.mkdtempSync('/tmp/opencode/qq-source-files-');roots.push(root)
  const native={type:'file',data:{file_id:'official-id',file_name:'example.zip',size:body.length}}
  const input:QQEventSubmitRequest={eventId:`qq:100:${type}:${type==='group'?'999':'123'}:1`,selfId:'100',conversationType:type,targetId:type==='group'?'999':'123',senderId:'123',senderName:'成员',
    messageId:'1',mentionedBot:true,occurredAt:1,content:'',sourceParts:[{type:'attachment',partId:'p0',attachmentId:'wire'}],attachments:[{partId:'p0',type:'file',name:'example.zip'}]}
  let received=0,committed=false
  const request=vi.fn(async(method:string,params:any)=>{
    if(method==='qq.source.file.import')return {success:false,error:{code:'FILE_DOWNLOAD_FAILED'}}
    if(method==='qq.source.file.chunk'){expect(params.offset).toBe(received);received+=Buffer.from(params.dataBase64,'base64').length;return {success:true,data:{nextOffset:received}}}
    if(method==='qq.source.file.unavailable')return {success:true,data:{recorded:true}}
    if(method==='qq.source.file.commit'){expect(received).toBe(body.length);committed=true}
    return {success:true,data:{state:committed?'committed':'uploading',nextOffset:received,uploadId:'upload',...(committed?{assetId:'asset',assetVersionId:'version'}:{})}}
  })
  const action=vi.fn(async(_name:string,_params:unknown)=>({data:{url:'https://files.example.test/official'}}))
  const access={wire:{request} as unknown as BackendChannel,action,dataRoot:root,signal:new AbortController().signal,validate:vi.fn()}
  return {root,native,input,raw:{message:[native]},request,action,access}
}
describe('offline NapCat source ZIP acquisition',()=>{
  it.each(['group','private'] as const)('obtains the official %s URL and streams bounded chunks after Backend import fails',async type=>{
    const f=fixture(type),fetch=vi.fn(async()=>new Response(body))
    vi.stubGlobal('fetch',fetch)
    await acquireSourceZips(f.raw,f.input,f.access)
    expect(f.action).toHaveBeenCalledWith(type==='group'?'get_group_file_url':'get_private_file_url',type==='group'?{group_id:'999',file_id:'official-id'}:{user_id:'123',file_id:'official-id'})
    expect(f.request.mock.calls.filter(([method])=>method==='qq.source.file.chunk')).toHaveLength(2)
    expect(f.request).toHaveBeenCalledWith('qq.source.file.commit',expect.objectContaining({eventId:f.input.eventId,partId:'p0',size:body.length,sha256:createHash('sha256').update(body).digest('hex')}))
    expect(f.request.mock.calls.some(([method])=>method==='qq.source.file.unavailable')).toBe(false)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it('recovers lost chunk and commit acknowledgements through status, without repeating the physical chunks',async()=>{
    const f=fixture(),request=f.request.getMockImplementation()!
    f.request.mockImplementation(async(method,params)=>{
      const result=await request(method,params)
      if(method==='qq.source.file.chunk'||method==='qq.source.file.commit')throw new Error('synthetic lost acknowledgement')
      return result
    })
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(body)))
    await acquireSourceZips(f.raw,f.input,f.access)
    expect(f.request.mock.calls.filter(([method])=>method==='qq.source.file.chunk')).toHaveLength(2)
    expect(f.request.mock.calls.filter(([method])=>method==='qq.source.file.commit')).toHaveLength(1)
    expect(f.request.mock.calls.filter(([method])=>method==='qq.source.file.status')).toHaveLength(3)
    expect(f.request.mock.calls.some(([method])=>method==='qq.source.file.unavailable')).toBe(false)
  })
  it('uses only an official get_file path under the data root, rejects links and rechecks authorization while reading',async()=>{
    const f=fixture(),filename=path.join(f.root,'download.zip')
    fs.writeFileSync(filename,body)
    f.action.mockImplementation(async name=>name==='get_file'?{data:{file:filename}}:{data:{}})
    vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('No network path expected')}))
    await acquireSourceZips(f.raw,f.input,f.access)
    expect(f.request).toHaveBeenCalledWith('qq.source.file.commit',expect.anything())
    const symlink=path.join(f.root,'symlink.zip'),hardlink=path.join(f.root,'hardlink.zip')
    fs.symlinkSync(filename,symlink)
    expect(()=>readSourceFile(f.root,symlink,()=>{})).toThrow()
    fs.linkSync(filename,hardlink)
    expect(()=>readSourceFile(f.root,hardlink,()=>{})).toThrow('FILE_INVALID')
    fs.unlinkSync(hardlink)
    expect(()=>readSourceFile(f.root,filename,()=>{throw new Error('revoked')})).toThrow('revoked')
    expect(()=>readSourceFile(f.root,path.join(f.root,'..','outside.zip'),()=>{})).toThrow('SOURCE_UNAVAILABLE')
  })
  it('never treats a raw event path as readable or publishes malformed bytes as a ZIP',async()=>{
    const f=fixture();(f.native.data as any).file=path.join(f.root,'untrusted.zip')
    fs.writeFileSync((f.native.data as any).file,body)
    f.action.mockResolvedValue({data:{url:'https://files.example.test/official'}})
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(Buffer.alloc(body.length))))
    await acquireSourceZips(f.raw,f.input,f.access)
    expect(f.request).toHaveBeenCalledWith('qq.source.file.unavailable',expect.objectContaining({reasonCode:'FILE_INVALID'}))
    expect(f.request.mock.calls.some(([method])=>method==='qq.source.file.begin'||method==='qq.source.file.commit')).toBe(false)
  })
})
