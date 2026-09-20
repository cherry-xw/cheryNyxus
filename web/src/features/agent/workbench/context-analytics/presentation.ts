import type { UsageMetric } from './model'

export function formatTokens(value: number | null): string {
  if (value === null) return '未知'
  if (Math.abs(value) < 1000) return String(Math.round(value))
  if (Math.abs(value) < 10_000) return `${(value / 1000).toFixed(1)}K`
  if (Math.abs(value) < 1_000_000) return `${Math.round(value / 1000)}K`
  return `${(value / 1_000_000).toFixed(1)}M`
}

export function formatMetric(metric: UsageMetric): string {
  return formatTokens(metric.value)
}

export function formatDuration(value: number | null): string {
  if (value === null) return '未知'
  const seconds = Math.max(0, Math.round(value / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours) return `${hours}小时 ${minutes}分`
  if (minutes) return `${minutes}分 ${rest}秒`
  return `${rest}秒`
}

export function formatDate(value: number | null): string {
  if (value === null) return '时间未保存'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}
