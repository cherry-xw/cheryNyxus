import {describe,it,expect,vi} from 'vitest'
import {QQDefaultConfig,QQEventSubmitRequestSchema} from '../../../packages/protocol/src/qq.js'
import {QQPlugin, discussionInputChunks} from '../src/index.js'
import {QQGroupMemoryStore} from '../src/groupMemory.js'
import {summarySourceData} from '../src/sourceMaintenance.js'
import {QQSourceIntake} from '../src/sourceIntake.js'
import {StateSchema, emptyState} from '../src/state.js'
import {mkdtemp, rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const sourceRef = { recordId: 'record-1', revision: 1 }
function fixture(){
 const job:any={requestId:'r',queueSequence:1,questionBatches:[],target:'group:2',state:'running',acceptedAt:Date.now(),input:{selfId:'1',targetId:'2',conversationType:'group'},snapshot:{revision:1,config:{continuationTtlMs:100000,waitIntervalSeconds:30}},toolIds:[]}
 const p:any=Object.create(QQPlugin.prototype)
  Object.assign(p,{state:{...emptyState(),jobs:[job],sourceScopes:{'group:2':{scopeId:'scope-2',conversationId:'conv-2',selfId:'1',conversationType:'group',targetId:'2',presetId:'p',generation:1,state:'active',qqContextEpoch:'',permissionRevision:1,selectionRevision:0,createdAt:1}}},snapshot:{revision:1,config:{...QQDefaultConfig,continuationTtlMs:100000,waitIntervalSeconds:30,groups:['2'],users:[],bindings:{'group:2':'preset'}}},learning:{tick:vi.fn(),interrupt:vi.fn()},persist:vi.fn(),context:{log:vi.fn(),isEnabled:()=>true,core:{resolvePreset:()=>({presetId:'p'}),sourceConversations:{recordDelivery:vi.fn(async()=>({}))}},connections:{isOpen:()=>true,send:vi.fn(()=>true)}},connection:'c',verifiedConnection:'c',recovered:true,stopped:false,paused:false,busy:new Set(),summaryOperations:new Map(),operations:new Set(),aborters:new Map(),preparingReplies:new Set(),publishingDeliveries:new Set(),answering:new Set(),adoptedJobs:new Set(),reminderBusy:true,nextAppNotificationPoll:Infinity})
 return {p,job}
}
function sourceApi(overrides: Record<string, any> = {}) {
 return {
  prepareSummary: vi.fn(async (input: any) => ({
   operation: { operationId: input.operationId, scopeId: input.scopeId, snapshotId: 'snap-maint', purpose: input.purpose, status: 'pending', phase: 'history', version: 1, qqConfigRevision: 1, permissionRevision: 1, baseSelectionRevision: 0, evidence: [{ record: sourceRef, textPartIds: ['p0'], attachments: [] }] },
   snapshot: { snapshotId: 'snap-maint', requestId: input.operationId, scopeId: input.scopeId, snapshotVersion: 1, selectionRevision: 0, throughIngestOrdinal: 1, selectedAt: 1, qqConfigRevision: 1, ordering: 'time_approximate', selectionStats: { recentRecordCount: 1, recentTextCodePoints: 4 }, inputRecords: [], maintenancePurpose: input.purpose, orderedItems: [{ type: 'message', ...sourceRef, selectionReasons: ['recent'], parts: [{ partId: 'p0', mode: 'expand' }] }], quoteRelations: [] },
   records: [{ ...sourceRef, conversationId: 'conv-2', ingestOrdinal: 1, origin: 'member', sender: { id: '3', name: '成员3' }, platformMessageIds: ['1'], platformSentAt: 1000, receivedAt: 1000, parts: [{ partId: 'p0', type: 'text', text: 'fact' }] }],
   attachments: [], deliveries: [],
  })),
  updateSummaryProgress: vi.fn(async (input: any) => ({ operationId: input.operationId, scopeId: input.scopeId, snapshotId: 'snap-maint', purpose: 'discussion', status: input.status, phase: input.phase, reasonCode: input.reasonCode, version: input.expectedVersion + 1, qqConfigRevision: 1, permissionRevision: 1, baseSelectionRevision: 0, evidence: [] })),
  summaryStatus: vi.fn(async (input: any) => ({ operationId: input.operationId, scopeId: input.scopeId, snapshotId: 'snap-maint', purpose: 'discussion', status: 'running', phase: 'summary', version: 2, qqConfigRevision: 1, permissionRevision: 1, baseSelectionRevision: 0, evidence: [] })),
  commitSummary: vi.fn(async (input: any) => {
   if (!input.validatePrerequisite(input.prerequisiteReceipt, input.operationId)) throw Object.assign(new Error('SUMMARY_PREREQUISITE_FAILED'), { code: 'SUMMARY_PREREQUISITE_FAILED' })
   return { summaryId: 'sum-1', scopeId: input.scopeId, revision: 1, operationId: input.operationId, purpose: 'discussion', text: input.text, committedAt: 10, evidence: [], replacement: [] }
  }),
  recordDelivery: vi.fn(async () => ({})),
  ...overrides,
 }
}
describe('discussion maintenance does not block foreground',()=>{
  function failedDiscussion() {
   const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'};p.state.receipts={};p.state.nextQueueSequence=1
   p.snapshot={revision:1,config:{...QQDefaultConfig,groups:['2'],users:[],bindings:{'group:2':'preset'},memoryEnabled:false}}
   const maintenance={operationId:'old-failed',scopeId:'scope-2',qqConfigRevision:1,status:'failed',phase:'memory',startedAt:3,
    discussionStartedAt:1,discussionClosedAt:2,attempt:1,reason:'SUMMARY_MEMORY_FAILED',memoryReceipts:[],
    memoryBatch:{expectedRevision:13,delete:[],save:[{content:'旧'.repeat(171)}]}}
   const discussion={active:false,lastActivity:1,startedAt:1,closedAt:2,sourceScopeId:'scope-2',summaryPending:true,summaryRetryAt:Number.MAX_SAFE_INTEGER,maintenance}
   p.state.discussions['group:2']=discussion
   const internalText=vi.fn(async()=> 'new summary'),api=sourceApi()
   p.context.core={internalText,resolvePreset:()=>({presetId:'p',brain:'b',senseGroup:'s'}),ensureConversation:async()=>{},sourceConversations:api}
   p.tick=vi.fn()
   const input=QQEventSubmitRequestSchema.parse({eventId:'qq:1:group:2:11',messageId:'11',selfId:'1',senderId:'3',senderName:'test',targetId:'2',conversationType:'group',mentionedBot:true,content:'新的讨论',sourceParts:[{partId:'p0',type:'text',text:'新的讨论'}],occurredAt:1})
   const scope=p.state.sourceScopes['group:2'],receipt={record:sourceRef}
   const tick=()=> (QQPlugin.prototype as any).tick.call(p)
   return {p,discussion,maintenance,input,scope,receipt,internalText,api,tick}
  }
  it.each([Number.MAX_SAFE_INTEGER,Date.now()+3600000])('starts a new discussion without inheriting old summary wait %s',async retryAt=>{
   const {p,discussion,maintenance,input,scope,receipt,internalText,api,tick}=failedDiscussion()
   discussion.summaryRetryAt=retryAt
   const old=structuredClone(maintenance)
   await p.decideInput(input,receipt,scope)
   expect(discussion.active).toBe(true);expect(discussion.startedAt).toBeGreaterThan(2);expect(discussion.summaryRetryAt).toBe(0)
   expect(discussion.maintenance).toBe(maintenance);expect(maintenance).toEqual(old)
   for(const job of p.state.jobs) job.state='running'
   p.state.outbox=[]
   tick();await Promise.all([...p.operations])
   expect(internalText).not.toHaveBeenCalled();expect(api.prepareSummary).not.toHaveBeenCalled()
   for(const job of p.state.jobs) job.state='completed'
   p.state.outbox=[];discussion.lastActivity=Date.now()-p.snapshot.config.continuationTtlMs-1
   tick();await Promise.all([...p.operations])
   expect(discussion.active).toBe(false);expect(discussion.summaryPending).toBe(false)
   expect(discussion.maintenance.operationId).not.toBe('old-failed');expect(discussion.maintenance.status).toBe('completed')
   expect(api.prepareSummary).toHaveBeenCalledTimes(1);expect(api.prepareSummary.mock.calls[0][0].operationId).toBe(discussion.maintenance.operationId)
   expect(api.commitSummary).toHaveBeenCalledTimes(1);expect(internalText).toHaveBeenCalledTimes(1)
   expect(maintenance).toEqual(old)
  })
  it.each([Number.MAX_SAFE_INTEGER,Date.now()+3600000])('keeps same-discussion failure wait %s on ticks and continued input',async retryAt=>{
   const {p,discussion,input,scope,receipt,internalText,api,tick}=failedDiscussion()
   discussion.summaryRetryAt=retryAt
   tick();await Promise.all([...p.operations])
   expect(internalText).not.toHaveBeenCalled();expect(api.prepareSummary).not.toHaveBeenCalled()
   discussion.active=true;discussion.lastActivity=Date.now()
   await p.decideInput(input,receipt,scope)
   expect(discussion.startedAt).toBe(1);expect(discussion.summaryRetryAt).toBe(retryAt)
   expect(discussion.maintenance.operationId).toBe('old-failed')
  })
  it('does not clear a failed summary wait when the same event is replayed',async()=>{
   const {p,discussion,input,scope,receipt,internalText}=failedDiscussion()
   await p.decideInput(input,receipt,scope)
   discussion.active=false;discussion.closedAt=Date.now();discussion.summaryRetryAt=Number.MAX_SAFE_INTEGER
   const before=structuredClone(discussion),jobs=p.state.jobs.length,outputs=p.state.outbox.length
   await p.decideInput(input,receipt,scope)
   expect(discussion).toEqual(before);expect(p.state.jobs).toHaveLength(jobs);expect(p.state.outbox).toHaveLength(outputs)
   expect(internalText).not.toHaveBeenCalled()
  })
  it('does not reset old failure wait for passive input or a rejected target',async()=>{
   const {p,discussion,input,scope,receipt,internalText}=failedDiscussion(),before=structuredClone(discussion)
   expect((await p.decideInput({...input,mentionedBot:false},receipt,scope)).accepted).toBe(false)
   expect(discussion).toEqual(before)
   await expect(p.decideInput({...input,eventId:'other',targetId:'99'},receipt,scope)).rejects.toThrow('QQ目标未获许可')
   expect(discussion).toEqual(before);expect(internalText).not.toHaveBeenCalled()
  })
  it('saves a native question answer without starting a new discussion or resetting summary wait',async()=>{
   const {p,discussion,input,scope,receipt,internalText}=failedDiscussion(),before=structuredClone(discussion)
   const batch={batchId:'question-batch',runId:'question-run',status:'pending',replies:[],items:[{questionId:'question',eventId:'question-event'}]}
   p.state.jobs.push({requestId:'question-request',coreRunId:'question-run',target:'group:2',state:'paused',reason:'WAITING_FOR_ANSWER',
    input,sourceScopeId:'scope-2',snapshot:{...p.snapshot,presetId:'p'},questionBatches:[batch]})
   p.state.outbox.push({status:'sent',messageIds:['55'],frame:{data:{eventId:'question-event'}}})
   expect((await p.decideInput({...input,replyToMessageId:'55'},receipt,scope)).accepted).toBe(true)
   expect(discussion).toEqual(before);expect(p.state.jobs).toHaveLength(1);expect(batch.replies).toHaveLength(1)
   expect(batch.items[0]).toMatchObject({answer:input.content,answerRecord:sourceRef})
   expect(internalText).not.toHaveBeenCalled()
  })
  it('chunks escaped Chinese and surrogate input losslessly within budget',()=>{
  const raw=('中文😀\\\"\u0001').repeat(80000)
  const chunks=discussionInputChunks(raw)
  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks.every(c=>c.length<=180000)).toBe(true)
  expect(chunks.flatMap(c=>JSON.parse(c)).map(f=>f.text).join('')).toBe(raw)
 })
 it('real group memory atomically deduplicates a receipt across store restart',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'qq-summary-memory-'))
  const subject={selfId:'1',userId:'3',conversationType:'group' as const,groupId:'2'}
  const batch={expectedRevision:0,delete:[],save:[{id:'fact',topic:'test',kind:'fact',content:'confirmed',members:['3'],evidence:'statement',sources:[{source:sourceRef,partIds:['p0'],messageId:'1',userId:'3',occurredAt:1}],status:'active'}]}
  try {
   const first=await new QQGroupMemoryStore(root).manage(subject,batch,[{source:sourceRef,partIds:['p0'],messageId:'1',senderId:'3',occurredAt:1,content:'confirmed'}],undefined,'stable-operation')
   const restored=new QQGroupMemoryStore(root)
   expect(await restored.operationStatus(subject,'stable-operation')).toMatchObject(first)
   expect(await restored.manage(subject,batch,[],undefined,'stable-operation')).toEqual(first)
   expect((await restored.search(subject,'')).revision).toBe(1)
   await expect(restored.manage(subject,{...batch,expectedRevision:1},[],undefined,'stable-operation')).rejects.toThrow('conflict')
  } finally {await rm(root,{recursive:true,force:true})}
 })
 it('memory written before state checkpoint is reconciled without a second extraction',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'qq-summary-recovery-'))
  const subject={selfId:'1',userId:'3',conversationType:'group' as const,groupId:'2'}
  const messages=[{source:sourceRef,partIds:['p0'],messageId:'1',senderId:'3',occurredAt:1,content:'fact'}]
  const batch={expectedRevision:0,delete:[],save:[{id:'fact',topic:'test',kind:'fact',content:'fact',members:['3'],evidence:'statement',sources:[{source:sourceRef,partIds:['p0'],messageId:'1',userId:'3',occurredAt:1}],status:'active'}]}
  try {
   await new QQGroupMemoryStore(root).manage(subject,batch,messages,undefined,'resume-memory-0')
   const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'};p.context.dataDir=root
   p.snapshot={revision:1,config:{groups:['2'],users:[],continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:true,memoryMaxEntries:80,memoryMaxChars:160,memoryContextChars:6000}}
   p.state.discussions['group:2']={active:false,lastActivity:1,startedAt:1,closedAt:2,sourceScopeId:'scope-2',summaryPending:true,summaryRetryAt:0,maintenance:{operationId:'resume-memory',scopeId:'scope-2',qqConfigRevision:1,status:'running',phase:'memory',startedAt:3,discussionStartedAt:1,discussionClosedAt:2,attempt:1,snapshotId:'snap-maint',memoryInputs:['saved-source'],memoryIndex:0,memoryBatch:batch,memoryReceipts:[]}}
   const internalText=vi.fn(async()=> 'summary')
   p.context.core={internalText,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},sourceConversations:sourceApi()}
   p.tick();await Promise.all([...p.operations])
   expect(internalText).toHaveBeenCalledTimes(1)
   expect((await new QQGroupMemoryStore(root).search(subject,'')).revision).toBe(1)
   expect(p.state.discussions['group:2'].summaryPending).toBe(false)
  } finally {await rm(root,{recursive:true,force:true})}
 })
 it('resumes completed memory and completed summary blocks after persisted restart',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={revision:1,config:{groups:['2'],users:[],continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:true}}
  const d={active:false,lastActivity:1,startedAt:1,closedAt:2,sourceScopeId:'scope-2',summaryPending:true,summaryRetryAt:0,maintenance:{operationId:'resume',scopeId:'scope-2',qqConfigRevision:1,status:'running',phase:'summary',startedAt:3,discussionStartedAt:1,discussionClosedAt:2,attempt:1,snapshotId:'snap-maint',memoryComplete:true,memoryReceipts:[],summaryInputs:['first-persisted-block','second-persisted-block'],summaryResults:['saved first']}}
  p.state.discussions=StateSchema.parse({...emptyState(),discussions:{'group:2':d}}).discussions
  const internalText=vi.fn(async()=> 'new summary'),api=sourceApi()
  p.context.core={internalText,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},sourceConversations:api}
  p.tick();await Promise.all([...p.operations])
  expect(internalText.mock.calls).toHaveLength(2)
  expect((internalText.mock.calls as any)[0][0].content).toBe('second-persisted-block')
  expect(p.state.discussions['group:2'].maintenance.operationId).toBe('resume')
  expect(p.state.discussions['group:2'].summaryPending).toBe(false)
 })
 it('a late old failure cannot set a new discussion pending or expose an arbitrary code',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={revision:1,config:{groups:['2'],users:[],continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:false}}
  const d:any={active:false,lastActivity:1,startedAt:1,closedAt:2,sourceScopeId:'scope-2',summaryPending:true,summaryRetryAt:0};p.state.discussions['group:2']=d
  let reject:any;const wait=new Promise<string>((_,r)=>reject=r)
  p.context.core={internalText:()=>wait,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},sourceConversations:sourceApi()}
  p.tick();for(let i=0;i<10;i++) await Promise.resolve()
  reject(Object.assign(new Error('secret'),{code:'secret-token'}))
  d.startedAt=10;d.active=true;d.summaryPending=false;d.summaryRetryAt=123
  await Promise.all([...p.operations])
  expect(d.summaryPending).toBe(false);expect(d.summaryRetryAt).toBe(123);expect(JSON.stringify(d)).not.toContain('secret-token')
 })
 it('reconciles an already committed candidate without generating or committing again',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={revision:1,config:{groups:['2'],users:[],continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:false}}
  const discussion:any={active:false,lastActivity:1,startedAt:1,closedAt:2,sourceScopeId:'scope-2',summaryPending:true,summaryRetryAt:0,maintenance:{operationId:'stable-op',scopeId:'scope-2',qqConfigRevision:1,status:'pending',phase:'commit',startedAt:3,discussionStartedAt:1,discussionClosedAt:2,attempt:1,candidate:'already stored',snapshotId:'snap-maint',memoryReceipts:[]}}
  p.state.discussions['group:2']=discussion
  const internalText=vi.fn(),api=sourceApi({prepareSummary:vi.fn(async(input:any)=>({
   operation:{operationId:input.operationId,scopeId:input.scopeId,snapshotId:'snap-maint',purpose:'discussion',status:'completed',phase:'commit',version:2,qqConfigRevision:1,permissionRevision:1,baseSelectionRevision:0,summaryId:'sum-1',evidence:[]},
   snapshot:{snapshotId:'snap-maint',requestId:input.operationId,scopeId:input.scopeId,snapshotVersion:1,selectionRevision:0,throughIngestOrdinal:1,selectedAt:1,qqConfigRevision:1,ordering:'time_approximate',selectionStats:{recentRecordCount:1,recentTextCodePoints:4},inputRecords:[],maintenancePurpose:'discussion',orderedItems:[],quoteRelations:[]},
   records:[],attachments:[],deliveries:[],
  }))})
  p.context.core={internalText,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},sourceConversations:api}
  p.tick();await Promise.all([...p.operations])
  expect(internalText).not.toHaveBeenCalled();expect(api.commitSummary).not.toHaveBeenCalled()
  expect(discussion.maintenance.status).toBe('completed');expect(discussion.summaryPending).toBe(false)
 })
 it('keeps pending during generation and publishes coverage only after commit',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={revision:1,config:{groups:['2'],users:[],continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:false}}
  const discussion:any={active:false,lastActivity:1,startedAt:1,closedAt:2,sourceScopeId:'scope-2',summaryPending:true,summaryRetryAt:0}
  p.state.discussions['group:2']=discussion
  let resolve:any;const waiting=new Promise<string>(r=>{resolve=r})
  const api=sourceApi()
  p.context.core={internalText:vi.fn(()=>waiting),resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},sourceConversations:api}
  p.tick();await Promise.resolve();await Promise.resolve();await Promise.resolve()
  expect(discussion.summaryPending).toBe(true);expect(discussion.maintenance.status).toBe('running');expect(p.busy.size).toBe(0)
  resolve('new summary');await Promise.all([...p.operations])
  expect(discussion.summaryPending).toBe(false)
  expect(discussion.maintenance).toMatchObject({status:'completed',throughEventId:'record-1',phase:'commit'})
  expect(api.commitSummary).toHaveBeenCalledTimes(1)
 })
 it('does not commit a summary after foreground cancellation',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={revision:1,config:{groups:['2'],users:[],continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:false}}
  const discussion:any={active:false,lastActivity:1,startedAt:1,closedAt:2,sourceScopeId:'scope-2',summaryPending:true,summaryRetryAt:0}
  p.state.discussions['group:2']=discussion
  let resolve:any;const waiting=new Promise<string>(r=>{resolve=r});const api=sourceApi()
  p.context.core={internalText:()=>waiting,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},sourceConversations:api}
  p.tick();await Promise.resolve();await Promise.resolve();await Promise.resolve()
  p.summaryOperations.get('group:2').abort();resolve('late');await Promise.all([...p.operations])
  expect(api.commitSummary).not.toHaveBeenCalled()
  expect(discussion.maintenance).toMatchObject({status:'cancelled',reason:'SUMMARY_FOREGROUND_PRIORITY'})
 })
})

