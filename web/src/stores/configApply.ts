import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ConfigApplyStateSchema, type ConfigApplyState } from '@chery/protocol'
import { agentApi } from '@/services/agentApi'

export const useConfigApplyStore = defineStore('configApply', () => {
  const state = ref<ConfigApplyState>()
  const error = ref<string>()
  let refreshing: Promise<void> | undefined

  const savedRevision = computed(() => state.value?.savedRevision)

  function apply(next: unknown): boolean {
    const parsed = ConfigApplyStateSchema.safeParse(next)
    if (!parsed.success) {
      error.value = '服务器返回了不兼容的设置状态，请刷新或升级客户端'
      return false
    }
    const revisionChanged = parsed.data.savedRevision !== state.value?.savedRevision
    state.value = parsed.data
    error.value = undefined
    return revisionChanged
  }

  function refresh(): Promise<void> {
    if (refreshing) return refreshing
    refreshing = agentApi
      .getConfigApplyState()
      .then((next) => {
        apply(next)
      })
      .catch((cause: unknown) => {
        error.value = cause instanceof Error ? cause.message : '无法读取设置生效状态'
      })
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }

  return { state, savedRevision, error, apply, refresh }
})
