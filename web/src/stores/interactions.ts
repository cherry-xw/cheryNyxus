import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { agentApi, type InteractionRecord } from '@/services/agentApi'

export const useInteractionsStore = defineStore('interactions', () => {
  const records = ref<Record<string, InteractionRecord>>({})
  const loading = ref(false)
  const error = ref<string>()

  const all = computed(() => Object.values(records.value))
  const pending = computed(() =>
    all.value.filter((item) => ['pending', 'resolving', 'blocked'].includes(item.status)),
  )
  const activity = computed(() =>
    all.value
      .filter((item) => !['pending', 'resolving', 'blocked'].includes(item.status))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  )

  function install(items: InteractionRecord[]): void {
    records.value = Object.fromEntries(items.map((item) => [item.interactionId, item]))
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      install(await agentApi.listInteractions({ includeActivity: true }))
      error.value = undefined
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '待处理交互加载失败'
      throw cause
    } finally {
      loading.value = false
    }
  }

  async function decide(item: InteractionRecord, action: 'accept' | 'reject'): Promise<void> {
    records.value[item.interactionId] = { ...item, status: 'resolving' }
    try {
      const next = await agentApi.decideInteractionApproval({
        interactionId: item.interactionId,
        action,
        expectedRevision: item.revision,
        commandId: crypto.randomUUID(),
      })
      records.value[next.interactionId] = next
    } catch (cause) {
      await refresh().catch(() => undefined)
      throw cause
    }
  }

  async function answer(
    item: InteractionRecord,
    answers: Parameters<typeof agentApi.answerInteractionQuestion>[0]['answers'],
  ): Promise<void> {
    records.value[item.interactionId] = { ...item, status: 'resolving' }
    try {
      const next = await agentApi.answerInteractionQuestion({
        interactionId: item.interactionId,
        expectedRevision: item.revision,
        commandId: crypto.randomUUID(),
        answers,
      })
      records.value[next.interactionId] = next
    } catch (cause) {
      await refresh().catch(() => undefined)
      throw cause
    }
  }

  return { records, all, pending, activity, loading, error, refresh, decide, answer }
})
