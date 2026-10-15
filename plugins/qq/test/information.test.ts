import { describe, expect, it, vi } from 'vitest'
import { informationSchema, informationTool } from '../src/information.js'
import { queryInformation } from '../../../platform/napcat-plugin/src/information.js'
import { prepareQuery } from '../skills/qq-information/scripts/query.mjs'

describe('QQ read-only information', () => {
  const subject = {userId:'123',conversationType:'private'}
  it('defaults to bounded samples and refuses arbitrary actions or targets', () => {
    expect(prepareQuery({kind:'history'},subject)).toMatchObject({count:50,userId:'123'})
    for (const input of [{kind:'send_msg'},{kind:'history',count:101},{kind:'profile',userId:'456'},{kind:'files'}]) expect(()=>prepareQuery(input,subject)).toThrow()
    expect(()=>informationSchema.parse({kind:'history',action:'send_msg'})).toThrow()
  })
  it('requires a trusted QQ execution identity',async()=>{
    const run=vi.fn(async()=>({messages:[]})), tool=informationTool(run).sense.executor
    await expect(tool.execute({kind:'history'},{ } as any,{} as any)).rejects.toThrow('Trusted')
    const result=await tool.execute({kind:'history'},{} as any,{requestView:{requestId:'r',identity:{source:'plugin',channel:'qq',subject}}} as any)
    expect(result.status).toBe('ok');expect(run).toHaveBeenCalledWith('r',expect.objectContaining({count:50}))
  })
  it('checks membership before personal profiles and minimizes returned fields',async()=>{
    const call=vi.fn(async(name:string)=> name==='get_group_member_list'?{data:[{user_id:123}]}:{data:{user_id:123,country:'中国',phone:'secret',homeTown:'1-2-3'}})
    expect(await queryInformation(call,{conversationType:'group',targetId:'999',information:{kind:'profile',userId:'123',count:50}})).toEqual({user_id:123,country:'中国'})
    await expect(queryInformation(call,{conversationType:'group',targetId:'999',information:{kind:'profile',userId:'456',count:50}})).rejects.toThrow('Not a member')
  })
  it('refuses cross-private and unsupported operations without native calls',async()=>{
    const call=vi.fn()
    for (const e of [{conversationType:'private',targetId:'123',information:{kind:'profile',userId:'456',count:50}},{conversationType:'group',targetId:'999',information:{kind:'send_group_msg',count:50}}]) await expect(queryInformation(call,e)).rejects.toThrow()
    expect(call).not.toHaveBeenCalled()
  })
  it('uses only the intended read route, limits results and fails on provider rejection',async()=>{
    const call=vi.fn(async()=>({retcode:0,data:{messages:Array.from({length:8},(_,i)=>({message_id:i,message:'hello',sender:{user_id:123,phone:'secret'}}))}}))
    const result=await queryInformation(call,{conversationType:'group',targetId:'999',information:{kind:'history',count:3}})
    expect(call).toHaveBeenCalledWith('get_group_msg_history',{group_id:'999',count:3,reverse_order:false})
    expect(result.messages).toHaveLength(3);expect(JSON.stringify(result)).not.toContain('secret')
    await expect(queryInformation(async()=>({retcode:1}),{conversationType:'group',targetId:'999',information:{kind:'notices',count:3}})).rejects.toThrow()
  })
})
