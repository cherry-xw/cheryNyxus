import { describe, expect, it, vi } from 'vitest'
import { QQPlugin } from '../src/index.js'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq.js'
import { emptyState } from '../src/state.js'
import { useQq } from '../ui/useQq.js'

describe('voice catalog settings', () => {
  it('queries only allowed groups with verified identity and propagates transport errors', async () => {
    const plugin = Object.create(QQPlugin.prototype) as any
    let routes: any[]=[]
    plugin.context={config:{snapshot:()=>({config:{...QQDefaultConfig,groups:['456']}})}, management:{register:(value:any)=>{routes=value.routes}}}
    plugin.register=vi.fn(); plugin.state={...emptyState(),identityBinding:{selfId:'123'}}
    plugin.queryDirectory=vi.fn(async()=>[{id:'actual',name:'真实声音'}]);plugin.stopped=false;plugin.paused=false
    plugin.prepareManagement()
    const route=routes.find(r=>r.path==='voices')
    expect(route.method).toBe('GET')
    const input=(id:string)=>({pathParams:{},query:{groupId:id}})
    expect(route.requestSchema.safeParse(input('bad')).success).toBe(false)
    await expect(route.handler(input('999'))).rejects.toThrow('not allowed')
    expect(plugin.queryDirectory).not.toHaveBeenCalled()
    await expect(route.handler(input('456'))).resolves.toEqual({items:[{id:'actual',name:'真实声音'}]})
    plugin.queryDirectory.mockRejectedValue(new Error('QQ disconnected'))
    await expect(route.handler(input('456'))).rejects.toThrow('disconnected')
  })
  it('does not overwrite saved voice when catalog fails or returns empty', async () => {
    const request=vi.fn(async()=>{throw new Error('离线')}) as any
    const {state,voices}=useQq(request)
    state.config={...QQDefaultConfig,groups:['456'],voiceDefaultCharacter:'saved'};state.voiceGroup='456'
    await voices()
    expect(state.voicesError).toBe('离线');expect(state.voices).toEqual([])
    expect(state.config.voiceDefaultCharacter).toBe('saved')
    request.mockResolvedValue({data:{items:[]}});await voices()
    expect(state.voicesError).toBe('');expect(state.config.voiceDefaultCharacter).toBe('saved')
  })
  it('ignores stale directory response when the group changes', async () => {
    let complete!:(v:any)=>void
    const request=vi.fn(()=>new Promise(r=>{complete=r})) as any
    const {state,voices}=useQq(request)
    state.config={...QQDefaultConfig,groups:['456','789']};state.voiceGroup='456'
    const pending=voices(); state.voiceGroup='789'
    complete({data:{items:[{id:'old',name:'旧群声音'}]}});await pending
    expect(state.voices).toEqual([])
    state.voiceGroup='';await voices();expect(state.voicesLoading).toBe(false)
  })
})
