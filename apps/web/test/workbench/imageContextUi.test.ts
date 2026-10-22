// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import type { ConfigDto } from '@/application/backend/public'
import FilesPolicyCard from '@/features/agent/settings/tabs/config/cards/FilesPolicyCard.vue'
import AssetCard from '@/features/agent/chat/AssetCard.vue'
import FileContextDetails from '@/features/agent/workbench/FileContextDetails.vue'

const api = vi.hoisted(() => ({ contextKey: vi.fn(), get: vi.fn(), imageDescription: vi.fn(), requestPlan: vi.fn(), read: vi.fn() }))
vi.mock('@/application/files/public', () => ({ fileApi: api }))
vi.mock('@/features/agent/composer/fileReferenceTarget', async () => {
  const { ref } = await import('vue')
  return { FILE_REFERENCE_TARGET: Symbol('test-target'), useFileReferenceTargets: () => ref([]) }
})
const identity = ref('identity')
const wrappers: VueWrapper[] = []
const global = { stubs: { 'el-tooltip': { template: '<span><slot /></span>' }, 'el-dialog': true } }
function policy(draft = reactive({}) as ConfigDto) {
  const wrapper = mount(FilesPolicyCard, { props: { draft, no: 1 }, global })
  wrappers.push(wrapper)
  return { wrapper, draft }
}
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const part = { type: 'asset' as const, partId: 'part', assetId: 'asset', assetVersionId: 'version', variant: 'original' as const, usage: 'content' as const, mimeType: 'image/png', originalName: '图片' }
const description = { text: '已有观察文字', keywords: ['桥'], source: 'observation', scope: '仅桥的位置', createdAt: 1 }
beforeEach(() => {
  vi.clearAllMocks()
  identity.value = 'identity'
  api.contextKey.mockImplementation(() => identity.value)
  api.get.mockResolvedValue({ assets: [{ id: 'asset', versionId: 'version', mimeType: 'image/png', originalName: '图片', sizeBytes: 10 }] })
  api.imageDescription.mockResolvedValue({ descriptions: [{ assetId: 'asset', assetVersionId: 'version', description }] })
  api.requestPlan.mockResolvedValue({ status: 'not_prepared', plan: [] })
})
afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()) })

describe('图片上下文设置', () => {
  it('单图字节上限明确标示十进制 MB，输入校验只修改同一草稿', async () => {
    const { wrapper, draft } = policy()
    const limit = wrapper.find('input[id$="imageAdaptation.maxBytes"]')
    expect((limit.element as HTMLInputElement).value).toBe('5000000')
    expect(wrapper.text()).toContain('5 MB = 5,000,000')
    await limit.setValue('2500000')
    expect(draft.files?.imageAdaptation?.maxBytes).toBe(2500000)
    await limit.setValue('0')
    expect(limit.attributes('aria-invalid')).toBe('true')
  })
  it('显示真实默认值，清空使用默认且不写成零，非法数字关联字段错误', async () => {
    const { wrapper, draft } = policy()
    const turns = wrapper.find('input[id$="imageContext.recentUserTurns"]')
    expect((turns.element as HTMLInputElement).value).toBe('1')
    expect(wrapper.text()).toContain('默认')
    await turns.setValue('5')
    expect(draft.files?.imageContext?.recentUserTurns).toBe(5)
    await turns.setValue('')
    expect(draft.files?.imageContext?.recentUserTurns).toBeUndefined()
    expect((turns.element as HTMLInputElement).value).toBe('1')
    await turns.setValue('1.5')
    expect(turns.attributes('aria-invalid')).toBe('true')
    expect(wrapper.find(`[id="${turns.attributes('aria-describedby')}"]`).text()).toContain('整数')
    await turns.setValue('不是数字')
    expect(turns.attributes('aria-invalid')).toBe('true')
    expect((turns.element as HTMLInputElement).value).toBe('不是数字')
    expect(api.imageDescription).not.toHaveBeenCalled()
  })

  it('按模式显示轮数，只列启用图片理解的服务并直接说明费用', async () => {
    const draft = reactive({ file_services: {
      inspect: { name: '识图', enabled: true, operations: ['image.inspect'] },
      disabled: { name: '停用', enabled: false, operations: ['image.inspect'] },
      generate: { name: '生成', enabled: true, operations: ['image.generate'] },
    } }) as unknown as ConfigDto
    const { wrapper } = policy(draft)
    await wrapper.findAll('select')[0]!.setValue('current')
    expect(wrapper.find('input[id$="imageContext.recentUserTurns"]').exists()).toBe(false)
    expect(draft.files?.context?.recentUserTurns).toBeUndefined()
    await wrapper.findAll('select')[2]!.setValue('inspect')
    const service = wrapper.findAll('select')[3]!
    expect(service.text()).toContain('识图')
    expect(service.text()).not.toContain('停用')
    expect(service.text()).not.toContain('生成')
    expect(wrapper.text()).toContain('费用以服务方为准')
    expect(service.attributes('aria-invalid')).toBe('true')
    await service.setValue('inspect')
    expect(draft.files?.imageContext?.serviceId).toBe('inspect')
    expect(service.attributes('aria-invalid')).toBe('false')
  })
})

