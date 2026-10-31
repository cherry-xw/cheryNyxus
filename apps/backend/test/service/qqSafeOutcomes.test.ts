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
import { closeAllDbs, getSoulDb } from '@/db/index.js'
import { addSenseBrain, addContentBrain, addMockBrain, scriptItem } from '../agent/helpers/mockScripts.js'
import * as chatSend from '@/service/chat/send.js'
import { BackendResumeRepository } from '@/db/backendResume.js'
import { BackendStopCoordinator } from '@/service/backendStopCoordinator.js'
import { configureBackendWork } from '@/service/backendWork.js'
import { resetMockProviderState } from '@/agent/provider/mock.js'
import { BackendWire } from '../../../../platform/napcat-plugin/src/wire.js'
import { Adapter } from '../../../../platform/napcat-plugin/src/adapter.js'
import { ErrorCode, ErrorId, RunOutcomeReasonCode, UserFeedbackSchema, QQCapabilities, QQDefaultConfig, publicOutcomeText, runFailureFeedback, feedbackForRpcError } from '@chery/protocol'
import { jsonRequest } from '@/agent/provider/fetchBase.js'
import { compose } from '@/core/middleware/compose.js'
import { streamAgentChunks } from '@/service/chat/streamMapper.js'
import { createMockContext } from '../agent/helpers/fakeContext.js'

let host: IngressHost | undefined, server: WebSocketServer | undefined, wire: BackendWire | undefined, root: string | undefined
const token = 'isolated-safe-outcome-token'
const databaseDirectory = config.global.db_dir
afterEach(async () => {
  configureBackendWork(undefined)
  vi.restoreAllMocks()
  wire?.close()
  await host?.stop()
  if (server) { for (const c of server.clients) c.terminate(); await new Promise<void>(r => server!.close(() => r())) }
  closeAllDbs()
  config.global.db_dir = databaseDirectory
  if (root) fs.rmSync(root, {recursive:true,force:true})
  host = undefined; server = undefined; wire = undefined; root = undefined
  delete process.env.QQBOT_PLATFORM_TOKEN
})
async function setup() {
  await bootstrapAgentRuntime()
  process.env.QQBOT_PLATFORM_TOKEN = token
  root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'qq-safe-'))
  closeAllDbs()
  config.global.db_dir = path.join(root, 'db')
  const store = new IngressStore(root), router = createRouter(), core = createIngressCoreAdapter()
  const executionErrors: unknown[] = []
  const submit = core.submit.bind(core)
  vi.spyOn(core, 'submit').mockImplementation(async (...args) => {
    try { return await submit(...args) }
    catch (error) { executionErrors.push(error); throw error }
  })
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
  return {store,core,call,state,executionErrors,rawSubmit:submit}
}
const event = (id:string, extra:object={}) => {
  const input = {eventId:`qq:123:group:456:${id}`,selfId:'123',conversationType:'group',targetId:'456',senderId:'789',senderName:'fixture',messageId:id,occurredAt:Math.floor(Date.now()/1000),mentionedBot:true,content:'offline request',attachments:[],...extra}
  return {...input, sourceParts: [{type:'text',partId:'p0',text:input.content}]}
}

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
    expect(s.executionErrors).toEqual([])
    expect(notice.frame.data.text).toContain('上游图片审核拒绝')
    expect(notice.frame.data.text).toContain('可能存在误判')
    expect(notice.frame.data.text).toMatch(/追踪码：[0-9a-f]{8}/)
    expect(JSON.stringify(state)).not.toContain('secret');expect(JSON.stringify(state)).not.toContain('/private/path')
    expect(state.jobs[0].outcome).toBe('failed')
  } finally {await new Promise<void>(r=>http.close(()=>r()))}
},20000)

