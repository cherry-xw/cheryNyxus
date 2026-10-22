import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { calculateImageCount, type DrawingTask, type DrawingCandidate } from '@chery/protocol'
import { useDrawingDraft } from '@/features/agent/composer/useDrawingDraft'
import type { ConfigDto } from '@/application/backend/public'

const api = vi.hoisted(() => ({ context: '', drawings: vi.fn(), imageOutput: vi.fn(), get: vi.fn(), finalizeDrawing: vi.fn(), tryService: vi.fn() }))
const lifecycle = vi.hoisted(() => ({ unmount: [] as (() => void)[] }))
vi.mock('vue', async original => ({ ...await original<typeof import('vue')>(), provide: vi.fn(), onBeforeUnmount: (fn: () => void) => lifecycle.unmount.push(fn) }))
vi.mock('@/application/files/public', () => ({ fileApi: { ...api, contextKey: () => api.context } }))
const scopes: ReturnType<typeof effectScope>[] = []
const capability = { nativeMultiImage: 'supported' as const, countControl: 'requested' as const, maxImagesPerRequest: 9 }
const flush = async () => { await nextTick(); await Promise.resolve(); await nextTick() }
function open() {
  const key = ref(crypto.randomUUID()), chatId = ref('chat')
  const config = ref({ files: { imageGeneration: { defaultCount: 6 } }, roles: {}, file_services: {
    svc: { name: '测试', adapter: 'openai-images', connection: { model: 'gpt-image-1' }, operations: ['image.generate', 'image.edit'] },
    small: { name: '低上限', adapter: 'openai-images', connection: { model: 'gpt-image-1' }, operations: ['image.generate', 'image.edit'] },
  } } as unknown as ConfigDto)
  const reference = vi.fn(async () => undefined), removeReference = vi.fn()
  const scope = effectScope(); scopes.push(scope)
  const draft = scope.run(() => useDrawingDraft({ key: () => key.value, chatId: () => chatId.value, config: () => config.value, preset: () => undefined,
    reference, removeReference, parts: () => [], draftParts: () => [] }))!
  return { draft, key, chatId, config, reference, removeReference }
}
function close() { lifecycle.unmount.splice(0).forEach(fn => fn()); scopes.splice(0).forEach(scope => scope.stop()) }
const candidate: DrawingCandidate = { candidateId: 'round:candidate', roundId: 'round', operationId: 'operation', partIndex: 0, assetId: 'asset', assetVersionId: 'fixed-version' }
const task: DrawingTask = { taskId: 'task', chatId: 'chat', selectionRevision: 0, createdAt: 1, rounds: [{ roundId: 'round', taskId: 'task', sourceMessageId: 'message', feedback: '原反馈',
  intent: { serviceId: 'svc', operation: 'image.generate', desiredCount: 1, params: {}, configRevision: 'revision' }, inputAssets: [], imageCount: calculateImageCount(1, capability),
  imageConfigRevision: 'revision', imageModel: 'gpt-image-1', adapter: 'openai-images', createdAt: 1, candidates: [candidate] }] }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); api.context = crypto.randomUUID()
  api.drawings.mockResolvedValue({ tasks: [] })
  api.imageOutput.mockImplementation(async (input: { serviceId: string; desiredCount: number }) => ({ model: 'gpt-image-1', imageModel: 'gpt-image-1', adapter: 'openai-images',
    configRevision: 'revision', availability: 'available', source: 'catalog', capability,
    count: calculateImageCount(input.desiredCount, { ...capability, maxImagesPerRequest: input.serviceId === 'small' ? 2 : 9 }) }))
  api.get.mockResolvedValue({ assets: [{ id: candidate.assetId, versionId: candidate.assetVersionId, availability: 'available' }] })
  api.finalizeDrawing.mockResolvedValue({ ...task, finalCandidateId: candidate.candidateId, selectionRevision: 1 })
})
afterEach(() => { close(); vi.useRealTimers() })

