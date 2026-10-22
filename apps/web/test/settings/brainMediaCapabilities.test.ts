// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h, nextTick, reactive } from 'vue'
import {
  ElButton,
  ElCheckbox,
  ElCheckboxGroup,
  ElInputNumber,
  ElOption,
  ElSelect,
} from 'element-plus'
import type { BrainCapabilitiesDto } from '@/application/backend/public'
import BrainMediaCapabilities from '@/features/agent/settings/tabs/brain/BrainMediaCapabilities.vue'
import BrainImageInputSettings from '@/features/agent/settings/tabs/brain/BrainImageInputSettings.vue'
import BrainImageOutputSettings from '@/features/agent/settings/tabs/brain/BrainImageOutputSettings.vue'
import MediaCapabilityGrid from '@/features/agent/settings/tabs/config/MediaCapabilityGrid.vue'

const wrappers: VueWrapper[] = []
function open(capabilities?: BrainCapabilitiesDto) {
  const draft = reactive<{ capabilities?: BrainCapabilitiesDto }>({ capabilities })
  const wrapper = mount(
    () =>
      h(BrainMediaCapabilities, {
        modelValue: draft.capabilities,
        'onUpdate:modelValue': (value) => {
          draft.capabilities = value
        },
      }),
    {
      attachTo: document.body,
      global: {
        components: {
          ElButton,
          ElCheckbox,
          ElCheckboxGroup,
          ElInputNumber,
          ElOption,
          ElSelect,
        },
        stubs: {
          ElTooltip: { name: 'ElTooltip', props: ['placement'], template: '<span><slot /></span>' },
        },
      },
    },
  )
  wrappers.push(wrapper)
  return { draft, wrapper }
}
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

function tab(wrapper: VueWrapper, name: string) {
  return wrapper
    .findAll('[role="tab"]')
    .find((item) => item.find(`[role="img"][aria-label="${name}"]`).exists())!
}

function tabNames(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('[role="tab"]')
    .map((item) => item.find('[role="img"]').attributes('aria-label')!)
}

