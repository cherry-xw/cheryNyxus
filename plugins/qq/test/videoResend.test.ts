import {describe,it,expect,vi} from 'vitest'
import {QQPlugin} from '../src/index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {findVideoSource,videoResendTool} from '../src/videoResend.js'
const current:any={requestId:'new',target:'group:1',input:{selfId:'9',senderId:'2',conversationType:'group'}}
const source:any={requestId:'old',target:'group:1',input:{selfId:'9',senderId:'3',messageId:'123'}}
const video:any={status:'unknown',frame:{type:'qq.reply.video',data:{requestId:'old',mediaFile:'123.mp4'}}}
describe('historical video resend',()=>{
 it('prepares a real file and queues once while preserving the old event',async()=>{
  const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'qq-resend-'))
  const old=process.env.CHERY_MEDIA_DIR;process.env.CHERY_MEDIA_DIR=root
  try{
   execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=44100:cl=stereo','-f','lavfi','-i','color=size=32x32:rate=1','-t','1','-map','0:a:0','-map','1:v:0','-c:a','mp3','-c:v','mpeg4',path.join(root,'123.mp4')])
   const job:any={...current,coreRequestId:'core',state:'running'},outbox:any[]=[structuredClone(video)]
   const plugin:any=Object.create(QQPlugin.prototype)
   Object.assign(plugin,{state:{jobs:[source,job],outbox},actionLocks:new Set(),connection:'c',recovered:true,stopped:false,paused:false,persist:vi.fn(),output:vi.fn((j:any,type:string,data:any)=>outbox.push({status:'pending',frame:{type,data:{...data,requestId:j.requestId}}}))})
   const result=await plugin.resendVideo('core','123')
   expect(result.status).toBe('queued');expect(job.videoResendSource).toBe('old')
   const file=outbox[1].frame.data.mediaFile
   expect(fs.statSync(path.join(root,file)).size).toBeGreaterThan(0)
   const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=index,codec_type,codec_name,profile','-of','json',path.join(root,file)],{encoding:'utf8'}))
   expect(probe.streams.map((s:any)=>({type:s.codec_type,codec:s.codec_name,profile:s.profile}))).toEqual([{type:'video',codec:'mpeg4',profile:'Simple Profile'},{type:'audio',codec:'aac',profile:'LC'}])
   await plugin.resendVideo('core','123')
   expect(plugin.output).toHaveBeenCalledOnce();expect(outbox[0].status).toBe('unknown')
  }finally{if(old===undefined)delete process.env.CHERY_MEDIA_DIR;else process.env.CHERY_MEDIA_DIR=old;fs.rmSync(root,{recursive:true,force:true})}
 })
 it('allows another group member to resend without mutating unknown',()=>{
  expect(findVideoSource(current,'123',[source],[video]).source).toBe(source)
  expect(video.status).toBe('unknown')
 })
 it('rejects cross-group and cross-bot sources',()=>{
  expect(()=>findVideoSource(current,'123',[{...source,target:'group:2'}],[video])).toThrow()
  expect(()=>findVideoSource(current,'123',[{...source,input:{...source.input,selfId:'8'}}],[video])).toThrow()
 })
 it('rejects in-progress or unsafe file records',()=>{
  expect(()=>findVideoSource(current,'123',[source],[{...video,status:'inflight'}])).toThrow('仍在发送')
  expect(()=>findVideoSource(current,'123',[source],[{...video,frame:{...video.frame,data:{requestId:'old',mediaFile:'../1.mp4'}}}])).toThrow('无效')
 })
 it('rejects ambiguous original messages',()=>expect(()=>findVideoSource(current,'123',[source,{...source,requestId:'other'}],[video])).toThrow('唯一'))
 it('limits private sources to the current sender',()=>{
  expect(()=>findVideoSource({...current,input:{...current.input,conversationType:'private'}},'123',[source],[video])).toThrow()
 })
 it('exposes only an original message id and requires trusted identity',async()=>{
  const run=vi.fn(async()=>({status:'queued'})),tool=videoResendTool(run).sense.executor
  await expect(tool.execute({messageId:'123'},{} as any,{} as any)).rejects.toThrow('Trusted')
  await tool.execute({messageId:'123'},{} as any,{requestView:{requestId:'r',identity:{source:'plugin',channel:'qq',subject:{conversationType:'group'}}}} as any)
  expect(run).toHaveBeenCalledWith('r','123')
  await tool.execute({messageId:'123',path:'/tmp/a'},{} as any,{requestView:{requestId:'r',identity:{source:'plugin',channel:'qq',subject:{}}}} as any)
  expect(run).toHaveBeenCalledTimes(1)
 })
})
