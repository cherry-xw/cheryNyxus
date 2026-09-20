import { describe, expect, it } from 'vitest'
import type { TaskUsageSummary } from '@chery/protocol'
import { contextAnalyticsCardSummaryFromUsage } from '../../src/features/agent/workbench/context-analytics/public'

const metric = (value: number) => ({
  value,
  source: 'provider' as const,
  coverage: 'complete' as const,
  knownCount: 1,
  totalCount: 1,
})

function summary(taskKey: string, requests: number): TaskUsageSummary {
  return {
    taskKey,
    inputTokens: metric(requests * 10),
    outputTokens: metric(requests * 5),
    totalTokens: metric(requests * 15),
    requests: metric(requests),
    rounds: metric(requests),
    retryCount: metric(0),
    agentCount: requests ? 1 : 0,
    capturedSince: null,
    currentRequest: null,
  }
}

describe('context analytics public card summary', () => {
  it('maps the server summary without deriving values from the task key', () => {
    expect(contextAnalyticsCardSummaryFromUsage(summary('task-a', 2))).toMatchObject({
      taskKey: 'task-a',
      agentCount: 1,
      totalTokens: { value: 30 },
      requests: { value: 2 },
    })
  })

  it('keeps an empty task empty instead of assigning demo statistics', () => {
    expect(contextAnalyticsCardSummaryFromUsage(summary('new-empty-task', 0))).toMatchObject({
      taskKey: 'new-empty-task',
      totalTokens: { value: 0 },
      requests: { value: 0 },
      rounds: { value: 0 },
      agentCount: 0,
    })
  })
})
