import { describe, expect, it, vi } from 'vitest'
import { useQqSources, sourceSelectionKey } from '../../../plugins/qq/ui/useQqSources'
import { ManagerApiError, type managerRequest } from '../../../packages/manager-ui/src/api'
import type { SourceContextIndex, SourceContextView, SourceVisibleBody } from '../../../packages/protocol/src/sourceManagement'

const selection=(id:string)=>({snapshotId:`snapshot-${id}`,modelStepId:`step-${id}`,projectionId:`projection-${id}`,attemptId:`attempt-${id}`})
const directory=(id:string,sequence=1)=>({snapshotId:`snapshot-${id}`,modelStepId:`step-${id}`,projectionId:`projection-${id}`,stepSequence:sequence,reason:'initial' as const,projectionSequence:1,preparedAt:1,
  attempt:{attemptId:`attempt-${id}`,attemptSequence:1,state:'responded' as const,startedAt:1,finishedAt:2,outcomeKnown:true}})
const index=(id='1'):SourceContextIndex=>({requestId:'request',observedAt:10,availability:'available',snapshotId:selection(id).snapshotId,
  defaultSelection:selection(id),selectedEntry:directory(id),items:[directory(id)],associatedSummaryIds:[],nextCursor:null})
const view=(id='1',more=false):SourceContextView=>({requestId:'request',...selection(id),observedAt:10,state:'available',ordering:'time_approximate',total:2,
  attemptState:'responded',items:[{itemId:`item-${id}-${more?2:1}`,position:more?1:0,type:'gap',reason:'history_start',relationId:'relation'}],nextCursor:more?null:'page-2'})
const reply=(preview='头😀'):SourceVisibleBody=>({state:'available',text:{textRefId:'text-1',revision:1,totalCodePoints:4,preview,previewCodePoints:Array.from(preview).length,complete:false,nextCursor:'text-page-2'}})
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fixture(){
  const request=vi.fn(async (path:string,_init?:RequestInit):Promise<unknown>=>({data:path.includes('/context/index')?index():view()}))
  const denied=vi.fn(),reader=useQqSources(request as typeof managerRequest,denied)
  return {request,reader,denied}
}

describe('QQ fixed input detail reading',()=>{
  it('does not fetch until expanded and preserves the chosen input when newer steps arrive',async()=>{
    const {reader,request}=fixture()
    expect(request).not.toHaveBeenCalled()
    await reader.index('request')
    expect(reader.session('request').error).toBe('')
    expect(reader.session('request').selection).toEqual(selection('1'))
    request.mockResolvedValueOnce({data:{...index('2'),items:[directory('2',2)]}})
    await reader.index('request')
    expect(reader.session('request').selection).toEqual(selection('1'))
    expect(reader.session('request').newer).toBe(true)
    expect(reader.entries('request').map(item=>item.projectionId)).toEqual(['projection-2','projection-1'])
    expect(request.mock.calls.filter(([path])=>path.includes('/context?'))).toHaveLength(1)
    request.mockResolvedValueOnce({data:view('2')})
    await reader.latest('request')
    expect(reader.session('request').selection).toEqual(selection('2'))
  })
  it('keeps late responses in their own version and preserves loaded pages on explicit status refresh',async()=>{
    const {reader,request}=fixture(),slow=deferred<{data:SourceContextView}>()
    reader.session('request').selection=selection('1')
    request.mockImplementationOnce(()=>slow.promise)
    const first=reader.view('request')
    request.mockResolvedValueOnce({data:view('2')})
    await reader.select('request',selection('2'))
    slow.resolve({data:view('1')});await first
    const session=reader.session('request')
    expect(session.selection).toEqual(selection('2'))
    expect(session.views[sourceSelectionKey(selection('1'))].data?.projectionId).toBe('projection-1')
    request.mockResolvedValueOnce({data:view('2',true)})
    await reader.view('request',true)
    request.mockResolvedValueOnce({data:{...view('2'),observedAt:20}})
    await reader.view('request',false,true)
    const saved=session.views[sourceSelectionKey(selection('2'))].data!
    expect(saved.items.map(item=>item.itemId)).toEqual(['item-2-1','item-2-2'])
    expect(saved.nextCursor).toBeNull()
  })
  it('paginates immutable Unicode text once and retries only the failed page',async()=>{
    const {reader,request}=fixture(),body=reply()
    if(body.state!=='available')throw new Error('Missing text')
    reader.body('request',body)
    request.mockRejectedValueOnce(new Error('offline'))
    await reader.text('request',body.text)
    expect(reader.texts['request:text-1'].value).toBe('头😀')
    expect(reader.texts['request:text-1'].nextCursor).toBe('text-page-2')
    request.mockResolvedValueOnce({data:{requestId:'request',textRefId:'text-1',revision:1,startCodePoint:2,endCodePoint:4,text:'尾文',totalCodePoints:4,nextCursor:null}})
    await reader.text('request',body.text)
    expect(reader.texts['request:text-1'].value).toBe('头😀尾文')
    expect(request.mock.calls[0][0]).toBe(request.mock.calls[1][0])
    await reader.text('request',body.text)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('clears restricted caches and rejects all older responses after a denial',async()=>{
    const {reader,request,denied}=fixture(),late=deferred<{data:SourceContextView}>()
    await reader.index('request');reader.body('request',reply())
    request.mockImplementationOnce(()=>late.promise)
    const pending=reader.view('request',false,true)
    request.mockRejectedValueOnce(new ManagerApiError('permission_denied',403,'/api/modules/qq/context/index','denied'))
    await reader.index('request')
    expect(reader.sessions).toEqual({});expect(reader.texts).toEqual({});expect(denied).toHaveBeenCalledOnce()
    late.resolve({data:view()});await pending
    expect(reader.sessions).toEqual({});expect(reader.texts).toEqual({})
  })
  it('aborts reads when the page is disposed without sending a business cancellation',async()=>{
    const {reader,request}=fixture(),slow=deferred<{data:SourceContextIndex}>()
    request.mockImplementationOnce(()=>slow.promise)
    const pending=reader.index('request'),signal=request.mock.calls[0][1]?.signal
    reader.clear()
    expect(signal?.aborted).toBe(true)
    slow.resolve({data:index()});await pending
    expect(reader.sessions).toEqual({})
    expect(request.mock.calls.every(([path])=>path.startsWith('/api/modules/qq/context'))).toBe(true)
  })
  it('does not replace a selected input with a mismatched response or guess a new cursor',async()=>{
    const {reader,request}=fixture();await reader.index('request')
    request.mockResolvedValueOnce({data:view('foreign')})
    await reader.view('request',true)
    const loaded=reader.session('request').views[sourceSelectionKey(selection('1'))]
    expect(loaded.data?.projectionId).toBe('projection-1');expect(loaded.data?.nextCursor).toBe('page-2');expect(loaded.error).toContain('不匹配')
  })
})
