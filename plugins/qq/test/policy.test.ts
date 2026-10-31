import { describe, expect, it } from 'vitest'
import { QQPlugin } from '../src/index.js'
import { emptyState } from '../src/state.js'
import { QQDefaultConfig, QQResponseSchemas } from '../../../packages/protocol/src/qq.js'

function fixture(){
  const plugin=Object.create(QQPlugin.prototype) as any
  const config={...structuredClone(QQDefaultConfig),groups:['456'],users:['789'],bindings:{'group:456':'preset','private:user:789':'preset'},voiceDefaultCharacter:'fixed'}
  const preset={name:'preset',presetId:'preset-id',leaderName:'role',brain:'brain',senseGroup:'tools',mcpServers:[],tools:['web_search:auto','qq_interact:auto'],
    configRevision:'core-1',registryVersion:1,toolStatus:[{selection:'web_search',available:true,allowed:true},{selection:'qq_interact.voice',available:true,allowed:false,reason:'role_deny'},{selection:'qq_interact.reaction',available:true,allowed:true}]}
  plugin.snapshot={revision:2,config};plugin.state=emptyState();plugin.connection='connection';plugin.recovered=true
  plugin.context={config:{saved:()=>({revision:2,config})},core:{resolvePreset:()=>preset}}
  const view=(name='web_search',target='group:456')=>{
    const result=plugin.policyView(target)
    QQResponseSchemas['qq.policy.get'].parse(result)
    return result.capabilities.find((cap:any)=>cap.name===name)
  }
  return {plugin,preset,config,view}
}
describe('QQ applied capabilities and versioned call facts',()=>{
  it('does not equate registration with verified readiness',()=>{
    const {view}=fixture()
    expect(view()).toMatchObject({configured:true,allowed:true,ready:null,reason:'unverified',lastResult:null})
    expect(view('qq_interact.voice')).toMatchObject({configured:true,allowed:false,ready:false,reason:'role_deny'})
  })
  it('keeps missing selections, disabled features and unsupported targets distinct',()=>{
    const {config,view}=fixture()
    expect(view('web_fetch')).toMatchObject({configured:false,allowed:false,ready:false,reason:'missing_tool'})
    config.voiceMode='off'
    expect(view('qq_interact.voice')).toMatchObject({reason:'disabled'})
    config.voiceMode='requested'
    expect(view('qq_interact.voice','private:user:789')).toMatchObject({reason:'not_supported'})
  })
  it('separates connection and fixed-voice prerequisites from role permission',()=>{
    const {plugin,preset,config,view}=fixture()
    preset.toolStatus[1]={selection:'qq_interact.voice',available:true,allowed:true}
    plugin.recovered=false
    expect(view('qq_interact.voice')).toMatchObject({allowed:true,ready:false,reason:'not_connected'})
    plugin.recovered=true;config.voiceDefaultCharacter=''
    expect(view('qq_interact.voice')).toMatchObject({allowed:true,ready:false,reason:'voice_unconfigured'})
  })
  it('shows actual call time and revisions but marks changed configurations as old',()=>{
    const {plugin,preset,view}=fixture()
    plugin.state.toolResults['group:456']={web_search:{status:'ok',at:123,qqConfigRevision:2,configRevision:'core-1',registryVersion:1}}
    expect(view()).toMatchObject({ready:true,reason:null,lastResult:{status:'ok',at:123,current:true}})
    plugin.snapshot.revision=3
    expect(view()).toMatchObject({ready:null,lastResult:{current:false,qqConfigRevision:2}})
    plugin.snapshot.revision=2;preset.configRevision='core-2'
    expect(view()).toMatchObject({ready:null,lastResult:{current:false}})
    preset.configRevision='core-1';preset.registryVersion=2
    expect(view()).toMatchObject({ready:null,lastResult:{current:false}})
  })
  it('does not treat another interaction action as a successful voice call or delivery',()=>{
    const {plugin,preset,view}=fixture()
    preset.toolStatus[1]={selection:'qq_interact.voice',available:true,allowed:true}
    plugin.state.toolResults['group:456']={qq_interact:{status:'ok',at:123},'qq_interact.reaction':{status:'ok',at:123}}
    expect(view('qq_interact.voice')).toMatchObject({ready:null,lastResult:null})
    plugin.state.toolResults['group:456']['qq_interact.voice']={status:'ok',at:124,qqConfigRevision:2,configRevision:'core-1',registryVersion:1}
    expect(view('qq_interact.voice')).toMatchObject({ready:null,lastResult:{status:'ok',current:true}})
  })
})
