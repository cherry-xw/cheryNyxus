/**
 * 工作台标题栏任务快捷位的纯逻辑。
 *
 * 稳定位置只按 taskKey 保存；实时概要覆盖保存快照，但普通步骤推进不会改变位置。
 * 本文件无 Vue/DOM 依赖，窗口缩窄、当前任务补位和再次提醒规则可直接单测。
 */
import type { TaskOverview, TaskOverviewStatus } from '@/application/backend/public'

type TaskLatestResult = NonNullable<TaskOverview['latestResult']>

export const SESSION_STRIP_STABLE_SLOTS = 5
export const SESSION_STRIP_MAX_VISIBLE_TASKS = 6

export interface SessionStripItem {
  taskKey: string
  rootChatId: string
  originalChatId: string
  openChatId: string
  relatedChatIds: string[]
  title: string
  lastUserPrompt?: string
  status: TaskOverviewStatus
  currentStep?: string
  latestResult?: TaskLatestResult
  unreadResult: boolean
  attentionKey: string
  pendingCount: number
  updatedAt: number
}

export interface SessionStripSlot {
  taskKey: string
  snapshot: SessionStripItem
}

export interface SessionStripPreference {
  version: 1
  slots: SessionStripSlot[]
  dismissedAttentionKeys: Record<string, string>
}

export interface SessionStripProjection {
  items: Array<SessionStripItem & { source: 'stable' | 'current'; ghost?: boolean }>
  overflowCount: number
  attentionCount: number
}

export interface TaskBrowserOpenRequest {
  focus: 'all' | 'attention'
}

export const EMPTY_SESSION_STRIP_PREFERENCE: SessionStripPreference = {
  version: 1,
  slots: [],
  dismissedAttentionKeys: {},
}

export function matchesSessionStripPreset(
  task: TaskOverview,
  presetId?: string,
  presetName?: string,
): boolean {
  if (!presetId && !presetName) return true
  return (
    (presetId ? task.presetId === presetId : false) ||
    (presetName ? task.preset === presetName : false)
  )
}

export function projectSessionStripTask(task: TaskOverview): SessionStripItem {
  return {
    taskKey: task.taskKey,
    rootChatId: task.rootChatId,
    originalChatId: task.originalChatId,
    openChatId: task.openChatId,
    relatedChatIds: [...new Set(task.agents.map((agent) => agent.chatId))],
    title: task.title,
    ...(task.lastUserPrompt ? { lastUserPrompt: task.lastUserPrompt } : {}),
    status: task.status,
    ...(task.currentStep ? { currentStep: task.currentStep } : {}),
    ...(task.latestResult ? { latestResult: { ...task.latestResult } } : {}),
    unreadResult: task.unreadResult,
    attentionKey: task.attentionKey,
    pendingCount: task.pendingCount,
    updatedAt: task.updatedAt,
  }
}

export function matchesCurrentTask(
  task: SessionStripItem | TaskOverview,
  currentChatId?: string,
): boolean {
  if (!currentChatId) return false
  return (
    task.taskKey === currentChatId ||
    task.rootChatId === currentChatId ||
    task.originalChatId === currentChatId ||
    task.openChatId === currentChatId ||
    ('agents' in task
      ? task.agents.some((agent) => agent.chatId === currentChatId)
      : task.relatedChatIds.includes(currentChatId))
  )
}

function needsStableSlot(task: TaskOverview, currentChatId?: string): boolean {
  return (
    matchesCurrentTask(task, currentChatId) ||
    task.status === 'running' ||
    task.status === 'needs_user' ||
    task.unreadResult
  )
}

function needsAttention(task: SessionStripItem | TaskOverview): boolean {
  return task.status === 'needs_user' || task.status === 'failed' || task.unreadResult
}

