import { describe, expect, it, vi } from 'vitest'
import { useQq } from '../../../plugins/qq/ui/useQq'
import { useQqKnowledge } from '../../../plugins/qq/ui/useQqKnowledge'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq'
import { ManagerApiError } from '../../../packages/manager-ui/src/api'

const receipt={fingerprint:'fingerprint',revision:1,saved:1,deleted:0}
const list=(revision=0)=>({data:{revision,entries:[],rejected:[],total:0,nextCursor:null}})
const entry={id:'entry',term:'术语',aliases:[],meaning:'解释',usage:'',caveat:'',status:'active',kind:'term',members:[],sources:[]}
function knowledge() {
  const request=vi.fn(async(path:string,_init?:RequestInit):Promise<any>=>{
    if(path.includes('/receipt?'))return {data:{state:'saved',receipt}}
    if(path.includes('/list?'))return list(1)
    if(path.endsWith('/edit'))return {data:receipt}
    return {data:{pending:0,usedCalls:0,limit:60,reason:null,tasks:[]}}
  })
  const ui=useQqKnowledge(request as any);ui.state.target='group:2';ui.state.note='管理员依据'
  return {ui,request}
}
describe('QQ memory save recovery without a browser',()=>{
  it('looks up a lost response by the original operation ID before unlocking writes',async()=>{
    const {ui,request}=knowledge()
    request.mockRejectedValueOnce(new ManagerApiError('timeout',0,'edit','超时'))
    ui.begin(entry);ui.state.note='纠正依据';await ui.saveEdit()
    const id=ui.state.pendingId;expect(id).not.toBe('');expect(ui.state.uncertain).toBe(true)
    await ui.edit({delete:['entry']});expect(request).toHaveBeenCalledTimes(1)
    await ui.read()
    expect(request.mock.calls[1]![0]).toContain(`operationId=${id}`)
    expect(ui.state.uncertain).toBe(false);expect(ui.state.editing).toBeNull()
    expect(request.mock.calls.filter(([path])=>path.endsWith('/edit'))).toHaveLength(1)
  })
  it('does not let an ordinary list response resolve an unknown write',async()=>{
    const {ui,request}=knowledge();request.mockRejectedValueOnce(new Error('network'))
    await ui.edit({delete:['entry']})
    request.mockResolvedValueOnce({data:{state:'not_found'}})
    await ui.read();expect(ui.state.uncertain).toBe(true);expect(ui.state.retryAllowed).toBe(true)
    const first=request.mock.calls[0]![1]!.body
    await ui.retrySave()
    const writes=request.mock.calls.filter(([path])=>path.endsWith('/edit'))
    expect(writes).toHaveLength(2);expect(writes[1]![1]!.body).toBe(first)
    expect(ui.state.uncertain).toBe(false)
  })
  it('preserves edits made while a save was waiting',async()=>{
    const {ui,request}=knowledge();let resolve!:(value:any)=>void
    request.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    ui.begin(entry);ui.state.note='原依据';const saving=ui.saveEdit()
    ui.state.editing.meaning='后续草稿';ui.state.note='后续依据'
    resolve({data:receipt});await saving
    expect(ui.state.editing.meaning).toBe('后续草稿');expect(ui.state.note).toBe('后续依据')
  })
  it('leaves validation/conflict errors visible and keeps the draft',async()=>{
    const {ui,request}=knowledge();request.mockRejectedValueOnce(new ManagerApiError('revision_conflict',409,'edit','版本变化'))
    ui.begin(entry);ui.state.note='纠正依据';await ui.saveEdit()
    expect(ui.state.error).toContain('版本变化');expect(ui.state.editing).not.toBeNull();expect(ui.state.uncertain).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('clears restricted drafts on revocation and ignores late saved/list responses',async()=>{
    const {ui,request}=knowledge();let resolve!:(value:any)=>void
    request.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    ui.begin(entry);ui.state.note='依据';const saving=ui.saveEdit()
    ui.clear();resolve({data:receipt});await saving
    expect(ui.state.message).toBe('');expect(ui.state.entries).toEqual([])
    request.mockRejectedValueOnce(new ManagerApiError('permission_denied',403,'list','无权限'))
    ui.begin(entry);await ui.read()
    expect(ui.state.editing).toBeNull();expect(ui.state.pendingId).toBe('')
  })
  it('does not put an old target response into a new target',async()=>{
    const {ui,request}=knowledge();let resolve!:(value:any)=>void
    request.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    const reading=ui.read();ui.state.target='group:3';await ui.read()
    resolve({data:{...list().data,entries:[entry]}});await reading
    expect(ui.state.entries).toEqual([])
  })
  it('does not lose learning state when a list refresh finishes first',async()=>{
    const {ui,request}=knowledge();let resolve!:(value:any)=>void
    request.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    const reading=ui.learning();await ui.read()
    resolve({data:{pending:1,usedCalls:2,limit:60,reason:null,tasks:[]}});await reading
    expect(ui.state.learning.pending).toBe(1)
  })
  it('passes the fixed list revision and cursor when reading another page',async()=>{
    const {ui,request}=knowledge();ui.state.revision=7;ui.state.nextCursor='frozen-cursor'
    await ui.read(true)
    expect(request.mock.calls[0]![0]).toContain('cursor=frozen-cursor');expect(request.mock.calls[0]![0]).toContain('revision=7')
  })
  it('keeps applied filters through pagination even while another search is being typed',async()=>{
    const {ui,request}=knowledge()
    ui.state.query='  术语  ';ui.state.status='disputed';await ui.read()
    const first=new URL(request.mock.calls[0]![0],'https://example.invalid').searchParams
    expect(first.get('query')).toBe('术语');expect(first.get('status')).toBe('disputed')
    ui.state.nextCursor='fixed';ui.state.revision=7;ui.state.query='尚未提交';ui.state.status='active'
    await ui.read(true)
    const more=new URL(request.mock.calls[1]![0],'https://example.invalid').searchParams
    expect(more.get('query')).toBe('术语');expect(more.get('status')).toBe('disputed');expect(more.get('cursor')).toBe('fixed')
    expect(ui.state.query).toBe('尚未提交');expect(ui.state.appliedQuery).toBe('术语')
    await ui.read()
    const changed=new URL(request.mock.calls[2]![0],'https://example.invalid').searchParams
    expect(changed.get('query')).toBe('尚未提交');expect(changed.has('cursor')).toBe(false)
  })
  it('ignores a response from a replaced search and clears filtered data after revocation',async()=>{
    const {ui,request}=knowledge();let resolve!:(value:any)=>void
    request.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
    ui.state.query='旧查询';const reading=ui.read()
    ui.state.query='新查询';await ui.read()
    resolve({data:{...list().data,entries:[entry],total:1}});await reading
    expect(ui.state.entries).toEqual([]);expect(ui.state.appliedQuery).toBe('新查询')
    request.mockRejectedValueOnce(new ManagerApiError('permission_denied',403,'list','无权限'));await ui.read()
    expect(ui.state.entries).toEqual([]);expect(ui.state.query).toBe('');expect(ui.state.total).toBe(0)
  })
})
describe('QQ settings submitted snapshot recovery',()=>{
  it('confirms the submitted snapshot without replacing a newer draft',async()=>{
    let saved=structuredClone(QQDefaultConfig),revision=0
    const request=vi.fn(async(path:string,init?:RequestInit):Promise<any>=>{
      if(init?.method==='PUT'){saved=JSON.parse(String(init.body)).config;revision++;throw new Error('lost response')}
      return {data:{config:saved,baseRevision:revision,apply:{state:'applied',revision}}}
    })
    const ui=useQq(request as any);await ui.read();ui.state.config.groups=['123']
    await ui.save();expect(ui.state.uncertain).toBe(true)
    ui.state.config.groups.push('456');await ui.read()
    expect(ui.state.uncertain).toBe(false);expect(ui.state.config.groups).toEqual(['123','456'])
    expect(ui.state.revision).toBe(1);expect(ui.dirty.value).toBe(true)
    expect(request.mock.calls.filter(([,init])=>init?.method==='PUT')).toHaveLength(1)
  })
  it('does not unlock a mismatched recovery or discard the draft implicitly',async()=>{
    const config=structuredClone(QQDefaultConfig)
    const request=vi.fn(async(_path:string,init?:RequestInit):Promise<any>=>{if(init?.method==='PUT')throw new Error('lost');return {data:{config,baseRevision:2,apply:{state:'applied',revision:2}}}})
    const ui=useQq(request as any);await ui.read();ui.state.config.groups=['123'];await ui.save();await ui.read()
    expect(ui.state.uncertain).toBe(true);expect(ui.state.config.groups).toEqual(['123'])
    await ui.read(true);expect(ui.state.uncertain).toBe(false);expect(ui.state.config.groups).toEqual([])
  })
  it('ignores a configuration response arriving after disposal',async()=>{
    let resolve!:(value:any)=>void
    const ui=useQq((()=>new Promise(done=>{resolve=done})) as any)
    const reading=ui.read();ui.dispose();resolve({data:{config:QQDefaultConfig,baseRevision:0}});await reading
    expect(ui.state.config).toBeNull();expect(ui.state.ready).toBe(false)
  })
})