describe('会话绘图草稿状态（不操作浏览器）', () => {
  it('开关、改参数、刷新、选图和定稿均不生成；反馈提交才产生新意图', async () => {
    const { draft, reference } = open()
    draft.open(); draft.chooseService('svc'); await flush()
    draft.state.value.params = { size: '1024x1024' }; await flush()
    await draft.selectCandidate(task, candidate); await flush()
    expect(reference).toHaveBeenCalledWith(expect.objectContaining({ versionId: 'fixed-version' }))
    expect(draft.prepare('chat')).toMatchObject({ sourceCandidateId: candidate.candidateId, operation: 'image.edit', desiredCount: 6 })
    await draft.finalize(task, candidate)
    draft.open(); await draft.refreshTasks()
    expect(api.tryService).not.toHaveBeenCalled()
  })
  it('切模型保留期望，主动编辑后用新期望；全局变化不覆盖已初始化草稿', async () => {
    const { draft, config } = open()
    draft.open(); draft.chooseService('svc'); await flush()
    expect(draft.result.value?.count.effectiveCount).toBe(6)
    draft.chooseService('small'); await flush()
    expect(draft.state.value.desiredCount).toBe(6)
    expect(draft.result.value?.count.effectiveCount).toBe(2)
    draft.chooseService('svc'); await flush()
    expect(draft.result.value?.count.effectiveCount).toBe(6)
    draft.state.value.desiredCount = 3; draft.chooseService('small'); await flush()
    draft.chooseService('svc'); await flush()
    expect(draft.result.value?.count.effectiveCount).toBe(3)
    config.value = { ...config.value, files: { ...config.value.files, imageGeneration: { defaultCount: 8 } } }
    await flush(); expect(draft.state.value.desiredCount).toBe(3)
    draft.resetCount(); await flush(); expect(draft.state.value.desiredCount).toBe(8)
  })
  it('未开启过的草稿读取新全局默认，重开同窗口保持本次参数，不串其他窗口', async () => {
    const first = open()
    first.config.value = { ...first.config.value, files: { ...first.config.value.files, imageGeneration: { defaultCount: 4 } } }
    await flush(); first.draft.open(); first.draft.chooseService('svc'); await flush()
    expect(first.draft.state.value.desiredCount).toBe(4)
    const oldKey = first.key.value
    first.draft.state.value.desiredCount = 7; await flush()
    first.key.value = 'another-window'; await flush()
    expect(first.draft.state.value.desiredCount).toBe(4)
    first.key.value = oldKey; await flush()
    expect(first.draft.state.value.desiredCount).toBe(7)
  })
  it('自然语言历史引用不强迫点击，非法张数保留草稿且禁止提交', async () => {
    const { draft } = open()
    draft.open(); draft.chooseService('svc'); draft.state.value.operation = 'image.edit'; await flush()
    expect(draft.prepare('chat')?.operation).toBe('image.edit')
    draft.state.value.desiredCount = 0; await flush()
    expect(() => draft.prepare('chat')).toThrow('整数')
    expect(draft.state.value.desiredCount).toBe(0)
  })
  it('切会话后迟到选图/查询不会污染新草稿', async () => {
    const { draft, key, reference } = open()
    let finish!: (value: unknown) => void
    api.get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = draft.selectCandidate(task, candidate)
    key.value = 'new-window'; await flush()
    finish({ assets: [{ id: 'asset', versionId: 'fixed-version', availability: 'available' }] }); await pending
    expect(reference).not.toHaveBeenCalled()
    expect(draft.state.value.sourceCandidateId).toBeUndefined()
  })
  it('定稿网络中断重用请求标识，冲突刷新，不自动替换用户选择', async () => {
    const { draft } = open(); await flush()
    api.finalizeDrawing.mockRejectedValueOnce(new Error('连接中断'))
    await draft.finalize(task, candidate); await draft.finalize(task, candidate)
    expect(api.finalizeDrawing.mock.calls[0]![0].requestId).toBe(api.finalizeDrawing.mock.calls[1]![0].requestId)
    api.finalizeDrawing.mockRejectedValueOnce(Object.assign(new Error('版本过期'), { status: 409 }))
    await draft.finalize(task, candidate)
    expect(draft.error.value).toContain('版本过期')
    expect(api.drawings).toHaveBeenCalled()
    expect(api.tryService).not.toHaveBeenCalled()
  })
  it('ACK 到达时不清除发送期间用户已改过的绘图参数', async () => {
    const { draft } = open(); draft.open(); draft.chooseService('svc'); await flush()
    const intent = draft.prepare('chat')!
    draft.state.value.desiredCount = 2
    draft.submitted(intent, { taskId: 'submitted-task', roundId: 'submitted-round' })
    expect(draft.state.value.taskId).toBeUndefined()
    expect(draft.state.value.desiredCount).toBe(2)
  })
  it('查询失败后停止自动重复，保留草稿、已有记录和错误；手动刷新成功后恢复查询', async () => {
    const { draft } = open(); await flush()
    draft.open(); draft.chooseService('svc'); draft.state.value.desiredCount = 3; await flush()
    api.drawings.mockResolvedValueOnce({ tasks: [task] })
    await draft.refreshTasks()
    api.drawings.mockRejectedValueOnce(Object.assign(new Error('无权访问此会话的文件'), { status: 400 }))
    await vi.advanceTimersByTimeAsync(2000)
    const callsAfterFailure = api.drawings.mock.calls.length
    expect(draft.historyError.value).toBe('无权访问此会话的文件')
    expect(draft.tasks.value).toEqual([task])
    expect(draft.state.value).toMatchObject({ serviceId: 'svc', desiredCount: 3, enabled: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.drawings).toHaveBeenCalledTimes(callsAfterFailure)
    await draft.refreshTasks()
    expect(draft.historyError.value).toBe('')
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.drawings).toHaveBeenCalledTimes(callsAfterFailure + 2)
  })
  it('过期查询失败不覆盖新的成功结果，过期成功不在最新失败后重启轮询', async () => {
    const { draft } = open(); await flush(); draft.open(); await flush()
    let reject!: (cause: unknown) => void
    api.drawings.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const staleFailure = draft.refreshTasks()
    await draft.refreshTasks()
    reject(new Error('过期错误')); await staleFailure
    expect(draft.historyError.value).toBe('')
    let resolve!: (value: { tasks: DrawingTask[] }) => void
    api.drawings.mockImplementationOnce(() => new Promise(finish => { resolve = finish }))
    const staleSuccess = draft.refreshTasks()
    api.drawings.mockRejectedValueOnce(new Error('最新查询失败'))
    await draft.refreshTasks()
    resolve({ tasks: [task] }); await staleSuccess
    const callsAfterFailure = api.drawings.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(draft.historyError.value).toBe('最新查询失败')
    expect(draft.tasks.value).toEqual([])
    expect(api.drawings).toHaveBeenCalledTimes(callsAfterFailure)
  })
  it('切会话或卸载后，迟到查询不污染记录或重启自动查询', async () => {
    const { draft, key, chatId } = open(); await flush(); draft.open(); await flush()
    let finish!: (value: { tasks: DrawingTask[] }) => void
    api.drawings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = draft.refreshTasks()
    key.value = 'other'; chatId.value = 'other-chat'; await flush()
    finish({ tasks: [task] }); await pending
    expect(draft.tasks.value).toEqual([])
    draft.open(); await flush(); close()
    const callsAtClose = api.drawings.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.drawings).toHaveBeenCalledTimes(callsAtClose)
  })
})