it('two real waiting batches preserve original runs, accept partial answers and continue in answer order without preemption', async () => {
  resetMockProviderState()
  const brain=addMockBrain('qq-interleaved-questions',{repeat:'last',script:[
    scriptItem({senseCalls:[{name:'ask_user_question',arguments:JSON.stringify({question:'第一个选择？',rationale:'需要用户选择',nextStep:'继续',options:[{label:'继续'},{label:'其他'}]})},
      {name:'ask_user_question',arguments:JSON.stringify({question:'第二个选择？',rationale:'需要用户选择',nextStep:'继续',options:[{label:'继续'},{label:'其他'}]})}]}),
    {...scriptItem({content:'isolated final'}),preRespondMs:1800},
  ]})
  config.roles.reviewer!.brain=brain; config.sense_groups.auto_senses=['ask_user_question:auto']
  const s=await setup()
  async function submit(id: string, text: string, quote?: string) {
    return s.call('qq.event.submit',event(id,{content:text,...(quote?{replyToMessageId:quote}: {})}))
  }
  async function questions(index: number) {
    await vi.waitFor(()=>expect(s.state().jobs[index]).toMatchObject({state:'paused',reason:'WAITING_FOR_ANSWER'}),{timeout:10000})
    const job=s.state().jobs[index], outputs=s.state().outbox.filter((o:any)=>o.frame.data.requestId===job.requestId&&o.frame.type==='qq.reply.action')
    expect(outputs).toHaveLength(2)
    for (const [n,output] of outputs.entries()) {
      await vi.waitFor(()=>expect(s.state().outbox.find((o:any)=>o.frame.data.eventId===output.frame.data.eventId).status).toBe('inflight'))
      const d=output.frame.data
      await s.call('qq.delivery.result',{eventId:d.eventId,requestId:d.requestId,selfId:d.selfId,targetId:d.targetId,conversationType:d.conversationType,
        seq:d.seq,status:'sent',sentAt:Date.now(),messageIds:[String(10000+index*10+n)],activity:false,terminal:false})
    }
    return { job,quotes:outputs.map((_:any,n:number)=>String(10000+index*10+n)) }
  }
  await submit('301','A: independent task')
  const a=await questions(0)
  await submit('302','B: independent task')
  const b=await questions(1)
  expect(s.state().jobs[0]).toMatchObject({state:'paused',coreRunId:a.job.coreRunId})
  expect(getInteraction(a.job.questionBatches[0].batchId)?.status).toBe('pending')
  // B is answered first. The first answer alone cannot save the complete batch or start it.
  await submit('303','B first answer',b.quotes[0])
  expect(s.state().jobs[1].questionBatches[0].commandId).toBeUndefined()
  expect(getInteraction(b.job.questionBatches[0].batchId)?.status).toBe('pending')
  await submit('304','B second answer',b.quotes[1])
  await vi.waitFor(()=>expect(s.state().jobs[1].state).toBe('running'),{timeout:6000})
  await submit('305','A first answer',a.quotes[0])
  await submit('306','A second answer',a.quotes[1])
  await vi.waitFor(()=>expect(s.state().jobs[0]).toMatchObject({state:'queued',reason:'QUESTION_ANSWER_SAVED'}))
  expect(s.state().jobs[1].state).toBe('running')
  await submit('306','A second answer',a.quotes[1])
  await vi.waitFor(()=>expect(s.state().jobs.every((job:any)=>job.outcome==='completed')).toBe(true),{timeout:12000})
  const state=s.state()
  expect(state.jobs).toHaveLength(2)
  expect(state.jobs.map((job:any)=>job.coreRunId)).toEqual([a.job.coreRunId,b.job.coreRunId])
  expect(state.outbox.filter((o:any)=>o.frame.type==='qq.reply.part')).toHaveLength(2)
  const db=getSoulDb()
  expect(db.prepare('SELECT state FROM source_answer_commands').all()).toEqual([{state:'started'},{state:'started'}])
  const projections=db.prepare('SELECT request_id,reason FROM source_projections ORDER BY rowid').all() as any[]
  for (const job of state.jobs) expect(projections.filter(p=>p.request_id===job.requestId).map(p=>p.reason)).toEqual(['initial','question_resume'])
  const messages=db.prepare('SELECT run_id,data_json FROM source_run_messages').all() as any[]
  const aTools=messages.filter(m=>m.run_id===a.job.coreRunId).map(m=>JSON.parse(m.data_json))
  expect(aTools.filter(m=>m.role==='sense').map(m=>m.content).join(' ')).toContain('A first answer')
  expect(JSON.stringify(aTools)).not.toContain('B first answer')
  expect(s.executionErrors).toEqual([])
},30000)