function snapshotChanged(snapshot: SessionStripItem, task: TaskOverview): boolean {
  return (
    snapshot.attentionKey !== task.attentionKey ||
    snapshot.openChatId !== task.openChatId ||
    snapshot.relatedChatIds.join('\0') !== task.agents.map((agent) => agent.chatId).join('\0') ||
    snapshot.title !== task.title ||
    snapshot.lastUserPrompt !== task.lastUserPrompt ||
    snapshot.status !== task.status ||
    snapshot.unreadResult !== task.unreadResult
  )
}

/**
 * 追加首次需要展示的任务并刷新必要快照。已有槽位绝不因状态、更新时间或查看结果而重排。
 */
export function reconcileSessionStripPreference(
  preference: SessionStripPreference,
  tasks: TaskOverview[],
  currentChatId?: string,
): SessionStripPreference {
  const liveByKey = new Map(tasks.map((task) => [task.taskKey, task]))
  const seen = new Set<string>()
  const dismissedAttentionKeys = { ...preference.dismissedAttentionKeys }
  const slots = preference.slots.flatMap((slot) => {
    if (seen.has(slot.taskKey) || seen.size >= SESSION_STRIP_STABLE_SLOTS) return []
    seen.add(slot.taskKey)
    const live = liveByKey.get(slot.taskKey)
    return [
      live && snapshotChanged(slot.snapshot, live)
        ? { taskKey: slot.taskKey, snapshot: projectSessionStripTask(live) }
        : slot,
    ]
  })

  const candidates = tasks
    .filter((task) => needsStableSlot(task, currentChatId))
    .sort((a, b) => {
      const priority = (task: TaskOverview) =>
        task.status === 'running' ? 0 : task.status === 'needs_user' || task.unreadResult ? 1 : 2
      return priority(a) - priority(b) || b.updatedAt - a.updatedAt || a.taskKey.localeCompare(b.taskKey)
    })

  for (const task of candidates) {
    if (seen.has(task.taskKey)) continue
    if (dismissedAttentionKeys[task.taskKey] === task.attentionKey) continue
    if (slots.length >= SESSION_STRIP_STABLE_SLOTS) {
      const replaceIndex = slots.findLastIndex(
        (slot) =>
          slot.snapshot.status !== 'running' &&
          !slot.snapshot.unreadResult &&
          slot.snapshot.status !== 'needs_user',
      )
      if (replaceIndex < 0 || (task.status !== 'running' && !task.unreadResult && task.status !== 'needs_user')) continue
      seen.delete(slots[replaceIndex]!.taskKey)
      slots[replaceIndex] = { taskKey: task.taskKey, snapshot: projectSessionStripTask(task) }
      seen.add(task.taskKey)
      continue
    }
    slots.push({ taskKey: task.taskKey, snapshot: projectSessionStripTask(task) })
    seen.add(task.taskKey)
    delete dismissedAttentionKeys[task.taskKey]
  }

  return {
    version: 1,
    slots,
    dismissedAttentionKeys,
  }
}

export function dismissSessionStripTask(
  preference: SessionStripPreference,
  item: SessionStripItem,
): SessionStripPreference {
  return {
    version: 1,
    slots: preference.slots.filter((slot) => slot.taskKey !== item.taskKey),
    dismissedAttentionKeys: {
      ...preference.dismissedAttentionKeys,
      [item.taskKey]: item.attentionKey,
    },
  }
}

/** 将用户从“全部任务”主动打开的任务提升到标题栏固定槽位。 */
export function promoteSessionStripTask(
  preference: SessionStripPreference,
  item: SessionStripItem,
): SessionStripPreference {
  if (preference.slots.some((slot) => slot.taskKey === item.taskKey)) return preference
  if (preference.slots.length < SESSION_STRIP_STABLE_SLOTS) {
    return { ...preference, slots: [...preference.slots, { taskKey: item.taskKey, snapshot: item }] }
  }
  const replaceIndex = preference.slots.findLastIndex(
    (slot) =>
      slot.snapshot.status !== 'running' &&
      !slot.snapshot.unreadResult &&
      slot.snapshot.status !== 'needs_user',
  )
  if (replaceIndex < 0) return preference
  const slots = preference.slots.slice()
  slots[replaceIndex] = { taskKey: item.taskKey, snapshot: item }
  return { ...preference, slots }
}

