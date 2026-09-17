import { ref } from 'vue'
import { defineStore } from 'pinia'
import { agentApi, type TaskCatalogItem, type TaskCatalogQuery } from '@/services/agentApi'

type BaseTaskCatalogQuery = Omit<TaskCatalogQuery, 'cursor'>

export const useTaskCatalogStore = defineStore('taskCatalog', () => {
  const items = ref<TaskCatalogItem[]>([])
  const total = ref(0)
  const snapshotAt = ref<number>()
  const nextCursor = ref<string>()
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref<string>()
  let generation = 0
  let lastQuery: BaseTaskCatalogQuery | undefined

  async function search(query: BaseTaskCatalogQuery): Promise<void> {
    const current = ++generation
    lastQuery = { ...query }
    loading.value = true
    error.value = undefined
    try {
      const page = await agentApi.listTasks(query)
      if (current !== generation) return
      items.value = page.items
      total.value = page.total
      snapshotAt.value = page.snapshotAt
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current !== generation) return
      error.value = cause instanceof Error ? cause.message : '任务列表加载失败'
    } finally {
      if (current === generation) loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor.value
    if (!cursor || loadingMore.value) return
    const current = generation
    loadingMore.value = true
    error.value = undefined
    try {
      const page = await agentApi.listTasks({ cursor, limit: lastQuery?.limit })
      if (current !== generation || cursor !== nextCursor.value) return
      const seen = new Set(items.value.map((item) => item.taskKey))
      items.value = [...items.value, ...page.items.filter((item) => !seen.has(item.taskKey))]
      total.value = page.total
      snapshotAt.value = page.snapshotAt
      nextCursor.value = page.nextCursor
    } catch (cause) {
      if (current !== generation) return
      error.value = cause instanceof Error ? cause.message : '更多任务加载失败'
    } finally {
      if (current === generation) loadingMore.value = false
    }
  }

  async function retry(): Promise<void> {
    if (lastQuery) await search(lastQuery)
  }

  async function markResultViewed(taskKey: string, resultId: string): Promise<boolean> {
    const response = await agentApi.markTaskResultViewed(taskKey, resultId)
    if (!response.viewed) return false
    items.value = items.value.map((item) =>
      item.taskKey === taskKey && item.latestResult?.resultId === resultId
        ? { ...item, unreadResult: false }
        : item,
    )
    return true
  }

  function reset(): void {
    generation += 1
    items.value = []
    total.value = 0
    snapshotAt.value = undefined
    nextCursor.value = undefined
    loading.value = false
    loadingMore.value = false
    error.value = undefined
    lastQuery = undefined
  }

  return {
    items,
    total,
    snapshotAt,
    nextCursor,
    loading,
    loadingMore,
    error,
    search,
    loadMore,
    retry,
    markResultViewed,
    reset,
  }
})
