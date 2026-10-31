import { describe, expect, it, vi } from 'vitest'
import { capabilityLabel, capabilityResultLabel } from '../../../plugins/qq/ui/qqPresentation'
import { useQq } from '../../../plugins/qq/ui/useQq'

const cap={name:'web_search',configured:true,allowed:false,ready:false,reason:'role_deny',lastResult:null}
const policy={target:'group:456',savedRevision:2,appliedRevision:2,effective:{mode:'followup',initiative:'balanced',style:'casual',customStyle:''},origins:{},capabilities:[cap],proactive:{usedChecks:0,limit:60,nextCheckAt:null}}
describe('QQ capability explanations without rendering assertions',()=>{
  it('does not describe permission, approval, connection or unknown states as a missing preset',()=>{
    for(const [reason,label] of [['role_deny','角色权限不允许'],['role_ask','需要审批'],['not_connected','QQ未连接'],['tool_unavailable','工具当前不可用'],['unverified','尚未验证'],['not_supported','当前目标不支持']])expect(capabilityLabel({...cap,reason})).toContain(label)
    expect(capabilityLabel({...cap,allowed:true,ready:null,reason:'unverified'})).not.toContain('成功')
  })
  it('shows old revision facts without claiming current success or delivery',()=>{
    expect(capabilityResultLabel(null)).toBe('尚无调用记录')
    const label=capabilityResultLabel({status:'ok',at:1,qqConfigRevision:2,configRevision:'core-1',registryVersion:7,current:false})
    expect(label).toContain('旧配置调用');expect(label).toContain('QQ配置版本 2');expect(label).toContain('核心配置版本 core-1');expect(label).toContain('工具版本 7')
    expect(label).not.toContain('已送达')
  })
  it('validates the policy response and rejects another target',async()=>{
    const request=vi.fn(async()=>({data:structuredClone(policy)})),qq=useQq(request as any)
    qq.state.selected='group:456';await qq.readPolicy()
    expect(qq.policy.value.capabilities[0].reason).toBe('role_deny')
    request.mockResolvedValueOnce({data:{...structuredClone(policy),target:'group:999'}})
    await qq.readPolicy();expect(qq.policy.value).toBeNull();expect(qq.policy.error).toContain('目标不匹配')
    request.mockResolvedValueOnce({data:{} as any})
    await qq.readPolicy();expect(qq.policy.value).toBeNull();expect(qq.policy.error).not.toBe('')
  })
})
