import { describe, expect, it } from 'vitest'
import type { TaskOverview } from '@/services/agentApi'
import {
  buildStripTooltip,
  dismissSessionStripTask,
  EMPTY_SESSION_STRIP_PREFERENCE,
  pickStripTasks,
  projectSessionStripTask,
  promoteSessionStripTask,
  reconcileSessionStripPreference,
  SESSION_STRIP_STABLE_SLOTS,
  sessionStripStatusIcon,
  sessionStripStatusLabel,
  taskIconIndex,
  type SessionStripPreference,
} from '@/features/agent/workbench/useSessionStripTasks'

function task(partial: Partial<TaskOverview> & { rootChatId: string }): TaskOverview {
  return {
    rootChatId: partial.rootChatId,
    taskKey: partial.taskKey ?? partial.rootChatId,
    originalChatId: partial.originalChatId ?? partial.rootChatId,
    openChatId: partial.openChatId ?? partial.rootChatId,
    title: partial.title ?? partial.rootChatId,
    status: partial.status ?? 'completed',
    updatedAt: partial.updatedAt ?? 0,
    pendingCount: partial.pendingCount ?? 0,
    hasFailure: partial.hasFailure ?? false,
    agents: partial.agents ?? [],
    recentEvents: partial.recentEvents ?? [],
    branchCount: partial.branchCount ?? 1,
    unreadResult: partial.unreadResult ?? false,
    attentionKey: partial.attentionKey ?? `attention-${partial.rootChatId}`,
    ...(partial.taskId ? { taskId: partial.taskId } : {}),
    ...(partial.presetId ? { presetId: partial.presetId } : {}),
    ...(partial.preset ? { preset: partial.preset } : {}),
    ...(partial.lastUserPrompt ? { lastUserPrompt: partial.lastUserPrompt } : {}),
    ...(partial.startedAt ? { startedAt: partial.startedAt } : {}),
    ...(partial.currentStep ? { currentStep: partial.currentStep } : {}),
    ...(partial.latestResult ? { latestResult: partial.latestResult } : {}),
  }
}

function reconcile(
  tasks: TaskOverview[],
  currentChatId?: string,
  preference: SessionStripPreference = EMPTY_SESSION_STRIP_PREFERENCE,
  knownChatIds?: ReadonlySet<string>,
): SessionStripPreference {
  return reconcileSessionStripPreference(preference, tasks, currentChatId, knownChatIds)
}

