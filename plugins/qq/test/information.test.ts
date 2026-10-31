import { describe, expect, it, vi } from 'vitest'
import { informationSchema, informationTools, sourceTextTool } from '../src/information.js'
import { queryInformation } from '../../../platform/napcat-plugin/src/information.js'
import { prepareQuery } from '../skills/qq-information/scripts/query.mjs'

describe('QQ read-only information', () => {
  const subject = {userId:'123',conversationType:'private'}
  it('defaults to bounded samples and refuses arbitrary actions or targets', () => {
    expect(prepareQuery({kind:'history'},subject)).toEqual({kind:'history',count:50,historySource:'retained'})
    for (const input of [{kind:'send_msg'},{kind:'history',count:101},{kind:'profile',userId:'456'},{kind:'files'},
      {kind:'history',historySource:'platform'},{kind:'history',userId:'123'}, {kind:'profile',cursor:'page'}]) expect(()=>prepareQuery(input,subject)).toThrow()
    expect(()=>informationSchema.parse({kind:'history',action:'send_msg'})).toThrow()
  })
  it('keeps local cursors out of the explicit platform route', () => {
    const group = {...subject, conversationType:'group'}
    expect(prepareQuery({kind:'history',cursor:'page'},group)).toEqual({kind:'history',count:50,historySource:'retained',cursor:'page'})
    expect(prepareQuery({kind:'history',historySource:'platform'},group)).toEqual({kind:'history',count:50,historySource:'platform'})
    expect(()=>prepareQuery({kind:'history',historySource:'platform',cursor:'page'},group)).toThrow()
    for (const input of [{kind:'history',userId:'456'}, {kind:'history',historySource:'platform',cursor:'page'}, {kind:'profile',historySource:'retained'}])
      expect(informationSchema.safeParse(input).success).toBe(false)
  })
  it('binds text continuation to the current trusted run and checks cancellation', async () => {
    const run = vi.fn(async () => ({text:'正文'})), tool = sourceTextTool(run).sense.executor
    await expect(tool.execute({textRefId:'text'},{} as any,{} as any)).rejects.toThrow('Trusted')
    const controller = new AbortController()
    const ctx = {requestView:{requestId:'r',identity:{source:'plugin',channel:'qq',subject}},signal:controller.signal} as any
    await expect(tool.execute({textRefId:'text',cursor:'page'},{} as any,ctx)).resolves.toMatchObject({status:'ok'})
    expect(run).toHaveBeenCalledWith('r',{textRefId:'text',cursor:'page'})
    controller.abort()
    await expect(tool.execute({textRefId:'text'},{} as any,ctx)).rejects.toThrow()
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('requires a trusted QQ execution identity',async()=>{
    const run=vi.fn(async()=>({messages:[]})), tools=informationTools(run), tool=tools.find(tool=>tool.sense.definition.function.name==='qq_history')!.sense.executor
    expect(tools.map(tool=>tool.sense.definition.function.name)).toEqual(['qq_information','qq_history'])
    await expect(tool.execute({},{ } as any,{} as any)).rejects.toThrow('Trusted')
    const result=await tool.execute({},{} as any,{requestView:{requestId:'r',identity:{source:'plugin',channel:'qq',subject}}} as any)
    expect(result.status).toBe('ok');expect(run).toHaveBeenCalledWith('r',expect.objectContaining({kind:'history',historySource:'retained',count:50}))
  })
  it.each([
    ['qq_history',{source:'retained',count:50},{kind:'history',historySource:'retained',count:50}],
    ['qq_history',{source:'platform',count:50},{kind:'history',historySource:'platform',count:50}],
    ['qq_information',{kind:'members',query:'小明',count:50},{kind:'members',query:'小明',count:50}],
    ['qq_information',{kind:'voices',query:'固定',count:50},{kind:'voices',query:'固定',count:50}],
  ])('accepts the documented %s example and maps only internal history parameters',async(name,input,expected)=>{
    const run=vi.fn(async()=>({items:[]})),tool=informationTools(run).find(tool=>tool.sense.definition.function.name===name)!.sense.executor
    const ctx={requestView:{requestId:'r',identity:{source:'plugin',channel:'qq',subject:{...subject,conversationType:'group',groupId:'456'}}}} as any
    expect((await tool.execute(input,{} as any,ctx)).status).toBe('ok')
    expect(run).toHaveBeenCalledWith('r',expect.objectContaining(expected))
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
