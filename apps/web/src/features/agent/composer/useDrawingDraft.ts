import { computed, onBeforeUnmount, provide, ref, watch, type InjectionKey } from 'vue'
import { uuid } from '@/utils/uuid'
import { DrawingIntentSchema, isImageOutputOperation, type DrawingIntent, type DrawingTask, type DrawingCandidate, type MessagePart, type ImageOutputOperation } from '@chery/protocol'
import { fileApi, type AssetRecord } from '@/application/files/public'
import type { ConfigDto } from '@/application/backend/public'

interface Draft { enabled: boolean; initialized: boolean; serviceId: string; roleId: string; operation: ImageOutputOperation; desiredCount: number; params: Record<string, unknown>; taskId?: string; sourceCandidateId?: string }
const drafts = new Map<string, Draft>()
export const DRAWING_DRAFT: InjectionKey<ReturnType<typeof useDrawingDraft>> = Symbol('drawing-draft')

export function useDrawingDraft(options: {
  key: () => string; chatId: () => string | null; config: () => ConfigDto | null; preset: () => string | undefined
  reference: (asset: AssetRecord) => Promise<void>; parts: () => MessagePart[]; draftParts: () => MessagePart[]
  removeReference: (candidate: DrawingCandidate) => void
}) {
  const state = ref<Draft>({ enabled: false, initialized: false, serviceId: '', roleId: '', operation: 'image.generate', desiredCount: 1, params: {} })
  const result = ref<Awaited<ReturnType<typeof fileApi.imageOutput>>>()
  const tasks = ref<DrawingTask[]>([])
  const error = ref('')
  const limitError = ref('')
  const historyError = ref('')
  const loading = ref(false)
  const busy = ref(false)
  let key = ''
  let query = 0
  let generation = 0
  let taskQuery = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let finalAttempt: { fingerprint: string; requestId: string } | undefined
  const services = computed(() => Object.entries(options.config()?.file_services ?? {}).filter(([, service]) => service.enabled !== false && service.operations.some(isImageOutputOperation)))
  const service = computed(() => options.config()?.file_services?.[state.value.serviceId])
  const operations = computed(() => service.value?.operations.filter(isImageOutputOperation) ?? [])
  const roles = computed(() => {
    const config = options.config()
    const preset = options.preset()
    const members = preset ? config?.presets?.[preset]?.roles ?? [] : Object.keys(config?.roles ?? {})
    return Object.entries(config?.roles ?? {}).filter(([name, role]) => members.includes(name) && role.kind !== 'shadow').map(([name, role]) => ({ id: role.id ?? name, name }))
  })
  const sendLabel = computed(() => state.value.enabled ? state.value.operation === 'image.generate' ? '生成图片' : '提交修改' : '发送消息')
  function stash() { if (key) drafts.set(key, structuredCloneRaw(state.value)) }
  function structuredCloneRaw<T>(value: T): T { return JSON.parse(JSON.stringify(value)) }
  watch(() => [options.key(), fileApi.contextKey()], () => {
    stash(); key = `${fileApi.contextKey()}:${options.key()}`; query++; generation++
    state.value = structuredCloneRaw(drafts.get(key) ?? { enabled: false, initialized: false, serviceId: '', roleId: '', operation: 'image.generate', desiredCount: options.config()?.files?.imageGeneration?.defaultCount ?? 1, params: {} })
    tasks.value = []; result.value = undefined; error.value = ''; limitError.value = ''; historyError.value = ''; busy.value = false; loading.value = false; clearTimeout(timer)
    void refreshLimits()
    void refreshTasks()
  }, { immediate: true })
  watch(() => options.config(), config => {
    if (!state.value.initialized) state.value.desiredCount = config?.files?.imageGeneration?.defaultCount ?? 1
  })
  watch(state, () => { stash(); void refreshLimits() }, { deep: true })
  watch(() => options.config(), () => void refreshLimits())
  async function refreshLimits() {
    const token = ++query
    limitError.value = ''
    if (!state.value.enabled || !service.value) { result.value = undefined; loading.value = false; return }
    loading.value = true
    try {
      const count = state.value.desiredCount
      if (!Number.isSafeInteger(count) || count < 1) throw new Error('张数必须为 1 或更大的整数')
      const response = await fileApi.imageOutput({ chatId: options.chatId() ?? undefined, roleId: state.value.roleId || undefined,
        serviceId: state.value.serviceId, operation: state.value.operation, desiredCount: count, params: state.value.params,
        inputImages: options.draftParts().filter(part => part.type === 'asset' && part.usage !== 'reference-only' && part.assetId !== state.value.params.maskAssetId).length })
      if (!disposed && token === query) result.value = response
    } catch (cause) { if (!disposed && token === query) limitError.value = cause instanceof Error ? cause.message : '无法读取绘图限制' }
    finally { if (!disposed && token === query) loading.value = false }
  }
  watch(() => JSON.stringify(options.draftParts().filter(part => part.type === 'asset')), () => void refreshLimits())
  async function refreshTasks() {
    const token = ++taskQuery
    const chatId = options.chatId(), currentKey = key, epoch = generation
    clearTimeout(timer)
    if (!chatId) return
    let succeeded = false
    try {
      const response = await fileApi.drawings(chatId)
      if (disposed || key !== currentKey || generation !== epoch || token !== taskQuery || options.chatId() !== chatId) return
      tasks.value = response.tasks
      historyError.value = ''
      succeeded = true
    } catch (cause) { if (!disposed && key === currentKey && generation === epoch && token === taskQuery && options.chatId() === chatId) historyError.value = cause instanceof Error ? cause.message : '绘图记录读取失败' }
    finally {
      if (succeeded && !disposed && key === currentKey && generation === epoch && token === taskQuery && options.chatId() === chatId) {
        if (state.value.enabled) timer = setTimeout(() => void refreshTasks(), 2000)
      }
    }
  }
  function open() {
    if (!state.value.initialized) { state.value.desiredCount = options.config()?.files?.imageGeneration?.defaultCount ?? 1; state.value.initialized = true }
    state.value.enabled = !state.value.enabled
    if (state.value.enabled) void refreshTasks()
    else clearTimeout(timer)
  }
  function chooseService(id: string) {
    state.value.serviceId = id
    state.value.params = {}
    const supported = options.config()?.file_services?.[id]?.operations.filter(isImageOutputOperation) ?? []
    state.value.operation = state.value.sourceCandidateId ? supported.find(operation => operation === 'image.edit') ?? supported.find(operation => operation === 'image.reference') ?? 'image.edit'
      : supported[0] ?? 'image.generate'
  }
  function resetCount() { state.value.desiredCount = options.config()?.files?.imageGeneration?.defaultCount ?? 1 }
  function prepare(chatId: string): DrawingIntent | undefined {
    if (!state.value.enabled) return
    if (chatId !== options.chatId()) throw new Error('绘图目标会话已变化，请在目标会话中重新确认')
    if (!result.value || loading.value || limitError.value) throw new Error(limitError.value || '请先选择绘图服务并等待限制查询完成')
    if (result.value.availability !== 'available') throw new Error(result.value.reason || '所选绘图方式不可用')
    const parts = options.parts().filter(part => part.type === 'asset' && part.usage !== 'reference-only')
    if (state.value.operation === 'image.generate' && parts.length) throw new Error('已有参考图片，请选择参考或编辑操作')
    return DrawingIntentSchema.parse({ serviceId: state.value.serviceId, roleId: state.value.roleId || undefined, operation: state.value.operation,
      desiredCount: state.value.desiredCount, params: structuredCloneRaw(state.value.params), configRevision: result.value.configRevision,
      taskId: state.value.taskId, sourceCandidateId: state.value.sourceCandidateId })
  }
  async function selectCandidate(task: DrawingTask, candidate: DrawingCandidate) {
    if (busy.value) return
    const currentKey = key, epoch = generation
    busy.value = true; error.value = ''
    try {
      const response = await fileApi.get([{ assetId: candidate.assetId, assetVersionId: candidate.assetVersionId }], task.chatId)
      if (disposed || key !== currentKey || epoch !== generation) return
      const asset = response.assets[0]
      if (!asset || 'missing' in asset || asset.availability !== 'available') throw new Error('候选图已缺失或无权读取')
      await options.reference(asset)
      if (disposed || key !== currentKey || epoch !== generation) return
      const previous = tasks.value.flatMap(task => task.rounds.flatMap(round => round.candidates)).find(item => item.candidateId === state.value.sourceCandidateId)
      if (previous && previous.candidateId !== candidate.candidateId) options.removeReference(previous)
      const round = task.rounds.find(round => round.roundId === candidate.roundId)!
      state.value.enabled = true
      state.value.initialized = true
      state.value.taskId = task.taskId
      state.value.sourceCandidateId = candidate.candidateId
      if (!state.value.serviceId) chooseService(round.intent.serviceId)
      const editing = operations.value.find(operation => operation === 'image.edit') ?? operations.value.find(operation => operation === 'image.reference')
      if (!editing || service.value?.adapter === 'minimax-images') throw new Error('当前服务不支持通用候选图修改，请选择支持参考或编辑的服务')
      state.value.operation = editing
    } catch (cause) { if (key === currentKey && epoch === generation) error.value = cause instanceof Error ? cause.message : '选择候选图失败' }
    finally { if (key === currentKey && epoch === generation) busy.value = false }
  }
  async function finalize(task: DrawingTask, candidate: DrawingCandidate) {
    if (busy.value) return
    const currentKey = key, epoch = generation
    busy.value = true; error.value = ''
    try {
      const input = { chatId: task.chatId, taskId: task.taskId, candidateId: candidate.candidateId, expectedSelectionRevision: task.selectionRevision }
      const fingerprint = JSON.stringify([key, input])
      if (finalAttempt?.fingerprint !== fingerprint) finalAttempt = { fingerprint, requestId: uuid() }
      const response = await fileApi.finalizeDrawing({ ...input, requestId: finalAttempt.requestId })
      if (!disposed && key === currentKey && epoch === generation) { taskQuery++; tasks.value = tasks.value.map(item => item.taskId === task.taskId ? response : item); finalAttempt = undefined }
    } catch (cause) {
      if (key === currentKey && epoch === generation) {
        error.value = cause instanceof Error ? cause.message : '定稿失败；请刷新后确认现有定稿'
        if ((cause as { status?: number }).status === 409) { finalAttempt = undefined; await refreshTasks() }
      }
    } finally { if (key === currentKey && epoch === generation) busy.value = false }
  }
  function submitted(intent: DrawingIntent, association?: { taskId: string; roundId: string }) {
    if (state.value.serviceId === intent.serviceId && state.value.sourceCandidateId === intent.sourceCandidateId && state.value.desiredCount === intent.desiredCount &&
        state.value.operation === intent.operation && (state.value.roleId || undefined) === intent.roleId && JSON.stringify(state.value.params) === JSON.stringify(intent.params)) {
      state.value.taskId = association?.taskId ?? intent.taskId
      state.value.sourceCandidateId = undefined
    }
    void refreshTasks()
  }
  onBeforeUnmount(() => { stash(); disposed = true; query++; clearTimeout(timer) })
  const binding = { state, sendLabel, result, tasks, error, limitError, historyError, loading, busy, services, service, roles, operations, open, chooseService, resetCount, refreshLimits, refreshTasks, prepare, selectCandidate, finalize, submitted }
  provide(DRAWING_DRAFT, binding)
  return binding
}
