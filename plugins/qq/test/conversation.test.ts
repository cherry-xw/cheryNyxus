import { describe, expect, it, vi } from 'vitest'
import { QQPlugin } from '../src/index.js'
import { QQDefaultConfig, QQConfigSchema } from '../../../packages/protocol/src/qq.js'
import { conversationRules, shanghaiTime, summaryEvidenceRules } from '../src/conversation.js'
import { replyActionSchema } from '../src/replyTools.js'
import { emptyState, nextTargetJob } from '../src/state.js'

function fixture(text = '用语音锐评一下 @小明', mode = 'requested') {
  const plugin = Object.create(QQPlugin.prototype) as any
  const job = { requestId: 'new', queueSequence: 1, questionBatches: [] as any[], coreRequestId: 'core', conversationKey: 'conversation', target: 'group:456', acceptedAt: 2000, reply: '', state: 'running', input: { selfId: '123', senderId: '789', targetId: '456', conversationType: 'group', content: text, messageId: '2' }, background: [], snapshot: { config: { ...QQDefaultConfig, voiceMode: mode, voiceDefaultCharacter: 'fixed' } } }
  plugin.state = { ...emptyState(), jobs: [job] }; plugin.snapshot = job.snapshot
  plugin.persist = vi.fn(); plugin.queryDirectory = vi.fn(async () => [{id: 'fixed', name: '固定声音'}])
  plugin.output = vi.fn((_job, type, data) => plugin.state.outbox.push({ status: 'pending', frame: {type, data: {...data, requestId: job.requestId}} }))
  return { plugin, job }
}
describe('normal conversation and fixed voice policy', () => {
   it.each(['好家伙', '哈哈哈哈😂', '确实', '😂'])('requires source authority rather than keywords for %s', async text => {
    const { plugin, job } = fixture(text, 'requested')
    await expect(plugin.enqueueReplyAction(job, {kind:'voice',text:'继续锐评',completeReply:true})).rejects.toThrow('not authorized')
    expect(plugin.output).not.toHaveBeenCalled()
  })
  it('accepts explicit requests, fixes the voice server-side and limits one voice', async () => {
    const {plugin,job} = fixture()
    job.sourceRecords=[{recordId:'current',revision:1}]
    await plugin.enqueueReplyAction(job, {kind:'voice',text:'你好',requestSource:job.sourceRecords[0],completeReply:false})
    expect(plugin.output).toHaveBeenCalledWith(job,'qq.reply.action',expect.objectContaining({character:'fixed'}))
    await expect(plugin.enqueueReplyAction(job, {kind:'voice',text:'再来',requestSource:job.sourceRecords[0],completeReply:false})).rejects.toThrow('Only one')
    expect(replyActionSchema.safeParse({kind:'voice',text:'你好',character:'other',completeReply:true}).success).toBe(false)
  })
  it.each(['声音怎么变了？','再看看其他人','为什么没完成','用文字回答，不要语音'])('does not turn %s into voice', async text => {
    const {plugin,job}=fixture(text)
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'解释',completeReply:true})).rejects.toThrow('not authorized')
  })
  it('does not use an old send as authority for a requested voice', async () => {
    const {plugin,job}=fixture('不够犀利')
    const old={...job,requestId:'old',acceptedAt:1000}
    const output={status:'sent',frame:{type:'qq.reply.action',data:{requestId:'old',actionKind:'voice'}}}
    plugin.state.jobs.unshift(old); plugin.state.outbox.push(output)
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'继续修改后的语音',requestSource:{recordId:'old',revision:1},completeReply:true})).rejects.toThrow('not authorized')
    expect(plugin.output).not.toHaveBeenCalled()
  })
  it('respects off mode and unavailable configured voices without switching', async () => {
    const {plugin,job}=fixture(undefined,'off')
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'hi',completeReply:true})).rejects.toThrow('not authorized')
    job.snapshot.config.voiceMode='auto'; plugin.queryDirectory.mockResolvedValue([{id:'other',name:'other'}])
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'hi',completeReply:true})).rejects.toThrow('not available')
    expect(plugin.output).not.toHaveBeenCalled()
  })
  it.each([true, false])('prepares source tools with workerEnabled=%s without repeating source text', async workerEnabled => {
    const {plugin,job}=fixture('锐评一下 @另一个人')
    const hooks:any[]=[]
    plugin.cleanups=[];plugin.paused=true
    job.input.eventId='current-event';job.input.replyToMessageId='42'
    job.sourceSnapshot={snapshotId:'fixed-snapshot'}
    job.snapshot.config={...job.snapshot.config,memoryEnabled:false,workerEnabled}
    plugin.state.jobs=[]
    const register=()=>()=>{}
    plugin.context={id:'qq-fixture',dataDir:'/tmp/opencode',runtimeOptions:{},config:{snapshot:()=>({revision:1,config:job.snapshot.config})},
      core:{sourceConversations:{},onEvent:register,answerQuestions:vi.fn(),questionResumeStatus:vi.fn(),resumeQuestions:vi.fn()},identity:{registerChannel:register},ingress:{register},connections:{onClose:register},
      hooks:{register:(hook:any)=>{hooks.push(hook);return ()=>{}}},tools:{register}}
    plugin.register=vi.fn()
    plugin.start()
    plugin.state.jobs=[{...job,requestId:'old',input:{...job.input,eventId:'old-event',content:'旧成员原文'},reply:'旧机器人错误宣称'},job]
    plugin.paused=false;plugin.connection='connection';plugin.recovered=true
    const requestPrepare=hooks.find(hook=>hook.event==='RequestPrepare')
    const identity={ownerId:'qq-fixture',channel:'qq',subject:{selfId:'123',userId:'789',conversationType:'group',groupId:'456'}}
    const prepared=await requestPrepare.handler({inputId:'current-event',requestId:'core-new'},{requestView:{identity}})
    for (const tool of ['qq_container_exec', 'qq_source_file_read']) {
      expect(prepared.tools.includes(tool)).toBe(false)
      expect(prepared.excludedTools.includes(tool)).toBe(!workerEnabled)
    }
    const unrelated=await requestPrepare.handler({inputId:'other',requestId:'web'},{requestView:{identity:{source:'web',channel:'web'}}})
    expect(unrelated).toBeUndefined()
    const discussion=JSON.parse(prepared.contexts.find((item:any)=>item.key==='qq.discussion').content)
    expect(discussion).toMatchObject({batchId:'new',snapshotId:'fixed-snapshot'})
    expect(JSON.stringify(prepared.contexts)).not.toMatch(/锐评一下|旧成员原文|旧机器人错误宣称|currentMessages|recentRequests|replyClaim/)
    expect(JSON.parse(prepared.contexts.find((item:any)=>item.key==='qq.identity').content).subject).toEqual(identity.subject)
    expect(JSON.parse(prepared.contexts.find((item:any)=>item.key==='qq.identity').content).selfPersonaRule).toContain('第一人称“我”')
    expect(discussion.selfId).toBe('123')
    expect(discussion.rule).toContain('origin="bot_delivery"')
    expect(prepared.contexts.find((item:any)=>item.key==='qq.conversationRules').content).toBe(conversationRules)
    expect(conversationRules).not.toContain('最后才考虑人设')
    expect(conversationRules).toContain('origin="bot_delivery"')
    expect(job.coreRequestId).toBe('core-new')
    expect(summaryEvidenceRules).toContain('未验证')
    expect(summaryEvidenceRules).not.toContain('AI自述')
    job.snapshot.revision=1
    const post=hooks.find(hook=>hook.event==='PostToolUse')
    post.handler({name:'qq_interact',args:{action:'voice'},result:{status:'ok'}},{requestId:'core-new',requestView:{identity,configRevision:'core-config',registryVersion:7}})
    expect(plugin.state.toolResults['group:456']['qq_interact.voice']).toMatchObject({status:'ok',qqConfigRevision:1,configRevision:'core-config',registryVersion:7})
    expect(plugin.state.toolResults['group:456'].qq_interact).toBeUndefined()
  })
  it('uses Shanghai time regardless of process timezone and rejects retired config', () => {
    expect(shanghaiTime(0)).toContain('08:00')
    expect(QQConfigSchema.parse(QQDefaultConfig).voiceMode).toBe('requested')
    expect(QQConfigSchema.safeParse({...QQDefaultConfig,voiceEnabled:true}).success).toBe(false)
  })
  it('separates new conversations after reset without changing retained jobs', () => {
    const {plugin,job}=fixture()
    plugin.state.contextEpoch='new-context'
    expect(plugin.conversationKey('123','group:456','preset')).toBe('123:group:456:preset:new-context')
    expect(job.conversationKey).toBe('conversation')
  })
  it('resumes QUESTION_RESUME_UNCONFIRMED when the answer event is resubmitted', async () => {
    const {plugin,job}=fixture('初始问题')
    job.state='paused'; job.reason='QUESTION_RESUME_UNCONFIRMED'; job.sourceScopeId='scope-1'
    job.sourceSnapshot={snapshotId:'snap-1',scopeId:'scope-1',requestId:job.requestId,turnId:job.requestId,createdAt:1,reason:'initial',qqConfigRevision:1,permissionRevision:1,selectionRevision:1,inputRecords:[],orderedItems:[]}
    const answerInput={...job.input,eventId:'evt-ans-1',messageId:'99',replyToMessageId:'10',content:'原发起者回答',sourceParts:[{type:'text',partId:'p0',text:'原发起者回答'}]}
    job.questionBatches=[{batchId:'b1',runId:'run-1',commandId:'cmd-1',status:'saving',items:[{questionId:'q1',question:'问题?',options:[],multiSelect:false,eventId:'out-1',answer:'原发起者回答',answerRecord:{recordId:'rec-ans-1',revision:1}}],replies:[answerInput]}]
    plugin.state.sourceScopes={'group:456':{scopeId:'scope-1'}}
    plugin.state.sourceReceipts={'evt-ans-1':{pendingReceipt:false,record:{recordId:'rec-ans-1',revision:1}}}
    plugin.sources={
      begin:vi.fn(async()=>({
        receipt:{state:'completed',receiptId:'rcpt-1',version:1,record:{recordId:'rec-ans-1',revision:1},result:{receiptId:'rcpt-1',record:{recordId:'rec-ans-1',revision:1},handling:{kind:'question_answer',requestId:job.requestId,runId:'run-1',batchId:'b1',questionId:'q1'}}},
        scope:{scopeId:'scope-1'}
      })),
      ready:vi.fn(()=>true),
      validate:vi.fn(),
    }
    const answerQuestions=vi.fn(async()=>({runId:'run-1',commandId:'cmd-1',status:'saved',canQueue:true,sourceSnapshot:{...job.sourceSnapshot,snapshotId:'snap-2',parentSnapshotId:'snap-1'}}))
    plugin.context={
      core:{
        resolvePreset:()=>({presetId:job.snapshot.presetId ?? 'fixed-preset'}),
        ensureConversation:vi.fn(async()=>({})),
        answerQuestions,
        questionResumeStatus: vi.fn(async()=>({runId:'run-1',commandId:'cmd-1',status:'saving',canQueue:false})),
        resumeQuestions: vi.fn(),
      },
      identity:{bind:vi.fn(async()=>({}))},
    }
    job.snapshot.presetId='fixed-preset'
    job.snapshot.config.groups=['456']
    job.snapshot.config.bindings={'group:456':'preset'}
    plugin.connection='conn-1'; plugin.verifiedConnection='conn-1'
    plugin.answering=new Set(); plugin.operations=new Set(); plugin.tick=vi.fn()
    const res=await plugin.submit(answerInput)
    expect(res.accepted).toBe(true)
    await Promise.all([...plugin.operations])
    expect(answerQuestions).toHaveBeenCalledOnce()
    expect(answerQuestions.mock.calls[0]![0]).toMatchObject({commandId:'cmd-1',runId:'run-1',batchId:'b1'})
    expect(job.sourceSnapshot.snapshotId).toBe('snap-2')
    expect(job.questionBatches[0].status).toBe('saved')
    expect(job.state).toBe('queued')
    expect(job.reason).toBe('QUESTION_ANSWER_SAVED')
    expect(plugin.context.core.resumeQuestions).not.toHaveBeenCalled()
  })
  it('puts answered A behind B, keeps its position on busy, and ignores a late startup acknowledgement', () => {
    const { plugin, job: a } = fixture()
    plugin.tick=vi.fn(); a.state='paused'; a.reason='WAITING_FOR_ANSWER'
    const batch={batchId:'a',runId:'run-a',commandId:'command-a',status:'saving',items:[],replies:[]}
    a.questionBatches=[batch]
    const b={...a,requestId:'B',state:'queued',queueSequence:2,questionBatches:[]}
    plugin.state.jobs.push(b); plugin.state.nextQueueSequence=3
    const result={runId:'run-a',commandId:'command-a',status:'saved',canQueue:true}
    plugin.applyQuestionStatus(a,batch,result)
    expect(a.queueSequence).toBe(3)
    expect(nextTargetJob(plugin.state.jobs,a.target)?.requestId).toBe('B')
    batch.status='starting'
    plugin.applyQuestionStatus(a,batch,{...result,reasonCode:'PREVIOUS_WORK_PENDING'})
    expect(a.queueSequence).toBe(3)
    b.state='running'
    expect(nextTargetJob(plugin.state.jobs,a.target)?.requestId).toBe('B')
    a.questionBatches.push({...batch,batchId:'new-a',status:'pending'})
    a.state='paused';a.reason='WAITING_FOR_ANSWER'
    plugin.applyQuestionStatus(a,batch,{...result,status:'started',canQueue:false})
    expect(a.reason).toBe('WAITING_FOR_ANSWER')
  })
})
