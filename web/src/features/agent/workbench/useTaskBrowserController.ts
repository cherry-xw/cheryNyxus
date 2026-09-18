import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, type Ref } from 'vue'
import { useTaskCatalogStore, useTaskOverviewStore } from '@/application/public'
import type { TaskCatalogItem } from '@/application/backend/public'
import {
  buildTaskCatalogQuery,
  cloneTaskBrowserFilters,
  countNewTaskBrowserItems,
  DEFAULT_TASK_BROWSER_FILTERS,
  mergeTaskBrowserUpdates,
  parseSavedTaskBrowserState,
  visibleTaskBrowserItems,
  type SavedTaskBrowserState,
} from './taskBrowserModel'
import {
  dismissSessionStripTask,
  SESSION_STRIP_STABLE_SLOTS,
  type SessionStripItem,
} from './useSessionStripTasks'
import { useSessionStripPreferences } from './useSessionStripPreferences'

interface TaskBrowserOptions {
  scope: Ref<string>
  preferenceScope: Ref<string>
  presetId: Ref<string | undefined>
  presetName: Ref<string | undefined>
  activeChatId: Ref<string | null | undefined>
  entryFocus: Ref<'all' | 'attention'>
  onOpenTask: (chatId: string) => void
  onArchived?: (taskKey: string, archivedChatIds: string[], activeChatIdAtStart?: string) => void
}