describe('大脑能力图标 Tab（离线组件交互，非真实界面验收）', () => {
  it('八个入口，未选择时不显示 Tab，查看不创建任何能力字段', async () => {
    const { draft, wrapper } = open()
    await nextTick()
    expect(wrapper.findAll('button[aria-pressed]')).toHaveLength(8)
    expect(wrapper.text()).toContain('理解输入')
    expect(wrapper.text()).toContain('原生输出')
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false)
    expect(draft.capabilities).toBeUndefined()
  })

  it('理解输入和原生输出的八个开关提示均指定在图标上方', () => {
    const { wrapper } = open()
    const tooltips = wrapper.getComponent(MediaCapabilityGrid).findAllComponents({ name: 'ElTooltip' })
    expect(tooltips).toHaveLength(8)
    for (const tooltip of tooltips) expect(tooltip.props('placement')).toBe('top')
  })

  it('选择八项各出现对应的双图标 Tab，未实现面板为空，不制造文件输出字段', async () => {
    const { draft, wrapper } = open()
    const names = [
      '图片输入',
      '视频输入',
      '音频输入',
      '文件输入（PDF）',
      '图片输出',
      '视频输出',
      '音频输出',
      '文件输出（未实现，仅空白页，不保存）',
    ]
    for (const [index, name] of names.entries()) {
      const previous = wrapper.find('[role="tab"][aria-selected="true"]')
      const previousId = previous.exists() ? previous.attributes('data-tab-id') : undefined
      await wrapper.get(`button[aria-label="${name}"]`).trigger('click')
      expect(wrapper.findAll('[role="tab"]')).toHaveLength(index + 1)
      const label = name.startsWith('文件')
        ? (name.startsWith('文件输入') ? '文件输入' : '文件输出')
        : name
      if (previousId) {
        expect(wrapper.get('[role="tab"][aria-selected="true"]').attributes('data-tab-id')).toBe(previousId)
      }
      await tab(wrapper, label).trigger('click')
      const selected = wrapper.get('[role="tab"][aria-selected="true"]')
      expect(selected.text()).toBe('')
      expect(selected.findAll('svg')).toHaveLength(2)
      expect(selected.find('[role="img"]').attributes('aria-label')).toBe(label)
      if (name !== '图片输入' && name !== '图片输出') {
        expect(wrapper.findComponent(BrainImageInputSettings).exists()).toBe(false)
        expect(wrapper.findComponent(BrainImageOutputSettings).exists()).toBe(false)
        expect(wrapper.findAll('input')).toHaveLength(0)
        const panelId = selected.attributes('aria-controls')
        expect(wrapper.get(`[id="${panelId}"]`).text()).toBe('')
      }
    }
    expect(draft.capabilities).toEqual({
      input: { image: 'supported', video: 'supported', audio: 'supported', pdf: 'supported' },
      output: { image: 'supported', video: 'supported', audio: 'supported' },
    })
    for (const button of wrapper.findAll('button[aria-pressed]')) {
      await button.trigger('click')
    }
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false)
    expect(draft.capabilities?.output).not.toHaveProperty('file')
    expect(draft.capabilities?.output).not.toHaveProperty('pdf')
  })

  it('勾选或取消其他能力不切换当前 Tab，包含页面临时文件输出', async () => {
    const { wrapper } = open({ input: { image: true }, output: { image: true } })
    await tab(wrapper, '图片输出').trigger('click')
    const names = [
      '视频输入',
      '音频输入',
      '文件输入（PDF）',
      '视频输出',
      '音频输出',
      '文件输出（未实现，仅空白页，不保存）',
    ]
    for (const name of names) {
      const button = wrapper.get(`button[aria-label="${name}"]`)
      for (const selected of ['true', 'false']) {
        await button.trigger('click')
        expect(button.attributes('aria-pressed')).toBe(selected)
        expect(tab(wrapper, '图片输出').attributes('aria-selected')).toBe('true')
        expect(wrapper.findAll('[role="tab"][aria-selected="true"]')).toHaveLength(1)
        expect(wrapper.findComponent(BrainImageOutputSettings).exists()).toBe(true)
        expect(wrapper.findComponent(BrainImageInputSettings).exists()).toBe(false)
      }
    }
  })

  it('Tab 固定按八个入口的显示顺序排列，不按勾选先后追加', async () => {
    const { wrapper } = open()
    const click = (name: string) => wrapper.get(`button[aria-label="${name}"]`).trigger('click')
    await click('文件输出（未实现，仅空白页，不保存）')
    await click('音频输出')
    await click('视频输入')
    await click('图片输出')
    await click('文件输入（PDF）')
    await click('音频输入')
    await click('图片输入')
    await click('视频输出')
    expect(tabNames(wrapper)).toEqual([
      '图片输入',
      '视频输入',
      '音频输入',
      '文件输入',
      '图片输出',
      '视频输出',
      '音频输出',
      '文件输出',
    ])
  })

  it('切换仅挂载当前面板，关闭再开启图片输入保留格式、大小与其他字段', async () => {
    const { draft, wrapper } = open({
      input: { image: true, audio: 'unknown' },
      output: { image: 'supported' },
      imageInput: { formats: [], animation: 'first-frame', maxBytes: 4096 },
      imageOutput: { 'image.edit': { countControl: 'unknown' } },
      toolCall: false,
    })
    const before = JSON.stringify(draft.capabilities)
    await nextTick()
    expect(wrapper.findComponent(BrainImageInputSettings).exists()).toBe(true)
    expect(wrapper.findComponent(BrainImageOutputSettings).exists()).toBe(false)
    await tab(wrapper, '图片输出').trigger('click')
    expect(wrapper.findComponent(BrainImageInputSettings).exists()).toBe(false)
    expect(wrapper.findComponent(BrainImageOutputSettings).exists()).toBe(true)
    expect(JSON.stringify(draft.capabilities)).toBe(before)
    await wrapper.get('button[aria-label="图片输入"]').trigger('click')
    expect(draft.capabilities?.input?.image).toBe('unsupported')
    expect(draft.capabilities?.imageInput?.formats).toEqual([])
    await wrapper.get('button[aria-label="图片输入"]').trigger('click')
    expect(tab(wrapper, '图片输出').attributes('aria-selected')).toBe('true')
    expect(tab(wrapper, '图片输入').attributes('aria-selected')).toBe('false')
    await tab(wrapper, '图片输入').trigger('click')
    expect(tab(wrapper, '图片输入').attributes('aria-selected')).toBe('true')
    expect(draft.capabilities?.imageInput).toEqual({
      formats: [],
      animation: 'first-frame',
      maxBytes: 4096,
    })
    expect(draft.capabilities?.imageOutput).toEqual({ 'image.edit': { countControl: 'unknown' } })
    expect(draft.capabilities?.input?.audio).toBe('unknown')
    expect(draft.capabilities?.toolCall).toBe(false)
  })

  it('删除当前项后选相邻 Tab，全取消后隐藏面板，细项不丢失', async () => {
    const { draft, wrapper } = open({
      input: { image: 'supported', video: 'supported', audio: 'supported' },
      imageInput: { maxBytes: 1024 },
    })
    await tab(wrapper, '视频输入').trigger('click')
    await wrapper.get('button[aria-label="视频输入"]').trigger('click')
    expect(tab(wrapper, '音频输入').attributes('aria-selected')).toBe('true')
    await wrapper.get('button[aria-label="音频输入"]').trigger('click')
    expect(tab(wrapper, '图片输入').attributes('aria-selected')).toBe('true')
    await wrapper.get('button[aria-label="图片输入"]').trigger('click')
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false)
    expect(wrapper.find('[role="tabpanel"]').exists()).toBe(false)
    expect(draft.capabilities?.imageInput).toEqual({ maxBytes: 1024 })
    await wrapper.get('button[aria-label="视频输入"]').trigger('click')
    expect(tab(wrapper, '视频输入').attributes('aria-selected')).toBe('true')
    expect(wrapper.findAll('[role="tabpanel"]')).toHaveLength(1)
  })

  it('图片细项修改只进入受控草稿，图片输出恢复不遗留空覆盖', async () => {
    const { draft, wrapper } = open({
      input: { image: 'supported', pdf: 'unknown' },
      output: { image: true },
      imageOutput: { 'image.generate': { countControl: 'unknown' } },
    })
    wrapper.findComponent(BrainImageInputSettings).vm.$emit('update:modelValue', {
      ...draft.capabilities,
      imageInput: { maxBytes: 1234 },
    })
    await nextTick()
    await tab(wrapper, '图片输出').trigger('click')
    wrapper.findComponent(BrainImageOutputSettings).vm.$emit('update:modelValue', undefined)
    await nextTick()
    expect(draft.capabilities).toEqual({
      input: { image: 'supported', pdf: 'unknown' },
      output: { image: true },
      imageInput: { maxBytes: 1234 },
    })
  })

  it('已有布尔与支持状态决定 Tab，未知和未设置不自动改写', async () => {
    const caps: BrainCapabilitiesDto = {
      input: { image: true, video: false, audio: 'unknown', pdf: 'unsupported' },
      output: { audio: 'supported', video: 'unknown' },
    }
    const before = JSON.stringify(caps)
    const { draft, wrapper } = open(caps)
    await nextTick()
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(2)
    expect(tab(wrapper, '图片输入').exists()).toBe(true)
    expect(tab(wrapper, '音频输出').exists()).toBe(true)
    expect(JSON.stringify(draft.capabilities)).toBe(before)
  })

  it('内置 Tab 支持方向键切换，图标保留可读名称', async () => {
    const { wrapper } = open({ input: { image: true }, output: { image: true } })
    await nextTick()
    const input = tab(wrapper, '图片输入')
    ;(input.element as HTMLElement).focus()
    await input.trigger('keydown', { code: 'ArrowRight', key: 'ArrowRight' })
    expect(tab(wrapper, '图片输出').attributes('aria-selected')).toBe('true')
    expect(wrapper.findComponent(BrainImageOutputSettings).exists()).toBe(true)
  })
})
