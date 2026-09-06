import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { agentApi, type TaskOverview } from '@/services/agentApi'

export interface TaskOverviewChange {
  type: 'upsert' | 'remove'
  rootChatId: string
  task?: TaskOverview
}

export interface TaskOverviewChangedData {
  subscriptionId: string
  revision: number
  changes: TaskOverviewChange[]
}

const STATUS_PRIORITY: Record<TaskOverview['status'], number> = {
  needs_user: 0,
  failed: 1,
  running: 2,
  paused: 3,
  completed: 4,
}

export const useTaskOverviewStore = defineStore('taskOverview', () => {
  const sessionStartedAt = Date.now()
  const tasksByRoot = ref<Record<string, TaskOverview>>({})
  const subscriptionId = ref<string>()
  const revision = ref(0)
  const loading = ref(false)
  const error = ref<string>()
  const pinnedRootIds = ref<string[]>([])
  let opening: Promise<void> | undefined

  const tasks = computed(() =>
    Object.values(tasksByRoot.value).sort(
      (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || b.updatedAt - a.updatedAt,
    ),
  )
  const pinnedTasks = computed(() =>
    pinnedRootIds.value.flatMap((rootChatId) => {
      const task = tasksByRoot.value[rootChatId]
      return task ? [task] : []
    }),
  )
  const pendingCount = computed(() => tasks.value.reduce((sum, task) => sum + task.pendingCount, 0))
  const runningCount = computed(
    () => tasks.value.filter((task) => task.status === 'running').length,
  )

  async function open(): Promise<void> {
    if (opening) return opening
    opening = (async () => {
      loading.value = true
      try {
        const snapshot = await agentApi.openTaskOverview(sessionStartedAt)
        subscriptionId.value = snapshot.subscriptionId
        revision.value = snapshot.revision
        tasksByRoot.value = Object.fromEntries(
          snapshot.tasks.map((task) => [task.rootChatId, task]),
        )
        error.value = undefined
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : '任务概览加载失败'
        throw cause
      } finally {
        loading.value = false
        opening = undefined
      }
    })()
    return opening
  }

  async function close(): Promise<void> {
    if (opening) await opening.catch(() => undefined)
    const current = subscriptionId.value
    subscriptionId.value = undefined
    revision.value = 0
    if (!current) return
    await agentApi.closeTaskOverview(current)
  }

  function resetSubscription(): void {
    subscriptionId.value = undefined
    revision.value = 0
  }

  async function reopen(): Promise<void> {
    if (opening) await opening.catch(() => undefined)
    const current = subscriptionId.value
    resetSubscription()
    if (current) await agentApi.closeTaskOverview(current).catch(() => undefined)
    await open()
  }

  function applyChanged(data: TaskOverviewChangedData): void {
    if (data.subscriptionId !== subscriptionId.value) return
    if (data.revision !== revision.value + 1) {
      void reopen().catch((cause) => console.warn('[taskOverview] resync failed:', cause))
      return
    }
    const next = { ...tasksByRoot.value }
    for (const change of data.changes) {
      if (change.type === 'remove') delete next[change.rootChatId]
      else if (change.task) next[change.rootChatId] = change.task
    }
    tasksByRoot.value = next
    revision.value = data.revision
  }

  function togglePin(rootChatId: string): boolean {
    if (pinnedRootIds.value.includes(rootChatId)) {
      pinnedRootIds.value = pinnedRootIds.value.filter((id) => id !== rootChatId)
      return true
    }
    if (pinnedRootIds.value.length >= 3 || !tasksByRoot.value[rootChatId]) return false
    pinnedRootIds.value = [...pinnedRootIds.value, rootChatId]
    return true
  }

  return {
    tasksByRoot,
    tasks,
    pinnedRootIds,
    pinnedTasks,
    pendingCount,
    runningCount,
    subscriptionId,
    revision,
    loading,
    error,
    open,
    reopen,
    close,
    resetSubscription,
    applyChanged,
    togglePin,
  }
})
