// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

const dailyMock = vi.fn()
const dayTasksMock = vi.fn()

vi.mock('@/application/backend/public', () => ({
  agentApi: {
    getContextUsageDaily: (...args: unknown[]) => dailyMock(...args),
    getContextUsageDayTasks: (...args: unknown[]) => dayTasksMock(...args),
  },
}))

vi.mock('@/services/ws', () => ({
  wsClient: {
    getStatus: () => 'connected',
    onStatus: vi.fn(() => vi.fn()),
  },
}))

import ContextDailyHeatmap from '../../src/features/agent/workbench/context-analytics/ContextDailyHeatmap.vue'

function stubResizeObserver(): void {
  ;(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

function dailyPoint(date: string, value: number | null, state: 'complete' | 'partial' | 'unknown' | 'future') {
  return {
    date,
    tokens: { value, source: value === null ? 'unknown' : 'provider', coverage: value === null ? 'none' : 'complete', knownCount: value === null ? 0 : 1, totalCount: 1 },
    taskKeys: value === null ? [] : ['task-1'],
    state,
  }
}

describe('ContextDailyHeatmap 数据加载与渲染', () => {
  beforeEach(() => {
    stubResizeObserver()
    dailyMock.mockReset()
    dayTasksMock.mockReset()
    dayTasksMock.mockResolvedValue({ asOf: Date.now(), items: [] })
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 8, 28, 4, 0, 0)))
  })

  it('请求成功且有数据时，日历 option 包含该日期的 Token 值', async () => {
    // 系统时间 2026-09-28，请求返回该范围内的真实点数据
    dailyMock.mockResolvedValue({
      asOf: Date.now(),
      from: '2025-10-06',
      to: '2026-10-04',
      timezone: 'Asia/Shanghai',
      capturedSince: 0,
      points: [
        dailyPoint('2026-09-22', 231562, 'complete'),
        dailyPoint('2026-09-23', null, 'unknown'),
        dailyPoint('2026-09-24', 0, 'complete'),
        dailyPoint('2026-10-01', null, 'future'),
      ],
    })

    const wrapper = mount(ContextDailyHeatmap, {
      props: { timeRange: 'all' },
      global: {
        stubs: {
          AnalyticsChart: { template: '<div class="chart-stub" />', props: ['option', 'selectedIndex', 'label', 'selectOnHover'] },
        },
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()

    const option = wrapper.vm.option as { series?: Array<{ data?: Array<{ value: [string, number] }> }> }
    const series = option.series?.[0]
    const data = series?.data ?? []

    const sep22 = data.find((item) => item.value[0] === '2026-09-22')
    expect(sep22).toBeTruthy()
    expect(sep22!.value[1]).toBe(231562)

    const sep23 = data.find((item) => item.value[0] === '2026-09-23')
    expect(sep23!.value[1]).toBe(-1) // unknown → -1（无数据灰色）

    const sep24 = data.find((item) => item.value[0] === '2026-09-24')
    expect(sep24!.value[1]).toBe(0) // 零消耗

    const future = data.find((item) => item.value[0] === '2026-10-01')
    expect(future!.value[1]).toBe(-1) // 未来 → -1

    wrapper.unmount()
  })

  it('请求失败时组件不应崩溃，并显示「加载失败」与重试按钮', async () => {
    dailyMock.mockRejectedValue(new Error('network down'))

    const wrapper = mount(ContextDailyHeatmap, {
      props: { timeRange: 'all' },
      global: {
        stubs: {
          AnalyticsChart: { template: '<div class="chart-stub" />', props: ['option', 'selectedIndex', 'label', 'selectOnHover'] },
        },
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()

    // 不应抛出渲染错误：详情区标题与日历骨架仍然存在
    expect(wrapper.find('.daily-detail-title').exists()).toBe(true)
    expect(wrapper.find('.daily-calendar').exists()).toBe(true)

    // 请求失败显式提示，并提供重试按钮（不假装有数据）
    const error = wrapper.find('.daily-load-error')
    expect(error.exists()).toBe(true)
    expect(error.text()).toContain('加载失败')
    const retry = error.find('button')
    expect(retry.exists()).toBe(true)
    expect(retry.text()).toContain('重试')

    wrapper.unmount()
  })
})
