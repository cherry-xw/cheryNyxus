import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { uuid } from '@/utils/uuid'
import type { FileServiceConfigDto } from '@/application/backend/public'
import { fileApi, fileDraftLeases, type FileOperationRecord, type AssetRecord } from '@/application/files/public'
import { isImageOutputOperation, withoutImageCountParams, imageParameterErrors, mergeImageParameters } from '@chery/protocol'

interface TrialDraft {
  desiredCount?: number
  operation: FileServiceConfigDto['operations'][number]
  prompt: string
  params: Record<string, unknown>
  assets: AssetRecord[]
  selectedId?: string
  fingerprint: string
  testedInput?: string
  attempt?: { signature: string; requestId: string }
}
const drafts = new Map<string, TrialDraft>()

export function useFileServiceTrial(props: { serviceId: string; service: FileServiceConfigDto }) {
  const context = fileApi.contextKey()
  const key = JSON.stringify([context, props.serviceId])
  const saved = drafts.get(key)
  const operation = ref(saved?.operation ?? props.service.operations[0]!)
  const prompt = ref(saved?.prompt ?? '')
  const trialParams = ref<Record<string, unknown>>(saved?.params ?? {})
  const desiredCount = ref(saved?.desiredCount ?? 1)
  const countInitialized = ref(saved?.desiredCount !== undefined)
  const imageOutput = ref<Awaited<ReturnType<typeof fileApi.imageOutput>>>()
  const countError = ref('')
  let countQuery = 0
  async function refreshImageOutput() {
    const token = ++countQuery
    countError.value = ''
    if (!isImageOutputOperation(operation.value)) { imageOutput.value = undefined; return }
    if (!Number.isSafeInteger(desiredCount.value) || desiredCount.value < 1) { countError.value = '请输入 1 或更大的整数'; return }
    try {
      const result = await fileApi.imageOutput({ serviceId: props.serviceId, service: props.service, operation: operation.value,
        desiredCount: countInitialized.value ? desiredCount.value : undefined, params: trialParams.value, inputImages: assets.value.filter(asset => asset.id !== trialParams.value.maskAssetId).length })
      if (current() && token === countQuery) {
        imageOutput.value = result
        if (!countInitialized.value) { desiredCount.value = result.count.desiredCount; countInitialized.value = true }
        if (result.availability !== 'available') countError.value = result.reason ?? '所选绘图方式不可用'
      }
    } catch (cause) { if (current() && token === countQuery) countError.value = cause instanceof Error ? cause.message : '无法读取张数限制' }
  }
  const assets = ref<AssetRecord[]>(saved?.assets ?? [])
  const record = ref<FileOperationRecord>()
  const previousTrials = ref<FileOperationRecord[]>([])
  const error = ref('')
  const busy = ref(false)
  const fingerprint = ref(saved?.fingerprint ?? '')
  const testedInput = ref(saved?.testedInput)
  const restoredHistory = ref(false)
  let attempt = saved?.attempt
  let disposed = false
  let selection = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const current = () => !disposed && context === fileApi.contextKey()
  const active = computed(() => !!record.value && ['waiting_approval', 'queued', 'running', 'cancel_requested'].includes(record.value.executionStatus))
  const saving = computed(() => record.value?.deliveryStatus === 'saving')
  const inputSignature = () => JSON.stringify({ desiredCount: desiredCount.value, operation: operation.value, params: { ...mergeImageParameters(props.service.defaults, trialParams.value), prompt: prompt.value }, assets: assets.value.map(asset => ({ assetId: asset.id, assetVersionId: asset.versionId })) })
  const stale = computed(() => restoredHistory.value || !!record.value && (fingerprint.value !== JSON.stringify(props.service) || testedInput.value !== inputSignature()))

  function stash() {
    if (!current()) return
    drafts.set(key, { desiredCount: countInitialized.value ? desiredCount.value : undefined, operation: operation.value, prompt: prompt.value, params: JSON.parse(JSON.stringify(trialParams.value)), assets: assets.value.map(asset => ({ ...asset })), selectedId: record.value?.operationId, fingerprint: fingerprint.value, testedInput: testedInput.value, attempt })
    const draft = drafts.get(key)!
    if (draft.assets.length) fileDraftLeases.set(`trial:${key}`, context,
      () => draft.assets.map(asset => ({ assetId: asset.id, assetVersionId: asset.versionId })),
      cause => { if (current()) error.value = `草稿文件保留失败：${cause instanceof Error ? cause.message : '请稍后重试'}` })
    else fileDraftLeases.drop(`trial:${key}`)
  }
  function apply(result: FileOperationRecord) {
    record.value = result
    previousTrials.value = [result, ...previousTrials.value.filter(item => item.operationId !== result.operationId)]
    stash()
  }
  async function loadTrials() {
    const token = selection
    try {
      const response = await fileApi.trials(props.serviceId)
      if (!current() || token !== selection) return
      previousTrials.value = record.value ? [record.value, ...response.operations.filter(item => item.operationId !== record.value?.operationId)] : response.operations
      if (!record.value) {
        record.value = response.operations.find(item => item.operationId === saved?.selectedId) ?? response.operations[0]
        restoredHistory.value = !!record.value && (record.value.operationId !== saved?.selectedId || !fingerprint.value)
      }
    } catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : '无法读取试用记录' }
  }
  function selectTrial(id: string) {
    selection++
    record.value = previousTrials.value.find(item => item.operationId === id)
    fingerprint.value = ''
    testedInput.value = undefined
    restoredHistory.value = !!record.value
    stash()
  }
  async function upload(event: Event) {
    if (busy.value || !current()) return
    const input = event.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    busy.value = true; error.value = ''
    try {
      for (const file of files) {
        const asset = await fileApi.upload(file)
        if (!current()) return
        assets.value.push(asset)
      }
    } catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : '上传失败' }
    finally { if (current()) busy.value = false; input.value = '' }
  }
  async function restoreRequest() {
    if (!record.value || busy.value || !current()) return
    const source = record.value
    const token = selection
    busy.value = true; error.value = ''
    try {
      if (!props.service.operations.includes(source.operation)) throw new Error('当前服务已不支持此历史操作')
      const response = await fileApi.get(source.inputAssets)
      if (!current() || token !== selection) return
      const restored = response.assets.map(asset => {
        if ('missing' in asset) throw new Error('历史参考文件缺失或无权使用，请重新选择')
        return asset
      })
      operation.value = source.operation
      const { prompt: question, ...params } = source.params ?? {}
      prompt.value = typeof question === 'string' ? question : source.question ?? ''
      trialParams.value = withoutImageCountParams(params)
      desiredCount.value = source.imageCount?.desiredCount ?? 1
      countInitialized.value = true
      assets.value = restored
      attempt = undefined
    } catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : '无法恢复试用输入' }
    finally { if (current()) busy.value = false }
  }
  async function run(action: 'try' | 'refresh' | 'cancel' | 'save') {
    if (busy.value || !current()) return
    const token = selection
    busy.value = true; error.value = ''
    try {
      let result: FileOperationRecord
      if (action === 'try') {
        if (active.value || saving.value) throw new Error('请先等待或停止当前操作')
        if (!props.service.operations.includes(operation.value)) throw new Error('当前服务已不支持所选操作，请重新选择')
        const parameterErrors = imageParameterErrors(props.service.adapter, { ...mergeImageParameters(props.service.defaults, trialParams.value), prompt: prompt.value }, imageOutput.value?.model ?? props.service.connection.model ?? '')
        if (parameterErrors.length) throw new Error(parameterErrors.join('\n'))
        const service = JSON.parse(JSON.stringify(props.service)) as FileServiceConfigDto
        if (isImageOutputOperation(operation.value) && (!imageOutput.value || countError.value)) throw new Error(countError.value || '请先等待绘图限制查询完成')
        const request = { serviceId: props.serviceId, service, operation: operation.value, params: { ...mergeImageParameters(service.defaults, trialParams.value), prompt: prompt.value }, assets: assets.value.map(asset => ({ assetId: asset.id, assetVersionId: asset.versionId })),
          ...(isImageOutputOperation(operation.value) ? { desiredCount: desiredCount.value, expectedImageConfigRevision: imageOutput.value!.configRevision } : {}) }
        const signature = JSON.stringify(request)
        if (attempt?.signature !== signature) attempt = { signature, requestId: uuid() }
        const requestInput = inputSignature()
        stash()
        result = await fileApi.tryService({ ...request, requestId: attempt.requestId })
        if (current()) attempt = undefined
        if (current() && token === selection) {
          fingerprint.value = JSON.stringify(service)
          testedInput.value = requestInput
          restoredHistory.value = false
        }
      } else {
        const id = record.value?.operationId
        if (!id) return
        result = action === 'refresh' ? await fileApi.operation(id) : action === 'cancel' ? await fileApi.cancel(id) : await fileApi.retry(id, 'save', uuid())
      }
      if (current() && token === selection) apply(result)
    } catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : '操作失败，请先查询状态，不要重复生成' }
    finally { if (current()) { busy.value = false; stash() } }
  }
  async function removeTrial() {
    if (!record.value || busy.value || !current()) return
    const id = record.value.operationId
    busy.value = true; error.value = ''
    try {
      await fileApi.deleteTrial(id)
      if (!current()) return
      previousTrials.value = previousTrials.value.filter(item => item.operationId !== id)
      record.value = previousTrials.value[0]
      restoredHistory.value = !!record.value
      stash()
    } catch (cause) { if (current()) error.value = cause instanceof Error ? cause.message : '无法删除试用记录' }
    finally { if (current()) busy.value = false }
  }
  function poll() {
    clearTimeout(timer)
    if (!current() || !active.value && !saving.value) return
    timer = setTimeout(async () => { await run('refresh'); poll() }, 1500)
  }
  watch(() => [record.value?.operationId, record.value?.executionStatus, record.value?.deliveryStatus], poll)
  watch([operation, prompt, trialParams, assets, desiredCount], stash, { deep: true })
  watch([operation, trialParams, assets, desiredCount, () => props.service], () => void refreshImageOutput(), { deep: true, immediate: true })
  onMounted(() => { void loadTrials(); stash() })
  onBeforeUnmount(() => { stash(); disposed = true; selection++; clearTimeout(timer) })
  return { operation, prompt, trialParams, assets, record, error, busy, previousTrials, stale, active, saving, upload, run, selectTrial, restoreRequest, removeTrial,
    desiredCount, imageOutput, countError, setCount: (value: number) => { countInitialized.value = true; desiredCount.value = value } }
}
