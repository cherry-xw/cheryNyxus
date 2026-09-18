import { computed, reactive } from 'vue'
import { defineStore } from 'pinia'
import { agentApi, type TaskCatalogItem, type TaskCatalogQuery } from '@/services/agentApi'

type BaseTaskCatalogQuery = Omit<TaskCatalogQuery, 'cursor'>

export interface TaskCatalogState {
  items: TaskCatalogItem[]
  total: number
  snapshotAt?: number
  nextCursor?: string
  loading: boolean
  loadingMore: boolean
  error?: string
}

interface TaskCatalogControl {
  generation: number
  lastQuery?: BaseTaskCatalogQuery
}

const DEFAULT_SCOPE = 'default'

function emptyState(): TaskCatalogState {
  return {
    items: [],
    total: 0,
    loading: false,
    loadingMore: false,
  }
}

export const useTaskCatalogStore = defineStore('taskCatalog', () => {
  const states = reactive<Record<string, TaskCatalogState>>({})
  const controls = new Map<string, TaskCatalogControl>()

  function stateFor(scope = DEFAULT_SCOPE): TaskCatalogState {
    states[scope] ??= emptyState()
    return states[scope]
  }

  function controlFor(scope: string): TaskCatalogControl {
    let control = controls.get(scope)
    if (!control) {
      control = { generation: 0 }
      controls.set(scope, control)
    }
    return control
  }

  const defaultState = computed(() => stateFor())
  const items = computed(() => defaultState.value.items)
  const total = computed(() => defaultState.value.total)
  const snapshotAt = computed(() => defaultState.value.snapshotAt)
  const nextCursor = computed(() => defaultState.value.nextCursor)
  const loading = computed(() => defaultState.value.loading)
  const loadingMore = computed(() => defaultState.value.loadingMore)
  const error = computed(() => defaultState.value.error)

  async function search(query: BaseTaskCatalogQuery, scope = DEFAULT_SCOPE): Promise<void> {
    const state = stateFor(scope)
    const control = controlFor(scope)
    const current = ++control.generation
    control.lastQuery = { ...query }
    state.loading = true
    state.error = undefined
    try {
      const page = await agentApi.listTasks(query)
      if (current !== control.generation) return
      state.items = page.items
      state.total = page.total
      state.snapshotAt = page.snapshotAt
      state.nextCursor = page.nextCursor
    } catch (cause) {
      if (current !== control.generation) return
      state.error = cause instanceof Error ? cause.message : '任务列表加载失败'
    } finally {
      if (current === control.generation) state.loading = false
    }
  }

  async function loadMore(scope = DEFAULT_SCOPE): Promise<void> {
    const state = stateFor(scope)
    const control = controlFor(scope)
    const cursor = state.nextCursor
    if (!cursor || state.loadingMore) return
    const current = control.generation
    state.loadingMore = true
    state.error = undefined
    try {
      const page = await agentApi.listTasks({ cursor, limit: control.lastQuery?.limit })
      if (current !== control.generation || cursor !== state.nextCursor) return
      const seen = new Set(state.items.map((item) => item.taskKey))
      state.items = [...state.items, ...page.items.filter((item) => !seen.has(item.taskKey))]
      state.total = page.total
      state.snapshotAt = page.snapshotAt
      state.nextCursor = page.nextCursor
    } catch (cause) {
      if (current !== control.generation) return
      state.error = cause instanceof Error ? cause.message : '更多任务加载失败'
    } finally {
      if (current === control.generation) state.loadingMore = false
    }
  }

  async function retry(scope = DEFAULT_SCOPE): Promise<void> {
    const query = controlFor(scope).lastQuery
    if (query) await search(query, scope)
  }

  async function markResultViewed(
    taskKey: string,
    resultId: string,
    scope = DEFAULT_SCOPE,
  ): Promise<boolean> {
    const response = await agentApi.markTaskResultViewed(taskKey, resultId)
    if (!response.viewed) return false
    const state = stateFor(scope)
    state.items = state.items.map((item) =>
      item.taskKey === taskKey && item.latestResult?.resultId === resultId
        ? { ...item, unreadResult: false }
        : item,
    )
    return true
  }

  function removeTask(taskKey: string, scope = DEFAULT_SCOPE): void {
    const state = stateFor(scope)
    const next = state.items.filter((item) => item.taskKey !== taskKey)
    if (next.length === state.items.length) return
    state.items = next
    state.total = Math.max(0, state.total - 1)
  }

  async function archiveTask(
    taskKey: string,
    originalChatId: string,
    scope = DEFAULT_SCOPE,
  ): Promise<void> {
    await agentApi.archiveChat(originalChatId)
    removeTask(taskKey, scope)
  }

  function reset(scope = DEFAULT_SCOPE): void {
    const control = controlFor(scope)
    control.generation += 1
    control.lastQuery = undefined
    states[scope] = emptyState()
  }

  return {
    states,
    stateFor,
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
    removeTask,
    archiveTask,
    reset,
  }
})