describe('stable session strip preferences', () => {
  it('appends eligible tasks once and never reorders them after progress or completion', () => {
    const first = task({ rootChatId: 'first', status: 'running', updatedAt: 20 })
    const second = task({ rootChatId: 'second', status: 'needs_user', updatedAt: 10 })
    const initial = reconcile([first, second])
    expect(initial.slots.map((slot) => slot.taskKey)).toEqual(['first', 'second'])

    const updated = reconcile(
      [
        { ...second, status: 'completed', unreadResult: false, updatedAt: 100 },
        { ...first, status: 'completed', unreadResult: false, updatedAt: 30 },
      ],
      undefined,
      initial,
    )
    expect(updated.slots.map((slot) => slot.taskKey)).toEqual(['first', 'second'])
  })

  it('keeps five stable slots and does not evict them for a newer task', () => {
    const initialTasks = Array.from({ length: SESSION_STRIP_STABLE_SLOTS }, (_, index) =>
      task({ rootChatId: `slot-${index}`, status: 'running', updatedAt: 100 - index }),
    )
    const initial = reconcile(initialTasks)
    const next = reconcile(
      [task({ rootChatId: 'newest', status: 'needs_user', updatedAt: 999 }), ...initialTasks],
      undefined,
      initial,
    )

    expect(next.slots.map((slot) => slot.taskKey)).toEqual(
      initialTasks.map((item) => item.taskKey),
    )
  })

  it('does not evict a pinned task that became idle when a newer task arrives while full', () => {
    // 5 个槽位占满：4 个运行中 + 1 个随后结束（completed）。
    const busy = Array.from({ length: SESSION_STRIP_STABLE_SLOTS - 1 }, (_, index) =>
      task({ rootChatId: `busy-${index}`, status: 'running', updatedAt: 100 - index }),
    )
    const pinned = task({ rootChatId: 'pinned', status: 'running', updatedAt: 50 })
    const initial = reconcile([...busy, pinned])
    expect(initial.slots).toHaveLength(SESSION_STRIP_STABLE_SLOTS)

    // pinned 结束变为 completed，同时一个新任务开始运行——设计「不挤掉现有任务」，
    // 已固定的 completed 槽位必须保留，新任务只进“全部任务”入口提醒。
    const finishedPinned = { ...pinned, status: 'completed', unreadResult: false, updatedAt: 200 }
    const newcomer = task({ rootChatId: 'newcomer', status: 'running', updatedAt: 999 })
    const next = reconcile([newcomer, ...busy, finishedPinned], undefined, initial)

    expect(next.slots.map((slot) => slot.taskKey)).toEqual(
      initial.slots.map((slot) => slot.taskKey),
    )
  })

  it('promotes a task only when a stable slot is free and never evicts when full', () => {
    const occupied = Array.from({ length: SESSION_STRIP_STABLE_SLOTS }, (_, index) =>
      task({ rootChatId: `slot-${index}`, status: 'completed', updatedAt: 10 - index }),
    )
    const full = reconcile(occupied.map((item) => ({ ...item, unreadResult: true })))
    const candidate = task({ rootChatId: 'candidate', status: 'running', updatedAt: 99 })

    // 已满：promote 不做任何改动，不挤掉现有任务。
    expect(promoteSessionStripTask(full, projectSessionStripTask(candidate))).toBe(full)

    // 有空位：追加到末尾，并清除该任务已有的“已收起”标记（用户主动提升优先于手动收起）。
    const withRoom = reconcile(
      occupied
        .slice(0, SESSION_STRIP_STABLE_SLOTS - 1)
        .map((item) => ({ ...item, unreadResult: true })),
    )
    const dismissed = dismissSessionStripTask(
      reconcile([]),
      projectSessionStripTask(candidate),
    )
    const promoted = promoteSessionStripTask(withRoom, projectSessionStripTask(candidate))
    expect(promoted.slots.map((slot) => slot.taskKey)).toEqual([
      ...occupied
        .slice(0, SESSION_STRIP_STABLE_SLOTS - 1)
        .map((item) => item.rootChatId),
      'candidate',
    ])
    expect(promoted.dismissedAttentionKeys.candidate).toBeUndefined()
    expect(dismissed.dismissedAttentionKeys.candidate).toBe(candidate.attentionKey)
  })

  it('suppresses the dismissed attention key and allows a new key back', () => {
    const running = task({
      rootChatId: 'task-a',
      status: 'running',
      attentionKey: 'run-1',
    })
    const initial = reconcile([running])
    const dismissed = dismissSessionStripTask(initial, initial.slots[0]!.snapshot)
    expect(dismissed.slots).toHaveLength(0)
    expect(reconcile([running], undefined, dismissed).slots).toHaveLength(0)

    const nextAttention = reconcile(
      [{ ...running, status: 'needs_user', attentionKey: 'question-1', updatedAt: 2 }],
      undefined,
      dismissed,
    )
    expect(nextAttention.slots.map((slot) => slot.taskKey)).toEqual(['task-a'])
  })

  it('keeps a dismissed current task in the supplement until the user switches away', () => {
    const current = task({ rootChatId: 'current', status: 'running', attentionKey: 'run-1' })
    const initial = reconcile([current], 'current')
    const dismissed = dismissSessionStripTask(initial, initial.slots[0]!.snapshot)

    expect(pickStripTasks(dismissed, [current], 'current').items).toMatchObject([
      { taskKey: 'current', source: 'current' },
    ])
    expect(pickStripTasks(dismissed, [current], undefined).items).toHaveLength(0)
  })

  it('removes a saved task when the authoritative chat catalog no longer contains it', () => {
    const stale = task({
      rootChatId: 'deleted',
      status: 'completed',
      unreadResult: true,
    })
    const saved = reconcile([stale])

    const cleaned = reconcile([], undefined, saved, new Set(['remaining']))

    expect(cleaned.slots).toHaveLength(0)
  })

  it('keeps an older completed task when it is omitted from the live overview but still exists', () => {
    const existing = task({
      rootChatId: 'older',
      status: 'completed',
      unreadResult: true,
    })
    const saved = reconcile([existing])

    const preserved = reconcile([], undefined, saved, new Set(['older']))

    expect(preserved.slots.map((slot) => slot.taskKey)).toEqual(['older'])
  })

  it('restores the current task from a saved branch id when live overview no longer contains it', () => {
    const completed = task({
      rootChatId: 'root',
      status: 'completed',
      agents: [{ chatId: 'branch', role: '分支', status: 'completed' }],
    })
    const saved = reconcile([completed], 'branch')

    expect(pickStripTasks(saved, [], 'branch').items).toMatchObject([
      { taskKey: 'root', source: 'stable' },
    ])
  })
})

