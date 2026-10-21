import {describe,it,expect,vi} from 'vitest'
import {QQEventSubmitRequestSchema} from '../../../packages/protocol/src/qq.js'
import {QQPlugin, discussionInputChunks} from '../src/index.js'
import {QQGroupMemoryStore} from '../src/groupMemory.js'
import {StateSchema, emptyState} from '../src/state.js'
import {mkdtemp, rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
function fixture(){
 const job:any={requestId:'r',target:'group:2',state:'running',acceptedAt:Date.now(),input:{selfId:'1',targetId:'2',conversationType:'group'},snapshot:{revision:1,config:{continuationTtlMs:100000,waitIntervalSeconds:30}},toolIds:[]}
 const p:any=Object.create(QQPlugin.prototype)
 Object.assign(p,{state:{jobs:[job],outbox:[],seq:{},discussions:{}},persist:vi.fn(),context:{log:vi.fn(),connections:{isOpen:()=>true,send:vi.fn(()=>true)}},connection:'c',recovered:true,stopped:false,paused:false,busy:new Set(),summaryOperations:new Map(),operations:new Set(),aborters:new Map(),preparingReplies:new Set(),reminderBusy:true,nextAppNotificationPoll:Infinity})
 return {p,job}
}
describe('discussion maintenance does not block foreground',()=>{
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
  const batch={expectedRevision:0,delete:[],save:[{id:'fact',topic:'test',kind:'fact',content:'confirmed',members:['3'],evidence:'statement',sources:[{messageId:'1',userId:'3',occurredAt:1}],status:'active'}]}
  try {
   const first=await new QQGroupMemoryStore(root).manage(subject,batch,[{messageId:'1',senderId:'3',occurredAt:1,content:'confirmed'}],undefined,'stable-operation')
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
  const messages=[{eventId:'e',messageId:'1',senderId:'3',occurredAt:1,content:'fact'}]
  const batch={expectedRevision:0,delete:[],save:[{id:'fact',topic:'test',kind:'fact',content:'fact',members:['3'],evidence:'statement',sources:[{messageId:'1',userId:'3',occurredAt:1}],status:'active'}]}
  try {
   await new QQGroupMemoryStore(root).manage(subject,batch,messages,undefined,'resume-memory-0')
   const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'};p.context.dataDir=root
   p.snapshot={config:{continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:true,memoryMaxEntries:80,memoryMaxChars:160,memoryContextChars:6000}}
   p.state.discussions['group:2']={active:false,lastActivity:1,startedAt:1,closedAt:2,summary:'old',summaryPending:true,summaryRetryAt:0,messages,maintenance:{operationId:'resume-memory',status:'running',phase:'memory',startedAt:3,discussionStartedAt:1,discussionClosedAt:2,attempt:1,expectedHistory:'snapshot',memoryInputs:['saved-source'],memoryIndex:0,memoryBatch:batch}}
   const internalText=vi.fn(async()=> 'summary')
   p.context.core={internalText,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},conversationHistory:async()=> 'unused',summaryCommitStatus:async()=>({committed:false}),commitSummary:async()=>{}}
   p.tick();await Promise.all([...p.operations])
   expect(internalText).toHaveBeenCalledTimes(1)
   expect((await new QQGroupMemoryStore(root).search(subject,'')).revision).toBe(1)
   expect(p.state.discussions['group:2'].summaryPending).toBe(false)
  } finally {await rm(root,{recursive:true,force:true})}
 })
 it('resumes completed memory and completed summary blocks after persisted restart',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={config:{continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:true}}
  const d={active:false,lastActivity:1,startedAt:1,closedAt:2,summary:'old',summaryPending:true,summaryRetryAt:0,messages:[],maintenance:{operationId:'resume',status:'running',phase:'summary',startedAt:3,discussionStartedAt:1,discussionClosedAt:2,attempt:1,expectedHistory:'snapshot',memoryComplete:true,summaryInputs:['first','second'],summaryResults:['saved first']}}
  p.state.discussions=StateSchema.parse({...emptyState(),discussions:{'group:2':d}}).discussions
  const internalText=vi.fn(async()=> 'new summary'),history=vi.fn()
  p.context.core={internalText,conversationHistory:history,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},summaryCommitStatus:async()=>({committed:false}),commitSummary:async()=>{}}
  p.tick();await Promise.all([...p.operations])
  expect(history).not.toHaveBeenCalled();expect(internalText.mock.calls).toHaveLength(2)
  expect((internalText.mock.calls as any)[0][0].content).toBe('second')
  expect(p.state.discussions['group:2'].maintenance.operationId).toBe('resume')
  expect(p.state.discussions['group:2'].summaryPending).toBe(false)
 })
 it('a late old failure cannot set a new discussion pending or expose an arbitrary code',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={config:{continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:false}}
  const d:any={active:false,lastActivity:1,startedAt:1,closedAt:2,summary:'old',summaryPending:true,summaryRetryAt:0,messages:[]};p.state.discussions['group:2']=d
  let reject:any;const wait=new Promise<string>((_,r)=>reject=r)
  p.context.core={internalText:()=>wait,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},conversationHistory:async()=> 'history'}
  p.tick();await Promise.resolve();await Promise.resolve();await Promise.resolve()
  d.startedAt=10;d.active=true;d.summaryPending=false;d.summaryRetryAt=123
  reject(Object.assign(new Error('secret'),{code:'secret-token'}));await Promise.all([...p.operations])
  expect(d.summaryPending).toBe(false);expect(d.summaryRetryAt).toBe(123);expect(JSON.stringify(d)).not.toContain('secret-token')
 })
 it('reconciles an already committed candidate without generating or committing again',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={config:{continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:false}}
  const discussion:any={active:false,lastActivity:1,startedAt:1,closedAt:2,summary:'old',summaryPending:true,summaryRetryAt:0,messages:[],maintenance:{operationId:'stable-op',status:'pending',phase:'commit',startedAt:3,discussionStartedAt:1,discussionClosedAt:2,attempt:1,candidate:'already stored',expectedHistory:'old snapshot'}}
  p.state.discussions['group:2']=discussion
  const internalText=vi.fn(),commitSummary=vi.fn()
  p.context.core={internalText,commitSummary,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},summaryCommitStatus:async()=>({committed:true,messageId:'stable-message'})}
  p.tick();await Promise.all([...p.operations])
  expect(internalText).not.toHaveBeenCalled();expect(commitSummary).not.toHaveBeenCalled()
  expect(discussion.summary).toBe('already stored');expect(discussion.maintenance.status).toBe('completed')
 })
 it('keeps pending during generation and publishes coverage only after commit',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={config:{continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:false}}
  const discussion:any={active:false,lastActivity:1,startedAt:1,closedAt:2,summary:'old',summaryPending:true,summaryRetryAt:0,messages:[{eventId:'event-1',senderId:'3'}]}
  p.state.discussions['group:2']=discussion
  let resolve:any;const waiting=new Promise<string>(r=>{resolve=r})
  const commitSummary=vi.fn(async()=>{})
  p.context.core={internalText:vi.fn(()=>waiting),resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},conversationHistory:async()=> 'history',summaryCommitStatus:async()=>({committed:false}),commitSummary}
  p.tick();await Promise.resolve();await Promise.resolve();await Promise.resolve()
  expect(discussion.summaryPending).toBe(true);expect(discussion.maintenance.status).toBe('running');expect(p.busy.size).toBe(0)
  resolve('new summary');await Promise.all([...p.operations])
  expect(discussion.summary).toBe('new summary');expect(discussion.summaryPending).toBe(false)
  expect(discussion.maintenance).toMatchObject({status:'completed',throughEventId:'event-1',phase:'commit'})
  expect(commitSummary).toHaveBeenCalledTimes(1)
 })
 it('does not commit a summary after foreground cancellation',async()=>{
  const {p}=fixture();p.state.jobs=[];p.state.identityBinding={selfId:'1'}
  p.snapshot={config:{continuationTtlMs:600000,bindings:{'group:2':'preset'},memoryEnabled:false}}
  const discussion:any={active:false,lastActivity:1,startedAt:1,closedAt:2,summary:'old',summaryPending:true,summaryRetryAt:0,messages:[]}
  p.state.discussions['group:2']=discussion
  let resolve:any;const waiting=new Promise<string>(r=>{resolve=r});const commitSummary=vi.fn()
  p.context.core={internalText:()=>waiting,resolvePreset:()=>({presetId:'p'}),ensureConversation:async()=>{},conversationHistory:async()=> 'history',summaryCommitStatus:async()=>({committed:false}),commitSummary}
  p.tick();await Promise.resolve();await Promise.resolve();await Promise.resolve()
  p.summaryOperations.get('group:2').abort();resolve('late');await Promise.all([...p.operations])
  expect(commitSummary).not.toHaveBeenCalled();expect(discussion.summary).toBe('old')
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
  const {p,job}=fixture();job.input.messageId='10';job.reply='';job.conversationKey='same';job.acceptedAt=2000;job.background=[];job.snapshot.config.backgroundMaxAgeMs=100000
  const old={...job,requestId:'old',acceptedAt:1000,input:{...job.input,messageId:'9'},reply:'已经发送',state:'failed'}
  p.state.jobs.unshift(old)
  p.output(old,'qq.reply.video',{mediaFile:'private.mp4'});p.state.outbox[0].status='unknown'
  p.output(old,'qq.request.failed',{text:'未取得确认'});p.state.outbox[1].status='sent';p.state.outbox[1].messageIds=['88']
  for(const type of ['qq.reply.part','qq.reply.file','qq.reply.images','qq.reply.action']) p.output(old,type,{text:'output'})
  const foreign={...old,requestId:'foreign',target:'group:99',conversationKey:'other'};p.state.jobs.push(foreign);p.output(foreign,'qq.reply.part',{text:'secret'})
  const facts=p.conversationFacts(job)
  expect(facts.deliveries).toHaveLength(6)
  expect(facts.deliveries[0]).toMatchObject({type:'qq.reply.video',status:'unknown',sourceMessageId:'9'})
  expect(facts.deliveries[1]).toMatchObject({isFailureNotice:true,status:'sent',messageIds:['88']})
  expect(JSON.stringify(facts)).not.toContain('private.mp4');expect(JSON.stringify(facts)).not.toContain('secret')
  expect(facts.recentRequests[0].replyClaim).toBe('已经发送')
 })
 it('accepts bare mentions and gives every merged mention its own acknowledgement',async()=>{
  const {p}=fixture();p.state.identityBinding={selfId:'1'};p.state.jobs=[];p.state.receipts={};p.snapshot={revision:1,config:{groups:['2'],users:[],bindings:{'group:2':'preset'},queueLimit:10,historyLimit:30,backgroundMaxAgeMs:100000,backgroundMaxChars:10000,continuationTtlMs:10000}}
  p.context.core={resolvePreset:()=>({presetId:'p',brain:'b',senseGroup:'s'})};p.tick=vi.fn()
  const input:any={eventId:'qq:1:group:2:11',messageId:'11',selfId:'1',senderId:'3',senderName:'test',targetId:'2',conversationType:'group',mentionedBot:true,content:'',parts:[{type:'text',text:' '}],attachments:[],occurredAt:Math.floor(Date.now()/1000)}
  expect(QQEventSubmitRequestSchema.safeParse({...input,mentionedBot:false}).success).toBe(false)
  expect((await p.submit(QQEventSubmitRequestSchema.parse(input))).accepted).toBe(true)
  expect((await p.submit(QQEventSubmitRequestSchema.parse({...input,eventId:'qq:1:group:2:12',messageId:'12'}))).accepted).toBe(true)
  expect(p.state.jobs).toHaveLength(1)
  expect(p.state.outbox.filter((o:any)=>o.frame.type==='qq.message.ack').map((o:any)=>o.frame.data.messageId)).toEqual(['11','12'])
  expect(p.state.jobs[0].input.content).toBe('')
  expect(p.state.jobs[0].input.mentionedBot).toBe(true)
  expect(p.conversationFacts(p.state.jobs[0]).currentMessages).toHaveLength(2)
 })
 it('keeps model running when acknowledgement is unknown and records a visible notice',()=>{
  const {p,job}=fixture();p.output(job,'qq.message.ack',{messageId:'3',emojiId:'178'})
  const ack=p.state.outbox[0];ack.status='unknown';p.deliveryProblem(job,ack)
  expect(job.state).toBe('running');expect(p.state.outbox[1].frame.data.text).toContain('确认表情')
  p.deliveryProblem(job,ack);expect(p.state.outbox).toHaveLength(2)
 })
 it('sends pending failure notice even after job becomes terminal',()=>{
  const {p,job}=fixture();p.failureNotice(job,'这次发送失败，未完成。');p.tick()
  expect(job.state).toBe('failed');expect(p.context.connections.send).toHaveBeenCalledWith('c',expect.objectContaining({type:'qq.request.failed'}))
 })
 it('does not recursively create notices for notice delivery failure',()=>{
  const {p,job}=fixture();p.failureNotice(job,'这次失败。');const notice=p.state.outbox[0];notice.status='unknown';p.deliveryProblem(job,notice)
  expect(p.state.outbox).toHaveLength(1)
 })
 it('dispatches new acknowledgements while an old video is still in flight',()=>{
  const {p,job}=fixture();p.output(job,'qq.reply.video',{mediaFile:'1.mp4'});p.state.outbox[0].status='inflight';p.state.outbox[0].issuedAt=Date.now()
  p.output(job,'qq.message.ack',{messageId:'4',emojiId:'178'});p.tick()
  expect(p.context.connections.send).toHaveBeenCalledWith('c',expect.objectContaining({type:'qq.message.ack'}))
 })
 it('does not expire a month-old running task or its video and keeps progress independent',()=>{
  const {p,job}=fixture();job.acceptedAt=Date.now()-32*86400000;p.output(job,'qq.reply.video',{mediaFile:'1.mp4'});const old=p.state.outbox[0];old.status='inflight';old.issuedAt=job.acceptedAt
  p.output(job,'qq.waiting',{text:'working'});p.tick()
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
