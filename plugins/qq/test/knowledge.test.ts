import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { QQKnowledgeStore, TermInputSchema, type KnowledgeEvidence } from '../src/knowledge.js'
import { QQKnowledgeCandidates } from '../src/knowledgeCandidates.js'

const dirs:string[]=[]
afterEach(async()=>{for(const dir of dirs.splice(0))await fs.rm(dir,{recursive:true,force:true})})
const subject={selfId:'100',conversationType:'group' as const,groupId:'999',userId:'123'}
const web:KnowledgeEvidence={kind:'web',evidenceId:'web-one',url:'https://example.com/terms',contentHash:'body-hash',observedAt:'2026-10-29T00:00:00Z',excerpt:'公开的释义',truncated:false,publicEligible:true}
const term=(id='term-one',name='躺平')=>TermInputSchema.parse({id,term:name,meaning:'表达降低竞争投入的态度',evidenceRefs:[web.evidenceId]})
async function fixture(){const dir=await fs.mkdtemp('/tmp/opencode/qq-knowledge-');dirs.push(dir);return {dir,store:new QQKnowledgeStore(dir)}}
describe('QQ scoped knowledge',()=>{
  it('isolates local/private/robot records; public sharing requires the same robot',async()=>{
    const {store}=await fixture()
    await store.manage(subject,'local',{operationId:'local',expectedRevision:0,save:[term()],delete:[]},[web])
    expect((await store.search({...subject,groupId:'998'},'躺平')).entries).toEqual([])
    expect((await store.search({...subject,conversationType:'private'},'躺平')).entries).toEqual([])
    await store.manage(subject,'public',{operationId:'public',expectedRevision:0,save:[term()],delete:[]},[web])
    expect((await store.search({...subject,groupId:'998'},'躺平')).entries).toHaveLength(1)
    expect((await store.search({...subject,selfId:'101'},'躺平')).entries).toEqual([])
  })
  it('does not inject empty queries or random one-character intersections',async()=>{
    const {store}=await fixture()
    await store.manage(subject,'local',{operationId:'local',expectedRevision:0,save:[term('test','随机串测试')],delete:[]},[web])
    expect((await store.search(subject,'')).entries).toEqual([])
    expect((await store.search(subject,'今天天气如何')).entries).toEqual([])
    expect((await store.search(subject,'随机串测试')).entries).toHaveLength(1)
  })
  it('keeps rejection across public revisions and restores only explicitly',async()=>{
    const {store}=await fixture()
    await store.manage(subject,'public',{operationId:'p1',expectedRevision:0,save:[term()],delete:[]},[web])
    const id=(await store.list(subject,'public')).entries[0]!.id
    await store.manage(subject,'local',{operationId:'reject',expectedRevision:0,save:[],delete:[],reject:[id]},[])
    await store.manage(subject,'public',{operationId:'p2',expectedRevision:1,save:[term()],delete:[]},[web])
    expect((await store.search(subject,'躺平')).entries).toEqual([])
    await store.manage(subject,'local',{operationId:'restore',expectedRevision:1,save:[],delete:[],restore:[id]},[])
    expect((await store.search(subject,'躺平')).entries).toHaveLength(1)
  })
  it('rejects forged or non-public evidence and reuses only identical receipts',async()=>{
    const {store}=await fixture(),input={operationId:'p',expectedRevision:0,save:[term()],delete:[]}
    await expect(store.manage(subject,'public',input,[{...web,publicEligible:false}])).rejects.toThrow('NOT_ALLOWED')
    const first=await store.manage(subject,'public',input,[web])
    expect(await store.manage(subject,'public',input,[web])).toEqual(first)
    await expect(store.manage(subject,'public',{...input,delete:['other']},[web])).rejects.toThrow('CONFLICT')
  })
  it('prevents deleted evidence reimport under a different generated ID',async()=>{
    const {store}=await fixture()
    await store.manage(subject,'local',{operationId:'one',expectedRevision:0,save:[term()],delete:[]},[web])
    await store.manage(subject,'local',{operationId:'delete',expectedRevision:1,save:[],delete:['term-one']},[])
    expect((await store.manage(subject,'local',{operationId:'again',expectedRevision:2,save:[term('changed')],delete:[]},[web])).saved).toBe(0)
    expect((await store.list(subject,'local')).entries).toEqual([])
  })
  it('uses fixed-revision pagination and adopts only completed candidates',async()=>{
    const {dir,store}=await fixture(),candidates=new QQKnowledgeCandidates(dir,store)
    await candidates.save(subject.selfId,'candidate',0,[term()],[web])
    await expect(candidates.adopt(subject,'candidate','adopt')).rejects.toThrow('NOT_AVAILABLE')
    await candidates.finish(subject.selfId,'candidate','completed')
    await candidates.adopt(subject,'candidate','adopt')
    await store.manage(subject,'public',{operationId:'next',expectedRevision:1,save:[term('another','内卷')],delete:[]},[web])
    const page=await store.list(subject,'public',undefined,undefined,1)
    await store.manage(subject,'public',{operationId:'third',expectedRevision:2,save:[term('last','摆烂')],delete:[]},[web])
    await expect(store.list(subject,'public',page.nextCursor!,page.revision,1)).rejects.toThrow('VERSION_CONFLICT')
  })
  it('keeps public admin corrections and provenance until genuinely new web evidence arrives',async()=>{
    const {store}=await fixture()
    await store.manage(subject,'public',{operationId:'initial',expectedRevision:0,save:[term()],delete:[]},[web])
    const entry=(await store.list(subject,'public')).entries[0]!
    const correction={...term(entry.id),status:'disputed' as const,meaning:'原解释存在争议',evidenceRefs:['admin-note']}
    await store.manage(subject,'public',{operationId:'correct',expectedRevision:1,save:[correction],delete:[],admin:true,explicit:true},[{kind:'admin',evidenceId:'admin-note',note:'需要重新查证'}])
    const corrected=(await store.list(subject,'public')).entries[0]!
    expect(corrected.sources.map(source=>source.kind)).toEqual(['web','admin'])
    expect((await store.manage(subject,'public',{operationId:'same',expectedRevision:2,save:[term()],delete:[]},[web])).saved).toBe(0)
    expect((await store.list(subject,'public')).entries[0]!.status).toBe('disputed')
    const fresh={...web,contentHash:'new-body'}
    await store.manage(subject,'public',{operationId:'new',expectedRevision:3,save:[term()],delete:[]},[fresh])
    expect((await store.list(subject,'public')).entries[0]!.status).toBe('active')
  })
  it('checks permission at candidate commit and adoption rather than only at queueing',async()=>{
    const {dir,store}=await fixture(),candidates=new QQKnowledgeCandidates(dir,store)
    const denied=()=>{throw new Error('PERMISSION_DENIED')}
    await expect(candidates.save(subject.selfId,'blocked',0,[term()],[web],undefined,denied)).rejects.toThrow('PERMISSION_DENIED')
    expect(await candidates.read(subject.selfId,'blocked')).toBeUndefined()
    await candidates.save(subject.selfId,'allowed',0,[term()],[web]);await candidates.finish(subject.selfId,'allowed','completed')
    await expect(candidates.adopt(subject,'allowed','adopt',undefined,denied)).rejects.toThrow('PERMISSION_DENIED')
    expect((await store.list(subject,'public')).entries).toEqual([])
  })
})
