import { afterEach, describe, expect, it, vi } from 'vitest'
import { QQPlugin } from '../src/index.js'
import { emptyState, JobSchema, StateSchema } from '../src/state.js'
import { closeQQQueues } from '../src/backendLifecycle.js'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq.js'

afterEach(()=>vi.useRealTimers())
function fixture() {
  vi.useFakeTimers();vi.setSystemTime(10_000_000)
  const plugin=Object.create(QQPlugin.prototype) as any,config=structuredClone(QQDefaultConfig)
  config.groups=['456'];config.conversation.defaults.mode='proactive'
  const input={eventId:'qq:123:group:456:1',selfId:'123',targetId:'456',senderId:'789',senderName:'成员',conversationType:'group',messageId:'1',content:'聊一聊',mentionedBot:false,occurredAt:1,sourceParts:[{type:'text',partId:'p0',text:'聊一聊'}]}
  const job=JobSchema.parse({requestId:'observe',queueSequence:1,questionBatches:[],input,target:'group:456',conversationKey:'key',snapshot:{revision:1,config,preset:'preset',presetId:'preset',brain:'brain',senseGroup:'tools'},state:'queued',acceptedAt:Date.now(),reply:'',toolIds:[],waits:0,observe:true,decisionRequired:true})
  plugin.state=emptyState();plugin.state.jobs=[job];plugin.snapshot={revision:1,config}
  plugin.connection='connection';plugin.recovered=true;plugin.reminderBusy=true;plugin.nextAppNotificationPoll=Infinity
  plugin.busy=new Set();plugin.operations=new Set();plugin.aborters=new Map();plugin.summaryOperations=new Map();plugin.adoptedJobs=new Set()
  plugin.context={connections:{isOpen:()=>true}};plugin.publishServiceState=vi.fn();plugin.persist=vi.fn();plugin.learning={tick:vi.fn()}
  plugin.closing=()=>false;plugin.accepting=()=>true;plugin.sources={ready:()=>true}
  plugin.execute=vi.fn(async(current:any)=>{current.state='running'})
  return {plugin,job,config,tick:()=>plugin.tick()}
}
describe('QQ proactive scheduling without model or transport calls',()=>{
  it('waits for the fixed batch start, then persists one observation charge',()=>{
    const f=fixture();f.tick();expect(f.plugin.execute).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2999);f.tick();expect(f.plugin.execute).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1);f.tick();expect(f.plugin.execute).toHaveBeenCalledTimes(1)
    expect(f.plugin.state.observations['group:456'].checks).toEqual([Date.now()]);expect(f.plugin.persist).toHaveBeenCalled()
  })
  it.each(['hourly','check-interval','reply-interval'])('defers observation at the %s limit',limit=>{
    const f=fixture();f.job.acceptedAt-=10000
    const quota=f.plugin.state.observations['group:456']={checks:[] as number[],lastReplyAt:0}
    if(limit==='hourly')quota.checks=Array.from({length:60},()=>Date.now()-60000)
    if(limit==='check-interval')quota.checks=[Date.now()-10000]
    if(limit==='reply-interval')quota.lastReplyAt=Date.now()-10000
    f.tick();expect(f.plugin.execute).not.toHaveBeenCalled();expect(f.job.state).toBe('queued')
  })
  it('expires old charges, does not charge direct @ or active continuation, and keeps the target sequential',()=>{
    const f=fixture();f.job.acceptedAt-=10000
    f.plugin.state.observations['group:456']={checks:Array.from({length:60},()=>Date.now()-3600001),lastReplyAt:0}
    f.tick();expect(f.plugin.state.observations['group:456'].checks).toHaveLength(1)
    const direct=structuredClone(f.job);direct.requestId='direct';direct.state='queued';direct.observe=false;direct.decisionRequired=false;direct.input.mentionedBot=true;direct.queueSequence=2
    f.plugin.state.jobs.push(direct);f.tick();expect(f.plugin.execute).toHaveBeenCalledTimes(1)
    const next=fixture();next.job.acceptedAt-=10000;next.job.observe=false;next.job.decisionRequired=false;next.job.input.mentionedBot=true
    next.plugin.state.observations['group:456']={checks:Array.from({length:60},()=>Date.now()-1),lastReplyAt:Date.now()}
    next.tick();expect(next.plugin.execute).toHaveBeenCalledOnce();expect(next.plugin.state.observations['group:456'].checks).toHaveLength(60)
    const active=fixture();active.job.acceptedAt-=10000;active.job.observe=false;active.plugin.state.discussions['group:456']={active:true,lastActivity:Date.now()}
    active.tick();expect(active.plugin.execute).toHaveBeenCalledOnce();expect(active.plugin.state.observations).toEqual({})
  })
  it('cancels disabled observations and keeps quota through persisted restart without replay',()=>{
    const f=fixture();f.job.acceptedAt-=10000;f.config.conversation.defaults.mode='followup'
    f.tick();expect(f.job.state).toBe('cancelled');expect(f.plugin.execute).not.toHaveBeenCalled()
    const restart=fixture();restart.plugin.state.observations['group:456']={checks:[Date.now()-10],lastReplyAt:Date.now()-20}
    const saved=StateSchema.parse(JSON.parse(JSON.stringify(restart.plugin.state)))
    closeQQQueues(saved);restart.plugin.state=saved;restart.tick()
    expect(saved.jobs[0]!.state).toBe('cancelled');expect(saved.observations['group:456']!.checks).toEqual([Date.now()-10])
    expect(restart.plugin.execute).not.toHaveBeenCalled()
  })
  it('does not create observations when there are no new jobs',()=>{
    const f=fixture();f.plugin.state.jobs=[];f.tick()
    expect(f.plugin.execute).not.toHaveBeenCalled();expect(f.plugin.state.observations).toEqual({})
  })
})
