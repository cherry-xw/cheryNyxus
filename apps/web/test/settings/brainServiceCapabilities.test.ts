import { effectScope, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrainServiceCapabilities } from '@/features/agent/settings/tabs/brain/useBrainServiceCapabilities'
import type { BrainConfigDto, ModelRecommendationDto } from '@/application/backend/public'
import type { BrainServiceCapabilities } from '@chery/protocol'

const api = vi.hoisted(() => ({
  context: 'current',
  contextKey: () => api.context,
  getModelRecommendation: vi.fn(),
}))
vi.mock('@/application/backend/public', () => ({ agentApi: api }))
const scopes: ReturnType<typeof effectScope>[] = []
function result(): ModelRecommendationDto {
  const field = { state: 'unknown', source: 'default' } as const
  const value: BrainServiceCapabilities = {
    nativeInput: { image: field, audio: field, video: field, pdf: field },
    serverTools: { imageInspect: field, webReader: field, webSearch: field },
    connectionIdentified: true,
    verification: { status: 'not-verified' },
    catalogComplete: false,
    observationsTruncated: false,
    knownTools: [],
  }
  return {
    matched: false,
    confidence: 'unknown',
    thinkingLevels: [],
    unknown: {},
    serviceCapabilities: value,
  }
}
function open(overrides: Partial<BrainConfigDto> = {}) {
  const cfg = reactive<BrainConfigDto>({
    provider: 'newapi',
    protocol: 'anthropic-messages',
    model: 'co-glm-5.3',
    url: 'https://example.com/v1',
    key: '$KEY',
    ...overrides,
  })
  const scope = effectScope()
  scopes.push(scope)
  const controller = scope.run(() =>
    useBrainServiceCapabilities(
      () => cfg,
      () => cfg.protocol,
    ),
  )!
  return { cfg, scope, ...controller }
}
async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}
beforeEach(() => {
  vi.resetAllMocks()
  api.context = 'current'
  api.getModelRecommendation.mockResolvedValue(result())
})
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()))

