import { describe, expect, it } from 'vitest'
import type { TaskOverview } from '@/services/agentApi'
import {
  buildStripTooltip,
  currentNodeLabel,
  pickStripTasks,
  SESSION_STRIP_MAX_ICONS,
} from '@/features/agent/workbench/useSessionStripTasks'

function task(partial: Partial<TaskOverview> & { rootChatId: string }): TaskOverview {
  return {
    rootChatId: partial.rootChatId,
    title: partial.title ?? '任务',
    status: partial.status ?? 'completed',
    updatedAt: partial.updatedAt ?? 0,
    pendingCount: partial.pendingCount ?? 0,
    hasFailure: partial.hasFailure ?? false,
    agents: partial.agents ?? [],
    recentEvents: partial.recentEvents ?? [],
    ...(partial.taskId ? { taskId: partial.taskId } : {}),
    ...(partial.presetId ? { presetId: partial.presetId } : {}),
    ...(partial.preset ? { preset: partial.preset } : {}),
    ...(partial.lastUserPrompt ? { lastUserPrompt: partial.lastUserPrompt } : {}),
    ...(partial.startedAt ? { startedAt: partial.startedAt } : {}),
  }
}

describe('pickStripTasks', () => {
  it('keeps only running/needs_user tasks of the current preset', () => {
    const running = task({
      rootChatId: 'a',
      presetId: 'preset-1',
      preset: 'research',
      status: 'running',
      updatedAt: 30,
    })
    const waiting = task({
      rootChatId: 'b',
      presetId: 'preset-1',
      status: 'needs_user',
      updatedAt: 20,
    })
    const completed = task({
      rootChatId: 'c',
      presetId: 'preset-1',
      status: 'completed',
      updatedAt: 10,
    })
    const otherPreset = task({ rootChatId: 'd', presetId: 'preset-2', status: 'running' })

    const { items } = pickStripTasks([completed, running, waiting, otherPreset], 'preset-1')
    expect(items.map((item) => item.rootChatId).sort()).toEqual(['a', 'b'])
  })

  it('matches by preset name when presetId is missing', () => {
    const legacy = task({ rootChatId: 'a', preset: 'research', status: 'running' })
    const { items } = pickStripTasks([legacy], undefined, 'research')
    expect(items).toHaveLength(1)
  })

  it('sorts by updatedAt descending and caps at the icon limit with overflow count', () => {
    const many = Array.from({ length: SESSION_STRIP_MAX_ICONS + 3 }, (_, index) =>
      task({ rootChatId: `s-${index}`, presetId: 'p', status: 'running', updatedAt: index }),
    )
    const { items, overflowCount } = pickStripTasks(many, 'p')
    expect(items).toHaveLength(SESSION_STRIP_MAX_ICONS)
    expect(items[0]?.updatedAt).toBe(SESSION_STRIP_MAX_ICONS + 2)
    expect(overflowCount).toBe(3)
  })

  it('projects currentStep and currentStepKind from the root agent', () => {
    const running = task({
      rootChatId: 'a',
      presetId: 'p',
      status: 'running',
      agents: [
        { chatId: 'a', role: '主 Agent', status: 'running', currentStep: 'search', currentStepKind: 'tool' },
      ],
    })
    const { items } = pickStripTasks([running], 'p')
    expect(items[0]).toMatchObject({ currentStep: 'search', currentStepKind: 'tool' })
  })

  it('forces the current chat into the strip even when it is not active', () => {
    const running = task({ rootChatId: 'a', presetId: 'p', status: 'running', updatedAt: 50 })
    const current = task({
      rootChatId: 'cur',
      presetId: 'p',
      status: 'completed',
      title: '当前会话',
      updatedAt: 10,
    })
    const { items, overflowCount } = pickStripTasks([running, current], 'p', undefined, 'cur')
    expect(items.map((item) => item.rootChatId)).toEqual(['cur', 'a'])
    expect(overflowCount).toBe(0)
  })

  it('keeps the active current chat in place without duplicating it', () => {
    const running = task({ rootChatId: 'cur', presetId: 'p', status: 'running', updatedAt: 50 })
    const { items } = pickStripTasks([running], 'p', undefined, 'cur')
    expect(items.map((item) => item.rootChatId)).toEqual(['cur'])
    expect(items).toHaveLength(1)
  })

  it('accounts for the current chat slot in the overflow count', () => {
    const many = Array.from({ length: SESSION_STRIP_MAX_ICONS + 2 }, (_, index) =>
      task({ rootChatId: `s-${index}`, presetId: 'p', status: 'running', updatedAt: index }),
    )
    const current = task({ rootChatId: 'cur', presetId: 'p', status: 'completed', updatedAt: 0 })
    const { items, overflowCount } = pickStripTasks([...many, current], 'p', undefined, 'cur')
    expect(items[0]?.rootChatId).toBe('cur')
    expect(items).toHaveLength(SESSION_STRIP_MAX_ICONS)
    expect(overflowCount).toBe(3)
  })
})

describe('buildStripTooltip / currentNodeLabel', () => {
  const base = {
    rootChatId: 'a',
    title: '标题',
    status: 'running' as const,
    pendingCount: 0,
    updatedAt: 0,
  }

  it('assembles title, last prompt and current node with fallbacks', () => {
    expect(
      buildStripTooltip({
        ...base,
        lastUserPrompt: '最后一次提问',
        currentStep: '搜索资料',
      }),
    ).toEqual({
      title: '标题',
      lastPrompt: '最后一次提问',
      currentNode: '搜索资料',
    })
    expect(
      buildStripTooltip({ ...base, title: '', currentStepKind: 'model' }),
    ).toEqual({
      title: '未命名会话',
      lastPrompt: '（暂无提问）',
      currentNode: '思考中',
    })
  })

  it('labels the current node from currentStepKind when step text is missing', () => {
    expect(currentNodeLabel({ ...base, currentStepKind: 'model' })).toBe('思考中')
    expect(currentNodeLabel({ ...base, currentStepKind: 'tool' })).toBe('执行工具')
    expect(currentNodeLabel({ ...base, currentStep: 'search' })).toBe('search')
  })
})
