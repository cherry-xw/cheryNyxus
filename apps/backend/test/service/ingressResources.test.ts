import fs from 'node:fs'
import path from 'node:path'
import { vi } from 'vitest'
import { IngressStore } from '@/service/ingress/store.js'
import { IngressHost } from '@/service/ingress/host.js'
import { createRouter } from '@/service/message/router.js'
import { getRequestPluginSkills, getSkillRealtime } from '@/agent/prompt/loadSkill.js'
import { describe, expect, it } from 'vitest'
import { registerPluginResources, pluginSkillSources } from '@/service/ingress/resources.js'
import type { IngressRegistration, IngressRequestIdentity } from '@/service/ingress/api.js'

const subject = { selfId: '1', userId: '2', conversationType: 'private' as const }
function registration(id: string, channel?: string): IngressRegistration {
  return {
    id, version: '1.0.0', apiVersion: 2, entry: 'index.mjs', dependencies: [],
    capabilities: ['channel.identity'], grantedCapabilities: ['channel.identity'],
    channelGrants: channel ? [{ channel, credentialKind: channel }] : [],
    enabled: true, packageDigest: '0'.repeat(64),
    resources: [{ id: 'sample', kind: 'skill', path: 'skills/sample/SKILL.md', ...(channel ? {channel} : {}) }],
  }
}
describe('plugin-owned Skill sources', () => {
  it('does not expose business resources in the global or other channel catalog', () => {
    const release = registerPluginResources(registration('test-channel-skill', 'qq'), '/package')
    try {
      expect(pluginSkillSources()).toEqual([])
      expect(pluginSkillSources({source: 'web'})).toEqual([])
      expect(pluginSkillSources({source: 'plugin', channel: 'qq'})).toEqual([])
      expect(pluginSkillSources({source: 'plugin', channel: 'other', subject})).toEqual([])
      expect(pluginSkillSources({source: 'plugin', channel: 'qq', subject})).toMatchObject([
        {ownerId: 'test-channel-skill', version: '1.0.0', resourceId: 'sample', filePath: '/package/skills/sample/SKILL.md'},
      ])
    } finally { release() }
  })
  it('revokes previously captured identities and retains no source after disable', () => {
    const identity: IngressRequestIdentity = {source: 'plugin', channel: 'qq', subject}
    const release = registerPluginResources(registration('test-revocation-skill', 'qq'), '/package')
    expect(pluginSkillSources(identity)).toHaveLength(1)
    release()
    release()
    expect(pluginSkillSources(identity)).toEqual([])
  })
  it('limits unscoped resources to their issuing plugin and rejects conflicts atomically', () => {
    const item = registration('test-owner-skill')
    const release = registerPluginResources(item, '/package')
    try {
      expect(pluginSkillSources({source: 'plugin', ownerId: item.id})).toHaveLength(1)
      expect(pluginSkillSources({source: 'plugin', ownerId: 'other'})).toEqual([])
      expect(() => registerPluginResources(item, '/other')).toThrow('REGISTRATION_CONFLICT')
      expect(pluginSkillSources({source: 'plugin', ownerId: item.id})[0]?.filePath).toBe('/package/skills/sample/SKILL.md')
    } finally { release() }
  })
})

describe('installed resource lifecycle', () => {
  it('publishes only successful starts, filters role allowlists, and revokes on disable/uninstall without deleting data', async () => {
    const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'resource-install-'))
    const source = path.join(root, 'package'); fs.mkdirSync(path.join(source, 'skills/sample'), { recursive: true })
    fs.writeFileSync(path.join(source, 'skills/sample/SKILL.md'), '---\nname: sample\ndescription: sample skill\n---\nfixture instruction')
    fs.writeFileSync(path.join(source, 'index.mjs'), 'export function createPlugin(ctx) { return { defaultConfig:{},validateConfig:x=>x,applyConfig(){},start(){ctx.resources.resolve("sample")},stop(){} } }')
    const manifest = { id:'resource-fixture',version:'1.0.0',apiVersion:2,entry:'index.mjs',dependencies:[],capabilities:[],resources:[{id:'sample',kind:'skill',path:'skills/sample/SKILL.md'}] }
    fs.writeFileSync(path.join(source, 'config.yaml'), JSON.stringify(manifest))
    const store = new IngressStore(path.join(root, 'runtime')); store.install(source); store.setEnabled(manifest.id, true)
    const host = new IngressHost({ store, router:createRouter(), core:{listPresets:()=>[],resolvePreset:vi.fn(),ensureConversation:vi.fn(),submit:vi.fn(),abort:vi.fn(),onEvent:()=>()=>{}},connections:{credentialKind:()=>undefined,isOpen:()=>false,send:()=>false,onClose:()=>()=>{}} })
    const identity = {source:'plugin' as const,ownerId:manifest.id}
    try {
      await host.start()
      expect(getRequestPluginSkills(identity).map(s=>s.name)).toEqual(['resource-fixture__sample'])
      expect(getRequestPluginSkills(identity, {plugins:[]})).toEqual([])
      expect(getRequestPluginSkills(identity, {plugins:[manifest.id]})).toHaveLength(1)
      expect(getSkillRealtime('resource-fixture__sample', {source:'web'})).toBeUndefined()
      const data = path.join(root, 'runtime/data/resource-fixture'); fs.mkdirSync(data,{recursive:true}); fs.writeFileSync(path.join(data,'retained'),'data')
      await host.disable(manifest.id)
      expect(getSkillRealtime('resource-fixture__sample',identity)).toBeUndefined()
      expect(fs.readFileSync(path.join(data,'retained'),'utf8')).toBe('data')
      await host.uninstall(manifest.id)
      expect(getRequestPluginSkills(identity)).toEqual([])
      expect(fs.readFileSync(path.join(data,'retained'),'utf8')).toBe('data')
    } finally { await host.stop(); fs.rmSync(root,{recursive:true,force:true}) }
  })
  it('never publishes Skill sources when package start fails after resolving a resource', async () => {
    const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'resource-rollback-'))
    const source = path.join(root,'package'); fs.mkdirSync(path.join(source,'skills/sample'),{recursive:true})
    fs.writeFileSync(path.join(source,'skills/sample/SKILL.md'),'---\nname: sample\n---\nfixture')
    fs.writeFileSync(path.join(source,'config.yaml'),JSON.stringify({id:'failed-resource',version:'1.0.0',apiVersion:2,entry:'index.mjs',dependencies:[],capabilities:[],resources:[{id:'sample',kind:'skill',path:'skills/sample/SKILL.md'}]}))
    fs.writeFileSync(path.join(source,'index.mjs'),'export function createPlugin(ctx){return {defaultConfig:{},validateConfig:x=>x,applyConfig(){},start(){ctx.resources.resolve("sample");throw new Error("failed")},stop(){}}}')
    const store = new IngressStore(path.join(root,'runtime'));store.install(source);store.setEnabled('failed-resource',true)
    const host = new IngressHost({store,router:createRouter(),core:{listPresets:()=>[],resolvePreset:vi.fn(),ensureConversation:vi.fn(),submit:vi.fn(),abort:vi.fn(),onEvent:()=>()=>{}},connections:{credentialKind:()=>undefined,isOpen:()=>false,send:()=>false,onClose:()=>()=>{}}})
    try { await host.start();expect(getRequestPluginSkills({source:'plugin',ownerId:'failed-resource'})).toEqual([]) }
    finally { await host.stop();fs.rmSync(root,{recursive:true,force:true}) }
  })

})