/**
 * 投影当前可见项。visibleCapacity 是“全部任务”入口之外可容纳的任务图标数。
 * 当前任务不在可见稳定槽时占用末尾补位，恢复宽度后回到自己的原槽。
 */
export function pickStripTasks(
  preference: SessionStripPreference,
  tasks: TaskOverview[],
  currentChatId?: string,
  visibleCapacity = SESSION_STRIP_MAX_VISIBLE_TASKS,
  currentItem?: SessionStripItem,
): SessionStripProjection {
  const capacity = Math.max(0, Math.min(SESSION_STRIP_STABLE_SLOTS, visibleCapacity))
  const liveByKey = new Map(tasks.map((task) => [task.taskKey, projectSessionStripTask(task)]))
  const stable = preference.slots.map((slot) => liveByKey.get(slot.taskKey) ?? slot.snapshot)
  const liveCurrent = tasks.find((task) => matchesCurrentTask(task, currentChatId))
  const current = liveCurrent
    ? projectSessionStripTask(liveCurrent)
    : currentItem ?? stable.find((item) => matchesCurrentTask(item, currentChatId))

  const visibleStable = stable.slice(0, capacity)
  const items: SessionStripProjection['items'] = visibleStable.map((item) => ({ ...item, source: 'stable' }))

  if (current && !items.some((item) => item.taskKey === current.taskKey) && capacity > 0) {
    const replaceIndex = items.findLastIndex(
      (item) => item.status !== 'running' && !item.unreadResult,
    )
    if (items.length < capacity) {
      items.push({ ...current, source: 'current' })
    } else if (replaceIndex >= 0) {
      items[replaceIndex] = { ...current, source: 'current' }
    } else {
      // 五个槽位都被运行中或未读结果占用时，当前任务只能以虚影入口保留。
      items.push({ ...current, source: 'current', ghost: true })
    }
  }

  const visibleKeys = new Set(items.map((item) => item.taskKey))
  const relevantKeys = new Set(
    [...stable, ...tasks.map(projectSessionStripTask)]
      .filter((item) => item.status === 'running' || item.unreadResult)
      .map((item) => item.taskKey),
  )

  return {
    items,
    overflowCount: [...relevantKeys].filter((taskKey) => !visibleKeys.has(taskKey)).length,
    attentionCount: tasks.filter(needsAttention).length,
  }
}

export function sessionStripStatusLabel(status: TaskOverviewStatus): string {
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

export function sessionStripStatusIcon(status: TaskOverviewStatus): string {
  return {
    idle: '·',
    needs_user: '!',
    running: '◇',
    paused: 'Ⅱ',
    stopped: '■',
    failed: '×',
    completed: '✓',
  }[status]
}

export function taskIconIndex(taskKey: string, iconCount: number): number {
  let hash = 2166136261
  for (let index = 0; index < taskKey.length; index += 1) {
    hash ^= taskKey.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return iconCount > 0 ? (hash >>> 0) % iconCount : 0
}

export function buildStripTooltip(item: SessionStripItem): {
  title: string
  lastPrompt: string
  detailLabel: string
  detail: string
  status: string
} {
  const result = item.latestResult?.content?.trim()
  const showsResult =
    item.status !== 'running' && item.status !== 'needs_user' && !!item.latestResult
  return {
    title: item.title || '未命名任务',
    lastPrompt: item.lastUserPrompt || '暂无最近要求',
    detailLabel: showsResult ? '最新结果' : '当前步骤',
    detail: showsResult
      ? result || '本次任务已结束，但没有可显示的结果内容'
      : item.currentStep || (item.status === 'needs_user' ? '等待你处理' : '暂无步骤信息'),
    status: sessionStripStatusLabel(item.status),
  }
}
