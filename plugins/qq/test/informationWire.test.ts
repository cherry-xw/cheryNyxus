import { describe,it,expect,vi } from 'vitest'
import { Adapter } from '../../../platform/napcat-plugin/src/adapter.js'
import { QQNotificationSchema,QQRequestSchemas } from '../../../packages/protocol/src/qq.js'
import { mkdtemp, rm } from 'node:fs/promises'

describe('information notification transport',()=>{
 it('returns bounded actual action data without sending a message',async()=>{
  const action=vi.fn(async()=>({data:[{text:'synthetic notice'}]})),request=vi.fn(async()=>({success:true}))
  const dataPath = await mkdtemp('/tmp/opencode/qq-information-')
  try {
  const adapter=new Adapter({configPath:'unused',dataPath,adapterName:'fixture',pluginManager:{config:{}},logger:{},actions:{call:action}} as any,{request} as any)
  ;(adapter as any).selfId='123'
  ;(adapter as any).authenticated=true
  const frame=QQNotificationSchema.parse({kind:'notification',type:'qq.information.request',data:{eventId:'q',lookupId:'q',requestId:'r',selfId:'123',targetId:'456',conversationType:'group',seq:1,information:{kind:'notices',count:3,userId:'789'}}})
  await (adapter as any).notification(frame)
  expect(action.mock.calls[0]?.[0]).toBe('_get_group_notice')
  expect(action).toHaveBeenCalledTimes(1)
  expect(request.mock.calls[0]?.[0]).toBe('qq.information.result')
  const result=QQRequestSchemas['qq.information.result'].parse(request.mock.calls[0]?.[1])
  expect(result.success).toBe(true);expect(JSON.parse(result.result)).toEqual([{text:'synthetic notice'}])
  } finally { await rm(dataPath, { recursive: true, force: true }) }
 })
})
