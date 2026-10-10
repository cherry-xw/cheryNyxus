export const DAILY_USAGE_TIME_ZONE = 'Asia/Shanghai'
export const MAX_DAILY_USAGE_DAYS = 366

export type DailyUsageCoverage = 'complete' | 'partial' | 'unknown'
export type DailyUsageState = DailyUsageCoverage | 'future' | 'outside'

export interface DailyTaskUsage {
  taskKey: string
  title: string
  tokens: number | null
  coverage: DailyUsageCoverage
  note?: string
}

export interface DailyUsagePoint {
  date: string
  tokens: number | null
  state: DailyUsageState
  tasks: DailyTaskUsage[]
}

export interface DailyUsageRange {
  startDate: string
  endDate: string
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 86_400_000

function dateOrdinal(date: string): number {
  const match = DATE_PATTERN.exec(date)
  if (!match) throw new RangeError(`无效日期：${date}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const ordinal = Date.UTC(year, month - 1, day)
  const parsed = new Date(ordinal)
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`无效日期：${date}`)
  }
  return ordinal
}

export function addCalendarDays(date: string, days: number): string {
  return new Date(dateOrdinal(date) + Math.trunc(days) * DAY_MS).toISOString().slice(0, 10)
}

export function calendarDayCount(range: DailyUsageRange): number {
  return Math.floor((dateOrdinal(range.endDate) - dateOrdinal(range.startDate)) / DAY_MS) + 1
}

export function normalizeDailyUsageRange(
  range: DailyUsageRange,
  maximumDays = MAX_DAILY_USAGE_DAYS,
): DailyUsageRange {
  if (!Number.isInteger(maximumDays) || maximumDays < 1) {
    throw new RangeError('日期范围上限必须是正整数')
  }
  const start = dateOrdinal(range.startDate)
  const end = dateOrdinal(range.endDate)
  if (start > end) throw new RangeError('开始日期不能晚于结束日期')
  if ((end - start) / DAY_MS + 1 <= maximumDays) return { ...range }
  return { startDate: addCalendarDays(range.endDate, -(maximumDays - 1)), endDate: range.endDate }
}

export function dateInTimeZone(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function defaultDailyUsageRange(now: number, timeZone: string): DailyUsageRange {
  const today = dateInTimeZone(now, timeZone)
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  const endDate = addCalendarDays(today, (7 - weekday) % 7)
  return { startDate: addCalendarDays(endDate, -363), endDate }
}

export function enumerateCalendarDays(range: DailyUsageRange): string[] {
  const normalized = normalizeDailyUsageRange(range)
  return Array.from({ length: calendarDayCount(normalized) }, (_, index) =>
    addCalendarDays(normalized.startDate, index),
  )
}

/** Expands a data range to complete Monday–Sunday rows for calendar placeholders. */
export function calendarDisplayRange(range: DailyUsageRange): DailyUsageRange {
  const startWeekday = new Date(`${range.startDate}T00:00:00Z`).getUTCDay()
  const endWeekday = new Date(`${range.endDate}T00:00:00Z`).getUTCDay()
  return {
    startDate: addCalendarDays(range.startDate, -((startWeekday + 6) % 7)),
    endDate: addCalendarDays(range.endDate, (7 - endWeekday) % 7),
  }
}

export function dailyHeatmapValue(point: DailyUsagePoint): number {
  if (point.state === 'outside' || point.state === 'future' || point.state === 'unknown' || point.tokens === null) return -1
  return Math.max(0, point.tokens)
}

export function dailyUsageStateLabel(point: DailyUsagePoint): string {
  if (point.state === 'outside') return '当前范围外'
  if (point.state === 'future') return '未来日期'
  if (point.state === 'unknown') return '无数据'
  if (point.state === 'partial') return '部分数据'
  if (point.tokens === 0) return '已记录，零消耗'
  return '数据完整'
}

export function dailyTasksForDate(points: DailyUsagePoint[], date: string): DailyTaskUsage[] {
  return points.find((point) => point.date === date)?.tasks ?? []
}

