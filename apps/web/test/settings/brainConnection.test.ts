import { effectScope, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmProtocol } from '@chery/protocol'
import type { BrainConfigDto } from '@/application/backend/public'
import { useBrainConnection } from '@/features/agent/settings/tabs/brain/useBrainConnection'

const api = vi.hoisted(() => ({ fetchModels: vi.fn(), testConnection: vi.fn() }))
const lifecycle = vi.hoisted(() => ({ close: [] as Array<() => void> }))
vi.mock('@/application/backend/public', () => ({ agentApi: api }))
vi.mock('vue', async original => ({ ...await original<typeof import('vue')>(), onBeforeUnmount: (fn: () => void) => lifecycle.close.push(fn) }))
const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  lifecycle.close.splice(0).forEach(fn => fn())
  scopes.splice(0).forEach(scope => scope.stop())
  vi.resetAllMocks()
})
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function open() {
  const cfg = ref<BrainConfigDto>({ provider: 'newapi', protocol: LlmProtocol.OPENAI_CHAT_COMPLETIONS, url: 'https://synthetic.invalid/v1', key: '$TEST', model: 'model-a' })
  const scope = effectScope(); scopes.push(scope)
  const controller = scope.run(() => useBrainConnection({ cfg: () => cfg.value, protocol: () => cfg.value.protocol, isPlaceholder: value => !!value && /^<[^>]*>$/.test(value) }))!
  return { cfg, controller }
}
describe('brain connection controller without browser operations', () => {
  it('retains query arguments, messages and draft while listing and checking', async () => {
    const { cfg, controller: c } = open()
    api.fetchModels.mockResolvedValue({ models: [{ id: 'model-b' }] })
    api.testConnection.mockResolvedValue({ ok: true })
    const before = JSON.stringify(cfg.value)
    await c.refreshModels(); await c.testConnection()
    expect(api.fetchModels).toHaveBeenCalledWith('newapi', cfg.value.url, '$TEST', false, cfg.value.protocol)
    expect(api.testConnection).toHaveBeenCalledWith('newapi', cfg.value.url, '$TEST', 'model-a', false, cfg.value.protocol)
    expect(c.modelOptions.value).toEqual([{ id: 'model-b' }])
    expect(c.connectionTestMessage.value).toBe('连接成功')
    expect(JSON.stringify(cfg.value)).toBe(before)
  })
  it('keeps model options when the user chooses a model', async () => {
    const { cfg, controller: c } = open()
    api.fetchModels.mockResolvedValue({ models: [{ id: 'model-b' }] })
    await c.refreshModels(); cfg.value.model = 'model-b'
    expect(c.modelOptions.value).toEqual([{ id: 'model-b' }])
  })
  it('retains disabled reasons and separates troubleshooting text', async () => {
    const { cfg, controller: c } = open()
    cfg.value.url = '<YOUR_URL>'
    expect(c.connectionTestDisabled.value).toBe(true)
    expect(c.connectionTestTip.value).toBe('请先填写地址')
    cfg.value.url = 'https://synthetic.invalid/v1'
    api.testConnection.mockResolvedValue({ ok: false, error: '错误原文；排查建议：检查配置' })
    await c.testConnection()
    expect(c.connectionTestMessageView.value).toEqual({ original: '错误原文', suggestion: '检查配置' })
  })
  it('ignores late connection success when model or full-URL mode changes', async () => {
    const { cfg, controller: c } = open()
    for (const change of [() => { cfg.value.model = 'model-b' }, () => { cfg.value.fullUrl = true }]) {
      const pending = deferred<{ ok: true }>(); api.testConnection.mockReturnValueOnce(pending.promise)
      const request = c.testConnection(); change(); pending.resolve({ ok: true }); await request
      expect(c.connectionTestState.value).toBe('idle')
      expect(c.connectionTestMessage.value).toBe('')
    }
  })
  it('does not let a late model request overwrite a newer request or its loading state', async () => {
    const { cfg, controller: c } = open()
    const old = deferred<{ models: Array<{ id: string }> }>(), current = deferred<{ models: Array<{ id: string }> }>()
    api.fetchModels.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const first = c.refreshModels(); cfg.value.url = 'https://second.invalid/v1'; const second = c.refreshModels()
    old.resolve({ models: [{ id: 'old' }] }); await first
    expect(c.modelLoading.value).toBe(true); expect(c.modelOptions.value).toEqual([])
    current.resolve({ models: [{ id: 'current' }] }); await second
    expect(c.modelLoading.value).toBe(false); expect(c.modelOptions.value).toEqual([{ id: 'current' }])
  })
  it('ignores late errors after disposal', async () => {
    const { controller: c } = open()
    const pending = deferred<never>(); api.testConnection.mockReturnValueOnce(pending.promise)
    const request = c.testConnection()
    lifecycle.close.splice(0).forEach(fn => fn())
    pending.reject(new Error('late failure')); await request
    expect(c.connectionTestMessage.value).toBe('')
  })
})
