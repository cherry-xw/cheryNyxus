import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useFileServiceTrial } from '@/features/agent/settings/tabs/tools/useFileServiceTrial'
import type { FileServiceConfigDto } from '@/application/backend/public'
import type { FileOperationRecord } from '@chery/protocol'

const lifecycle = vi.hoisted(() => ({ mount: [] as (() => void)[], unmount: [] as (() => void)[] }))
const api = vi.hoisted(() => ({ context: 'identity', tryService: vi.fn(), imageOutput: vi.fn(), trials: vi.fn(), retainDraft: vi.fn(), operation: vi.fn(), get: vi.fn() }))
vi.mock('vue', async original => ({ ...await original<typeof import('vue')>(),
  onMounted: (fn: () => void) => lifecycle.mount.push(fn),
  onBeforeUnmount: (fn: () => void) => lifecycle.unmount.push(fn),
}))
vi.mock('@/application/files/public', () => ({ fileApi: { ...api, contextKey: () => api.context }, fileDraftLeases: { set: vi.fn(), drop: vi.fn() } }))
vi.mock('@/application/backend/public', () => ({ agentApi: { getConfig: async () => ({ files: { imageGeneration: { defaultCount: 1 } } }) } }))
const scopes: ReturnType<typeof effectScope>[] = []
const service: FileServiceConfigDto = { name: '测试', adapter: 'minimax-images', enabled: true,
  connection: { baseUrl: 'https://example.com', model: 'image-01' }, operations: ['image.generate'] }
function result(id = 'operation'): FileOperationRecord {
  return { operationId: id, operation: 'image.generate', inputAssets: [], targetKind: 'tool', targetId: 'test',
    executionStatus: 'succeeded', deliveryStatus: 'saved', inspectionStatus: 'not_requested', createdAt: 1, updatedAt: 1 }
}
function open(serviceId = crypto.randomUUID()) {
  const scope = effectScope(); scopes.push(scope)
  const controller = scope.run(() => useFileServiceTrial({ serviceId, service }))!
  lifecycle.mount.splice(0).forEach(fn => fn())
  return controller
}
function close() { lifecycle.unmount.splice(0).forEach(fn => fn()); scopes.splice(0).forEach(scope => scope.stop()) }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); api.context = crypto.randomUUID()
  api.trials.mockResolvedValue({ operations: [] }); api.retainDraft.mockResolvedValue({})
  api.tryService.mockResolvedValue(result())
  api.imageOutput.mockResolvedValue({ configRevision: 'revision', availability: 'available', count: { desiredCount: 1, effectiveCount: 1, countControl: 'requested' } })
})
afterEach(() => { close(); vi.useRealTimers() })

describe('文件服务试用恢复', () => {
  it('网络失败重试沿用标识，已接受后的新调用使用新标识，改输入标记旧结果', async () => {
    const trial = open()
    await nextTick()
    trial.prompt.value = '画一座桥'
    api.tryService.mockRejectedValueOnce(new Error('网络中断'))
    await trial.run('try')
    await trial.run('try')
    const first = api.tryService.mock.calls[0]![0]
    expect(api.tryService.mock.calls[1]![0].requestId).toBe(first.requestId)
    expect(trial.stale.value).toBe(false)
    trial.prompt.value = '画另一座桥'
    expect(trial.stale.value).toBe(true)
    await trial.run('try')
    expect(api.tryService.mock.calls[2]![0].requestId).not.toBe(first.requestId)
    expect(trial.stale.value).toBe(false)
  })
  it('关闭不取消后台操作；重开恢复草稿及持久记录，不自动再次调用', async () => {
    const id = crypto.randomUUID()
    const trial = open(id)
    await nextTick()
    trial.prompt.value = '保留的提示'
    trial.trialParams.value = { aspect_ratio: '16:9' }
    await nextTick()
    close()
    api.trials.mockResolvedValue({ operations: [result('persisted')] })
    const reopened = open(id)
    await nextTick()
    expect(reopened.prompt.value).toBe('保留的提示')
    expect(reopened.trialParams.value).toEqual({ aspect_ratio: '16:9' })
    expect(reopened.record.value?.operationId).toBe('persisted')
    expect(reopened.stale.value).toBe(true)
    expect(api.tryService).not.toHaveBeenCalled()
  })
  it('异步结果不会写入已改变身份的面板', async () => {
    const trial = open()
    await nextTick()
    let finish!: (value: FileOperationRecord) => void
    api.tryService.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    trial.prompt.value = '输入'
    const pending = trial.run('try')
    api.context = 'another-identity'
    finish(result('old-identity'))
    await pending
    expect(trial.record.value).toBeUndefined()
    await trial.run('try')
    expect(api.tryService).toHaveBeenCalledTimes(1)
  })
})
