import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { registerPluginSense } from '@/core/sense/senseRegistry.js'
import { compileRoleSecurity } from '@/core/security/rolePolicy.js'
import { SupervisionLevel } from '@/core/config.js'
import { ingressToolStatus } from '@/service/ingress/toolStatus.js'

const releases: Array<()=>void> = []
afterEach(()=>{for(const release of releases.splice(0))release()})
function register(level=SupervisionLevel.auto,available=()=>true){
  releases.push(registerPluginSense({definition:{type:'function',function:{name:'status_action',description:'fixture',parameters:{type:'object',properties:{}}}},supervisionLevel:level,
    operationPolicy:{keys:['status_action.voice','status_action.reaction'],key:args=>`status_action.${args.action}`,definition:()=>({type:'function',function:{name:'status_action',description:'fixture',parameters:{}}})},
    executor:{schema:z.object({}),execute:async()=>({status:'ok',content:'fixture'})}} as any,{source:'plugin',available}))
}
const security=(tools:Record<string,'allow'|'ask'|'deny'>={})=>compileRoleSecurity('status',{permissions:{template:'trusted',tools}} as any)
describe('ingress capability status follows actual operation selections',()=>{
  it('expands a whole tool and applies each operation role rule',()=>{
    register()
    expect(ingressToolStatus(['status_action:auto'],security({'status_action.voice':'deny'}),SupervisionLevel.auto)).toEqual([
      {selection:'status_action.voice',available:true,allowed:false,reason:'role_deny'},
      {selection:'status_action.reaction',available:true,allowed:true,reason:undefined},
    ])
  })
  it('does not override a base denial with operation allow',()=>{
    register()
    expect(ingressToolStatus(['status_action.voice:auto'],security({status_action:'deny','status_action.voice':'allow'}),SupervisionLevel.auto)[0]).toMatchObject({allowed:false,reason:'role_deny'})
  })
  it('keeps the stricter duplicate level in either order',()=>{
    register()
    for(const tools of [['status_action:auto','status_action.voice:manual'],['status_action.voice:manual','status_action:auto']]){
      expect(ingressToolStatus(tools,security(),SupervisionLevel.auto).find(item=>item.selection==='status_action.voice')).toMatchObject({allowed:false,reason:'role_ask'})
    }
  })
  it('uses global and registered supervision, not an implicit auto level',()=>{
    register(SupervisionLevel.manual)
    expect(ingressToolStatus(['status_action.voice:auto'],security(),SupervisionLevel.auto)[0]).toMatchObject({allowed:false,reason:'role_ask'})
    expect(ingressToolStatus(['status_action.voice'],security(),SupervisionLevel.manual)[0]).toMatchObject({allowed:false,reason:'role_ask'})
  })
  it('does not mark unknown operations or unavailable registrations as usable',()=>{
    register(SupervisionLevel.auto,()=>false)
    for(const tool of ['status_action.voice','status_action.other','missing'])expect(ingressToolStatus([tool],security(),SupervisionLevel.auto)[0]).toMatchObject({available:false,allowed:false,reason:'tool_unavailable'})
  })
  it('preserves explicit then registered then global supervision for tools without operations',()=>{
    for(const [name,level] of [['status_plain',SupervisionLevel.manual],['status_inherited',undefined]] as const){
      releases.push(registerPluginSense({definition:{type:'function',function:{name,description:'fixture',parameters:{type:'object',properties:{}}}},supervisionLevel:level,
        executor:{schema:z.object({}),execute:async()=>({status:'ok',content:'fixture'})}} as any,{source:'plugin'}))
    }
    expect(ingressToolStatus(['status_plain:auto'],security(),SupervisionLevel.manual)[0]).toMatchObject({available:true,allowed:true})
    expect(ingressToolStatus(['status_plain'],security(),SupervisionLevel.auto)[0]).toMatchObject({allowed:false,reason:'role_ask'})
    expect(ingressToolStatus(['status_inherited'],security(),SupervisionLevel.manual)[0]).toMatchObject({allowed:false,reason:'role_ask'})
  })
})
