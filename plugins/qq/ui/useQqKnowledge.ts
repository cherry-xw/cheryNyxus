import { reactive } from 'vue'
import { managerRequest, ManagerApiError } from '../../../packages/manager-ui/src/api'
import { requestId } from '../../../packages/manager-ui/src/requestId'
import { QQKnowledgeResponseSchemas as responses } from '../../../packages/protocol/src/qqKnowledge'
import type { z } from 'zod'
import type { QQTermInputSchema } from '../../../packages/protocol/src/qqKnowledge'

type Change={save?:any[];delete?:string[];reject?:string[];restore?:string[]}
type Pending={body:Change&{target:string;scope:'local'|'public';operationId:string;expectedRevision:number;adminNote:string};draft:string;note:string}
type Status=''|z.infer<typeof QQTermInputSchema>['status']
export function useQqKnowledge(request = managerRequest) {
  const state = reactive({target:'',scope:'local' as 'local'|'public',entries:[] as any[],revision:0,nextCursor:null as string|null,
    query:'',status:'' as Status,appliedQuery:'',appliedStatus:'' as Status,total:0,
    rejected:[] as string[],loading:false,saving:false,error:'',message:'',learning:null as any,editing:null as any,note:'',uncertain:false,pendingId:'',retryAllowed:false})
  let generation=0, lifetime=0, learningGeneration=0, controller:AbortController|undefined, pending:Pending|undefined
  function clear() {
    lifetime++;generation++;learningGeneration++;controller?.abort();pending=undefined
    state.entries=[];state.rejected=[];state.learning=null;state.editing=null;state.note='';state.nextCursor=null
    state.query='';state.status='';state.appliedQuery='';state.appliedStatus='';state.total=0
    state.loading=false;state.saving=false;state.uncertain=false;state.pendingId='';state.retryAllowed=false;state.error='';state.message=''
  }
  function denied(error:unknown) {if(error instanceof ManagerApiError&&[401,403].includes(error.status)){clear();return true}return false}
  function confirmed(item:Pending) {
    if(JSON.stringify(state.editing)===item.draft)state.editing=null
    if(state.note===item.note)state.note=''
    pending=undefined;state.uncertain=false;state.pendingId='';state.retryAllowed=false;state.message='已确认保存管理员修改'
  }
  async function recover() {
    if(!pending)return
    const item=pending,version=lifetime
    const query=new URLSearchParams({target:item.body.target,scope:item.body.scope,operationId:item.body.operationId})
    const {data}=await request<any>(`/api/modules/qq/knowledge/receipt?${query}`)
    if(version!==lifetime||pending!==item)return
    const result=responses['qq.knowledge.receipt'].parse(data)
    if(result.state==='saved')confirmed(item)
    else {state.retryAllowed=true;state.error='尚未查到此保存编号；可以继续查询，或使用原编号和原内容重试。'}
  }
  async function read(more=false) {
    if(!state.target||state.saving)return
    const version=++generation,epoch=lifetime,target=state.target,scope=state.scope
    if(!more){state.appliedQuery=state.query.trim();state.appliedStatus=state.status}
    const filter={query:state.appliedQuery,status:state.appliedStatus}
    controller?.abort();controller=new AbortController();state.loading=true;state.error=''
    if(!more){state.entries=[];state.nextCursor=null;state.total=0}
    try {
      if(state.uncertain)await recover()
      if(epoch!==lifetime||version!==generation)return
      const query=new URLSearchParams({target,scope})
      if(filter.query)query.set('query',filter.query)
      if(filter.status)query.set('status',filter.status)
      if(more&&state.nextCursor){query.set('cursor',state.nextCursor);query.set('revision',String(state.revision))}
      const {data}=await request<any>(`/api/modules/qq/knowledge/list?${query}`,{signal:controller.signal})
      if(epoch!==lifetime||version!==generation||target!==state.target||scope!==state.scope)return
      const value=responses['qq.knowledge.list'].parse(data)
      state.entries=more?[...state.entries,...value.entries]:value.entries;state.revision=value.revision;state.nextCursor=value.nextCursor;state.rejected=value.rejected;state.total=value.total
    }catch(error){if(version===generation&&!denied(error))state.error=error instanceof Error?error.message:'记忆读取失败'}
    finally{if(version===generation)state.loading=false}
  }
  async function learning() {
    const version=++learningGeneration,epoch=lifetime
    try {const {data}=await request<any>('/api/modules/qq/learning/get');if(epoch===lifetime&&version===learningGeneration)state.learning=responses['qq.learning.get'].parse(data)}
    catch(error){if(epoch===lifetime&&version===learningGeneration&&!denied(error))state.error=error instanceof Error?error.message:'学习状态读取失败'}
  }
  async function submit(item:Pending) {
    if(state.saving)return
    const epoch=lifetime
    let saved=false
    state.saving=true;state.error='';state.message='';state.retryAllowed=false
    try {
      const {data}=await request<any>('/api/modules/qq/knowledge/edit',{method:'POST',body:JSON.stringify(item.body)})
      responses['qq.knowledge.edit'].parse(data)
      if(epoch!==lifetime||pending!==item)return
      confirmed(item);saved=true
    }catch(error){
      if(epoch!==lifetime||denied(error))return
      const definitive=error instanceof ManagerApiError&&[400,409,422].includes(error.status)
      if(definitive){pending=undefined;state.pendingId='';state.uncertain=false}
      else state.uncertain=true
      state.error=`${error instanceof Error?error.message:'保存未确认'}${definitive?'':'。请先刷新核对原保存编号，不要新建提交。'}`
    }finally{if(epoch===lifetime)state.saving=false}
    if(saved&&epoch===lifetime&&state.target===item.body.target)await read()
  }
  async function edit(input:Change,scope=state.scope,revision=state.revision) {
    if(state.loading||state.saving||state.uncertain||!state.target||!state.note.trim())return
    const item:Pending={body:{target:state.target,scope,operationId:requestId(),expectedRevision:revision,save:input.save??[],delete:input.delete??[],reject:input.reject??[],restore:input.restore??[],adminNote:state.note.trim()},draft:JSON.stringify(state.editing),note:state.note}
    pending=item;state.pendingId=item.body.operationId;await submit(item)
  }
  async function retrySave() {if(pending&&state.uncertain&&state.retryAllowed)await submit(pending)}
  async function adoption(id:string,restore:boolean) {
    if(state.loading||state.saving||state.uncertain)return
    const epoch=lifetime,target=state.target,scope=state.scope
    try {
      const {data}=await request<any>(`/api/modules/qq/knowledge/list?target=${encodeURIComponent(target)}&scope=local`)
      if(epoch!==lifetime||target!==state.target||scope!==state.scope)return
      const local=responses['qq.knowledge.list'].parse(data)
      await edit(restore?{restore:[id]}:{reject:[id]},'local',local.revision)
    }catch(error){if(epoch===lifetime&&!denied(error))state.error=error instanceof Error?error.message:'采用状态读取失败'}
  }
  async function retry(operationId:string) {
    const epoch=lifetime
    try {await request('/api/modules/qq/learning/retry',{method:'POST',body:JSON.stringify({operationId})});if(epoch===lifetime)await learning()}
    catch(error){if(epoch===lifetime&&!denied(error))state.error=error instanceof Error?error.message:'重试未提交'}
  }
  function begin(entry:any) {if(state.editing||state.saving||state.uncertain)return;state.editing={...entry,aliases:[...entry.aliases],status:state.scope==='public'&&entry.status==='active'?'disputed':entry.status};state.note=''}
  async function saveEdit() {
    if(!state.editing)return
    const {id,term,aliases,meaning,usage,caveat,status,kind,members}=state.editing
    await edit({save:[{id,term,aliases,meaning,usage,caveat,status,kind,members,evidenceRefs:['admin']}]})
  }
  return {state,read,learning,edit,adoption,retry,retrySave,begin,saveEdit,clear}
}
