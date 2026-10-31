import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { QQPlugin } from '../src/index.js'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq.js'
import { QQKnowledgeResponseSchemas } from '../../../packages/protocol/src/qqKnowledge.js'
import { emptyState } from '../src/state.js'

const dirs:string[]=[]
afterEach(async()=>{for(const dir of dirs.splice(0))await fs.rm(dir,{recursive:true,force:true})})
async function fixture() {
  const dir=await fs.mkdtemp('/tmp/opencode/qq-management-');dirs.push(dir)
  const plugin=Object.create(QQPlugin.prototype) as any
  plugin.context={dataDir:dir};plugin.state=emptyState();plugin.state.identityBinding={selfId:'100'}
  plugin.snapshot={config:{...structuredClone(QQDefaultConfig),groups:['2']}}
  plugin.learning={interrupt:vi.fn()}
  const call=(method:string,args:any)=>plugin.knowledgeManagement(method,args)
  return {plugin,call}
}
describe('QQ knowledge management receipts',()=>{
  it('reads the original save receipt without rewriting or including message bodies',async()=>{
    const {call}=await fixture(),input={target:'group:2',scope:'local',operationId:'edit-one',expectedRevision:0,save:[],delete:[],reject:['term-one'],restore:[],adminNote:'本群不采用'}
    expect(await call('qq.knowledge.receipt',input)).toEqual({state:'not_found'})
    const saved=await call('qq.knowledge.edit',input)
    const result=await call('qq.knowledge.receipt',input)
    expect(QQKnowledgeResponseSchemas['qq.knowledge.receipt'].parse(result)).toEqual({state:'saved',receipt:saved})
    expect(await call('qq.knowledge.edit',input)).toEqual(saved)
    expect((await call('qq.knowledge.list',input)).revision).toBe(1)
    expect(JSON.stringify(result)).not.toContain('本群不采用')
  })
  it('refuses a target or public scope after it is disabled, including receipt reads',async()=>{
    const {call,plugin}=await fixture()
    await expect(call('qq.knowledge.receipt',{target:'group:3',scope:'local',operationId:'missing'})).rejects.toThrow('目标未获许可')
    plugin.snapshot.config.publicTermsEnabled=false
    await expect(call('qq.knowledge.receipt',{target:'group:2',scope:'public',operationId:'missing'})).rejects.toThrow('公共词义已关闭')
  })
  it('checks permission again after waiting for the write lock',async()=>{
    const {call,plugin}=await fixture()
    const changing=call('qq.knowledge.edit',{target:'group:2',scope:'local',operationId:'one',expectedRevision:0,save:[],delete:[],reject:[],restore:[],adminNote:'依据'})
    plugin.snapshot.config.groups=[]
    await expect(changing).rejects.toThrow('记忆管理权限已变化')
    plugin.snapshot.config.groups=['2']
    expect((await call('qq.knowledge.list',{target:'group:2',scope:'local'})).revision).toBe(0)
  })
})
