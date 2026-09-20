import { describe, expect, it } from 'vitest'
import {
  CONTEXT_ANALYTICS_DEMO,
  CONTEXT_ANALYTICS_DEMOS,
} from '../../src/features/agent/workbench/context-analytics/demoData'
import {
  assertDemoConsistency,
  compositionTotal,
  groupRequestComposition,
  contextOccupancy,
  metricPercent,
  rankAgents,
  snapshotFor,
  type AgentUsageView,
  type UsageMetric,
} from '../../src/features/agent/workbench/context-analytics/model'

function metric(value: number | null): UsageMetric {
  return {
    value,
    source: value === null ? 'unknown' : 'provider',
    coverage: value === null ? 'none' : 'complete',
    knownCount: value === null ? 0 : 1,
    totalCount: 1,
  }
}

function agent(agentId: string, value: number | null): AgentUsageView {
  const base = CONTEXT_ANALYTICS_DEMO.agents[0]!
  return {
    ...base,
    agentId,
    name: agentId,
    isMain: agentId === 'main',
    cumulativeTokens: metric(value),
    currentContext: { ...base.currentContext, snapshotId: `snapshot-${agentId}`, agentId },
  }
}

describe('context analytics demo model', () => {
  it('links operation details to recorded steps and reconciles tool totals', () => {
    for (const model of CONTEXT_ANALYTICS_DEMOS) {
      for (const operation of model.operations ?? []) {
        expect(model.requestComposition?.some(request =>
          request.step === operation.step && request.round === operation.round && request.agentId === operation.agentId,
        )).toBe(true)
      }
      for (const tool of model.tools) {
        const operations = model.operations!.filter(operation => operation.toolName === tool.name)
        expect(operations).toHaveLength(tool.calls)
        expect(operations.filter(operation => operation.status === 'failed')).toHaveLength(tool.failures)
        expect(operations.reduce((sum, operation) => sum + operation.durationMs, 0)).toBe(tool.totalDurationMs)
      }
    }
  })
  it('aggregates every request once per round without changing step data', () => {
    const requests = CONTEXT_ANALYTICS_DEMO.requestComposition!
    const rounds = groupRequestComposition(requests, 'round')
    expect(rounds).toHaveLength(12)
    expect(groupRequestComposition(requests, 'step')).toHaveLength(56)
    expect(rounds.reduce((sum, row) => sum + compositionTotal(row.segments), 0))
      .toBe(requests.reduce((sum, row) => sum + compositionTotal(row.segments), 0))
    expect(rounds[0]!.segments[0]).not.toBe(requests[0]!.segments[0])
  })

  it('preserves partial and unknown components when grouping rounds', () => {
    const base = CONTEXT_ANALYTICS_DEMO.requestComposition![0]!
    const segment = base.segments[0]!
    const result = groupRequestComposition([
      { ...base, segments: [{ ...segment, tokens: metric(null) }] },
      { ...base, step: 2, segments: [{ ...segment, tokens: metric(20) }] },
    ], 'round')
    expect(result[0]!.segments[0]!.tokens).toMatchObject({ value: 20, coverage: 'partial', knownCount: 1, totalCount: 2 })
    expect(groupRequestComposition([{ ...base, segments: [{ ...segment, tokens: metric(null) }] }], 'round')[0]!.segments[0]!.tokens.value).toBeNull()
  })
  it('keeps the fixture internally consistent', () => {
    expect(CONTEXT_ANALYTICS_DEMOS.map(assertDemoConsistency)).toEqual([[], [], []])
  })

  it('ranks known usage stably and leaves unknown agents unranked', () => {
    const ranked = rankAgents([
      agent('unknown', null),
      agent('b', 200),
      agent('a', 200),
      agent('main', 100),
      agent('last', 50),
    ])
    expect(ranked.map((entry) => [entry.agent.agentId, entry.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['main', 3],
      ['last', 4],
      ['unknown', null],
    ])
    expect(ranked.map((entry) => entry.detailedByDefault)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ])
  })

  it('does not promote unknown agents when no ranking evidence exists', () => {
    expect(rankAgents([agent('b', null), agent('a', null)])).toMatchObject([
      { rank: null, detailedByDefault: false },
      { rank: null, detailedByDefault: false },
    ])
  })

  it('keeps zero separate from unknown and does not invent percentages', () => {
    expect(metricPercent(metric(0), metric(100))).toBe(0)
    expect(metricPercent(metric(null), metric(100))).toBeNull()
    expect(metricPercent(metric(20), metric(null))).toBeNull()
    expect(
      contextOccupancy({ ...CONTEXT_ANALYTICS_DEMO.snapshots[0]!, limitTokens: null }),
    ).toBeNull()
  })

  it('looks up snapshots by both agent and epoch', () => {
    expect(snapshotFor(CONTEXT_ANALYTICS_DEMO, 'agent-primary', 'epoch-2')?.snapshotId).toBe(
      'snap-primary-history',
    )
    expect(snapshotFor(CONTEXT_ANALYTICS_DEMO, 'agent-ui', 'epoch-2')).toBeUndefined()
  })

})
