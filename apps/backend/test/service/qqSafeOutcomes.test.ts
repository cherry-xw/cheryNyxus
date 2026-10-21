import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocketServer } from 'ws'
import { IngressHost } from '@/service/ingress/host.js'
import { IngressStore } from '@/service/ingress/store.js'
import { createRouter } from '@/service/message/router.js'
import { createWebSocketServer } from '@/service/websocket/index.js'
import { createIngressConnections, createIngressCoreAdapter } from '@/service/ingress/coreAdapter.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import config from '@/utils/config.js'
import { getMessages } from '@/db/message.js'
import { getInteraction } from '@/db/interaction.js'
import { getSoulDb } from '@/db/index.js'
import { addSenseBrain } from '../agent/helpers/mockScripts.js'
import { resetMockProviderState } from '@/agent/provider/mock.js'
import * as chatSend from '@/service/chat/send.js'
import { BackendWire } from '../../../../platform/napcat-plugin/src/wire.js'
import { Adapter } from '../../../../platform/napcat-plugin/src/adapter.js'
import { ErrorCode, ErrorId, RunOutcomeReasonCode, UserFeedbackSchema, QQCapabilities, QQDefaultConfig, publicOutcomeText, runFailureFeedback, feedbackForRpcError } from '@chery/protocol'
import { jsonRequest } from '@/agent/provider/fetchBase.js'
import { compose } from '@/core/middleware/compose.js'
import { streamAgentChunks } from '@/service/chat/streamMapper.js'
import { createMockContext } from '../agent/helpers/fakeContext.js'

let host: IngressHost | undefined, server: WebSocketServer | undefined, wire: BackendWire | undefined, root: string | undefined
const token = 'isolated-safe-outcome-token'
afterEach(async () => { vi.restoreAllMocks(); wire?.close(); await host?.stop(); if (server) { for (const c of server.clients) c.terminate(); await new Promise<void>(r => server!.close(() => r())) }; if (root) fs.rmSync(root, {recursive:true,force:true}); delete process.env.QQBOT_PLATFORM_TOKEN })
async function setup() {
  await bootstrapAgentRuntime()
  process.env.QQBOT_PLATFORM_TOKEN = token
  root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'qq-safe-'))
  const store = new IngressStore(root), router = createRouter(), core = createIngressCoreAdapter()
  store.install(path.resolve(import.meta.dirname, '../../../../plugins/qq/dist'), false, undefined, { grantedCapabilities: ['ingress','rpc.business','rpc.management','tools','hooks','channel.identity','manager.ui'], channelGrants: [{channel:'qq',credentialKind:'qq'}] })
  store.setEnabled('cherynyxus-qq-module',true)
  const presetId=randomUUID()
  config.presets['detail-test']!.id=presetId
  store.saveConfig('cherynyxus-qq-module', {...QQDefaultConfig,messageMergeMs:0,selfId:'123',groups:['456'],users:['789'],bindings:{'group:456':'detail-test','private:user:789':'detail-test'},memoryEnabled:false},0)

  host = new IngressHost({store,router,core,connections:createIngressConnections()}); await host.start()
  server = createWebSocketServer({port:0,host:'127.0.0.1',router,authToken:'isolated-control',channelAuth:{token,credentialKind:'qq',header:'x-qqbot-token'},listener:'local'})
  await new Promise<void>(r => server!.once('listening',r))
  wire = new BackendWire(`ws://127.0.0.1:${(server.address() as {port:number}).port}`,token); await wire.connect()
  const call = async (method:string,params:unknown) => { const response=await wire!.request(method,params); expect(response.success,JSON.stringify(response.error)).toBe(true);return response.data as any }
  await call('qq.plugin.hello',{protocolVersion:1,pluginVersion:'0.2.14',selfId:'123',capabilities:[...QQCapabilities]})
  await call('qq.identity.bind',{selfId:'123',sourceType:'napcat-action',validation:'accepted',verifiedAt:Date.now(),sourceVersion:'napcat'})
  await call('qq.request.recover',{selfId:'123'})
  const state=()=>JSON.parse(fs.readFileSync(store.safe('data/cherynyxus-qq-module/state.json'),'utf8'))
  return {store,core,call,state}
}
const event = (id:string, extra:object={}) => ({eventId:`qq:123:group:456:${id}`,selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:id,occurredAt:Math.floor(Date.now()/1000),mentionedBot:true,content:'offline request',attachments:[],...extra})

