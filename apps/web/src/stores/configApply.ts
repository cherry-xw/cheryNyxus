import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { ConfigApplyStateSchema, type ConfigApplyState } from '@chery/protocol'
import { agentApi } from '@/services/agentApi'
import { runSingleFlight } from '@/utils/asyncGuards'

export const useConfigApplyStore = defineStore('configApply', () => {
  let generation = 0
  function resetTarget(): void { generation++; state.value = undefined; error.value = undefined; refreshFlights.clear() }
  const state = ref<ConfigApplyState>()
  const error = ref<string>()
  const refreshFlights = new Map<string, Promise<void>>()

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
    const current = generation
    return runSingleFlight(refreshFlights, 'refresh', () =>
      agentApi
        .getConfigApplyState()
        .then((next) => {
          if (current === generation) apply(next)
        })
        .catch((cause: unknown) => {
          if (current !== generation) return
          error.value = cause instanceof Error ? cause.message : '无法读取设置生效状态'
        }),
    )
  }

  return { resetTarget, state, savedRevision, error, apply, refresh }
})
