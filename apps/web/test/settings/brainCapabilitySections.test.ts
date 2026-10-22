// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { h, nextTick, reactive } from 'vue'
import {
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElInput,
  ElInputNumber,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTabs,
  ElTabPane,
} from 'element-plus'
import type {
  BrainCapabilitiesDto,
  BrainConfigDto,
  ConfigDto,
  ModelRecommendationDto,
} from '@/application/backend/public'
import type { ImageOutputCapabilities } from '@chery/protocol'
import BrainCard from '@/features/agent/settings/tabs/brain/BrainCard.vue'
import BrainImageInputSettings from '@/features/agent/settings/tabs/brain/BrainImageInputSettings.vue'
import BrainImageOutputSettings from '@/features/agent/settings/tabs/brain/BrainImageOutputSettings.vue'
import BrainServerTools from '@/features/agent/settings/tabs/brain/BrainServerTools.vue'
import LegacyImageOutputSettings from '@/features/agent/settings/tabs/tools/ImageOutputSettings.vue'
import {
  imageOutputDraftErrors,
  updateImageOutputDraft,
} from '@/features/agent/settings/model/imageOutputDraft'

const api = vi.hoisted(() => ({
  contextKey: () => 'brain-section-test',
  getModelRecommendation: vi.fn(),
  testConnection: vi.fn(),
  saveConfig: vi.fn(),
}))
vi.mock('@/application/backend/public', () => ({ agentApi: api }))

