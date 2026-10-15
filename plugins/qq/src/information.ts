import { z } from 'zod'
import type { IngressContext } from '@chery/plugin-api'
type Registration = Parameters<IngressContext['tools']['register']>[0]
export const informationSchema = z.object({
  kind: z.enum(['history','profile','group','members','member','notices','files','file_url','file_space','essence','albums','album_media','honor']),
  count: z.number().int().min(1).max(100).default(50), userId: z.string().regex(/^[1-9]\d{0,19}$/).optional(),
  folderId: z.string().max(256).optional(), fileId: z.string().max(256).optional(), albumId: z.string().max(256).optional(),
}).strict()
export function informationTool(run: (id: string, input: z.infer<typeof informationSchema>) => Promise<unknown>): Registration {
  const schema = informationSchema
  const json = z.toJSONSchema(schema)
  const description = 'QQ只读信息查询，使用当前会话身份。支持近期消息、资料、当前群成员/公告/文件/精华/相册/荣誉。先加载qq-information技能。默认50条最多100条，不支持管理操作和跨私聊查询。'
  return {sense:{definition:{type:'function',function:{name:'qq_information',description,parameters:json as any}},supervisionLevel:0,
    executor:{schema,execute:async (input,_shared,ctx)=>{
      const view=ctx?.requestView
      if (view?.identity.source!=='plugin' || view.identity.channel!=='qq' || !view.identity.subject) throw new Error('Trusted QQ request required')
      ctx?.signal?.throwIfAborted()
      try {return {status:'ok',content:JSON.stringify(await run(view.requestId,schema.parse(input)))}}
      catch {return {status:'provider_error',errorCode:'provider_error',content:JSON.stringify({ok:false,error:'查询失败或不允许，未自动重试'})}}
    }}},metadata:{label:'QQ信息查询',description,icon:'qq',doc:description}}
}
