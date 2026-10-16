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
  it('inherits voice only for a same-sender modification after confirmed send', () => {
    const {plugin,job}=fixture('不够犀利')
    const old={...job,requestId:'old',acceptedAt:1000}
    const output={status:'sent',frame:{type:'qq.reply.action',data:{requestId:'old',actionKind:'voice'}}}
    expect(voiceRequested(job as any,[old] as any,[output] as any)).toBe(true)
    expect(voiceRequested(job as any,[{...old,input:{...old.input,senderId:'888'}}] as any,[output] as any)).toBe(false)
    expect(voiceRequested(job as any,[old] as any,[{...output,status:'unknown'}] as any)).toBe(false)
    plugin.state.jobs.unshift(old); plugin.state.outbox.push(output)
    const facts=plugin.conversationFacts(job)
    expect(facts.recentRequests[0].text).toBe('不够犀利')
    expect(facts.actions[0].status).toBe('sent')
  })
  it('respects off mode and unavailable configured voices without switching', async () => {
    const {plugin,job}=fixture(undefined,'off')
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'hi',completeReply:true})).rejects.toThrow('not authorized')
    job.snapshot.config.voiceMode='auto'; plugin.queryDirectory.mockResolvedValue([{id:'other',name:'other'}])
    await expect(plugin.enqueueReplyAction(job,{kind:'voice',text:'hi',completeReply:true})).rejects.toThrow('not available')
    expect(plugin.output).not.toHaveBeenCalled()
  })
  it('keeps explicit current input and real quote independent from old assistant claims', () => {
    const {plugin,job}=fixture('锐评一下 @另一个人')
    ;(job.input as any).replyToMessageId='42'
    plugin.state.discussions[job.target]={messages:[{targetId:'456',messageId:'42',senderId:'555',content:'被引用内容'}]}
    expect(plugin.conversationFacts(job).currentMessages[0].content).toContain('另一个人')
    expect(plugin.conversationFacts(job).quotedMessages[0].message.senderId).toBe('555')
    expect(conversationRules).toContain('明确新对象时切换')
    expect(conversationRules).toContain('错了直接承认')
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
})
