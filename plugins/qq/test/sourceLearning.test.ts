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
  const learning=new QQSourceLearning({context:{core:{sourceConversations:api,internalText}} as any,state,save,current:()=>current as any,commit})
  const work=()=> (learning as any).work(new AbortController().signal)
  return {state,config,current,task,operation,prepared,api,internalText,commit,save,learning,work}
}
describe('QQ learning scheduling and recovery',()=>{
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
})
