import fs from 'node:fs'
import path from 'node:path'
import { describe,it,expect,vi } from 'vitest'
import { IngressStore } from '@/service/ingress/store.js'
import { IngressHost } from '@/service/ingress/host.js'
import { createRouter } from '@/service/message/router.js'
import { getRequestPluginSkills,getSkillRealtime } from '@/agent/prompt/loadSkill.js'
import { getSense } from '@/core/sense/senseRegistry.js'

describe('installed QQ information resources',()=>{
 it('publishes skill and tool only through active QQ package lifecycle',async()=>{
  const root=fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!,'qq-info-'))
  const store=new IngressStore(root)
  store.install(path.resolve('plugins/qq/dist'),false,undefined,{grantedCapabilities:['ingress','rpc.business','rpc.management','tools','hooks','channel.identity','manager.ui'],channelGrants:[{channel:'qq',credentialKind:'qq'}]})
  store.setEnabled('cherynyxus-qq-module',true)
  const host=new IngressHost({store,router:createRouter(),core:{listPresets:()=>[],resolvePreset:vi.fn(),ensureConversation:vi.fn(),submit:vi.fn(),abort:vi.fn(),onEvent:()=>()=>{}},connections:{credentialKind:()=>undefined,isOpen:()=>false,send:()=>false,onClose:()=>()=>{}}})
  const identity={source:'plugin' as const,ownerId:'cherynyxus-qq-module',channel:'qq',subject:{selfId:'1',userId:'2',conversationType:'private' as const}}
  try{
   await host.start()
   expect(host.status().find(p=>p.id==='cherynyxus-qq-module')?.state).toBe('active')
   const skills=getRequestPluginSkills(identity)
   expect(skills.some(s=>s.name==='cherynyxus-qq-module__qq-information')).toBe(true)
   expect(getSkillRealtime('cherynyxus-qq-module__qq-information',identity)?.skill.content).toContain('qq_information')
   expect(getRequestPluginSkills({source:'web'})).toEqual([])
   expect(getSense('qq_information')).toBeDefined()
   await host.disable('cherynyxus-qq-module')
   expect(getRequestPluginSkills(identity)).toEqual([]);expect(getSense('qq_information')).toBeUndefined()
  }finally{await host.stop();fs.rmSync(root,{recursive:true,force:true})}
 })
})
