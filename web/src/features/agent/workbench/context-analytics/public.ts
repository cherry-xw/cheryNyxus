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
  const request = summary.latestRequest
  const currentContext = request
    ? {
        snapshotId: `${request.chatId}:${request.attemptId}`,
        agentId: request.chatId,
        epochId: 'current',
        capturedAt: request.startedAt,
        origin: 'reconstructed' as const,
        quality: 'partial' as const,
        usedTokens: {
          value: request.context.system + request.context.tools + request.context.conversation,
          source: 'estimate' as const,
          coverage: 'complete' as const,
          knownCount: 1,
          totalCount: 1,
        },
        limitTokens: request.context.limit,
        segments: [
          { key: 'system' as const, label: '系统规则', color: '#65c6d8', tokens: { value: request.context.system, source: 'estimate' as const, coverage: 'complete' as const, knownCount: 1, totalCount: 1 } },
          { key: 'tools' as const, label: '工具定义', color: '#a98be8', tokens: { value: request.context.tools, source: 'estimate' as const, coverage: 'complete' as const, knownCount: 1, totalCount: 1 } },
          { key: 'conversation' as const, label: '会话与工具结果', color: '#e8b86a', tokens: { value: request.context.conversation, source: 'estimate' as const, coverage: 'complete' as const, knownCount: 1, totalCount: 1 } },
        ],
        items: [],
      }
    : undefined
  return {
    taskKey: summary.taskKey,
    ...(currentContext ? { currentContext } : {}),
    totalTokens: summary.totalTokens,
    rounds: summary.rounds,
    requests: summary.requests,
    agentCount: summary.agentCount,
  }
}