const STORAGE_PREFIX = 'chery:workbench-task-browser:'

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}`
}

function readSaved(scope: string): SavedTaskBrowserState {
  try {
    if (typeof localStorage === 'undefined') throw new Error('storage unavailable')
    const parsed = JSON.parse(localStorage.getItem(storageKey(scope)) ?? 'null') as unknown
    return parseSavedTaskBrowserState(parsed)
  } catch {
    return parseSavedTaskBrowserState(undefined)
  }
}

function writeSaved(scope: string, saved: SavedTaskBrowserState): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(storageKey(scope), JSON.stringify(saved))
    }
  } catch {
    // 持久化不可用时，当前组件实例仍可正常使用。
  }
}

function toStripItem(item: TaskCatalogItem): SessionStripItem {
  return {
    taskKey: item.taskKey,
    rootChatId: item.originalChatId,
    originalChatId: item.originalChatId,
    openChatId: item.openChatId,
    relatedChatIds: [],
    title: item.title,
    ...(item.lastUserPrompt ? { lastUserPrompt: item.lastUserPrompt } : {}),
    status: item.status,
    ...(item.currentStep ? { currentStep: item.currentStep } : {}),
    ...(item.latestResult ? { latestResult: { ...item.latestResult } } : {}),
    unreadResult: item.unreadResult,
    attentionKey: item.attentionKey,
    pendingCount: item.status === 'needs_user' ? 1 : 0,
    updatedAt: item.updatedAt,
  }
}

export function useTaskBrowserController(options: TaskBrowserOptions) {
  const catalog = useTaskCatalogStore()
  const overview = useTaskOverviewStore()
  const { preference, setPreference } = useSessionStripPreferences(options.preferenceScope)
  const initialSaved = readSaved(options.scope.value)
  const filters = ref(
    options.entryFocus.value === 'attention'
      ? { ...cloneTaskBrowserFilters(initialSaved.filters), attentionOnly: true }
      : cloneTaskBrowserFilters(initialSaved.filters),
  )
  const savedScrollTop = ref(initialSaved.scrollTop)
  const archivingKeys = shallowRef<Set<string>>(new Set())
  const actionErrors = ref<Record<string, string>>({})

  const state = computed(() => catalog.stateFor(options.scope.value))
  const identity = computed(() => ({
    presetId: options.presetId.value,
    preset: options.presetName.value,
  }))
  const updatedItems = computed(() => mergeTaskBrowserUpdates(state.value.items, overview.tasks))
  const items = computed(() => visibleTaskBrowserItems(updatedItems.value, filters.value))
  const newContentCount = computed(() =>
    countNewTaskBrowserItems(state.value.items, overview.tasks, identity.value),
  )
  const shortcutKeys = computed(() => new Set(preference.value.slots.map((slot) => slot.taskKey)))
  const hasMore = computed(() => !!state.value.nextCursor)

  async function refresh(saveAsNormal = true): Promise<void> {
    if (!options.presetId.value && !options.presetName.value) return
    if (saveAsNormal) {
      writeSaved(options.scope.value, {
        filters: cloneTaskBrowserFilters(filters.value),
        scrollTop: savedScrollTop.value,
      })
    }
    await catalog.search(buildTaskCatalogQuery(filters.value, identity.value), options.scope.value)
  }

  function applyFilters(): void {
    void refresh(true)
  }

  function clearFilters(): void {
    filters.value = cloneTaskBrowserFilters(DEFAULT_TASK_BROWSER_FILTERS)
    void refresh(true)
  }

  function showAllTasks(): void {
    filters.value.attentionOnly = false
    void refresh(true)
  }

  function openTask(item: TaskCatalogItem): void {
    options.onOpenTask(item.openChatId)
  }

  function toggleShortcut(item: TaskCatalogItem): void {
    delete actionErrors.value[item.taskKey]
    const existing = preference.value.slots.some((slot) => slot.taskKey === item.taskKey)
    const stripItem = toStripItem(item)
    if (existing) {
      setPreference(dismissSessionStripTask(preference.value, stripItem))
      return
    }
    if (preference.value.slots.length >= SESSION_STRIP_STABLE_SLOTS) {
      actionErrors.value[item.taskKey] = '标题栏快捷位已满，请先收起一个任务。'
      return
    }
    setPreference({
      ...preference.value,
      slots: [...preference.value.slots, { taskKey: item.taskKey, snapshot: stripItem }],
      dismissedAttentionKeys: Object.fromEntries(
        Object.entries(preference.value.dismissedAttentionKeys).filter(
          ([taskKey]) => taskKey !== item.taskKey,
        ),
      ),
    })
  }

  async function archiveTask(item: TaskCatalogItem): Promise<void> {
    if (archivingKeys.value.has(item.taskKey)) return
    const activeChatIdAtStart = options.activeChatId.value ?? undefined
    const liveTask = overview.tasks.find((task) => task.taskKey === item.taskKey)
    const archivedChatIds = [
      item.taskKey,
      item.originalChatId,
      item.openChatId,
      ...(liveTask?.agents.map((agent) => agent.chatId) ?? []),
    ]
    archivingKeys.value = new Set(archivingKeys.value).add(item.taskKey)
    delete actionErrors.value[item.taskKey]
    try {
      await catalog.archiveTask(item.taskKey, item.originalChatId, options.scope.value)
      if (shortcutKeys.value.has(item.taskKey)) {
        setPreference(dismissSessionStripTask(preference.value, toStripItem(item)))
      }
      options.onArchived?.(item.taskKey, [...new Set(archivedChatIds)], activeChatIdAtStart)
    } catch (cause) {
      actionErrors.value[item.taskKey] =
        cause instanceof Error ? cause.message : '归档失败，请稍后重试。'
    } finally {
      const next = new Set(archivingKeys.value)
      next.delete(item.taskKey)
      archivingKeys.value = next
    }
  }

  function rememberScroll(element: HTMLElement): void {
    savedScrollTop.value = element.scrollTop
  }

  async function restoreScroll(element: HTMLElement): Promise<void> {
    await nextTick()
    element.scrollTop = savedScrollTop.value
  }

  function saveCurrentState(): void {
    if (options.entryFocus.value === 'attention' && filters.value.attentionOnly) return
    writeSaved(options.scope.value, {
      filters: cloneTaskBrowserFilters(filters.value),
      scrollTop: savedScrollTop.value,
    })
  }

  onMounted(() => void refresh(false))
  onBeforeUnmount(saveCurrentState)

  return {
    state,
    filters,
    items,
    newContentCount,
    shortcutKeys,
    archivingKeys,
    actionErrors,
    hasMore,
    refresh,
    applyFilters,
    clearFilters,
    showAllTasks,
    openTask,
    toggleShortcut,
    archiveTask,
    loadMore: () => catalog.loadMore(options.scope.value),
    retry: () => catalog.retry(options.scope.value),
    rememberScroll,
    restoreScroll,
  }
}
