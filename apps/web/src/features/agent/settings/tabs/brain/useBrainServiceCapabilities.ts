import { onScopeDispose, ref, watch } from 'vue'
import { agentApi, type BrainConfigDto } from '@/application/backend/public'
import type { BrainServiceCapabilities, LlmProtocol } from '@chery/protocol'

type CapabilityViewState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'ready'; value: BrainServiceCapabilities }
  | { kind: 'error'; message: string }

/** Only explicit refresh reads records; connection edits invalidate without making a request. */
export function useBrainServiceCapabilities(
  cfg: () => BrainConfigDto,
  protocol: () => LlmProtocol | undefined,
) {
  const state = ref<CapabilityViewState>({ kind: 'idle' })
  const ownerContext = agentApi.contextKey()
  let request = 0
  let disposed = false
  async function refresh(): Promise<void> {
    if (disposed) return
    const id = ++request
    if (agentApi.contextKey() !== ownerContext) {
      state.value = { kind: 'error', message: '后端身份已改变，请重新打开设置。' }
      return
    }
    const current = cfg()
    if (!current.model || !current.provider) {
      state.value = { kind: 'idle' }
      return
    }
    state.value = { kind: 'loading' }
    try {
      const result = await agentApi.getModelRecommendation(
        current.model,
        current.provider,
        protocol(),
        {
          url: current.url,
          key: current.key,
          fullUrl: current.fullUrl,
          capabilities: current.capabilities
            ? JSON.parse(JSON.stringify(current.capabilities))
            : undefined,
        },
      )
      if (disposed || id !== request) return
      if (agentApi.contextKey() !== ownerContext) {
        state.value = { kind: 'error', message: '后端身份已改变，请重新打开设置。' }
        return
      }
      state.value = result.serviceCapabilities
        ? { kind: 'ready', value: result.serviceCapabilities }
        : { kind: 'error', message: '暂时无法读取此连接的能力说明，请稍后刷新。' }
    } catch {
      if (!disposed && id === request)
        state.value = { kind: 'error', message: '能力说明读取失败，请稍后刷新。' }
    }
  }
  watch(
    () => [
      agentApi.contextKey(),
      cfg(),
      cfg().provider,
      protocol(),
      cfg().url,
      cfg().key,
      cfg().model,
      cfg().fullUrl,
    ],
    () => {
      request++
      state.value = { kind: 'idle' }
    },
    { flush: 'sync' },
  )
  onScopeDispose(() => {
    disposed = true
    request++
  })
  return { state, refresh }
}
