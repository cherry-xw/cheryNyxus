import { describe, expect, it, vi } from 'vitest'
import { useQq } from '../../../plugins/qq/ui/useQq'
import { qqSettingIssue } from '../../../plugins/qq/ui/qqSettingsValidation'
import { QQDefaultConfig } from '../../../packages/protocol/src/qq'

describe('QQ setting validation data without a browser',()=>{
  it.each([
    ['memoryTargetRatio','memory'],['learning.maxPending','memory'],['workerCpuCores','worker'],
    ['voiceMaxChars','interaction'],['imageStorage.totalBytes','messages'],['conversation.proactive.minCheckIntervalMs','conversation'],
    ['conversation.groups.123.customStyle','conversation'],['bindings.group:123','targets'],
  ])('routes %s to %s',(path,category)=>{
    const issue=qqSettingIssue({path:path.split('.'),message:'设置有误'})
    expect(issue).toMatchObject({path,category,message:'设置有误'})
    expect(issue.label).not.toBe('QQ 设置')
  })
  it('does not submit invalid drafts and clears field errors when corrected',async()=>{
    const request=vi.fn(async()=>({data:{config:structuredClone(QQDefaultConfig),baseRevision:0}}))
    const ui=useQq(request as any);await ui.read();request.mockClear()
    ui.state.config.memoryTargetRatio=0.94
    ui.state.config.conversation.proactive.minCheckIntervalMs=1000
    await ui.save()
    expect(request).not.toHaveBeenCalled();expect(ui.validation.attempt).toBe(1)
    expect(ui.fieldIssues.value.map(issue=>issue.category)).toEqual(expect.arrayContaining(['memory','conversation']))
    expect(ui.fieldAttrs('memoryTargetRatio')).toMatchObject({'aria-invalid':true,'aria-describedby':expect.any(String)})
    expect(ui.state.config.memoryTargetRatio).toBe(0.94);expect(ui.state.uncertain).toBe(false)
    ui.state.config.memoryTargetRatio=0.5;ui.state.config.conversation.proactive.minCheckIntervalMs=30000
    expect(ui.fieldIssues.value).toEqual([])
    expect(ui.fieldAttrs('memoryTargetRatio')['aria-invalid']).toBeUndefined()
  })
  it('associates an invalid waiting-message row with its full editable field',async()=>{
    const ui=useQq((async()=>({data:{config:structuredClone(QQDefaultConfig),baseRevision:0}})) as any)
    await ui.read();ui.state.config.waitMessages=[''];await ui.save()
    expect(ui.fieldIssues.value[0]).toMatchObject({path:'waitMessages.0',category:'messages',label:'等待文案'})
    expect(ui.fieldAttrs('waitMessages')['aria-invalid']).toBe(true)
  })
})
