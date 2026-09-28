import { describe, expect, it } from 'vitest'
import {
  MAX_DAILY_USAGE_DAYS,
  addCalendarDays,
  calendarDisplayRange,
  calendarDayCount,
  dailyHeatmapValue,
  dailyTasksForDate,
  dateInTimeZone,
  defaultDailyUsageRange,
  normalizeDailyUsageRange,
  type DailyUsagePoint,
} from '../../src/features/agent/workbench/context-analytics/dailyModel'

const NOW = Date.UTC(2026, 8, 19, 4, 0, 0)

describe('daily context usage model', () => {
  it('uses the declared IANA time zone at a calendar-day boundary', () => {
    const timestamp = Date.UTC(2026, 8, 18, 16, 30, 0)
    expect(dateInTimeZone(timestamp, 'Asia/Shanghai')).toBe('2026-09-19')
    expect(dateInTimeZone(timestamp, 'America/Los_Angeles')).toBe('2026-09-18')
  })

  it('keeps the default calendar within the 366-day closed interval limit', () => {
    const range = defaultDailyUsageRange(NOW, 'Asia/Shanghai')
    expect(calendarDayCount(range)).toBe(364)
    expect(range).toEqual({ startDate: '2025-09-22', endDate: '2026-09-20' })

    const clamped = normalizeDailyUsageRange({
      startDate: '2024-01-01',
      endDate: '2026-09-19',
    })
    expect(calendarDayCount(clamped)).toBe(MAX_DAILY_USAGE_DAYS)
    expect(clamped.endDate).toBe('2026-09-19')
  })

  it('handles leap days with civil-date arithmetic', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(addCalendarDays('2024-02-29', 1)).toBe('2024-03-01')
    expect(() => normalizeDailyUsageRange({ startDate: '2026-09-20', endDate: '2026-09-19' }))
      .toThrow('开始日期不能晚于结束日期')
  })

  it('pads a partial month with gray calendar placeholders', () => {
    expect(calendarDisplayRange({ startDate: '2025-08-01', endDate: '2025-08-31' })).toEqual({
      startDate: '2025-07-28',
      endDate: '2025-08-31',
    })
  })

  it('does not collapse unknown or future dates into zero usage', () => {
    const unknown: DailyUsagePoint = { date: '2026-09-10', tokens: null, state: 'unknown', tasks: [] }
    const zero: DailyUsagePoint = { date: '2026-09-11', tokens: 0, state: 'complete', tasks: [] }
    const future: DailyUsagePoint = { date: '2026-09-20', tokens: null, state: 'future', tasks: [] }

    expect(dailyHeatmapValue(unknown)).toBe(-1)
    expect(dailyHeatmapValue(future)).toBe(-1)
    expect(dailyHeatmapValue(zero)).toBe(0)
    expect(unknown.tokens).toBeNull()
    expect(future.date).toBe('2026-09-20')
  })

  it('keeps partial task coverage visible in the selected-day list', () => {
    const points: DailyUsagePoint[] = [
      {
        date: '2026-09-16',
        tokens: 100,
        state: 'partial',
        tasks: [
          { taskKey: 'daily-design', title: '上下文统计页面设计', tokens: 60, coverage: 'partial' },
          {
            taskKey: 'daily-protocol',
            title: '统计协议能力调研',
            tokens: null,
            coverage: 'unknown',
            note: '该任务当天仍有请求未报告 Token',
          },
        ],
      },
    ]
    const tasks = dailyTasksForDate(points, '2026-09-16')
    expect(tasks[0]).toMatchObject({ taskKey: 'daily-design', coverage: 'partial' })
    expect(tasks.some((task) => task.tokens === null)).toBe(true)
    expect(dailyTasksForDate(points, '2026-09-17')).toEqual([])
  })
})