describe('delivery failures never silence future requests',()=>{
 it('approval wait is visible without exposing arguments or accepting chat approval',()=>{
  const {p,job}=fixture();job.conversationKey='k';job.nextWaitAt=Date.now()
  p.coreEvent('k',{type:'interrupt',data:{needsApproval:true,arguments:'secret',senseName:'private_tool'}})
  expect(job.state).toBe('running');expect(job.reason).toBe('WAITING_FOR_APPROVAL');expect(job.nextWaitAt).toBeUndefined()
  expect(p.state.outbox[0].frame.data.text).toContain('工作台')
  expect(JSON.stringify(p.state.outbox)).not.toContain('secret')
  p.coreEvent('k',{type:'interrupt',data:{needsApproval:true,arguments:'secret'}});expect(p.state.outbox).toHaveLength(1)
 })
 it('directory lookup remains pending after a month and accepts its result',async()=>{
  vi.useFakeTimers()
  try {
   const {p,job}=fixture();p.lookups=new Map()
   const operation=p.queryDirectory(job,'voices');let settled=false;void operation.then(()=>{settled=true})
   await vi.advanceTimersByTimeAsync(32*86400000);expect(settled).toBe(false)
   const [id,pending]=[...p.lookups.entries()][0];p.lookups.delete(id);pending.resolve([{id:'voice',name:'voice'}])
   expect(await operation).toEqual([{id:'voice',name:'voice'}])
  } finally {vi.useRealTimers()}
 })
 it('provides all delivery kinds without confusing notice success with video success or crossing conversations',()=>{
  const {p,job}=fixture();job.input.messageId='10';job.reply='';job.conversationKey='same';job.acceptedAt=2000;job.background=[];job.snapshot.config.backgroundMaxAgeMs=100000;job.sourceScopeId='scope-2'
  const old={...job,requestId:'old',acceptedAt:1000,input:{...job.input,messageId:'9'},reply:'已经发送',state:'failed',sourceScopeId:'scope-2'}
  p.state.jobs.unshift(old)
  p.output(old,'qq.reply.video',{mediaFile:'private.mp4'});p.state.outbox[0].status='unknown'
  p.output(old,'qq.request.failed',{text:'未取得确认'});p.state.outbox[1].status='sent';p.state.outbox[1].messageIds=['88'];p.state.outbox[1].result={status:'sent',messageIds:['88']}
  for(const type of ['qq.reply.part','qq.reply.file','qq.reply.images','qq.reply.action']) p.output(old,type,{text:'output'})
  const foreign={...old,requestId:'foreign',target:'group:99',conversationKey:'other',sourceScopeId:'scope-99'};p.state.jobs.push(foreign);p.output(foreign,'qq.reply.part',{text:'secret'})
  const scoped=p.state.outbox.filter((o:any)=>o.sourceScopeId==='scope-2')
  const data=summarySourceData({
   operation:{} as any,snapshot:{snapshotId:'snap-1',ordering:'time_approximate',orderedItems:[]} as any,
   records:[],attachments:[],
   deliveries:scoped.map((o:any)=>({deliveryId:o.frame.data.eventId,purpose:o.frame.type==='qq.request.failed'?'error_notice':'reply',kind:'message',frame:o.frame,result:o.result??(o.status!=='pending'?{status:o.status,messageIds:o.messageIds??[]}:undefined),revision:1})),
  }) as any
  expect(data.deliveries).toHaveLength(6)
  expect(data.deliveries[0]).toMatchObject({type:'qq.reply.video',status:'unknown',purpose:'reply'})
  expect(data.deliveries[1]).toMatchObject({type:'qq.request.failed',purpose:'error_notice',status:'sent',messageIds:['88']})
  expect(JSON.stringify(data)).not.toContain('private.mp4');expect(JSON.stringify(data)).not.toContain('secret')
 })
 it('accepts bare mentions and gives every merged mention its own acknowledgement',async()=>{
  const {p}=fixture();p.state.identityBinding={selfId:'1'};p.state.jobs=[];p.state.receipts={};p.state.contextEpoch=''
   p.snapshot={revision:1,config:{...QQDefaultConfig,groups:['2'],users:[],bindings:{'group:2':'preset'},queueLimit:10,backgroundMessageLimit:30,backgroundMaxAgeMs:100000,backgroundMaxChars:10000,continuationTtlMs:10000,messageMergeMs:1500}}
  let nextRec=0
  const api=sourceApi({
   beginReceipt:vi.fn(async(input:any)=>({state:'pending',receiptId:`rcpt-${++nextRec}`,version:1,record:{recordId:`rec-${nextRec}`,revision:1}})),
   receiptAttachments:vi.fn(async()=>[]),
   completeReceipt:vi.fn(async(input:any)=>({receiptId:input.receiptId,version:2,record:{recordId:input.receiptId.replace('rcpt-','rec-'),revision:1},handling:input.handling})),
   lookupReceipt:vi.fn(async()=>({state:'pending'})),
  })
  p.context.identity={bind:vi.fn(async()=>({} as any))}
  p.context.core={resolvePreset:()=>({presetId:'p',brain:'b',senseGroup:'s'}),sourceConversations:api};p.tick=vi.fn()
  p.sources=new QQSourceIntake(p.context,p.state,()=>({config:p.snapshot.config,revision:1,enabled:true}),()=>p.persist())
  const input:any={eventId:'qq:1:group:2:11',messageId:'11',selfId:'1',senderId:'3',senderName:'test',targetId:'2',conversationType:'group',mentionedBot:true,content:'',sourceParts:[{partId:'p0',type:'mention',target:'1'}],parts:[{type:'text',text:' '}],attachments:[],occurredAt:Math.floor(Date.now()/1000)}
  expect(QQEventSubmitRequestSchema.safeParse({...input,mentionedBot:false,sourceParts:[]}).success).toBe(false)
  expect((await p.submit(QQEventSubmitRequestSchema.parse(input))).accepted).toBe(true)
  expect((await p.submit(QQEventSubmitRequestSchema.parse({...input,eventId:'qq:1:group:2:12',messageId:'12'}))).accepted).toBe(true)
  expect(p.state.jobs).toHaveLength(1)
  expect(p.state.outbox.filter((o:any)=>o.frame.type==='qq.message.ack').map((o:any)=>o.frame.data.messageId)).toEqual(['11','12'])
  expect(p.state.jobs[0].input.content).toBe('')
  expect(p.state.jobs[0].input.mentionedBot).toBe(true)
  expect(p.state.jobs[0].sourceRecords).toHaveLength(2)
  expect(p.state.jobs[0].mergedInputs).toHaveLength(2)
 })
 it('keeps model running when acknowledgement is unknown and records a visible notice',()=>{
  const {p,job}=fixture();p.output(job,'qq.message.ack',{messageId:'3',emojiId:'178'})
  const ack=p.state.outbox[0];ack.status='unknown';p.deliveryProblem(job,ack)
  expect(job.state).toBe('running');expect(p.state.outbox[1].frame.data.text).toContain('确认表情')
  p.deliveryProblem(job,ack);expect(p.state.outbox).toHaveLength(2)
 })
 it('sends pending failure notice even after job becomes terminal',async()=>{
  const {p,job}=fixture();p.failureNotice(job,'这次发送失败，未完成。');p.tick();await Promise.all([...p.operations])
  expect(job.state).toBe('failed');expect(p.context.connections.send).toHaveBeenCalledWith('c',expect.objectContaining({type:'qq.request.failed'}))
 })
 it('does not recursively create notices for notice delivery failure',()=>{
  const {p,job}=fixture();p.failureNotice(job,'这次失败。');const notice=p.state.outbox[0];notice.status='unknown';p.deliveryProblem(job,notice)
  expect(p.state.outbox).toHaveLength(1)
 })
 it('dispatches new acknowledgements while an old video is still in flight',async()=>{
  const {p,job}=fixture();p.output(job,'qq.reply.video',{mediaFile:'1.mp4'});p.state.outbox[0].status='inflight';p.state.outbox[0].issuedAt=Date.now()
  p.output(job,'qq.message.ack',{messageId:'4',emojiId:'178'});p.tick();await Promise.all([...p.operations])
  expect(p.context.connections.send).toHaveBeenCalledWith('c',expect.objectContaining({type:'qq.message.ack'}))
 })
 it('does not expire a month-old running task or its video and keeps progress independent',async()=>{
  const {p,job}=fixture();job.acceptedAt=Date.now()-32*86400000;p.output(job,'qq.reply.video',{mediaFile:'1.mp4'});const old=p.state.outbox[0];old.status='inflight';old.issuedAt=job.acceptedAt
  p.output(job,'qq.waiting',{text:'working'});p.tick();await Promise.all([...p.operations])
  expect(old.status).toBe('inflight');expect(job.state).toBe('running')
  expect(p.context.connections.send).toHaveBeenCalledWith('c',expect.objectContaining({type:'qq.waiting'}))
  expect(p.context.connections.send.mock.calls.some((c:any)=>c[1].type==='qq.reply.video')).toBe(false)
 })
 it('combines tool icons and public text in the existing cycle without thinking or completion',()=>{
  const {p,job}=fixture();job.reply='';job.waits=0;job.conversationKey='k';job.snapshot.config={...job.snapshot.config,waitMessages:['working'],toolIconsEnabled:true,waitMessageMode:'cycle',toolIcons:{web:'🌐',bash:'🔧'}}
  p.coreEvent('k',{type:'sense_started',data:{id:'a',senseName:'web'}})
  p.coreEvent('k',{kind:'chunk',type:'staged',data:{type:'content_end',role:'assistant',content:'读取网页。'}})
  p.coreEvent('k',{type:'sense_started',data:{id:'b',senseName:'bash'}})
  p.coreEvent('k',{kind:'chunk',type:'staged',data:{type:'content_end',role:'assistant',content:'探测清晰度。'}})
  p.coreEvent('k',{kind:'chunk',type:'staged',data:{type:'thinking_end',role:'assistant',content:'private'}})
  expect(p.state.outbox).toHaveLength(0)
  job.nextWaitAt=Date.now()-1;p.tick()
  expect(p.state.outbox.at(-1).frame.data.text).toBe('🌐 读取网页。\n🔧 探测清晰度。')
  expect(job.state).toBe('running');expect(job.pendingActivity).toEqual([])
  expect(p.state.outbox.at(-1).activityReplyThrough).toBe(job.reply.length)
 })
 it('retains unsent text when replacing a pending feedback cycle',()=>{
  const {p,job}=fixture();job.reply='A';job.waits=0;job.pendingActivity=['🌐 A'];job.pendingIcons=['🌐'];job.activityReplyOffset=0
  job.snapshot.config={...job.snapshot.config,waitMessages:['working'],toolIconsEnabled:true,waitMessageMode:'cycle'}
  p.context.connections.send=()=>false
  job.nextWaitAt=Date.now()-1;p.tick()
  job.reply='A\n\nB';job.pendingActivity=['🔧 B'];job.pendingIcons=['🔧'];job.nextWaitAt=Date.now()-1;p.tick()
  const feedback=p.state.outbox.filter((o:any)=>o.frame.type==='qq.waiting')
  expect(feedback).toHaveLength(1);expect(feedback[0].frame.data.text).toContain('A\n\nB')
 })
 it('defers final reply preparation while public text feedback is in flight',async()=>{
  const {p,job}=fixture();job.reply='A';job.pendingActivity=['🌐 A'];job.pendingIcons=['🌐'];job.activityReplyOffset=0
  job.snapshot.config={...job.snapshot.config,waitMessages:['working'],toolIconsEnabled:true,waitMessageMode:'cycle'}
  job.snapshot.config.maxMessageChars=1000
  job.nextWaitAt=Date.now()-1;p.tick();p.state.outbox.at(-1).status='inflight'
  await p.finishWithFiles(job,'completed')
  expect(job.filePreparationPending).toBe(true)
  expect(p.state.outbox.some((o:any)=>o.frame.type==='qq.reply.part')).toBe(false)
  p.state.outbox.at(-1).status='sent';job.activityReplyOffset=1
  await p.finishWithFiles(job,'completed')
  expect(p.state.outbox.at(-1).frame.data.text).toBe('本次处理已结束。')
 })
 it('repeats icons and fallback every cycle even when the model target is busy',()=>{
  const {p,job}=fixture();p.busy.add(job.target);job.waits=0;job.pendingIcons=['🔧'];job.snapshot.config={...job.snapshot.config,waitMessages:['working'],toolIconsEnabled:true,waitMessageMode:'sequence',toolIcons:{}}
  const cycle=()=>{job.nextWaitAt=Date.now()-1;p.tick();return p.state.outbox.at(-1)}
  expect(cycle().frame.data.text).toBe('🔧');expect(job.nextWaitAt).toBeGreaterThan(Date.now())
  expect(cycle().frame.data.text).toBe('working')
  job.conversationKey='k';p.coreEvent('k',{type:'sense_started',data:{id:'tool2',senseName:'bash'}})
  expect(cycle().frame.data.text).toBe('🔧')
  expect(job.state).toBe('running')
 })
 it('bounds heartbeat history over a month and stops producing after computation ends',()=>{
  const {p,job}=fixture();job.waits=0;job.snapshot.config={...job.snapshot.config,waitMessages:['working'],toolIconsEnabled:true,waitMessageMode:'cycle'};p.busy.add(job.target)
  for(let i=0;i<15000;i++) {job.nextWaitAt=Date.now()-1;p.tick();for(const o of p.state.outbox)o.status='sent'}
  expect(job.state).toBe('running');expect(p.state.outbox.length).toBeLessThanOrEqual(258)
  job.state='completed';const before=p.state.outbox.length;p.tick();expect(p.state.outbox.length).toBe(before)
 })
 it('does not turn confirmation-pending computation into failure',()=>{
  const {p,job}=fixture();job.state='sending';job.outcome='completed';p.output(job,'qq.reply.video',{mediaFile:'1.mp4'});const output=p.state.outbox[0];output.status='unknown';p.deliveryProblem(job,output)
  expect(job.state).toBe('completed');expect(job.outcome).toBe('completed');expect(job.reason).toBe('CONFIRMATION_PENDING')
 })
 it('does not fail the running task when media delivery is unknown',()=>{
  const {p,job}=fixture();p.output(job,'qq.reply.video',{mediaFile:'1.mp4'});const output=p.state.outbox[0];output.status='unknown';p.deliveryProblem(job,output)
  expect(job.state).toBe('running');expect(p.state.outbox.at(-1).frame.data.text).toContain('已发起发送')
 })
})
