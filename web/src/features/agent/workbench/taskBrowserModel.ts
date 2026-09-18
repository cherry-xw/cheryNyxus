import type {
  TaskCatalogItem,
  TaskCatalogQuery,
  TaskOverview,
  TaskOverviewStatus,
  TaskSearchMatch,
} from '@/application/backend/public'

export type TaskBrowserTimeRange = 'all' | 'day' | 'week' | 'month'
export type TaskBrowserSort = NonNullable<TaskCatalogQuery['sort']>

export interface TaskBrowserFilters {
  query: string
  statuses: TaskOverviewStatus[]
  timeRange: TaskBrowserTimeRange
  sort: TaskBrowserSort
  attentionOnly: boolean
}

export interface TaskBrowserTextPart {
  text: string
  highlighted: boolean
}

export interface SavedTaskBrowserState {
  filters: TaskBrowserFilters
  scrollTop: number
}

export const DEFAULT_TASK_BROWSER_FILTERS: TaskBrowserFilters = {
  query: '',
  statuses: [],
  timeRange: 'all',
  sort: 'updated_desc',
  attentionOnly: false,
}

const RANGE_MS: Record<Exclude<TaskBrowserTimeRange, 'all'>, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
}

const STATUSES = new Set<TaskOverviewStatus>([
  'idle',
  'needs_user',
  'running',
  'paused',
  'stopped',
  'failed',
  'completed',
])

export function cloneTaskBrowserFilters(filters: TaskBrowserFilters): TaskBrowserFilters {
  return { ...filters, statuses: [...filters.statuses] }
}

export function parseTaskBrowserFilters(value: unknown): TaskBrowserFilters {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return cloneTaskBrowserFilters(DEFAULT_TASK_BROWSER_FILTERS)
  }
  const candidate = value as Partial<TaskBrowserFilters>
  const statuses = Array.isArray(candidate.statuses)
    ? candidate.statuses.filter((status): status is TaskOverviewStatus => STATUSES.has(status))
    : []
  const timeRange = ['all', 'day', 'week', 'month'].includes(candidate.timeRange ?? '')
    ? (candidate.timeRange as TaskBrowserTimeRange)
    : 'all'
  const sort = ['updated_desc', 'created_desc', 'relevance'].includes(candidate.sort ?? '')
    ? (candidate.sort as TaskBrowserSort)
    : 'updated_desc'
  return {
    query: typeof candidate.query === 'string' ? candidate.query : '',
    statuses: [...new Set(statuses)],
    timeRange,
    sort,
    attentionOnly: candidate.attentionOnly === true,
  }
}

export function parseSavedTaskBrowserState(value: unknown): SavedTaskBrowserState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { filters: cloneTaskBrowserFilters(DEFAULT_TASK_BROWSER_FILTERS), scrollTop: 0 }
  }
  const candidate = value as { filters?: unknown; scrollTop?: unknown }
  return {
    filters: parseTaskBrowserFilters(candidate.filters),
    scrollTop:
      typeof candidate.scrollTop === 'number' && candidate.scrollTop >= 0 ? candidate.scrollTop : 0,
  }
}

export function buildTaskCatalogQuery(
  filters: TaskBrowserFilters,
  identity: { presetId?: string; preset?: string },
  now = Date.now(),
): Omit<TaskCatalogQuery, 'cursor'> {
  const query = filters.query.trim()
  const effectiveSort = query && filters.sort === 'updated_desc' ? 'relevance' : filters.sort
  return {
    ...(identity.presetId ? { presetId: identity.presetId } : {}),
    ...(!identity.presetId && identity.preset ? { preset: identity.preset } : {}),
    ...(query ? { query } : {}),
    ...(filters.statuses.length ? { statuses: filters.statuses } : {}),
    ...(filters.timeRange === 'all' ? {} : { updatedFrom: now - RANGE_MS[filters.timeRange] }),
    sort: effectiveSort,
    limit: 24,
  }
}

function isAttention(item: Pick<TaskCatalogItem, 'status' | 'unreadResult'>): boolean {
  return item.status === 'needs_user' || item.status === 'failed' || item.unreadResult
}

export function visibleTaskBrowserItems(
  items: TaskCatalogItem[],
  filters: TaskBrowserFilters,
): TaskCatalogItem[] {
  return filters.attentionOnly ? items.filter(isAttention) : items
}

export function mergeTaskBrowserUpdates(
  items: TaskCatalogItem[],
  overviewTasks: TaskOverview[],
): TaskCatalogItem[] {
  const live = new Map(overviewTasks.map((task) => [task.taskKey, task]))
  return items.map((item) => {
    const task = live.get(item.taskKey)
    if (!task) return item
    return {
      ...item,
      taskId: task.taskId ?? item.taskId,
      originalChatId: task.originalChatId,
      openChatId: task.openChatId,
      title: task.title,
      lastUserPrompt: task.lastUserPrompt,
      status: task.status,
      currentStep: task.currentStep,
      latestResult: task.latestResult,
      unreadResult: task.unreadResult,
      attentionKey: task.attentionKey,
      updatedAt: task.updatedAt,
      branchCount: task.branchCount,
    }
  })
}

export function countNewTaskBrowserItems(
  items: TaskCatalogItem[],
  overviewTasks: TaskOverview[],
  identity: { presetId?: string; preset?: string },
): number {
  const loaded = new Set(items.map((item) => item.taskKey))
  return overviewTasks.filter((task) => {
    if (loaded.has(task.taskKey)) return false
    if (identity.presetId && task.presetId === identity.presetId) return true
    return !identity.presetId && !!identity.preset && task.preset === identity.preset
  }).length
}

export function taskBrowserStatusLabel(status: TaskOverviewStatus): string {
  return {
    idle: '空闲',
    needs_user: '等待处理',
    running: '运行中',
    paused: '已暂停',
    stopped: '已停止',
    failed: '失败',
    completed: '已完成',
  }[status]
}

export function taskBrowserDetail(item: TaskCatalogItem): {
  label: string
  content: string
} {
  if (item.status === 'running' || item.status === 'needs_user') {
    return {
      label: item.status === 'needs_user' ? '等待处理' : '当前进展',
      content:
        item.currentStep?.trim() ||
        (item.status === 'needs_user' ? '任务正在等待你的处理。' : '任务正在运行，暂无步骤说明。'),
    }
  }
  if (item.latestResult) {
    return {
      label: item.latestResult.status === 'failed' ? '失败说明' : '最新结果',
      content:
        item.latestResult.content?.trim() ||
        (item.latestResult.status === 'failed'
          ? '任务失败，但没有可安全显示的失败说明。'
          : '任务已结束，但没有可显示的结果内容。'),
    }
  }
  return { label: '当前进展', content: '暂无可显示的进展或结果。' }
}

export function taskSearchSourceLabel(source: TaskSearchMatch['source']): string {
  return { title: '标题', user_prompt: '用户提问', result: '任务结果' }[source]
}

export function splitHighlightedText(
  text: string,
  highlights: TaskSearchMatch['highlights'],
): TaskBrowserTextPart[] {
  const ranges = highlights
    .map(({ start, end }) => ({
      start: Math.max(0, Math.min(text.length, start)),
      end: Math.max(0, Math.min(text.length, end)),
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }

  const parts: TaskBrowserTextPart[] = []
  let cursor = 0
  for (const range of merged) {
    if (range.start > cursor)
      parts.push({ text: text.slice(cursor, range.start), highlighted: false })
    parts.push({ text: text.slice(range.start, range.end), highlighted: true })
    cursor = range.end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false })
  return parts.length ? parts : [{ text, highlighted: false }]
}