it('installed QQ starts a new trusted source request behind an empty restart gate without explicit resume', async () => {
  config.roles.reviewer!.brain = addContentBrain('qq-restart-new-input', 'new request completed')
  const s = await setup(), submit = s.rawSubmit
  const resume = new BackendResumeRepository(getSoulDb())
  const coordinator = new BackendStopCoordinator({ backendInstanceId: randomUUID(), parkInputs: () => 0,
    restoreInputs() {}, blockers: () => [], close() {}, force() {} })
  configureBackendWork({ coordinator, resume, canContinue: () => false })
  let chatId = ''
  vi.spyOn(s.core, 'submit').mockImplementation(async (owner, key, input) => {
    chatId = (await s.core.ensureConversation(owner, key, 'detail-test')).chatId
    resume.recover([chatId])
    return submit(owner, key, input)
  })
  const oldResume = vi.spyOn(chatSend, 'launchDetachedResume')
  await s.call('qq.event.submit', event('301'))
  await vi.waitFor(() => {
    expect(s.executionErrors).toEqual([])
    expect(s.state().jobs[0]?.coreRunId).toBeTruthy()
    expect(s.state().outbox.some((out: any) => out.frame.type === 'qq.reply.part')).toBe(true)
  }, { timeout: 10000 })
  expect(resume.required(chatId)).toBe(false)
  expect(oldResume).not.toHaveBeenCalled()
  expect(s.state().jobs[0].entryFailure).toBeUndefined()
  expect(getMessages(chatId).filter(message => message.role === 'user')).toHaveLength(1)
  expect(getSoulDb().prepare('SELECT request_id FROM source_runs WHERE run_id=?').all(s.state().jobs[0].coreRunId)).toEqual([{ request_id: s.state().jobs[0].requestId }])
}, 20000)

it('installed QQ persists a safe entry failure when Core submit rejects before allocating a run', async () => {
  const s = await setup()
  vi.spyOn(s.core, 'submit').mockRejectedValue(Object.assign(new Error('secret /private/path ?token=secret'), { code: 'BACKEND_RESUME_REQUIRED' }))
  await s.call('qq.event.submit', event('302'))
  await vi.waitFor(() => expect(s.state().jobs[0]?.state).toBe('failed'), { timeout: 10000 })
  const job = s.state().jobs[0]
  expect(job.coreRunId).toBeUndefined()
  expect(job.entryFailure).toMatchObject({ code: 'BACKEND_RESUME_REQUIRED', phase: 'core_submit' })
  expect(job.reason).toBe('BACKEND_RESUME_REQUIRED')
  expect(JSON.stringify(s.state())).not.toContain('secret')
  expect(s.state().outbox.filter((out: any) => out.frame.type === 'qq.request.failed')).toHaveLength(1)
}, 20000)

