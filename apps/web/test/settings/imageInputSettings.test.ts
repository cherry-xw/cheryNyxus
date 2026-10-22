// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import FilesSettings from '../../../../plugins/settings/ui/FilesSettings.vue'
import ImageInputSettings from '../../../../packages/manager-ui/src/ImageInputSettings.vue'
import FilesPolicyCard from '../../src/features/agent/settings/tabs/config/cards/FilesPolicyCard.vue'
const mock = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../../../packages/manager-ui/src/api', () => ({ managerRequest: mock.request }))
describe('Manager 图片设置组件（离线接口，不是浏览器验收）', () => {
  it('读取、输入、保存、回读共用文件策略，带 revision，不丢其他策略', async () => {
    let saved = { policy: { context: { recentUserTurns: 3 }, imageAdaptation: { maxBytes: 5000000, quality: 91 } }, baseRevision: 'one' }
    mock.request.mockImplementation(async (_url, options) => {
      if (options?.method === 'PUT') { const body = JSON.parse(options.body); expect(body.expectedBaseRevision).toBe('one'); expect(body.policy.context.recentUserTurns).toBe(3); saved = { policy: body.policy, baseRevision: 'two' } }
      return { data: structuredClone(saved) }
    })
    const wrapper = mount(FilesSettings)
    await flushPromises()
    expect(wrapper.text()).toContain('5,000,000')
    expect(wrapper.text()).toContain('编码质量上限')
    expect(wrapper.text()).toContain('PNG 无有损 quality 参数')
    expect(wrapper.findAll('input')[2]!.element.value).toBe('91')
    await wrapper.findAll('input')[0]!.setValue('1234567')
    await wrapper.findAll('input')[2]!.setValue('73')
    await wrapper.findAll('button').find(b => b.text() === '保存图片设置')!.trigger('click')
    await flushPromises()
    expect(saved.policy.imageAdaptation.maxBytes).toBe(1234567)
    expect(saved.policy.imageAdaptation.quality).toBe(73)
    expect(wrapper.findAll('input')[2]!.element.value).toBe('73')
    expect(wrapper.text()).toContain('已保存并回读')
    wrapper.unmount()
  })
  it('Web 使用已有质量字段回显并编辑统一保存草稿，不创建重复配置', async () => {
    const draft = reactive<any>({ files: { imageAdaptation: { quality: 91 } } })
    const wrapper = mount(FilesPolicyCard, { props: { draft, no: 1 }, global: { stubs: { ElTooltip: { template: '<div><slot /></div>' } } } })
    expect(wrapper.text()).toContain('JPEG/WebP 编码质量上限')
    const input = wrapper.find('input[id$="imageAdaptation.quality"]')
    expect((input.element as HTMLInputElement).value).toBe('91')
    await input.setValue('73')
    expect(draft.files.imageAdaptation).toEqual({ quality: 73 })
    wrapper.unmount()
  })
  it('未知模型可以覆盖格式，透明/动画策略只写入模型草稿', async () => {
    const brain = reactive<{ capabilities?: any }>({})
    const wrapper = mount(ImageInputSettings, { props: { brain } })
    await wrapper.findAll('input')[0]!.setValue(true)
    await wrapper.findAll('input')[2]!.setValue(true)
    expect(brain.capabilities.imageInput.formats).toEqual(['image/png'])
    await wrapper.findAll('select')[1]!.setValue('unknown')
    expect(brain.capabilities.imageInput.animation).toBe('unknown')
    wrapper.unmount()
  })
  it('显式配置等于默认值时保留显式态，仅主动清空恢复默认才删除并显示默认', async () => {
    const draft = reactive<any>({ files: { imageAdaptation: { quality: 85, maxEdge: 1536 } } })
    const wrapper = mount(FilesPolicyCard, { props: { draft, no: 1 }, global: { stubs: { ElTooltip: { template: '<div><slot /></div>' } } } })
    const qualityInput = wrapper.find('input[id$="imageAdaptation.quality"]')
    const qualityField = qualityInput.element.closest('.field')!
    expect(qualityField.textContent).not.toContain('默认')
    expect((qualityInput.element as HTMLInputElement).value).toBe('85')
    expect(draft.files.imageAdaptation.quality).toBe(85)
    await qualityInput.setValue('')
    expect(draft.files.imageAdaptation).toEqual({ maxEdge: 1536 })
    expect((qualityInput.element as HTMLInputElement).value).toBe('85')
    expect(qualityField.textContent).toContain('默认')
    wrapper.unmount()
  })
  it('共享协议合并深层绘图参数、呈现单列未核实默认并统一校验保存前草稿', async () => {
    const { imageParameterDisplay, imageParameterErrors, mergeImageParameters } = await import('@chery/protocol')
    const { settingsDraftErrors } = await import('../../src/features/agent/settings/model/settingsValidation')
    expect(
      mergeImageParameters(
        { style: { style_type: '漫画', style_weight: 0.6 }, aspect_ratio: '1:1' },
        { style: { style_weight: 0.9 } },
      ),
    ).toEqual({ style: { style_type: '漫画', style_weight: 0.9 }, aspect_ratio: '1:1' })
    expect(
      imageParameterDisplay({ adapter: 'google-gemini-image', params: {} }, 'imageConfig.aspectRatio').source,
    ).toBe('unknown')
    expect(
      imageParameterDisplay(
        { adapter: 'openai-images', operations: ['image.edit'], params: {} },
        'moderation',
      ).source,
    ).toBe('unknown')
    expect(
      imageParameterDisplay({ adapter: 'doubao-seedream', model: 'doubao-seedream-3-0', params: {} }, 'seed').source,
    ).toBe('unknown')
    expect(imageParameterErrors('minimax-images', { prompt: 'p', width: 1024 }, 'image-01')).toContain(
      'width 与 height 必须同时设置',
    )
    const errors = settingsDraftErrors({
      global: { thinking: true, supervision: 'smart', stream: true },
      llm: { brain: { main: { provider: 'openai', model: 'gpt-5', key: 'sk-1' } } },
      files: {
        context: { maxExtractedCharsPerAsset: 50000, maxExtractedChars: 20000 },
        imageContext: { missingDescription: 'inspect' },
      },
    } as any)
    expect(errors.join('\n')).toContain('llm.brain.main.contextLimit')
    expect(errors.join('\n')).toContain('files.context.maxExtractedChars')
    expect(errors.join('\n')).toContain('files.imageContext.serviceId')
  })
})
