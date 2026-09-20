export { default as ContextUsageRing } from './ContextUsageRing.vue'
export { CONTEXT_ANALYTICS_DEMOS } from './demoData'
export type { ContextAnalyticsDemo, ContextSnapshotView, UsageMetric } from './model'

import type { TaskUsageSummary } from '@chery/protocol'
import type { ContextAnalyticsDemo } from './model'

export interface ContextAnalyticsCardSummary {
  taskKey: string
  currentContext?: ContextAnalyticsDemo['agents'][number]['currentContext']
  totalTokens: ContextAnalyticsDemo['totalTokens']
  rounds: ContextAnalyticsDemo['rounds']
  requests: ContextAnalyticsDemo['requests']
  agentCount: number
}

export function contextAnalyticsCardSummaryFromUsage(
  summary: TaskUsageSummary,
): ContextAnalyticsCardSummary {
  return {
    taskKey: summary.taskKey,
    totalTokens: summary.totalTokens,
    rounds: summary.rounds,
    requests: summary.requests,
    agentCount: summary.agentCount,
  }
}