it('A remains answerable after ordinary B completes, without changing B history or replaying A tools', async () => {
  resetMockProviderState()
  const question = {content:'need A answer',senseCalls:[{id:'a-question',name:'ask_user_question',arguments:JSON.stringify({
    question:'选择？',rationale:'需要确认',nextStep:'完成 A',options:[{label:'继续'},{label:'其他'}]})}]}
  config.roles.reviewer!.brain=addMockBrain('qq-a-wait-b-finish',{repeat:'last',script:[
    {...question,attempts:[question,{content:'B completed independently',senseCalls:[]}]},scriptItem({content:'A completed after B'})]})
  config.sense_groups.auto_senses=['ask_user_question:auto']
  const s=await setup()
  await s.call('qq.event.submit',event('401'))
  await vi.waitFor(()=>expect(s.state().jobs[0]?.reason).toBe('WAITING_FOR_ANSWER'),{timeout:10000})
  const a=s.state().jobs[0], output=s.state().outbox.find((o:any)=>o.frame.type==='qq.reply.action'), d=output.frame.data
  await vi.waitFor(()=>expect(s.state().outbox.find((o:any)=>o.frame.data.eventId===d.eventId).status).toBe('inflight'))
  await s.call('qq.delivery.result',{eventId:d.eventId,requestId:d.requestId,selfId:d.selfId,targetId:d.targetId,conversationType:d.conversationType,
    seq:d.seq,status:'sent',sentAt:Date.now(),messageIds:['10401'],activity:false,terminal:false})
  await s.call('qq.event.submit',event('402',{content:'ordinary B'}))
  await vi.waitFor(()=>expect(s.state().jobs[1]?.outcome).toBe('completed'),{timeout:10000})
  const b=s.state().jobs[1], db=getSoulDb()
  expect(s.state().jobs[0]).toMatchObject({state:'paused',reason:'WAITING_FOR_ANSWER'})
  expect(getInteraction(a.questionBatches[0].batchId)?.status).toBe('pending')
  const before=db.prepare('SELECT * FROM workflow_occurrences WHERE run_id=? ORDER BY occurrence_id').all(b.coreRunId)
  expect(before.length).toBeGreaterThan(0)
  const chatId=(db.prepare('SELECT chat_id FROM source_tasks WHERE run_id=?').get(b.coreRunId) as {chat_id:string}).chat_id
  const beforeReply=getMessages(chatId).find(m=>m.content==='B completed independently')
  expect(beforeReply).toBeDefined()
  await s.call('qq.event.submit',event('403',{content:'A answer',replyToMessageId:'10401'}))
  await vi.waitFor(()=>expect(s.state().jobs[0]?.outcome).toBe('completed'),{timeout:10000})
  expect(s.state().jobs.map((j:any)=>j.coreRunId)).toEqual([a.coreRunId,b.coreRunId])
  expect(db.prepare('SELECT * FROM workflow_occurrences WHERE run_id=? ORDER BY occurrence_id').all(b.coreRunId)).toEqual(before)
  expect(getMessages(chatId).find(m=>m.id===beforeReply!.id)).toEqual(beforeReply)
  const replies=s.state().outbox.filter((o:any)=>o.frame.type==='qq.reply.part').map((o:any)=>o.frame.data.text)
  expect(replies).toHaveLength(2)
  expect(replies[0]).toBe('B completed independently')
  expect(replies[1]).toContain('A completed after B')
  expect(replies[1]).not.toContain('B completed independently')
  expect(s.executionErrors).toEqual([])
},20000)

it('an invalid question reaches the next request-owned model step once, without an endless question replay',async()=>{
  resetMockProviderState()
  config.roles.reviewer!.brain=addSenseBrain('qq-invalid-question','ask_user_question','{}','parameters corrected with text')
  config.sense_groups.auto_senses=['ask_user_question:auto']
  const s=await setup()
  await s.call('qq.event.submit',event('410'))
  await vi.waitFor(()=>expect(s.state().jobs[0]?.outcome).toBe('completed'),{timeout:10000})
  const job=s.state().jobs[0], db=getSoulDb()
  expect(job.questionBatches).toHaveLength(0)
  const messages=db.prepare('SELECT data_json FROM source_run_messages WHERE run_id=? ORDER BY sequence').all(job.coreRunId) as any[]
  expect(messages.map(row=>JSON.parse(row.data_json).role)).toEqual(['assistant','sense'])
  expect(JSON.parse(messages[1].data_json).content).toContain('参数校验失败')
  expect((db.prepare('SELECT reason FROM source_projections WHERE request_id=? ORDER BY rowid').all(job.requestId) as any[]).map(row=>row.reason)).toEqual(['initial','tool_continue'])
  expect(s.executionErrors).toEqual([])
},20000)