describe('历史图片说明', () => {
  it('仅展开时查询已有文字，按固定版本和会话查询，不读取图片', async () => {
    const wrapper = mount(AssetCard, { props: { part, chatId: 'chat' }, global }); wrappers.push(wrapper)
    await flushPromises()
    expect(api.imageDescription).not.toHaveBeenCalled()
    const details = wrapper.find('details')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(api.imageDescription).toHaveBeenCalledWith([{ assetId: 'asset', assetVersionId: 'version' }], 'chat')
    expect(wrapper.text()).toContain('已有观察文字')
    expect(wrapper.text()).toContain('已有图片理解记录')
    expect(api.read).not.toHaveBeenCalled()
  })

  it('身份切换清除说明且丢弃迟到错误，不查询没有会话的资产', async () => {
    const late = pending<unknown>()
    api.imageDescription.mockReturnValueOnce(late.promise)
    const wrapper = mount(AssetCard, { props: { part, chatId: 'chat' }, global }); wrappers.push(wrapper)
    await flushPromises()
    const details = wrapper.find('details')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    identity.value = 'another'
    late.reject(new Error('旧身份错误'))
    await flushPromises()
    expect(wrapper.text()).not.toContain('旧身份错误')
    expect((wrapper.find('details').element as HTMLDetailsElement).open).toBe(false)
    await wrapper.setProps({ chatId: undefined })
    const withoutChat = wrapper.find('details')
    ;(withoutChat.element as HTMLDetailsElement).open = true
    await withoutChat.trigger('toggle')
    await flushPromises()
    expect(api.imageDescription).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('需要在所属会话中查询')
  })
})

describe('最近文件请求详情', () => {
  it('区分发送阶段和文字替换，不把准备当成已理解', async () => {
    api.requestPlan.mockResolvedValueOnce({ requestId: 'request', phase: 'prepared', updatedAt: 1, policy: { mode: 'recent', recentUserTurns: 3 }, plan: [
      { ...part, messageId: 'message', action: 'describe', reason: '已超过保留轮数', binaryBytes: 0, extractedChars: 6, description },
    ] })
    const wrapper = mount(FileContextDetails, { props: { chatId: 'chat' } }); wrappers.push(wrapper)
    await flushPromises()
    expect(wrapper.text()).toContain('发送阶段：已准备')
    expect(wrapper.text()).toContain('仅携带文字说明')
    expect(wrapper.text()).toContain('不能证明模型已理解')
    expect(wrapper.text()).toContain('仅桥的位置')
    expect(wrapper.findAll('select')).toHaveLength(0)
  })

  it('切换身份或空会话立即清除旧内容并拒绝旧响应', async () => {
    const late = pending<unknown>()
    api.requestPlan.mockReturnValueOnce(late.promise)
    const wrapper = mount(FileContextDetails, { props: { chatId: 'chat' } }); wrappers.push(wrapper)
    identity.value = 'another'
    await nextTick()
    late.reject(new Error('旧身份错误'))
    await flushPromises()
    expect(api.requestPlan).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).not.toContain('旧身份错误')
    await wrapper.setProps({ chatId: '' })
    expect(wrapper.text()).not.toContain('此会话还没有准备过文件请求')
    expect(wrapper.attributes('aria-busy')).toBe('false')
  })
})
