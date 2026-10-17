import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'
import type { Job, Outbox } from './state.js'

type Registration = Parameters<IngressContext['tools']['register']>[0]
export function findVideoSource(current: Job, messageId: string, jobs: Job[], outbox: Outbox[]) {
 const sources=jobs.filter(j=>j.requestId!==current.requestId && j.input.selfId===current.input.selfId && j.target===current.target &&
  (current.input.conversationType==='group' || j.input.senderId===current.input.senderId) &&
  [j.input,...(j.mergedInputs??[])].some(m=>m.messageId===messageId))
 if(sources.length!==1) throw new Error('未找到唯一的本会话视频原消息，请查询现有历史或澄清对象')
 const source=sources[0]!
 if(jobs.some(j=>j.requestId!==current.requestId && j.target===current.target && j.videoResendSource===source.requestId && ['queued','running','sending','paused'].includes(j.state))) throw new Error('该视频已有重发任务，不重复排队')
 const videos=outbox.filter(o=>o.frame.data.requestId===source.requestId && o.frame.type==='qq.reply.video')
 if(videos.length!==1) throw new Error('这条原消息没有可复用的已下载视频')
 const video=videos[0]!
 if(['pending','inflight'].includes(video.status)) throw new Error('原视频仍在发送，不重复排队')
 if(!/^\d+\.mp4$/.test(video.frame.data.mediaFile??'')) throw new Error('视频文件记录无效')
 if(outbox.some(o=>o.frame.type==='qq.reply.video' && o.frame.data.mediaFile===video.frame.data.mediaFile && ['pending','inflight'].includes(o.status))) throw new Error('视频仍在发送')
 return {source,video}
}
export function videoResendTool(run:(requestId:string,messageId:string)=>Promise<unknown>):Registration {
 const schema=z.object({messageId:z.string().regex(/^-?\d+$/)}).strict()
 const description='把当前会话历史原分享消息对应的已下载视频再发送一次。先用上下文或现有qq_information历史查询确定原分享消息ID，不能猜ID或文件路径。群里针对明确视频问“怎么没发”“视频呢”就是催发，直接执行，无须再次确认；仅查原因或明确不要发送时不调用。多个对象不明确才询问。可发送本群其他成员的分享，不跨群、不跨私聊。文件失效不自动重新下载。排队不是发送成功。'
 return {sense:{definition:{type:'function',function:{name:'qq_video_resend',description,parameters:z.toJSONSchema(schema) as any}},supervisionLevel:0,executor:{schema,execute:async(input,_shared,ctx)=>{
  const view=ctx?.requestView
  if(view?.identity.source!=='plugin'||view.identity.channel!=='qq'||!view.identity.subject) throw new Error('Trusted QQ request required')
  ctx?.signal?.throwIfAborted()
  try{return {status:'ok',content:JSON.stringify(await run(view.requestId,schema.parse(input).messageId))}}
  catch(e){return {status:'provider_error',errorCode:'provider_error',content:JSON.stringify({ok:false,error:e instanceof Error?e.message:'视频重发失败'})}}
 }}},metadata:{label:'重发历史视频',description,icon:'qq',doc:description}}
}