describe('pickStripTasks', () => {
  const stableTasks = Array.from({ length: SESSION_STRIP_STABLE_SLOTS }, (_, index) =>
    task({ rootChatId: `slot-${index}`, status: 'completed', updatedAt: 100 - index }),
  )
  const preference = reconcile(
    stableTasks.map((item) => ({ ...item, unreadResult: true })),
  )

  it('uses one extra slot for a current task that is not already stable', () => {
    const current = task({ rootChatId: 'current', status: 'completed' })
    const projection = pickStripTasks(preference, [...stableTasks, current], 'current', 6)

    expect(projection.items.map((item) => item.taskKey)).toEqual([
      'slot-0',
      'slot-1',
      'slot-2',
      'slot-3',
      'slot-4',
      'current',
    ])
    expect(projection.items.at(-1)?.source).toBe('current')
  })

  it('does not duplicate a visible current task', () => {
    const projection = pickStripTasks(preference, stableTasks, 'slot-2', 6)
    expect(projection.items.map((item) => item.taskKey)).toEqual([
      'slot-0',
      'slot-1',
      'slot-2',
      'slot-3',
      'slot-4',
    ])
  })

  it('temporarily replaces a hidden stable slot with the current supplement in a narrow window', () => {
    const narrow = pickStripTasks(preference, stableTasks, 'slot-4', 3)
    expect(narrow.items.map((item) => item.taskKey)).toEqual(['slot-0', 'slot-1', 'slot-4'])
    expect(narrow.items.at(-1)?.source).toBe('current')
    expect(narrow.overflowCount).toBe(2)

    const restored = pickStripTasks(preference, stableTasks, 'slot-4', 6)
    expect(restored.items.map((item) => item.taskKey)).toEqual(
      stableTasks.map((item) => item.taskKey),
    )
    expect(preference.slots.map((slot) => slot.taskKey)).toEqual(
      stableTasks.map((item) => item.taskKey),
    )
  })

  it('counts unslotted active work and attention without changing stable positions', () => {
    const overflow = task({ rootChatId: 'overflow', status: 'needs_user', updatedAt: 999 })
    const projection = pickStripTasks(preference, [...stableTasks, overflow], undefined, 5)
    expect(projection.items.map((item) => item.taskKey)).toEqual(
      stableTasks.map((item) => item.taskKey),
    )
    expect(projection.overflowCount).toBe(1)
    expect(projection.attentionCount).toBe(1)
  })

  it('keeps placeholder count within the visible stable capacity across widths', () => {
    const three = reconcile(
      stableTasks.slice(0, 3).map((item) => ({ ...item, unreadResult: true })),
    )
    const extra = task({ rootChatId: 'current', status: 'completed' })

    // 宽窗、当前任务不在槽内：5 稳定槽分配 4 格 + 补位 1 = 5 图标，补齐到 5 的占位 = 2。
    const supplement = pickStripTasks(three, [...stableTasks.slice(0, 3), extra], 'current', 6)
    expect(supplement.items).toHaveLength(4)
    expect(supplement.placeholderCount).toBe(2)

    // 宽窗、当前任务已在槽内：5 个稳定图标无占位。
    const wide = pickStripTasks(preference, stableTasks, 'slot-2', 6)
    expect(wide.items).toHaveLength(5)
    expect(wide.placeholderCount).toBe(0)

    // 窄窗（容量 3）：稳定槽被从末尾隐藏、当前任务补位，占位为 0，不溢出。
    const narrow = pickStripTasks(preference, stableTasks, 'slot-4', 3)
    expect(narrow.items).toHaveLength(3)
    expect(narrow.placeholderCount).toBe(0)
  })
})

describe('session strip presentation helpers', () => {
  it('maps the same task key to the same fixed icon', () => {
    expect(taskIconIndex('stable-task', 8)).toBe(taskIconIndex('stable-task', 8))
    expect(taskIconIndex('stable-task', 8)).toBeGreaterThanOrEqual(0)
    expect(taskIconIndex('stable-task', 8)).toBeLessThan(8)
  })

  it('provides readable labels for every status and a non-rotating running mark', () => {
    const statuses: TaskOverview['status'][] = [
      'idle',
      'needs_user',
      'running',
      'paused',
      'stopped',
      'failed',
      'completed',
    ]
    for (const status of statuses) {
      expect(sessionStripStatusLabel(status)).not.toBe('')
      expect(sessionStripStatusIcon(status)).not.toBe('')
    }
    expect(sessionStripStatusIcon('running')).toBe('◇')
  })

  it('shows latest result and an explicit fallback when result content is absent', () => {
    const finished = task({
      rootChatId: 'done',
      title: '完成任务',
      status: 'completed',
      latestResult: {
        resultId: 'result-1',
        status: 'completed',
        completedAt: 10,
        content: '结果正文',
      },
    })
    const preference = reconcile([{ ...finished, unreadResult: true }])
    const item = pickStripTasks(preference, [finished], 'done').items[0]!
    expect(buildStripTooltip(item)).toMatchObject({
      title: '完成任务',
      detailLabel: '最新结果',
      detail: '结果正文',
      status: '已完成',
    })
    expect(
      buildStripTooltip({
        ...item,
        latestResult: { resultId: 'result-2', status: 'completed', completedAt: 11 },
      }).detail,
    ).toContain('没有可显示')
  })
})
