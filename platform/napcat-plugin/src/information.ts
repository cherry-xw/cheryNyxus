type Call = (name: string, params: unknown) => Promise<any>
const pick = (v: any, keys: string[]) => Object.fromEntries(keys.filter(k => v?.[k] !== undefined).map(k => [k,v[k]]))
export async function queryInformation(call: Call, event: any) {
  const q = event.information
  if (!q || !Number.isInteger(q.count) || q.count < 1 || q.count > 100) throw new Error('Invalid query')
  const group = event.conversationType === 'group', group_id = String(event.targetId)
  if (!group && (q.kind !== 'profile' || q.userId !== event.targetId)) throw new Error('Private query denied')
  const get = async (name: string, params: unknown) => {
    const r = await call(name,params)
    if (r?.retcode !== undefined && r.retcode !== 0) throw new Error('Query rejected')
    return r?.data ?? r
  }
  if (['profile','member'].includes(q.kind)) {
    if (group) {
      const members = await get('get_group_member_list',{group_id,no_cache:false})
      if (!Array.isArray(members) || !members.some(m => String(m.user_id) === q.userId)) throw new Error('Not a member')
    }
    const d=await get(q.kind==='profile'?'get_stranger_info':'get_group_member_info',q.kind==='profile'?{user_id:q.userId,no_cache:false}:{group_id,user_id:q.userId,no_cache:false})
    return pick(d,['user_id','nickname','card','role','area','country','province','city','join_time','last_sent_time'])
  }
  const routes: Record<string,[string,unknown]> = {
    history:['get_group_msg_history',{group_id,count:q.count,reverse_order:false}],
    group:['get_group_info',{group_id,no_cache:false}], members:['get_group_member_list',{group_id,no_cache:false}],
    notices:['_get_group_notice',{group_id}], files:[q.folderId?'get_group_files_by_folder':'get_group_root_files',{group_id,file_count:q.count,...(q.folderId?{folder_id:q.folderId}:{})}],
    file_url:['get_group_file_url',{group_id,file_id:q.fileId}],file_space:['get_group_file_system_info',{group_id}],
    essence:['get_essence_msg_list',{group_id}],albums:['get_qun_album_list',{group_id}],album_media:['get_group_album_media_list',{group_id,album_id:q.albumId}],honor:['get_group_honor_info',{group_id,type:'all'}],
  }
  if (!group || !routes[q.kind]) throw new Error('Unsupported query')
  if ((q.kind==='file_url'&&!q.fileId)||(q.kind==='album_media'&&!q.albumId)) throw new Error('Missing resource ID')
  const [name,params]=routes[q.kind]!
  let d=await get(name,params)
  if (q.kind==='members') d=d.slice(0,q.count).map((m:any)=>pick(m,['user_id','nickname','card','role','last_sent_time']))
  if (q.kind==='history') d={messages:(d.messages??[]).slice(-q.count).map((m:any)=>({message_id:m.message_id,time:m.time,sender:pick(m.sender,['user_id','nickname','card']),message:m.message}))}
  const bound=(v:any,depth=0):any=>depth>10?null:typeof v==='string'?v.slice(0,4000):Array.isArray(v)?v.slice(0,q.count).map(x=>bound(x,depth+1)):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!/(cookie|token|password|credential|phone|email)/i.test(k)).map(([k,x])=>[k,bound(x,depth+1)])):v
  const result=bound(d)
  if (JSON.stringify(result).length>55000) throw new Error('Result too large; request fewer items')
  return result
}