describe('public registry exhaustiveness and privacy',()=>{
  it.each(Object.values(ErrorCode))('RPC code %s has valid safe feedback',code=>{
    const f=feedbackForRpcError({code,message:'secret /private/path https://secret.invalid?key=secret',source:'system',tracingId:'0123abcd',retryable:false})
    expect(UserFeedbackSchema.safeParse(f).success).toBe(true)
    expect(JSON.stringify(f)).not.toContain('secret')
  })
  it.each(Object.values(ErrorId))('domain code %s survives safe rendering',errorId=>{
    const p=runFailureFeedback({errorId,category:'validation',source:'brain',description:'secret',detail:'secret',tracingId:'0123abcd',canResume:false})
    expect(UserFeedbackSchema.safeParse(p.feedback).success).toBe(true)
    const text=publicOutcomeText({status:'failed',reasonCode:p.reasonCode,feedback:p.feedback})
    expect(text).not.toContain('secret');expect(text).toContain('0123abcd');expect(text).not.toContain('刚才处理失败')
  })
  it.each(Object.values(RunOutcomeReasonCode))('reason %s is rendered without raw text',reasonCode=>{
    expect(publicOutcomeText({status:reasonCode.includes('CANCELLED')?'cancelled':reasonCode==='RUN_COMPLETED'?'completed':reasonCode==='RUN_PAUSED'?'paused':'failed',reasonCode})).not.toContain('undefined')
  })
  it('unknown status is not fabricated as failure or success',()=>{expect(publicOutcomeText({status:'future-status',reasonCode:'future'})).toContain('结果尚未确认')})
})

it('real fetch HTTP422 -> compose -> Core outcome preserves moderation identity and safe trace',async()=>{
  const http=createServer((_req,res)=>{res.writeHead(422,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:"input new_sensitive, messages[1]'s content[19] image is sensitive, please check your input (1026) secret /private/path",code:1026}}))})
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r))
  try {
    const chain=compose([async function*(){await jsonRequest(`http://127.0.0.1:${(http.address() as {port:number}).port}`,{},'fixture')}])
    const output=[]
    try { for await(const n of streamAgentChunks(chain.run(createMockContext({})) as any,'fixture','missing-chat',randomUUID())) output.push(n) } catch (error) { expect((error as any).errorId,String((error as Error).stack ?? error)).toBe(ErrorId.BRAIN_IMAGE_REVIEW_REJECTED) }
    const outcome:any=output.find(n=>n.type==='run.outcome')
    expect(outcome.data).toMatchObject({status:'failed',reasonCode:'RUN_VALIDATION_FAILED',retryable:false,feedback:{code:ErrorId.BRAIN_IMAGE_REVIEW_REJECTED,source:'brain'}})
    expect(JSON.stringify(output)).not.toContain('secret');expect(JSON.stringify(output)).not.toContain('/private/path')
    expect(outcome.data.feedback.detail).toBe('HTTP 422; provider code 1026; image_review_rejected')
  } finally {await new Promise<void>(r=>http.close(()=>r()))}
})

it('local provider HTTP422 reaches installed QQ safe failure outbox without unknown reclassification',async()=>{
  const http=createServer((_req,res)=>{res.writeHead(422,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:"input new_sensitive, messages[1]'s content[19] image is sensitive, please check your input (1026) secret /private/path",code:1026}}))})
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r))
  try {
    config.llm.brain.safe_http={provider:'openai',model:'fixture',url:`http://127.0.0.1:${(http.address() as {port:number}).port}/v1`,key:'fixture'}
    config.roles.reviewer!.brain='safe_http'
    const s=await setup();await s.call('qq.event.submit',event('201'))
    await vi.waitFor(()=>expect(s.state().outbox.some((out:any)=>out.frame.type==='qq.request.failed')).toBe(true),{timeout:10000})
    const state=s.state(),notice=state.outbox.find((out:any)=>out.frame.type==='qq.request.failed')
    expect(notice.frame.data.text).toContain('上游图片审核拒绝')
    expect(notice.frame.data.text).toContain('可能存在误判')
    expect(notice.frame.data.text).toMatch(/追踪码：[0-9a-f]{8}/)
    expect(JSON.stringify(state)).not.toContain('secret');expect(JSON.stringify(state)).not.toContain('/private/path')
    expect(state.jobs[0].outcome).toBe('failed')
  } finally {await new Promise<void>(r=>http.close(()=>r()))}
},20000)