describe('大脑服务工具只读查询', () => {
  it('进入详情不读取，只由手动刷新查询且不修改草稿', async () => {
    const panel = open()
    const before = JSON.stringify(panel.cfg)
    await settle()
    expect(panel.state.value.kind).toBe('idle')
    expect(api.getModelRecommendation).not.toHaveBeenCalled()
    await panel.refresh()
    expect(api.getModelRecommendation).toHaveBeenCalledWith(
      'co-glm-5.3',
      'newapi',
      'anthropic-messages',
      {
        url: 'https://example.com/v1',
        key: '$KEY',
        fullUrl: undefined,
        capabilities: undefined,
      },
    )
    expect(panel.state.value.kind).toBe('ready')
    expect(JSON.stringify(panel.cfg)).toBe(before)
  })

  it.each(['url', 'key', 'model', 'provider', 'protocol', 'fullUrl'] as const)(
    '改%s只清除旧结果，不自动请求',
    async (field) => {
      const panel = open()
      await panel.refresh()
      api.getModelRecommendation.mockReturnValue(new Promise(() => {}))
      Object.assign(panel.cfg, {
        [field]: field === 'fullUrl' ? true : field === 'protocol' ? 'openai-responses' : 'changed',
      })
      expect(panel.state.value.kind).toBe('idle')
      expect(api.getModelRecommendation).toHaveBeenCalledTimes(1)
    },
  )

  it('迟到的旧配置查询不覆盖新结果', async () => {
    let finish!: (value: ModelRecommendationDto) => void
    api.getModelRecommendation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const panel = open()
    const pending = panel.refresh()
    panel.cfg.key = '$NEW_KEY'
    expect(panel.state.value.kind).toBe('idle')
    await panel.refresh()
    await settle()
    const latest = panel.state.value
    finish({ ...result(), serviceCapabilities: undefined })
    await pending
    expect(panel.state.value).toEqual(latest)
  })

  it('卸载后不采用在途结果，手动刷新也不查询', async () => {
    let finish!: (value: ModelRecommendationDto) => void
    api.getModelRecommendation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const panel = open()
    const pending = panel.refresh()
    const before = panel.state.value
    panel.scope.stop()
    finish(result())
    await pending
    expect(panel.state.value).toEqual(before)
    await panel.refresh()
    expect(api.getModelRecommendation).toHaveBeenCalledTimes(1)
  })

  it('失败可见并可只读重试，旧后端没有该字段也不假装空目录成功', async () => {
    api.getModelRecommendation.mockRejectedValueOnce(new Error('offline'))
    const panel = open()
    await panel.refresh()
    expect(panel.state.value.kind).toBe('error')
    await panel.refresh()
    expect(panel.state.value.kind).toBe('ready')
    api.getModelRecommendation.mockResolvedValueOnce({
      ...result(),
      serviceCapabilities: undefined,
    })
    await panel.refresh()
    expect(panel.state.value.kind).toBe('error')
  })

  it('后端身份改变后丢弃结果，不向新后端发送旧配置', async () => {
    let finish!: (value: ModelRecommendationDto) => void
    api.getModelRecommendation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const panel = open()
    const pending = panel.refresh()
    api.context = 'another-backend'
    finish(result())
    await pending
    expect(panel.state.value.kind).toBe('error')
    await panel.refresh()
    expect(api.getModelRecommendation).toHaveBeenCalledTimes(1)
  })

  it('缺服务或模型时不查询，补齐后仍须手动刷新', async () => {
    const panel = open({ model: '' })
    expect(panel.state.value.kind).toBe('idle')
    expect(api.getModelRecommendation).not.toHaveBeenCalled()
    panel.cfg.model = 'filled'
    await settle()
    expect(panel.state.value.kind).toBe('idle')
    expect(api.getModelRecommendation).not.toHaveBeenCalled()
    await panel.refresh()
    expect(panel.state.value.kind).toBe('ready')
    panel.cfg.provider = ''
    expect(panel.state.value.kind).toBe('idle')
    expect(api.getModelRecommendation).toHaveBeenCalledTimes(1)
  })

  it('切换大脑卸载旧详情后，迟到结果不改变新大脑的记录', async () => {
    let finish!: (value: ModelRecommendationDto) => void
    api.getModelRecommendation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const previous = open()
    const pending = previous.refresh()
    previous.scope.stop()
    const current = open({ model: 'another-model', key: '$OTHER_KEY' })
    expect(current.state.value.kind).toBe('idle')
    expect(api.getModelRecommendation).toHaveBeenCalledTimes(1)
    await current.refresh()
    const before = current.state.value
    finish({ ...result(), serviceCapabilities: undefined })
    await pending
    expect(current.state.value).toEqual(before)
    expect(current.state.value.kind).toBe('ready')
    expect(api.getModelRecommendation).toHaveBeenLastCalledWith(
      'another-model',
      'newapi',
      'anthropic-messages',
      expect.objectContaining({ key: '$OTHER_KEY' }),
    )
  })

  it('普通媒体能力编辑不清空工具列表也不重新请求', async () => {
    const panel = open()
    await panel.refresh()
    const previous = panel.state.value
    panel.cfg.capabilities = {
      input: { image: 'supported' },
      imageInput: { maxBytes: 1024 },
    }
    panel.cfg.capabilities.imageInput!.maxBytes = 2048
    await settle()
    expect(panel.state.value).toBe(previous)
    expect(api.getModelRecommendation).toHaveBeenCalledTimes(1)
  })

  it('同连接切换草稿对象时清空结果，但不自动查询', async () => {
    const cfg = ref<BrainConfigDto>({ provider: 'newapi', model: 'same' })
    const scope = effectScope()
    scopes.push(scope)
    const panel = scope.run(() =>
      useBrainServiceCapabilities(
        () => cfg.value,
        () => undefined,
      ),
    )!
    await panel.refresh()
    cfg.value = { provider: 'newapi', model: 'same' }
    expect(panel.state.value.kind).toBe('idle')
    expect(api.getModelRecommendation).toHaveBeenCalledTimes(1)
  })

  it('更早的手动刷新不能覆盖最新的手动刷新', async () => {
    let finish!: (value: ModelRecommendationDto) => void
    api.getModelRecommendation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const panel = open()
    const pending = panel.refresh()
    await panel.refresh()
    const latest = panel.state.value
    finish({ ...result(), serviceCapabilities: undefined })
    await pending
    expect(panel.state.value).toBe(latest)
  })
})
