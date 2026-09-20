import { describe, expect, it } from 'vitest'
import type { TaskCatalogItem, TaskOverview } from '../../src/services/agentApi'
import {
  buildTaskCatalogQuery,
  countNewTaskBrowserItems,
  DEFAULT_TASK_BROWSER_FILTERS,
  hasTaskBrowserFilters,
  mergeTaskBrowserUpdates,
  parseTaskBrowserFilters,
  parseSavedTaskBrowserState,
  splitHighlightedText,
  taskBrowserDetail,
  visibleTaskBrowserItems,
} from '../../src/features/agent/workbench/taskBrowserModel'

function catalogItem(taskKey: string, updatedAt = 1): TaskCatalogItem {
  return {
    taskKey,
    originalChatId: `${taskKey}-original`,
    openChatId: `${taskKey}-open`,
    title: `任务 ${taskKey}`,
    status: 'idle',
    unreadResult: false,
    attentionKey: `attention-${taskKey}`,
    createdAt: 1,
    updatedAt,
    branchCount: 1,
    matches: [],
  }
}

function overviewTask(taskKey: string, updatedAt = 1): TaskOverview {
  return {
    rootChatId: `${taskKey}-root`,
    taskKey,
    presetId: 'preset-1',
    title: `实时 ${taskKey}`,
    status: 'running',
    updatedAt,
    pendingCount: 0,
    hasFailure: false,
    agents: [],
    recentEvents: [],
    originalChatId: `${taskKey}-original`,
    openChatId: `${taskKey}-live`,
    branchCount: 2,
    currentStep: '正在处理',
    unreadResult: false,
    attentionKey: `live-${taskKey}`,
  }
}

describe('task browser model', () => {
  it('builds full-history query filters with a deterministic time boundary', () => {
    expect(
      buildTaskCatalogQuery(
        {
          query: '  结果  ',
          statuses: ['running', 'failed'],
          timeRange: 'week',
          sort: 'updated_desc',
          attentionOnly: false,
        },
        { presetId: 'preset-1', preset: 'legacy-name' },
        1_000_000_000,
      ),
    ).toEqual({
      presetId: 'preset-1',
      query: '结果',
      statuses: ['running', 'failed'],
      updatedFrom: 395_200_000,
      sort: 'relevance',
      limit: 24,
    })
  })

  it('sanitizes restored filters without accepting unknown values', () => {
    expect(
      parseTaskBrowserFilters({
        query: '保留',
        statuses: ['running', 'unknown', 'running'],
        timeRange: 'never',
        sort: 'bad',
        attentionOnly: true,
      }),
    ).toEqual({
      query: '保留',
      statuses: ['running'],
      timeRange: 'all',
      sort: 'updated_desc',
      attentionOnly: true,
    })
  })

  it('restores a valid scroll position and rejects an invalid one', () => {
    expect(
      parseSavedTaskBrowserState({
        filters: { ...DEFAULT_TASK_BROWSER_FILTERS, query: '上次搜索' },
        scrollTop: 438,
      }),
    ).toMatchObject({ filters: { query: '上次搜索' }, scrollTop: 438 })
    expect(parseSavedTaskBrowserState({ filters: null, scrollTop: -1 }).scrollTop).toBe(0)
  })

  it('keeps the clear-filter control disabled for the default filter state', () => {
    expect(hasTaskBrowserFilters(DEFAULT_TASK_BROWSER_FILTERS)).toBe(false)
    expect(hasTaskBrowserFilters({ ...DEFAULT_TASK_BROWSER_FILTERS, timeRange: 'week' })).toBe(true)
  })

  it('updates loaded cards in place and reports unseen live tasks without reordering', () => {
    const original = [catalogItem('one'), catalogItem('two')]
    const live = [overviewTask('two', 20), overviewTask('three', 30)]

    const merged = mergeTaskBrowserUpdates(original, live)
    expect(merged.map((item) => item.taskKey)).toEqual(['one', 'two'])
    expect(merged[1]).toMatchObject({ title: '实时 two', openChatId: 'two-live', updatedAt: 20 })
    expect(countNewTaskBrowserItems(original, live, { presetId: 'preset-1' })).toBe(1)
  })

  it('keeps only attention cards in the temporary attention view', () => {
    const items = [
      catalogItem('idle'),
      { ...catalogItem('question'), status: 'needs_user' as const },
      { ...catalogItem('unread'), status: 'completed' as const, unreadResult: true },
    ]
    expect(
      visibleTaskBrowserItems(items, {
        ...DEFAULT_TASK_BROWSER_FILTERS,
        attentionOnly: true,
      }).map((item) => item.taskKey),
    ).toEqual(['question', 'unread'])
  })

  it('renders UTF-16 highlight ranges as text parts and never as HTML', () => {
    expect(splitHighlightedText('A😀结果B', [{ start: 3, end: 5 }])).toEqual([
      { text: 'A😀', highlighted: false },
      { text: '结果', highlighted: true },
      { text: 'B', highlighted: false },
    ])
    expect(splitHighlightedText('<b>文字</b>', [{ start: 3, end: 5 }])[0]?.text).toBe('<b>')
  })

  it('uses an explicit safe fallback when a failed task has no visible explanation', () => {
    const item = {
      ...catalogItem('failed'),
      status: 'failed' as const,
      latestResult: { resultId: 'result-1', status: 'failed' as const, completedAt: 2 },
    }
    expect(taskBrowserDetail(item)).toEqual({
      label: '失败说明',
      content: '任务失败，但没有可安全显示的失败说明。',
    })
  })
})