it('installed QQ keeps invalid reply parameters distinct from actual ordinary-text delivery', async () => {
  const final = '普通正文照常发送，不把执行前的参数拒绝当作 QQ 发送失败。'
  config.roles.reviewer!.brain = addSenseBrain('qq-invalid-reply-parameters', 'qq_quote_reply',
    JSON.stringify({ messageId: '310', text: '字'.repeat(501), completeReply: true }), final)
  const s = await setup()
  await s.call('qq.event.submit', event('310'))
  await vi.waitFor(() => expect(s.state().outbox.some((out: any) => out.frame.type === 'qq.reply.part')).toBe(true), { timeout: 10000 })
  const state = s.state(), job = state.jobs[0]
  expect(s.executionErrors).toEqual([])
  expect(state.outbox.some((out: any) => ['qq.reply.action', 'qq.request.failed', 'qq.tool.icon'].includes(out.frame.type))).toBe(false)
  const history = getSoulDb().prepare('SELECT data_json FROM source_run_messages WHERE run_id=? ORDER BY sequence').all(job.coreRunId)
    .map((row: any) => JSON.parse(row.data_json))
  const results = history.filter((message: any) => message.role === 'sense')
  expect(results).toHaveLength(1)
  expect(results[0].content).toContain('工具参数无效，本次调用未执行')
  expect(results[0].content).toContain('这不是外部执行或消息发送失败')
  expect(results[0].content).not.toContain('字'.repeat(501))
  const reply = state.outbox.find((out: any) => out.frame.type === 'qq.reply.part')
  expect(reply.frame.data.text).toBe(final)
  await vi.waitFor(() => expect(s.state().outbox.find((out: any) => out.frame.data.eventId === reply.frame.data.eventId).status).toBe('inflight'))
  const nativeCall = vi.fn(async () => ({ message_id: 9310 }))
  const adapter = new Adapter({ dataPath: path.join(root!, 'native-invalid-reply'), actions: { call: nativeCall }, logger: {}, pluginManager: { config: {} } } as any, wire! as any)
  ;(adapter as any).selfId = '123'; (adapter as any).authenticated = true
  await (adapter as any).notification(reply.frame)
  expect(nativeCall).toHaveBeenCalledTimes(1)
  expect(s.state().outbox.find((out: any) => out.frame.data.eventId === reply.frame.data.eventId)).toMatchObject({ status: 'sent', messageIds: ['9310'] })
}, 20000)

it.each([0,1,2])('real ask tool and original run question continuation; resume fault mode=%s',async lost=>{
  resetMockProviderState()
  const brain=addSenseBrain(`qq-safe-question-${lost}`,'ask_user_question',JSON.stringify({question:'选择画质？',rationale:'private rationale',nextStep:'continue',options:[{label:'原画'},{label:'取消'}],multiSelect:false}),'offline final')
  config.roles.reviewer!.brain=brain
  config.sense_groups.auto_senses=['ask_user_question:auto']
  const s=await setup()
  const fixedTime=Math.floor(Date.now()/1000)
   const input = (id:string, extra:object={}) => event(id,{occurredAt:fixedTime,...(lost?{conversationType:'private',targetId:'789',eventId:`qq:123:private:789:${id}`} : {}),...extra})
  await s.call('qq.event.submit',input('101'))
   await vi.waitFor(()=>{
     expect(s.executionErrors).toEqual([])
     expect(s.state().jobs[0]?.state,JSON.stringify(s.state().jobs[0])).toBe('paused')
   },{timeout:10000})
  let state=s.state(),job=state.jobs[0]
  expect(job.outcome).toBe('paused');expect(job.reason).toBe('WAITING_FOR_ANSWER')
  expect(state.outbox.some((o:any)=>o.frame.type==='qq.request.failed')).toBe(false)
  const question=state.outbox.find((o:any)=>o.frame.type==='qq.reply.action')
  expect(question.frame.data.text).toContain('选择画质？');expect(question.frame.data.text).not.toContain('private rationale')
   const run=job.coreRunId,batch=job.questionBatches.at(-1).batchId
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
   if (lost===1) {
     const answer=s.core.answerQuestions!.bind(s.core)
     vi.spyOn(s.core,'answerQuestions').mockImplementationOnce(async(...args)=>{ await answer(...args); throw new Error('saved response lost') })
   }
   if (lost===2) {
     const resume=s.core.resumeQuestions!.bind(s.core)
     vi.spyOn(s.core,'resumeQuestions').mockImplementationOnce(async(...args)=>{ await resume(...args); throw new Error('started response lost') })
   }
  const answerSpy=vi.spyOn(s.core,'answerQuestions')
  const wrong=await wire!.request('qq.event.submit',input('199',{senderId:'790',content:'开始',replyToMessageId:'9001'}))
   if (lost) {
     expect(wrong.success).toBe(false)
     expect(wrong.error.code).toBe('IDENTITY_REJECTED')
   } else {
     expect(wrong.success).toBe(true)
     expect(wrong.data.accepted).toBe(false)
     expect(wrong.data.receipt.handling).toMatchObject({kind:'rejected',reasonCode:'IDENTITY_REJECTED'})
   }
  expect(answerSpy).not.toHaveBeenCalled()
   expect(getInteraction(batch)?.status).toBe('pending')
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
