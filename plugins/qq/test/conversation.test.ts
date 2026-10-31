import { describe, expect, it, vi } from 'vitest'
import { QQPlugin } from '../src/index.js'
import { QQDefaultConfig, QQConfigSchema } from '../../../packages/protocol/src/qq.js'
import { conversationRules, reactionOnly, shanghaiTime, summaryEvidenceRules, voiceRequested } from '../src/conversation.js'
import { replyActionSchema } from '../src/replyTools.js'
import { emptyState } from '../src/state.js'

function fixture(text = '用语音锐评一下 @小明', mode = 'requested') {
  const plugin = Object.create(QQPlugin.prototype) as any
  const job = { requestId: 'new', coreRequestId: 'core', conversationKey: 'conversation', target: 'group:456', acceptedAt: 2000, reply: '', state: 'running', input: { selfId: '123', senderId: '789', targetId: '456', conversationType: 'group', content: text, messageId: '2' }, background: [], snapshot: { config: { ...QQDefaultConfig, voiceMode: mode, voiceDefaultCharacter: 'fixed' } } }
  plugin.state = { ...emptyState(), jobs: [job] }; plugin.snapshot = job.snapshot
  plugin.persist = vi.fn(); plugin.queryDirectory = vi.fn(async () => [{id: 'fixed', name: '固定声音'}])
  plugin.output = vi.fn((_job, type, data) => plugin.state.outbox.push({ status: 'pending', frame: {type, data: {...data, requestId: job.requestId}} }))
  return { plugin, job }
}
describe('normal conversation and fixed voice policy', () => {
  it.each(['好家伙', '哈哈哈哈😂', '确实', '😂'])('reaction %s is not a new voice request', async text => {
    const { plugin, job } = fixture(text, 'auto')
    expect(reactionOnly(text)).toBe(true)
    expect(voiceRequested(job as any, [], [])).toBe(false)
    await expect(plugin.enqueueReplyAction(job, {kind:'voice',text:'继续锐评',completeReply:true})).rejects.toThrow('authorization')
    await expect(plugin.enqueueReplyAction(job, {kind:'poke',userId:'789',completeReply:true})).rejects.toThrow('authorization')
    expect(plugin.output).not.toHaveBeenCalled()
  })
  it('accepts explicit requests, fixes the voice server-side and limits one voice', async () => {
    const {plugin,job} = fixture()
    expect(voiceRequested(job as any, [], [])).toBe(true)
    await plugin.enqueueReplyAction(job, {kind:'voice',text:'你好',completeReply:false})
    expect(plugin.output).toHaveBeenCalledWith(job,'qq.reply.action',expect.objectContaining({character:'fixed'}))
    await expect(plugin.enqueueReplyAction(job, {kind:'voice',text:'再来',completeReply:false})).rejects.toThrow('Only one')
    expect(replyActionSchema.safeParse({kind:'voice',text:'你好',character:'other',completeReply:true}).success).toBe(false)
  })
  it.each(['声音怎么变了？','再看看其他人','为什么没完成','用文字回答，不要语音'])('does not turn %s into voice', async text => {
    const {plugin,job}=fixture(text)
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'解释',completeReply:true})).rejects.toThrow('not authorized')
  })
  it('inherits voice only for a same-sender modification after confirmed send', async () => {
    const {plugin,job}=fixture('不够犀利')
    const old={...job,requestId:'old',acceptedAt:1000}
    const output={status:'sent',frame:{type:'qq.reply.action',data:{requestId:'old',actionKind:'voice'}}}
    expect(voiceRequested(job as any,[old] as any,[output] as any)).toBe(true)
    expect(voiceRequested(job as any,[{...old,input:{...old.input,senderId:'888'}}] as any,[output] as any)).toBe(false)
    expect(voiceRequested(job as any,[old] as any,[{...output,status:'unknown'}] as any)).toBe(false)
    plugin.state.jobs.unshift(old); plugin.state.outbox.push(output)
    await plugin.enqueueReplyAction(job,{kind:'voice',text:'继续修改后的语音',completeReply:true})
    expect(plugin.output).toHaveBeenCalledWith(job,'qq.reply.action',expect.objectContaining({character:'fixed',text:'继续修改后的语音'}))
  })
  it('respects off mode and unavailable configured voices without switching', async () => {
    const {plugin,job}=fixture(undefined,'off')
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'hi',completeReply:true})).rejects.toThrow('not authorized')
    job.snapshot.config.voiceMode='auto'; plugin.queryDirectory.mockResolvedValue([{id:'other',name:'other'}])
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'hi',completeReply:true})).rejects.toThrow('not available')
    expect(plugin.output).not.toHaveBeenCalled()
  })
  it('prepares only trusted rules and references, never repeats current/old source text in the request hook', async () => {
    const {plugin,job}=fixture('锐评一下 @另一个人')
    const hooks:any[]=[]
    plugin.cleanups=[];plugin.paused=true
    job.input.eventId='current-event';job.input.replyToMessageId='42'
    job.sourceSnapshot={snapshotId:'fixed-snapshot'}
    job.snapshot.config={...job.snapshot.config,memoryEnabled:false}
    plugin.state.jobs=[]
    const register=()=>()=>{}
    plugin.context={id:'qq-fixture',dataDir:'/tmp/opencode',runtimeOptions:{},config:{snapshot:()=>({revision:1,config:job.snapshot.config})},
      core:{sourceConversations:{},onEvent:register},identity:{registerChannel:register},ingress:{register},connections:{onClose:register},
      hooks:{register:(hook:any)=>{hooks.push(hook);return ()=>{}}},tools:{register}}
    plugin.register=vi.fn()
    plugin.start()
    plugin.state.jobs=[{...job,requestId:'old',input:{...job.input,eventId:'old-event',content:'旧成员原文'},reply:'旧机器人错误宣称'},job]
    plugin.paused=false;plugin.connection='connection';plugin.recovered=true
    const requestPrepare=hooks.find(hook=>hook.event==='RequestPrepare')
    const identity={ownerId:'qq-fixture',channel:'qq',subject:{selfId:'123',userId:'789',conversationType:'group',groupId:'456'}}
    const prepared=await requestPrepare.handler({inputId:'current-event',requestId:'core-new'},{requestView:{identity}})
    const discussion=JSON.parse(prepared.contexts.find((item:any)=>item.key==='qq.discussion').content)
    expect(discussion).toMatchObject({batchId:'new',snapshotId:'fixed-snapshot'})
    expect(JSON.stringify(prepared.contexts)).not.toMatch(/锐评一下|旧成员原文|旧机器人错误宣称|currentMessages|recentRequests|replyClaim/)
    expect(JSON.parse(prepared.contexts.find((item:any)=>item.key==='qq.identity').content).subject).toEqual(identity.subject)
    expect(prepared.contexts.find((item:any)=>item.key==='qq.conversationRules').content).toBe(conversationRules)
    expect(job.coreRequestId).toBe('core-new')
    expect(summaryEvidenceRules).toContain('未验证')
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
    job.questions={batchId:'b1',runId:'run-1',commandId:'cmd-1',items:[{questionId:'q1',question:'问题?',options:[],multiSelect:false,eventId:'out-1',answer:'原发起者回答',answerRecord:{recordId:'rec-ans-1',revision:1}}],replies:[answerInput]}
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
    const answerQuestions=vi.fn(async()=>({runId:'run-1',sourceSnapshot:{...job.sourceSnapshot,snapshotId:'snap-2',parentSnapshotId:'snap-1'}}))
    plugin.context={
      core:{
        resolvePreset:()=>({presetId:job.snapshot.presetId ?? 'fixed-preset'}),
        ensureConversation:vi.fn(async()=>({})),
        answerQuestions,
      },
      identity:{bind:vi.fn(async()=>({}))},
    }
    job.snapshot.presetId='fixed-preset'
    job.snapshot.config.groups=['456']
    job.snapshot.config.bindings={'group:456':'preset'}
    plugin.connection='conn-1'; plugin.verifiedConnection='conn-1'
    plugin.answering=new Set(); plugin.operations=new Set()
    const res=await plugin.submit(answerInput)
    expect(res.accepted).toBe(true)
    await Promise.all([...plugin.operations])
    expect(answerQuestions).toHaveBeenCalledOnce()
    expect(answerQuestions.mock.calls[0]![0]).toMatchObject({commandId:'cmd-1',runId:'run-1',batchId:'b1'})
    expect(job.sourceSnapshot.snapshotId).toBe('snap-2')
    expect(job.questions).toBeUndefined()
    expect(job.reason).toBeUndefined()
  })
})
