import { afterEach, describe, expect, it, vi } from 'vitest'
import { QQSourceLearning } from '../src/sourceLearning.js'
import { LearningStateSchema, LearningTaskSchema } from '../src/learningState.js'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq.js'
import type { IngressLearningPreparation } from '@chery/plugin-api'

afterEach(()=>vi.useRealTimers())
function fixture() {
  const state=LearningStateSchema.parse({}),config=structuredClone(QQDefaultConfig)
  const current={config,revision:1,connectionId:'connection',foreground:false,scopes:{'group:2':{scopeId:'scope',state:'active',permissionRevision:1,presetId:'preset'}} as any,completedRequests:[]}
  const task=LearningTaskSchema.parse({operationId:'operation',scopeId:'scope',target:'group:2',preset:'preset',revision:1,state:'pending',phase:'local',version:1,nextAt:0,retries:0})
  state.tasks.push(task)
  const operation={operationId:'operation',scopeId:'scope',snapshotId:'snapshot',permissionRevision:1,version:1,status:'pending' as string}
  const prepared={operation,records:[{recordId:'message',parts:[{type:'text',text:'学习资料'}]}],runs:[],deliveries:[],evidence:[],throughOrdinal:1,throughRun:0} as unknown as IngressLearningPreparation
  const api={prepareLearning:vi.fn(async()=>({...prepared,operation:{...operation}})),learningStatus:vi.fn(async()=>({...operation})),updateLearning:vi.fn(async(input:any)=>Object.assign(operation,input,{version:operation.version+1}))}
  const internalText=vi.fn(async()=> '[]'),commit=vi.fn(async(input:any)=>{input.validate();return 'receipt'}),save=vi.fn()
  const listPresets=vi.fn(()=>[{name:'named-preset',presetId:'preset'}])
  const learning=new QQSourceLearning({context:{core:{sourceConversations:api,internalText,listPresets}} as any,state,save,current:()=>current as any,commit})
  const work=()=> (learning as any).work(new AbortController().signal)
  return {state,config,current,task,operation,prepared,api,internalText,listPresets,commit,save,learning,work}
}
describe('QQ learning scheduling and recovery',()=>{
  it('looks up the source preset name by stable ID when registering automatic learning',async()=>{
    const f=fixture();f.state.tasks=[]
    await f.work()
    expect(f.state.tasks[0]?.preset).toBe('named-preset')
    expect(f.internalText).toHaveBeenCalledWith(expect.objectContaining({preset:'named-preset'}))
    expect(f.state.tasks[0]?.state).toBe('completed')
  })
  it('retries a persisted task whose preset field contains the source stable ID',async()=>{
    const f=fixture();f.task.state='failed';f.task.reason='LEARNING_FAILED'
    f.learning.retry(f.task.operationId);await f.work()
    expect(f.internalText).toHaveBeenCalledWith(expect.objectContaining({preset:'named-preset'}))
    expect(f.task.state).toBe('completed');expect(f.task.reason).toBeUndefined()
  })
  it('regenerates only rejected fragments on explicit retry and retains committed progress',async()=>{
    const f=fixture();f.task.state='failed';f.task.reason='NOT_ALLOWED'
    f.task.inputs=['already-committed','needs-regeneration'];f.task.index=1;f.task.results=['committed-result','rejected-result']
    f.learning.retry(f.task.operationId)
    expect(f.task.results).toEqual(['committed-result']);expect(f.task.index).toBe(1)
    await f.work()
    expect(f.internalText).toHaveBeenCalledTimes(1)
    expect(f.internalText).toHaveBeenCalledWith(expect.objectContaining({content:'needs-regeneration'}))
    expect(f.commit).toHaveBeenCalledTimes(1);expect(f.commit.mock.calls[0]![0]).toMatchObject({index:1,raw:'[]'})
    expect(f.task.state).toBe('completed');expect(f.state.calls).toHaveLength(1)
  })
  it('retains the local receipt when explicitly retrying a rejected public result',async()=>{
    const f=fixture();f.task.state='failed';f.task.phase='public';f.task.reason='NOT_ALLOWED';f.task.localReceipt='local-saved';f.task.inputs=['public-evidence'];f.task.results=['rejected-result']
    f.prepared.evidence=[{publicEligible:true,text:'公开词义',contentHash:'hash'} as any]
    f.learning.retry(f.task.operationId);await f.work()
    expect(f.internalText).toHaveBeenCalledTimes(1);expect(f.task.localReceipt).toBe('local-saved')
    expect(f.commit.mock.calls[0]![0]).toMatchObject({phase:'public',index:0,raw:'[]'})
    expect(f.task.state).toBe('completed')
  })
  it('follows a preset rename without selecting a different preset that reused the old name',async()=>{
    const f=fixture();f.task.preset='old-name'
    f.listPresets.mockReturnValue([{name:'old-name',presetId:'different-preset'},{name:'renamed-preset',presetId:'preset'}])
    await f.work()
    expect(f.internalText).toHaveBeenCalledWith(expect.objectContaining({preset:'renamed-preset'}))
    expect(f.task.state).toBe('completed')
  })
  it('does not charge or invoke a model when the original preset no longer exists',async()=>{
    const f=fixture();f.listPresets.mockReturnValue([{name:'preset',presetId:'different-preset'}])
    await f.work()
    expect(f.internalText).not.toHaveBeenCalled();expect(f.state.calls).toEqual([])
    expect(f.task).toMatchObject({state:'cancelled',reason:'NOT_FOUND'})
  })
  it('resumes persisted fragments without another model call',async()=>{
    const f=fixture();f.task.inputs=['one','two'];f.task.index=1;f.task.results=['[]','[]']
    await f.work()
    expect(f.internalText).not.toHaveBeenCalled();expect(f.commit).toHaveBeenCalledTimes(1)
    expect(f.commit.mock.calls[0]![0].index).toBe(1);expect(f.task.state).toBe('completed')
  })
  it('counts each real call, pauses at quota and resumes the remaining fragment',async()=>{
    const f=fixture();f.config.learning.maxCallsPerHour=1;f.task.inputs=['one','two']
    await f.work()
    expect(f.internalText).toHaveBeenCalledTimes(1);expect(f.state.calls).toHaveLength(1)
    expect(f.task).toMatchObject({state:'pending',index:1,reason:'LEARNING_HOURLY_LIMIT'})
    f.state.calls=[];f.task.nextAt=0;await f.work()
    expect(f.internalText).toHaveBeenCalledTimes(2);expect(f.task.state).toBe('completed')
  })
  it('counts a budget-driven split and retains all fragments',async()=>{
    const f=fixture();f.task.inputs=['x'.repeat(6000)]
    f.internalText.mockRejectedValueOnce(Object.assign(new Error('split'),{code:'SUMMARY_BUDGET_FAILED'}))
    await f.work()
    expect(f.task.state).toBe('completed');expect(f.state.calls.length).toBeGreaterThan(1)
    expect(f.commit.mock.calls.map(([input])=>input.index)).toEqual([0,1,2])
    expect(f.internalText.mock.calls.slice(1).flatMap(([input])=>JSON.parse((input as any).content).map((part:any)=>part.text)).join('')).toBe('x'.repeat(6000))
  })
  it('rechecks foreground and revocation after waiting for fixed input',async()=>{
    for(const revoke of [false,true]) {
      const f=fixture();f.api.prepareLearning.mockImplementationOnce(async()=>{if(revoke)f.current.scopes={};else f.current.foreground=true;return f.prepared})
      await f.work()
      expect(f.internalText).not.toHaveBeenCalled();expect(f.commit).not.toHaveBeenCalled()
      expect(f.task.state).toBe(revoke?'cancelled':'pending')
    }
  })
  it('does not register or advance new work if disabled during prepare',async()=>{
    const f=fixture();f.state.tasks=[]
    f.api.prepareLearning.mockImplementationOnce(async()=>{f.config.learningEnabled=false;return f.prepared})
    await f.work()
    expect(f.state.positions).toEqual({});expect(f.state.tasks).toEqual([]);expect(f.internalText).not.toHaveBeenCalled()
  })
  it('retains the source position at the backlog limit',async()=>{
    const f=fixture();f.config.learning.maxPending=1;f.task.state='failed'
    await f.work()
    expect(f.api.prepareLearning).not.toHaveBeenCalled();expect(f.state.positions).toEqual({})
    expect(f.state.reason).toBe('LEARNING_BACKLOG_LIMIT')
  })
  it('rechecks the public switch before committing a candidate',async()=>{
    const f=fixture();f.task.phase='public';f.task.localReceipt='done';f.prepared.evidence=[{publicEligible:true,text:'公开释义',contentHash:'hash'} as any]
    f.internalText.mockImplementationOnce(async()=>{f.config.publicTermsEnabled=false;return '[]'})
    await f.work()
    expect(f.commit).not.toHaveBeenCalled();expect(f.task.state).toBe('pending')
    await f.work();expect(f.task.state).toBe('completed');expect(f.internalText).toHaveBeenCalledTimes(1)
  })
  it('persists transient backoff and stops permanent source failures',async()=>{
    const f=fixture();f.internalText.mockRejectedValueOnce(Object.assign(new Error('temporary'),{code:'ECONNRESET'}))
    const before=Date.now();await f.work()
    expect(f.task).toMatchObject({state:'pending',retries:1,reason:'ECONNRESET'})
    expect(f.task.nextAt).toBeGreaterThanOrEqual(before+60000)
    f.task.nextAt=0;f.api.prepareLearning.mockRejectedValueOnce(Object.assign(new Error('revoked'),{code:'PERMISSION_DENIED'}))
    await f.work();expect(f.task.state).toBe('cancelled');expect(f.save).toHaveBeenCalled()
  })
  it('cancels unfinished work and marks disabled time without replaying it',()=>{
    vi.useFakeTimers();const f=fixture();vi.setSystemTime(200000)
    f.config.learningEnabled=false;f.learning.changed();f.learning.tick()
    expect(f.state.since).toBe(200000);expect(f.task.state).toBe('cancelled')
    vi.setSystemTime(300000);f.config.learningEnabled=true;f.learning.changed()
    expect(f.state.since).toBe(300000);expect(f.task.state).toBe('cancelled')
  })
  it('sends only eligible web text to public extraction, not group records or execution facts',async()=>{
    const f=fixture();f.task.phase='public';f.task.localReceipt='done'
    f.prepared.records=[{recordId:'private-record',parts:[{type:'text',text:'group-private-body'}]} as any]
    f.prepared.runs=[{runId:'private-run',output:'private-output'} as any]
    f.prepared.deliveries=[{message:'private-delivery'} as any]
    f.prepared.evidence=[{publicEligible:true,text:'公开词义正文',contentHash:'public-hash',truncated:false,runId:'private-run',url:'https://example.com/term'},
      {publicEligible:false,text:'private-web-body',contentHash:'private-hash'}] as any
    await f.work()
    expect(f.internalText).toHaveBeenCalledTimes(1)
    const input=f.internalText.mock.calls[0]![0] as any
    const content=JSON.parse(JSON.parse(input.content).map((part:any)=>part.text).join(''))
    expect(content).toEqual([{evidenceId:'public-hash',text:'公开词义正文',truncated:false}])
    for(const secret of ['group-private-body','private-record','private-output','private-delivery','private-web-body','private-run'])expect(input.content).not.toContain(secret)
  })
  it('passes configured consolidation limits to local learning without charging a summary call',async()=>{
    const f=fixture();f.config.memoryConsolidateRatio=0.9;f.config.memoryTargetRatio=0.4
    await f.work()
    const input=f.internalText.mock.calls[0]![0] as any
    const content=JSON.parse(JSON.parse(input.content).map((part:any)=>part.text).join(''))
    expect(content.limits).toMatchObject({triggerRatio:0.9,targetRatio:0.4,maxEntries:f.config.memoryMaxEntries,maxChars:f.config.memoryMaxChars})
    expect(f.state.calls).toHaveLength(f.internalText.mock.calls.length)
    expect(input.sourceMaintenance.kind).toBe('learning')
    expect(input.instruction).toContain('origin=member')
    expect(input.instruction).toContain('不得作为成员消息证据引用')
    expect(input.instruction).toContain('sender.id')
  })
})
