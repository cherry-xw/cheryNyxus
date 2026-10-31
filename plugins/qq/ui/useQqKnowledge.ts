import { reactive } from 'vue'
import { managerRequest, ManagerApiError } from '../../../packages/manager-ui/src/api'
import { requestId } from '../../../packages/manager-ui/src/requestId'
export function useQqKnowledge(request = managerRequest) {
  const state = reactive({target:'',scope:'local' as 'local'|'public',entries:[] as any[],revision:0,nextCursor:null as string|null,
    rejected:[] as string[],loading:false,saving:false,error:'',message:'',learning:null as any,editing:null as any,note:'',uncertain:false})
  let generation = 0, controller: AbortController|undefined
  function clear() {generation++;controller?.abort();state.entries=[];state.rejected=[];state.learning=null;state.editing=null;state.note='';state.nextCursor=null;state.loading=false}
  function denied(error: unknown) { if (error instanceof ManagerApiError && [401,403].includes(error.status)) clear() }
  async function read(more=false) {
    if (!state.target || state.saving) return
    const version=++generation;controller?.abort();controller=new AbortController();state.loading=true;state.error=''
    if (!more) {state.entries=[];state.nextCursor=null}
    try {
      const query=new URLSearchParams({target:state.target,scope:state.scope})
      if(more&&state.nextCursor){query.set('cursor',state.nextCursor);query.set('revision',String(state.revision))}
      const {data}=await request<any>(`/api/modules/qq/knowledge/list?${query}`,{signal:controller.signal})
      if(version!==generation)return
      state.entries=more?[...state.entries,...data.entries]:data.entries;state.revision=data.revision;state.nextCursor=data.nextCursor;state.rejected=data.rejected
      state.uncertain=false
    }catch(error){denied(error);if(version===generation)state.error=error instanceof Error?error.message:'记忆读取失败'}
    finally{if(version===generation)state.loading=false}
  }
  async function learning() {
    const version=generation
    try {const {data}=await request<any>('/api/modules/qq/learning/get');if(version===generation)state.learning=data}
    catch(error){denied(error);if(version===generation)state.error=error instanceof Error?error.message:'学习状态读取失败'}
  }
  async function edit(input:{save?:any[];delete?:string[];reject?:string[];restore?:string[]},scope=state.scope,revision=state.revision) {
    if(state.saving||state.uncertain||!state.note.trim())return
    state.saving=true;state.error='';state.message=''
    const operationId=requestId(),target=state.target
    try {
      await request('/api/modules/qq/knowledge/edit',{method:'POST',body:JSON.stringify({target,scope,operationId,expectedRevision:revision,
        save:input.save??[],delete:input.delete??[],reject:input.reject??[],restore:input.restore??[],adminNote:state.note})})
      state.editing=null;state.message='已保存管理员修改';state.note=''
    }catch(error){denied(error);state.uncertain=true;state.error=`${error instanceof Error?error.message:'保存未确认'}。请先刷新核对，不要重复提交（${operationId}）。`}
    finally{state.saving=false}
    if(!state.uncertain&&state.target===target)await read()
  }
  async function adoption(id:string,restore:boolean) {
    try {const {data}=await request<any>(`/api/modules/qq/knowledge/list?target=${encodeURIComponent(state.target)}&scope=local`)
      await edit(restore?{restore:[id]}:{reject:[id]},'local',data.revision)
    }catch(error){denied(error);state.error=error instanceof Error?error.message:'采用状态读取失败'}
  }
  async function retry(operationId:string) {
    try {await request('/api/modules/qq/learning/retry',{method:'POST',body:JSON.stringify({operationId})});await learning()}
    catch(error){denied(error);state.error=error instanceof Error?error.message:'重试未提交'}
  }
  function begin(entry:any) {state.editing={...entry,aliases:[...entry.aliases],status:state.scope==='public'&&entry.status==='active'?'disputed':entry.status};state.note=''}
  async function saveEdit() {
    const {id,term,aliases,meaning,usage,caveat,status,kind,members}=state.editing
    await edit({save:[{id,term,aliases,meaning,usage,caveat,status,kind,members,evidenceRefs:['admin']}]})
  }
  return {state,read,learning,edit,adoption,retry,begin,saveEdit,clear}
}
