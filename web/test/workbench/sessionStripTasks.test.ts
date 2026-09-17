import { describe, expect, it } from 'vitest'
import type { TaskOverview } from '@/services/agentApi'
import {
  buildStripTooltip,
  dismissSessionStripTask,
  EMPTY_SESSION_STRIP_PREFERENCE,
  pickStripTasks,
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
): SessionStripPreference {
  return reconcileSessionStripPreference(preference, tasks, currentChatId)
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
