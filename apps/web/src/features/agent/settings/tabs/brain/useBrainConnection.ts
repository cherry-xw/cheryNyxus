import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { agentApi, type BrainConfigDto } from '@/application/backend/public'
import type { LlmProtocol } from '@chery/protocol'
import { effectiveLlmBaseUrl, llmRequiresKey, httpAddressError } from '@chery/protocol'

/** Model lookup and connection feedback belong to the current, unsaved brain draft. */
export function useBrainConnection(options: {
  cfg: () => BrainConfigDto
  protocol: () => LlmProtocol | undefined
  isPlaceholder: (value: string | undefined) => boolean
}) {
  const modelOptions = ref<Array<{ id: string; name?: string }>>([])
  const modelLoading = ref(false)
  const connectionTestState = ref<'idle' | 'pending' | 'success' | 'error'>('idle')
  const connectionTestMessage = ref('')
  const isMockProvider = computed(() => options.protocol() === 'mock')
  let generation = 0
  let connectionRequest = 0
  let modelsRequest = 0
  let disposed = false
  const marker = '；排查建议：'
  const connectionTestMessageView = computed(() => {
    const message = connectionTestMessage.value
    const index = message.indexOf(marker)
    return index < 0 ? { original: message, suggestion: '' }
      : { original: message.slice(0, index), suggestion: message.slice(index + marker.length) }
  })
  const refreshModelsBlockedBy = computed<string | null>(() => {
    const cfg = options.cfg()
    if (isMockProvider.value) return '离线模拟无需刷新模型'
    if (!cfg.provider) return '请先选择服务'
    if (!options.protocol()) return '请先选择 API 协议'
    const address = effectiveLlmBaseUrl({ ...cfg, protocol: options.protocol() })
    if (options.isPlaceholder(address)) return '请先填写地址'
    if (address?.startsWith('$') !== true && httpAddressError(address)) return '请先填写有效地址'
    if (llmRequiresKey({ ...cfg, protocol: options.protocol() }) && !cfg.key?.trim()) return '请先填写密钥'
    return null
  })
  const connectionBlockedBy = computed<string | null>(() => {
    if (isMockProvider.value) return '离线模拟无需测试'
    if (refreshModelsBlockedBy.value) return refreshModelsBlockedBy.value
    const model = options.cfg().model
    if (!model || options.isPlaceholder(model)) return '请先选择模型'
    return null
  })
  const connectionTestDisabled = computed(() => connectionTestState.value === 'pending' || connectionBlockedBy.value !== null)
  const connectionTestTip = computed(() => connectionTestState.value === 'pending' ? '正在测试连接…' : connectionBlockedBy.value ?? '测试地址与密钥是否连通')
  const refreshModelsDisabled = computed(() => modelLoading.value || refreshModelsBlockedBy.value !== null)
  const refreshTip = computed(() => modelLoading.value ? '正在获取模型列表…' : refreshModelsBlockedBy.value ?? '获取最新模型列表；亦可测试连通')

  watch(() => {
    const cfg = options.cfg()
    return [cfg, cfg.provider, options.protocol(), cfg.url, cfg.key, cfg.fullUrl] as const
  }, () => {
    generation++
    connectionTestState.value = 'idle'
    connectionTestMessage.value = ''
    modelLoading.value = false
  }, { flush: 'sync' })
  watch(() => options.cfg().model, () => {
    connectionRequest++
    connectionTestState.value = 'idle'
    connectionTestMessage.value = ''
  }, { flush: 'sync' })
  onBeforeUnmount(() => { disposed = true; generation++ })

  async function refreshModels(): Promise<void> {
    const { provider, url, key, fullUrl } = options.cfg()
    if (refreshModelsBlockedBy.value) {
      connectionTestState.value = 'error'
      connectionTestMessage.value = '请先选择服务、协议并填写地址'
      return
    }
    const epoch = generation, request = ++modelsRequest
    const current = () => !disposed && epoch === generation && request === modelsRequest
    modelLoading.value = true
    try {
      const res = await agentApi.fetchModels(provider, url, key || undefined, fullUrl === true, options.protocol())
      if (!current()) return
      if (res.error) {
        connectionTestState.value = 'error'
        connectionTestMessage.value = res.error
        return
      }
      modelOptions.value = res.models
      connectionTestState.value = 'idle'
      connectionTestMessage.value = ''
    } catch (error) {
      if (!current()) return
      connectionTestState.value = 'error'
      connectionTestMessage.value = error instanceof Error ? error.message : String(error)
    } finally { if (current()) modelLoading.value = false }
  }

  async function testConnection(): Promise<void> {
    const { provider, url, key, model, fullUrl } = options.cfg()
    if (provider === 'mock') return
    if (connectionBlockedBy.value) {
      connectionTestState.value = 'error'
      connectionTestMessage.value = '请先选择服务、协议并填写地址和模型'
      return
    }
    const epoch = generation, request = ++connectionRequest
    const current = () => !disposed && epoch === generation && request === connectionRequest
    connectionTestState.value = 'pending'
    connectionTestMessage.value = ''
    try {
      const result = await agentApi.testConnection(provider, url, key || undefined, model, fullUrl === true, options.protocol())
      if (!current()) return
      connectionTestState.value = result.ok ? 'success' : 'error'
      connectionTestMessage.value = result.ok ? '连接成功' : result.error
    } catch (error) {
      if (!current()) return
      connectionTestState.value = 'error'
      connectionTestMessage.value = error instanceof Error ? error.message : String(error)
    }
  }
  return { modelOptions, modelLoading, connectionTestState, connectionTestMessage, isMockProvider,
    connectionTestMessageView, connectionTestDisabled, connectionTestTip, refreshModelsDisabled, refreshTip,
    refreshModels, testConnection }
}
