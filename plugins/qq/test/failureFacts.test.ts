import { describe, it, expect, vi } from 'vitest'
import { QQPlugin } from '../src/index.js'
import { mergeFailure, FailureSchema } from '../src/failure.js'

const detail = { status:'failed', retryable:false, feedback:{code:'BRAIN_IMAGE_REVIEW_REJECTED',tracingId:'6486dd90',description:'secret URL'}, detail:'secret-key' }
function fixture() {
  const job:any={requestId:'request',coreRunId:'run',conversationKey:'key',target:'group:2',state:'running',acceptedAt:1000,input:{messageId:'10',selfId:'1',senderId:'3',targetId:'2',conversationType:'group'},snapshot:{config:{backgroundMaxAgeMs:10000}},inputParts:[{type:'asset',kind:'image'}],reply:'',toolIds:[],background:[]}
  const plugin:any=Object.create(QQPlugin.prototype)
  Object.assign(plugin,{state:{jobs:[job],outbox:[],seq:{},discussions:{}},stopped:false,paused:false,persist:vi.fn(),preparingReplies:new Set(),operations:new Set(),context:{}})
  return {plugin,job}
}
describe('safe persistent failure facts',()=>{
  it('retains declared cause across generic events and strips upstream prose',()=>{
    const first=mergeFailure(undefined,'run',detail,1)
    const next=mergeFailure(first,'run',{status:'failed',code:'SECRET',message:'secret'},1)
    expect(FailureSchema.parse(next)).toMatchObject({code:'BRAIN_IMAGE_REVIEW_REJECTED',stage:'model',tracingId:'6486dd90',retryable:false,inputImageReferences:1})
    expect(next.text).toContain('图片审核');expect(next.text).not.toContain('稍后再试')
    expect(JSON.stringify(next)).not.toContain('secret')
  })
  for(const order of ['outcome-first','error-first']) it(`one notice and exact run facts: ${order}`,async()=>{
    const {plugin,job}=fixture()
    const outcome={type:'run.outcome',runId:'run',data:detail}
    const error={type:'error',runId:'run',data:{code:'BRAIN_IMAGE_REVIEW_REJECTED',tracingId:'6486dd90',retryable:false}}
    for(const event of order==='outcome-first'?[outcome,error]:[error,outcome]) plugin.coreEvent('key',event)
    await Promise.all([...plugin.operations])
    expect(plugin.state.outbox).toHaveLength(1)
    expect(plugin.state.outbox[0].frame.data.text).toContain('6486dd90')
    expect(job.failure).toMatchObject({code:'BRAIN_IMAGE_REVIEW_REJECTED',runId:'run'})
    const next={...job,requestId:'next',coreRunId:'next-run',acceptedAt:2000,state:'running'}
    plugin.state.jobs.push(next)
    plugin.coreEvent('key',{type:'error',runId:'run',data:{code:'SECRET'}})
    expect(next.state).toBe('running');expect(plugin.state.outbox).toHaveLength(1)
    const facts=plugin.conversationFacts(next)
    expect(facts.recentRequests[0].failure.code).toBe('BRAIN_IMAGE_REVIEW_REJECTED')
    plugin.state.jobs.push({...job,requestId:'foreign',conversationKey:'foreign',target:'group:9'})
    expect(plugin.conversationFacts(next).recentRequests).toHaveLength(1)
  })
  it('unknown errors never invent an image acquisition cause',()=>{
    const failure=mergeFailure(undefined,'run',{code:'UNKNOWN_URL',message:'secret'},0)
    expect(failure.code).toBeUndefined();expect(failure.text).toContain('原因尚未确定')
  })
})
