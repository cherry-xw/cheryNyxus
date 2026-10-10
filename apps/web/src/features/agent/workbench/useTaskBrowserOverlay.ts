import { computed, reactive, type ComputedRef } from 'vue'
import type { TaskOverview } from '@/application/backend/public'
import {
  matchesCurrentTask,
  matchesSessionStripPreset,
  type TaskBrowserOpenRequest,
} from './useSessionStripTasks'

interface TaskBrowserOverlayState {
  open: boolean
  entryFocus: TaskBrowserOpenRequest['focus']
  revision: number
}

const states = reactive<Record<string, TaskBrowserOverlayState>>({})

function stateFor(windowId: string): TaskBrowserOverlayState {
  return (states[windowId] ??= { open: false, entryFocus: 'all', revision: 0 })
}

export function taskBrowserCatalogScope(
  windowId: string,
  presetId?: string,
  presetName?: string,
): string {
  return presetId ? `${windowId}:id:${presetId}` : `${windowId}:name:${presetName ?? 'unknown'}`
}

export function canMarkTaskResultViewed(input: {
  task?: TaskOverview
  currentChatId?: string | null
  loadedChatId?: string | null
  loading: boolean
  foreground: boolean
  taskBrowserOpen: boolean
}): input is typeof input & {
  task: TaskOverview & { latestResult: NonNullable<TaskOverview['latestResult']> }
} {
  return !!(
    input.task?.unreadResult &&
    input.task.latestResult &&
    matchesCurrentTask(input.task, input.currentChatId ?? undefined) &&
    matchesCurrentTask(input.task, input.loadedChatId ?? undefined) &&
    !input.loading &&
    input.foreground &&
    !input.taskBrowserOpen
  )
}

export function taskAfterArchive(input: {
  tasks: TaskOverview[]
  taskKey: string
  archivedChatIds: string[]
  activeChatIdAtStart?: string
  currentChatId?: string | null
  presetId?: string
  presetName?: string
}): { change: false } | { change: true; chatId: string | null } {
  if (
    !input.activeChatIdAtStart ||
    !input.archivedChatIds.includes(input.activeChatIdAtStart) ||
    (input.currentChatId && !input.archivedChatIds.includes(input.currentChatId))
  ) {
    return { change: false }
  }
  const next = input.tasks
    .filter(
      (task) =>
        task.taskKey !== input.taskKey &&
        matchesSessionStripPreset(task, input.presetId, input.presetName),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  return { change: true, chatId: next?.openChatId ?? null }
}

export function useTaskBrowserOverlay(windowId: string): {
  state: ComputedRef<TaskBrowserOverlayState>
  open: (request: TaskBrowserOpenRequest) => void
  close: () => void
  toggle: (request: TaskBrowserOpenRequest) => void
  dispose: () => void
} {
  const state = computed(() => stateFor(windowId))

  function open(request: TaskBrowserOpenRequest): void {
    const current = stateFor(windowId)
    current.entryFocus = request.focus
    current.revision += 1
    current.open = true
  }

  function close(): void {
    stateFor(windowId).open = false
  }

  function toggle(request: TaskBrowserOpenRequest): void {
    if (stateFor(windowId).open) close()
    else open(request)
  }

  function dispose(): void {
    delete states[windowId]
  }

  return { state, open, close, toggle, dispose }
}