const global = {
  components: {
    ElButton,
    ElCheckbox,
    ElCheckboxGroup,
    ElInput,
    ElInputNumber,
    ElOption,
    ElSelect,
    ElSwitch,
    ElTabs,
    ElTabPane,
  },
  stubs: {
    ElTooltip: { template: '<span><slot /></span>' },
    ConfirmPopover: { template: '<span><slot name="trigger" /></span>' },
    EditableTitle: { template: '<span><slot /><slot name="actions" /></span>' },
    ThinkingLevelKnob: true,
  },
}
const wrappers: VueWrapper[] = []
function track<T extends VueWrapper>(wrapper: T): T {
  wrappers.push(wrapper)
  return wrapper
}
function result(): ModelRecommendationDto {
  const field = { state: 'unknown', source: 'default' } as const
  return {
    matched: false,
    confidence: 'unknown',
    thinkingLevels: [],
    unknown: {},
    serviceCapabilities: {
      nativeInput: { image: field, audio: field, video: field, pdf: field },
      serverTools: { webSearch: field, webReader: field, imageInspect: field },
      connectionIdentified: true,
      verification: { status: 'not-verified' },
      catalogComplete: false,
      observationsTruncated: false,
      knownTools: [],
    },
  }
}
function inputPanel(capabilities?: BrainCapabilitiesDto) {
  const draft = reactive<{ capabilities?: BrainCapabilitiesDto }>({ capabilities })
  const wrapper = track(
    mount(
      () =>
        h(BrainImageInputSettings, {
          modelValue: draft.capabilities,
          'onUpdate:modelValue': (value) => {
            draft.capabilities = value
          },
        }),
      { global },
    ),
  )
  return { draft, wrapper }
}
function outputPanel(capabilities?: ImageOutputCapabilities) {
  const draft = reactive<{ imageOutput?: ImageOutputCapabilities }>({ imageOutput: capabilities })
  const wrapper = track(
    mount(
      () =>
        h(BrainImageOutputSettings, {
          modelValue: draft.imageOutput,
          operations: ['image.generate', 'image.reference', 'image.edit'],
          'onUpdate:modelValue': (value) => {
            draft.imageOutput = value
          },
        }),
      { global },
    ),
  )
  return { draft, wrapper }
}
beforeEach(() => {
  vi.resetAllMocks()
  api.getModelRecommendation.mockResolvedValue(result())
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('大脑详情字段组件（离线交互检查，不是浏览器或视觉验收）', () => {
  it.each([250_000, 512_000])(
    '标题推荐按钮仅将上下文草稿改为目录值 %i，不自动保存',
    async (contextLimit) => {
      api.getModelRecommendation.mockResolvedValue({
        ...result(),
        recommend: { contextLimit },
      })
      const cfg = reactive<BrainConfigDto>({
        provider: 'newapi',
        protocol: 'openai-chat-completions',
        model: 'test-model',
        contextLimit: 128_000,
      })
      const draft = { llm: { brain: { test: cfg } }, roles: {} } as unknown as ConfigDto
      const wrapper = track(
        mount(BrainCard, {
          props: { name: 'test', idx: 0, cfg, draft, envVars: [], detailMode: true },
          global,
        }),
      )
      await flushPromises()
      expect(cfg.contextLimit).toBe(128_000)
      const button = wrapper.get('.context-recommendation-btn')
      expect(button.text()).toBe('（推荐）')
      expect(button.attributes('aria-label')).toBe(`采用推荐上下文上限 ${contextLimit / 1000}K`)
      expect(button.element.parentElement?.getAttribute('content')).toBe(
        `点击填入推荐值 ${contextLimit / 1000}K`,
      )
      expect(button.element.closest('.lbl')).not.toBeNull()
      expect(button.element.parentElement?.nextElementSibling?.querySelector('.info-ico')).not.toBeNull()
      expect(wrapper.text()).not.toContain('采用推荐值')
      await button.trigger('click')
      expect(cfg.contextLimit).toBe(contextLimit)
      expect(
        wrapper
          .findAllComponents(ElSelect)
          .some((select) => select.props('modelValue') === contextLimit / 1000),
      ).toBe(true)
      expect(api.saveConfig).not.toHaveBeenCalled()
      expect(api.testConnection).not.toHaveBeenCalled()
    },
  )

  it('大脑详情按所选 Tab 挂载图片设置，工具独立且不会自动读取或保存', async () => {
    const cfg = reactive<BrainConfigDto>({
      provider: 'newapi',
      protocol: 'openai-chat-completions',
      model: 'test-model',
      url: 'https://synthetic.invalid/v1',
      key: '$TEST',
    })
    const draft = {
      llm: { brain: { test: cfg } },
      roles: {},
      file_services: {},
    } as unknown as ConfigDto
    const wrapper = track(
      mount(BrainCard, {
        props: { name: 'test', idx: 0, cfg, draft, envVars: ['TEST'], detailMode: true },
        global,
      }),
    )
    await flushPromises()
    expect(wrapper.find('.context-recommendation-btn').exists()).toBe(false)
    expect(wrapper.findComponent(BrainServerTools).exists()).toBe(true)
    expect(wrapper.findComponent(BrainImageInputSettings).exists()).toBe(false)
    expect(wrapper.findComponent(BrainImageOutputSettings).exists()).toBe(false)
    expect(wrapper.findAll('details')).toHaveLength(0)
    expect(cfg.capabilities).toBeUndefined()
    await wrapper.get('button[aria-label="图片输入"]').trigger('click')
    expect(cfg.capabilities?.input?.image).toBe('supported')
    expect(wrapper.findComponent(BrainImageInputSettings).exists()).toBe(true)
    await wrapper.get('button[aria-label="图片输出"]').trigger('click')
    expect(cfg.capabilities?.output?.image).toBe('supported')
    expect(wrapper.findComponent(BrainImageInputSettings).exists()).toBe(true)
    expect(wrapper.findComponent(BrainImageOutputSettings).exists()).toBe(false)
    expect(wrapper.get('[role="tab"][data-tab-id="input-image"]').attributes('aria-selected')).toBe('true')
    const beforeTabClick = JSON.stringify(cfg.capabilities)
    await wrapper.get('[role="tab"][data-tab-id="output-image"]').trigger('click')
    expect(JSON.stringify(cfg.capabilities)).toBe(beforeTabClick)
    expect(wrapper.findComponent(BrainImageInputSettings).exists()).toBe(false)
    expect(wrapper.findComponent(BrainImageOutputSettings).exists()).toBe(true)
    expect(wrapper.findAll('.capability-group')).toHaveLength(3)
    expect(api.getModelRecommendation.mock.calls.every((call) => call[3] === undefined)).toBe(true)
    expect(api.testConnection).not.toHaveBeenCalled()
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('仅查看图片字段不生成手动覆盖或把继承改为未知', async () => {
    const { draft, wrapper } = inputPanel()
    await flushPromises()
    expect(draft.capabilities).toBeUndefined()
    expect(wrapper.findAllComponents(ElSelect).map((select) => select.props('modelValue'))).toEqual(
      [''],
    )
    const output = outputPanel()
    await flushPromises()
    expect(output.draft.imageOutput).toBeUndefined()
    expect(
      output.wrapper.findAllComponents(ElButton).every((button) => button.props('disabled')),
    ).toBe(true)
  })

  it('图片细项不重复提供能力开关，编辑动画不删除其他能力', async () => {
    const { draft, wrapper } = inputPanel({
      input: { image: true, audio: 'supported' },
      output: { image: false },
      toolCall: false,
    })
    expect(wrapper.text()).not.toContain('原生图片能力')
    wrapper.findComponent(ElSelect).vm.$emit('update:modelValue', 'first-frame')
    await nextTick()
    expect(draft.capabilities?.input).toEqual({ image: true, audio: 'supported' })
    expect(draft.capabilities?.imageInput).toEqual({ animation: 'first-frame' })
    expect(draft.capabilities?.toolCall).toBe(false)
    expect(draft.capabilities?.output).toEqual({ image: false })
  })

  it('格式覆盖区分继承、显式空列表和选中格式，动画独立保留', async () => {
    const { draft, wrapper } = inputPanel({
      imageInput: { animation: 'first-frame', maxBytes: 1234 },
    })
    const toggle = wrapper.findComponent(ElCheckbox)
    toggle.vm.$emit('update:modelValue', true)
    await nextTick()
    expect(draft.capabilities?.imageInput?.formats).toEqual([])
    wrapper.findComponent(ElCheckboxGroup).vm.$emit('update:modelValue', ['image/png', 'image/gif'])
    await nextTick()
    expect(draft.capabilities?.imageInput?.formats).toEqual(['image/png', 'image/gif'])
    toggle.vm.$emit('update:modelValue', false)
    await nextTick()
    expect(draft.capabilities?.imageInput).toEqual({ animation: 'first-frame', maxBytes: 1234 })
    const animation = wrapper.findComponent(ElSelect)
    animation.vm.$emit('update:modelValue', 'supported')
    await nextTick()
    expect(draft.capabilities?.imageInput?.animation).toBe('supported')
    animation.vm.$emit('update:modelValue', '')
    await nextTick()
    expect(draft.capabilities?.imageInput).toEqual({ maxBytes: 1234 })
  })

  it('两项字节上限可编辑和清空，清空确实删除字段而不是写入 0', async () => {
    const { draft, wrapper } = inputPanel({
      imageInput: { formats: ['image/webp'], maxBytes: 1234, maxBase64Bytes: 5678 },
    })
    const numbers = wrapper.findAllComponents(ElInputNumber)
    await numbers[0]!.find('input').setValue('4096')
    await numbers[0]!.find('input').trigger('change')
    expect(draft.capabilities?.imageInput?.maxBytes).toBe(4096)
    for (const number of numbers) {
      await number.find('input').setValue('')
      await number.find('input').trigger('change')
    }
    expect(draft.capabilities?.imageInput).toEqual({ formats: ['image/webp'] })
  })

  it('三种图片操作分别编辑，错误就近显示，恢复只清除当前组', async () => {
    const { draft, wrapper } = outputPanel({
      'image.edit': {
        nativeMultiImage: 'unsupported',
        countControl: 'uncontrolled',
        maxImagesPerRequest: 1,
      },
    })
    const selects = wrapper.findAllComponents(ElSelect)
    selects[0]!.vm.$emit('update:modelValue', 'supported')
    await nextTick()
    expect(wrapper.find('[role="alert"]').text()).toContain('支持原生多图时请填写至少为 2 的上限')
    const number = wrapper.findComponent(ElInputNumber)
    await number.find('input').setValue('4')
    await number.find('input').trigger('change')
    selects[1]!.vm.$emit('update:modelValue', 'maximum')
    await nextTick()
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(0)
    expect(draft.imageOutput?.['image.generate']).toEqual({
      nativeMultiImage: 'supported',
      countControl: 'maximum',
      maxImagesPerRequest: 4,
    })
    expect(draft.imageOutput?.['image.edit']?.maxImagesPerRequest).toBe(1)
    await number.find('input').setValue('')
    await number.find('input').trigger('change')
    expect(draft.imageOutput?.['image.generate']?.maxImagesPerRequest).toBeUndefined()
    expect(wrapper.find('[role="alert"]').text()).toContain('上限')
    await wrapper.findAllComponents(ElButton)[0]!.trigger('click')
    expect(draft.imageOutput).toEqual({
      'image.edit': {
        nativeMultiImage: 'unsupported',
        countControl: 'uncontrolled',
        maxImagesPerRequest: 1,
      },
    })
    await wrapper.findAllComponents(ElButton)[2]!.trigger('click')
    expect(draft.imageOutput).toBeUndefined()
  })

  it('切换大脑只替换受控字段，不把上一项的图片限制写进新项', async () => {
    const { draft, wrapper } = inputPanel({ imageInput: { maxBytes: 1000 } })
    draft.capabilities = {
      imageInput: { formats: [], maxBase64Bytes: 2000 },
      input: { image: false },
    }
    await nextTick()
    expect(wrapper.findComponent(ElSelect).props('modelValue')).toBe('')
    const numbers = wrapper.findAllComponents(ElInputNumber)
    expect(numbers.map((number) => number.props('modelValue'))).toEqual([undefined, 2000])
    numbers[0]!.vm.$emit('update:modelValue', 3000)
    await nextTick()
    expect(draft.capabilities.imageInput).toEqual({
      formats: [],
      maxBytes: 3000,
      maxBase64Bytes: 2000,
    })
  })

  it('工具记录仅点击刷新才读取，错误可重试，记录完成不表示能力验证成功', async () => {
    api.getModelRecommendation.mockRejectedValueOnce(new Error('offline'))
    const cfg: BrainConfigDto = {
      provider: 'newapi',
      model: 'model',
      url: 'https://synthetic.invalid/v1',
    }
    const wrapper = track(
      mount(BrainServerTools, { props: { cfg, protocol: 'openai-chat-completions' }, global }),
    )
    await flushPromises()
    expect(api.getModelRecommendation).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('点击刷新')
    await wrapper.findComponent(ElButton).trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toContain('读取失败')
    const response = result()
    response.serviceCapabilities!.knownTools = [
      {
        name: 'search',
        sources: ['catalog'],
        description: '搜索记录',
        observation: { status: 'completed', observedAt: 1, count: 1 },
      },
    ]
    api.getModelRecommendation.mockResolvedValueOnce(response)
    await wrapper.findComponent(ElButton).trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('当前配置尚未验证')
    expect(wrapper.text()).toContain('调用已结束')
    expect(wrapper.text()).toContain('完整列表未知')
    expect(wrapper.text()).not.toContain('能力验证成功')
    expect(api.testConnection).not.toHaveBeenCalled()
    expect(api.saveConfig).not.toHaveBeenCalled()
  })

  it('文件服务原有折叠展示保持，共用相同的草稿更新和校验规则', async () => {
    const input: ImageOutputCapabilities = {
      'image.edit': { nativeMultiImage: 'unsupported', countControl: 'unknown' },
    }
    const before = JSON.stringify(input)
    const next = updateImageOutputDraft(input, 'image.generate', { nativeMultiImage: 'supported' })
    expect(JSON.stringify(input)).toBe(before)
    expect(imageOutputDraftErrors(next, 'image.generate')).toContain('上限')
    expect(updateImageOutputDraft(next, 'image.generate')).toEqual(input)
    expect(updateImageOutputDraft(input, 'audio.transcribe', {})).toBe(input)
    const wrapper = track(
      mount(LegacyImageOutputSettings, {
        props: { modelValue: input, operations: ['image.edit'] },
      }),
    )
    expect(wrapper.find('details').exists()).toBe(true)
    expect(wrapper.find('summary').text()).toBe('图片模型的原生张数限制')
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[undefined]])
  })
})
