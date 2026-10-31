import { reactive } from 'vue'
import { managerRequest, ManagerApiError } from '../../../packages/manager-ui/src/api'
import { QQSourceResponseSchemas, type SourceManagementQuery, type SourceContextIndex, type SourceContextView,
  type SourceContextItem, type SourceDirectoryEntry, type SourceVisibleBody } from '../../../packages/protocol/src/sourceManagement'
import type { SourceTextRef } from '../../../packages/protocol/src/sourceContext'

type Selection={snapshotId:string;projectionId?:string;modelStepId?:string;attemptId?:string}
type Sources=import('zod').infer<typeof QQSourceResponseSchemas['qq.context.sources']>
type EntryPage=import('zod').infer<typeof QQSourceResponseSchemas['qq.entry.items']>
type ReadView={data?:SourceContextView;loading:boolean;error:string}
type Session={index?:SourceContextIndex;loading:boolean;error:string;selection?:Selection;views:Record<string,ReadView>;
  relations:Record<string,{data?:Sources;loading:boolean;error:string}>;entryPages:Partial<Record<EntryPage['kind'],{data?:EntryPage;loading:boolean;error:string}>>;
  newer:boolean}
export const sourceSelectionKey=(value:Selection)=>JSON.stringify([value.snapshotId,value.projectionId??null,value.attemptId??null])
const failure=(error:unknown)=>error instanceof Error?error.message:'来源详情读取失败'
const merge=<T extends {itemId:string}>(a:T[],b:T[])=>[...new Map([...a,...b].map(item=>[item.itemId,item])).values()]
export function useQqSources(request=managerRequest,onDenied?:()=>void) {
  const sessions=reactive<Record<string,Session>>({})
  const texts=reactive<Record<string,{value:string;nextCursor:string|null;end:number;loading:boolean;error:string}>>({})
  let generation=0
  const reads=new Set<AbortController>()
  function clear(){generation++;for(const controller of reads)controller.abort();reads.clear();for(const id of Object.keys(sessions))delete sessions[id];for(const id of Object.keys(texts))delete texts[id]}
  function session(id:string):Session {
    sessions[id]??={loading:false,error:'',views:{},relations:{},entryPages:{},newer:false}
    return sessions[id]!
  }
  async function query(input:SourceManagementQuery) {
    const captured=generation,path=input.method==='qq.context.get'?'context':input.method.slice(3).replaceAll('.','/')
    const params=new URLSearchParams(Object.entries(input.params).filter(([,value])=>value!==undefined).map(([key,value])=>[key,String(value)]))
    const controller=new AbortController();reads.add(controller)
    try {
      const response=await request<{data:unknown}>(`/api/modules/qq/${path}?${params}`,{signal:controller.signal})
      if(captured!==generation)throw new Error('读取已失效，请重新打开详情。')
      const checked=QQSourceResponseSchemas[input.method].parse(response.data)
      if(checked.requestId!==input.params.requestId)throw new Error('来源详情所属请求不匹配。')
      return checked
    } catch(error) {
      if(error instanceof ManagerApiError&&[401,403].includes(error.status)&&captured===generation){clear();onDenied?.()}
      throw error
    } finally {reads.delete(controller)}
  }
  async function index(id:string,more=false) {
    const current=session(id);if(current.loading)return
    const cursor=more?current.index?.nextCursor:undefined
    if(more&&!cursor)return
    current.loading=true;current.error=''
    try {
      const result=QQSourceResponseSchemas['qq.context.index'].parse(await query({method:'qq.context.index',params:{requestId:id,cursor:cursor??undefined}}))
      if(sessions[id]!==current)return
      const old=current.selection
      const pinned=current.index&&old?.projectionId ? mergeDirectory(current.index,current.index).find(item=>item.projectionId===old.projectionId) : undefined
      current.index=more&&current.index?{...result,items:mergeDirectory(current.index,result)}:result
      if(pinned&&!current.index.items.some(item=>item.projectionId===pinned.projectionId))current.index.items.push(pinned)
      const choice=result.defaultSelection??(result.snapshotId?{snapshotId:result.snapshotId}:undefined)
      current.newer=!!old&&!!choice&&sourceSelectionKey(old)!==sourceSelectionKey(choice)
      if(!old&&choice){current.selection=choice;await view(id)}
    }catch(error){if(sessions[id]===current)current.error=failure(error)}
    finally{current.loading=false}
  }
  function entries(id:string):SourceDirectoryEntry[]{const current=session(id).index;return current?mergeDirectory(current,current):[]}
  function mergeDirectory(a:SourceContextIndex,b:SourceContextIndex):SourceDirectoryEntry[]{return [...new Map([
    ...(a.selectedEntry?[a.selectedEntry]:[]),...a.items,...(b.selectedEntry?[b.selectedEntry]:[]),...b.items,
  ].map(item=>[item.projectionId,item])).values()].sort((a,b)=>b.stepSequence-a.stepSequence||b.projectionSequence-a.projectionSequence)}
  async function select(id:string,selection:Selection){session(id).selection=selection;session(id).newer=false;await view(id)}
  async function latest(id:string){const current=session(id).index;if(current?.defaultSelection)await select(id,current.defaultSelection);else if(current?.snapshotId)await select(id,{snapshotId:current.snapshotId})}
  async function view(id:string,more=false,refresh=false,cursorOverride?:string) {
    const current=session(id),selection=current.selection;if(!selection)return
    const key=sourceSelectionKey(selection)
    current.views[key]??={loading:false,error:''}
    const loaded=current.views[key]!
    if(loaded.loading||loaded.data&&!more&&!refresh&&!cursorOverride)return
    const cursor=cursorOverride??(more?loaded.data?.nextCursor:undefined);if(more&&!cursor)return
    loaded.loading=true;loaded.error=''
    try {
      const result=QQSourceResponseSchemas['qq.context.get'].parse(await query({method:'qq.context.get',params:{requestId:id,...selection,cursor:cursor??undefined}}))
      if(result.snapshotId!==selection.snapshotId||result.projectionId!==selection.projectionId)throw new Error('输入版本不匹配；未切换到其他内容。')
      if(sessions[id]!==current)return
      loaded.data=loaded.data&&(more||cursorOverride||refresh)?{...result,nextCursor:cursorOverride||refresh?loaded.data.nextCursor:result.nextCursor,items:merge(loaded.data.items,result.items).sort((a,b)=>a.position-b.position),
        ...(result.fileInputs?{fileInputs:mergeFiles(loaded.data.fileInputs??[],result.fileInputs)}:{})}:result
    }catch(error){if(sessions[id]===current)loaded.error=failure(error)}finally{loaded.loading=false}
  }
  async function restart(id:string){const current=session(id),selection=current.selection;if(!selection)return;delete current.views[sourceSelectionKey(selection)];await view(id)}
  function mergeFiles(a:NonNullable<SourceContextView['fileInputs']>,b:NonNullable<SourceContextView['fileInputs']>){return [...new Map([...a,...b].map(file=>[file.provisionId,file])).values()]}
  function body(id:string,value:SourceVisibleBody) {
    if(value.state!=='available')return undefined
    const key=`${id}:${value.text.textRefId}`
    texts[key]??={value:value.text.preview,nextCursor:value.text.nextCursor,end:value.text.previewCodePoints,loading:false,error:''}
    return texts[key]!
  }
  async function text(id:string,reference:SourceTextRef) {
    const loaded=body(id,{state:'available',text:reference})!;if(loaded.loading||!loaded.nextCursor)return
    const cursor=loaded.nextCursor,expected=loaded.end;loaded.loading=true;loaded.error=''
    try{
      const result=QQSourceResponseSchemas['qq.context.text'].parse(await query({method:'qq.context.text',params:{requestId:id,textRefId:reference.textRefId,cursor}}))
      if(result.textRefId!==reference.textRefId||result.revision!==reference.revision||result.startCodePoint!==expected)throw new Error('正文续页不连续；已读内容保持不变。')
      if(texts[`${id}:${reference.textRefId}`]!==loaded)return
      loaded.value+=result.text;loaded.end=result.endCodePoint;loaded.nextCursor=result.nextCursor
    }catch(error){if(texts[`${id}:${reference.textRefId}`]===loaded)loaded.error=failure(error)}finally{loaded.loading=false}
  }
  async function sources(id:string,relationId:string,more=false) {
    const current=session(id),selection=current.selection;if(!selection)return
    const key=`${selection.snapshotId}:${relationId}`
    current.relations[key]??={loading:false,error:''}
    const loaded=current.relations[key]!
    if(loaded.loading)return
    const cursor=more?loaded.data?.nextCursor:undefined;if(more&&!cursor)return
    loaded.loading=true;loaded.error=''
    try{
      const result=QQSourceResponseSchemas['qq.context.sources'].parse(await query({method:'qq.context.sources',params:{requestId:id,snapshotId:selection.snapshotId,relationId,cursor:cursor??undefined}}))
      if(result.snapshotId!==selection.snapshotId||result.relationId!==relationId)throw new Error('来源关系不匹配。')
      if(sessions[id]!==current)return
      loaded.data=more&&loaded.data?{...result,items:[...new Map([...loaded.data.items,...result.items].map(item=>[`${item.source.recordId}:${item.source.revision}`,item])).values()]}:result
    }catch(error){if(sessions[id]===current)loaded.error=failure(error)}finally{loaded.loading=false}
  }
  async function locate(id:string,item:Pick<SourceContextItem,'itemId'>) {
    const selection=session(id).selection;if(!selection)throw new Error('尚未选择输入版本')
    const result=QQSourceResponseSchemas['qq.context.locate'].parse(await query({method:'qq.context.locate',params:{requestId:id,snapshotId:selection.snapshotId,projectionId:selection.projectionId,itemId:item.itemId}}))
    if(!session(id).selection||sourceSelectionKey(session(id).selection!)!==sourceSelectionKey(selection))throw new Error('输入版本已切换，未改变当前阅读位置。')
    await view(id,false,false,result.cursor)
    return result.itemId
  }
  async function entry(id:string,kind:EntryPage['kind'],more=false) {
    const current=session(id)
    current.entryPages[kind]??={loading:false,error:''}
    const loaded=current.entryPages[kind]!
    if(loaded.loading)return
    const cursor=more?loaded.data?.nextCursor:undefined;if(more&&!cursor)return
    loaded.loading=true;loaded.error=''
    try{
      const result=QQSourceResponseSchemas['qq.entry.items'].parse(await query({method:'qq.entry.items',params:{requestId:id,kind,cursor:cursor??undefined}}))
      if(result.kind!==kind)throw new Error('详情类别不匹配。')
      if(sessions[id]===current)loaded.data=more&&loaded.data?{...result,items:merge(loaded.data.items,result.items)}:result
    }catch(error){if(sessions[id]===current)loaded.error=failure(error)}finally{loaded.loading=false}
  }
  function seedEntry(id:string,input:NonNullable<import('../../../packages/protocol/src/qq').QQEntryDetail['sourceContext']>){
    const current=session(id)
    for(const page of [input.messages,input.deliveries])if(page&&page.requestId===id&&!current.entryPages[page.kind]?.data&&!current.entryPages[page.kind]?.loading)
      current.entryPages[page.kind]={data:page,loading:false,error:''}
  }
  return {sessions,texts,session,index,entries,select,latest,view,restart,body,text,sources,locate,entry,seedEntry,clear}
}
