import { describe, it, expect, vi } from 'vitest'
import { QQPlugin } from '../src/index.js'
import { mergeFailure, FailureSchema, entryFailure, EntryFailureSchema } from '../src/failure.js'

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
    const next={...job,requestId:'next',coreRunId:'next-run',acceptedAt:2000,state:'running',failure:undefined}
    plugin.state.jobs.push(next)
    plugin.coreEvent('key',{type:'error',runId:'run',data:{code:'SECRET'}})
    expect(next.state).toBe('running');expect(plugin.state.outbox).toHaveLength(1)
    expect(plugin.state.jobs[0].failure.code).toBe('BRAIN_IMAGE_REVIEW_REJECTED')
    plugin.state.jobs.push({...job,requestId:'foreign',conversationKey:'foreign',target:'group:9'})
    expect(plugin.state.jobs.filter((j:any)=>j.target==='group:2' && j.failure)).toHaveLength(1)
  })
  it('unknown errors never invent an image acquisition cause',()=>{
    const failure=mergeFailure(undefined,'run',{code:'UNKNOWN_URL',message:'secret'},0)
    expect(failure.code).toBeUndefined();expect(failure.text).toContain('原因尚未确定')
  })
  it('stores only declared entry codes and phases, never raw or nested error text', () => {
    const cause = Object.assign(new Error('secret /private/path ?token=secret'), { code: 'PREVIOUS_WORK_PENDING', cause: { key: 'secret' } })
    expect(EntryFailureSchema.parse(entryFailure(cause, 'core_submit'))).toMatchObject({ code: 'PREVIOUS_WORK_PENDING', phase: 'core_submit' })
    for (const error of [new Error('secret'), { code: 'secret', message: 'secret' }, { code: { toString: () => 'PREVIOUS_WORK_PENDING' } }, null]) {
      const failure = entryFailure(error, 'source_files')
      expect(failure.code).toBe('EXECUTION_ENTRY_FAILED')
      expect(JSON.stringify(failure)).not.toContain('secret')
    }
  })
  it('records entry rejection with the request ID and sends one generic safe notice', async () => {
    const { plugin, job } = fixture()
    plugin.closing = () => false
    plugin.context.log = vi.fn()
    plugin.executeRequest = vi.fn(async (_job, stage) => {
      stage('core_submit')
      throw Object.assign(new Error('secret credentials'), { code: 'BACKEND_RESUME_REQUIRED' })
    })
    await plugin.execute(job)
    expect(job.entryFailure).toMatchObject({ code: 'BACKEND_RESUME_REQUIRED', phase: 'core_submit' })
    expect(job).toMatchObject({ state: 'failed', reason: 'BACKEND_RESUME_REQUIRED' })
    expect(plugin.context.log).toHaveBeenCalledWith('qq.request.entry.failed', expect.objectContaining({ requestId: 'request', code: 'BACKEND_RESUME_REQUIRED', phase: 'core_submit' }))
    expect(JSON.stringify([job.entryFailure, plugin.context.log.mock.calls, plugin.state.outbox])).not.toContain('secret')
    expect(plugin.state.outbox).toHaveLength(1)
  })
  it('does not change or notify a task already cancelled by shutdown on late rejection', async () => {
    const { plugin, job } = fixture()
    plugin.context.log = vi.fn()
    plugin.executeRequest = vi.fn(async () => { job.state = 'cancelled'; job.reason = 'BACKEND_STOPPED'; throw new Error('late') })
    await plugin.execute(job)
    expect(job).toMatchObject({ state: 'cancelled', reason: 'BACKEND_STOPPED' })
    expect(job.entryFailure).toBeUndefined(); expect(plugin.state.outbox).toEqual([])
    expect(plugin.context.log).not.toHaveBeenCalled()
  })
})