it.each([0,1,2])('real ask tool and original run question continuation; resume fault mode=%s',async lost=>{
  resetMockProviderState()
  const brain=addSenseBrain(`qq-safe-question-${lost}`,'ask_user_question',JSON.stringify({question:'选择画质？',rationale:'private rationale',nextStep:'continue',options:[{label:'原画'},{label:'取消'}],multiSelect:false}),'offline final')
  config.roles.reviewer!.brain=brain
  config.sense_groups.auto_senses=['ask_user_question:auto']
  const s=await setup()
  const fixedTime=Math.floor(Date.now()/1000)
  const input = (id:string, extra:object={}) => event(id,{occurredAt:fixedTime,...(lost?{conversationType:'private',targetId:'789',eventId:`qq:123:private:789:${id}`} : {}),...extra})
  await s.call('qq.event.submit',input('101'))
  await vi.waitFor(()=>expect(s.state().jobs[0]?.state).toBe('paused'),{timeout:10000})
  let state=s.state(),job=state.jobs[0]
  expect(job.outcome).toBe('paused');expect(job.reason).toBe('WAITING_FOR_ANSWER')
  expect(state.outbox.some((o:any)=>o.frame.type==='qq.request.failed')).toBe(false)
  const question=state.outbox.find((o:any)=>o.frame.type==='qq.reply.action')
  expect(question.frame.data.text).toContain('选择画质？');expect(question.frame.data.text).not.toContain('private rationale')
  const run=job.coreRunId,batch=job.questions.batchId
  expect(getInteraction(batch)?.status).toBe('pending')
  // Exercise the actual producer/schema/native Adapter/receipt chain; only
  // NapCat's action call is controlled, so this never reaches a real QQ account.
  await vi.waitFor(()=>expect(s.state().outbox.find((o:any)=>o.frame.data.eventId===question.frame.data.eventId).status).toBe('inflight'))
  const nativeCall=vi.fn(async()=>({message_id:9001}))
  const adapter=new Adapter({dataPath:path.join(root!,'native-question'),actions:{call:nativeCall},logger:{},pluginManager:{config:{}}} as any,wire! as any)
  ;(adapter as any).selfId='123';(adapter as any).authenticated=true
  await (adapter as any).notification(question.frame)
  expect(nativeCall).toHaveBeenCalledWith('send_msg',expect.objectContaining(lost?{message_type:'private',user_id:'789'}:{message_type:'group',group_id:'456'}),undefined,{})
  expect(s.state().outbox.find((o:any)=>o.frame.data.eventId===question.frame.data.eventId)).toMatchObject({status:'sent',messageIds:['9001']})
  if (lost===2) vi.spyOn(chatSend,'launchDetachedResume').mockRejectedValueOnce(new Error('offline after durable answer'))
  if (lost) {
    const answer=s.core.answerQuestions!.bind(s.core)
    let first=true
    if(lost===1) s.core.answerQuestions=async(...args)=>{
      if(first){first=false;throw new Error('offline resume temporarily unavailable')}
      return answer(...args)
    }
    const rejected=await wire!.request('qq.event.submit',input('102',{content:'请继续原画',replyToMessageId:'9001'}))
    expect(rejected.success).toBe(false)
    expect(s.state().jobs[0].reason).toBe('QUESTION_RESUME_UNCONFIRMED')
    if(lost===2) expect(getInteraction(batch)?.status).toBe('completed')
  }
  const answerSpy=vi.spyOn(s.core,'answerQuestions')
  const wrong=await wire!.request('qq.event.submit',input('199',{senderId:'790',content:'开始',replyToMessageId:'9001'}))
  expect(wrong.success).toBe(false)
  expect(answerSpy).not.toHaveBeenCalled()
  expect(getInteraction(batch)?.status).toBe(lost===2?'completed':'pending')
  await s.call('qq.event.submit',input('102',{content:'请继续原画',replyToMessageId:'9001'}))
  await vi.waitFor(()=>expect(s.state().jobs[0]?.outcome).toBe('completed'),{timeout:10000})
  state=s.state();job=state.jobs[0]
  expect(job.coreRunId).toBe(run);expect(state.jobs).toHaveLength(1)
  expect(getInteraction(batch)?.status).toBe('completed')
  const metadata=getSoulDb().prepare('SELECT id FROM chats WHERE id LIKE ?').all('ingress-cherynyxus-qq-module-%') as {id:string}[]
  expect(metadata.some(c=>getMessages(c.id).some(m=>m.role==='sense'&&m.content?.includes('请继续原画')))).toBe(true)
  expect(state.outbox.filter((o:any)=>o.frame.type==='qq.reply.part')).toHaveLength(1)
  expect(state.outbox.find((o:any)=>o.frame.type==='qq.reply.part').frame.data.text).toContain('offline final')
  await s.call('qq.event.submit',input('102',{content:'请继续原画',replyToMessageId:'9001'}))
  expect(s.state().jobs).toHaveLength(1)
},20000)
