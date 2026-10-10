import { describe, expect, it } from 'vitest'
import {
  compositionTotal,
  groupRequestComposition,
  contextOccupancy,
  metricPercent,
  rankAgents,
  snapshotFor,
  type AgentUsageView,
  type ContextAnalyticsDemo,
  type ContextCategory,
  type ContextSegmentView,
  type ContextSnapshotView,
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

function segment(key: ContextCategory, value: number | null): ContextSegmentView {
  return {
    key,
    label: key,
    color: '#888',
    tokens: metric(value),
  }
}

const SNAPSHOT: ContextSnapshotView = {
  snapshotId: 'snap-primary-history',
  agentId: 'agent-primary',
  epochId: 'epoch-2',
  capturedAt: 1_700_000_000_000,
  origin: 'frozen',
  quality: 'exact',
  usedTokens: metric(120),
  limitTokens: 200,
  segments: [segment('system', 40), segment('tools', 80)],
  items: [],
}

const fixture: ContextAnalyticsDemo = {
  taskKey: 'fixture',
  taskTitle: '测试任务',
  asOf: 1_700_000_000_000,
  totalTokens: metric(120),
  rounds: metric(2),
  requests: metric(3),
  agents: [
    {
      agentId: 'main',
      name: '主 Agent',
      role: 'main',
      isMain: true,
      status: 'completed',
      cumulativeTokens: metric(120),
      rounds: metric(2),
      requests: metric(3),
      durationMs: metric(500),
      currentContext: { ...SNAPSHOT },
    },
  ],
  trend: [
    { round: 1, cumulativeTokens: 30, roundTokens: 30, contextTokens: 120 },
    { round: 2, cumulativeTokens: 120, roundTokens: 90, contextTokens: 120 },
  ],
  requestComposition: [
    { step: 1, round: 1, agentId: 'main', segments: [segment('system', 20), segment('tools', 10)] },
    { step: 2, round: 1, agentId: 'main', segments: [segment('tools', 60)] },
    { step: 3, round: 2, agentId: 'main', segments: [segment('conversation', 90)] },
  ],
  operations: [
    { id: 'op-1', step: 1, round: 1, agentId: 'main', kind: 'read', toolName: 'read', description: '读取文件', durationMs: 120, status: 'completed' },
    { id: 'op-2', step: 2, round: 1, agentId: 'main', kind: 'write', toolName: 'edit', description: '编辑文件', durationMs: 40, status: 'completed' },
  ],
  imageCount: 0,
  audioCount: 0,
  cacheHitRequests: 0,
  epochs: [
    { epochId: 'epoch-1', ordinal: 1, label: '第一轮', status: 'historical', transitionReason: '', createdAt: 1_000, availableAgentIds: ['agent-primary'] },
    { epochId: 'epoch-2', ordinal: 2, label: '第二轮', status: 'active', transitionReason: '', createdAt: 2_000, availableAgentIds: ['agent-primary'] },
  ],
  snapshots: [SNAPSHOT],
  cache: { readTokens: metric(50), writeTokens: metric(10), reportedRequests: 1, totalRequests: 1 },
  taskDurationMs: metric(500),
  activeDurationMs: metric(500),
  tools: [
    { name: 'read', calls: 1, failures: 0, rejected: 0, totalDurationMs: 120 },
    { name: 'edit', calls: 1, failures: 0, rejected: 0, totalDurationMs: 40 },
  ],
}

function agent(agentId: string, value: number | null): AgentUsageView {
  const base = fixture.agents[0]!
  return {
    ...base,
    agentId,
    name: agentId,
    isMain: agentId === 'main',
    cumulativeTokens: metric(value),
    currentContext: { ...base.currentContext, snapshotId: `snapshot-${agentId}`, agentId },
  }
}

describe('context analytics model', () => {
  it('links operation details to recorded steps and reconciles tool totals', () => {
    for (const operation of fixture.operations ?? []) {
      expect(
        fixture.requestComposition?.some(
          (request) =>
            request.step === operation.step &&
            request.round === operation.round &&
            request.agentId === operation.agentId,
        ),
      ).toBe(true)
    }
    for (const tool of fixture.tools) {
      const operations = fixture.operations!.filter((operation) => operation.toolName === tool.name)
      expect(operations).toHaveLength(tool.calls)
      expect(operations.reduce((sum, operation) => sum + operation.durationMs, 0)).toBe(
        tool.totalDurationMs,
      )
    }
  })

  it('aggregates every request once per round without changing step data', () => {
    const requests = fixture.requestComposition!
    const rounds = groupRequestComposition(requests, 'round')
    expect(rounds).toHaveLength(2)
    expect(groupRequestComposition(requests, 'step')).toHaveLength(3)
    expect(rounds.reduce((sum, row) => sum + compositionTotal(row.segments), 0)).toBe(
      requests.reduce((sum, row) => sum + compositionTotal(row.segments), 0),
    )
    expect(rounds[0]!.segments[0]).not.toBe(requests[0]!.segments[0])
  })

  it('preserves partial and unknown components when grouping rounds', () => {
    const base = fixture.requestComposition![0]!
    const segment = base.segments[0]!
    const result = groupRequestComposition(
      [
        { ...base, segments: [{ ...segment, tokens: metric(null) }] },
        { ...base, step: 2, segments: [{ ...segment, tokens: metric(20) }] },
      ],
      'round',
    )
    expect(result[0]!.segments[0]!.tokens).toMatchObject({
      value: 20,
      coverage: 'partial',
      knownCount: 1,
      totalCount: 2,
    })
    expect(
      groupRequestComposition(
        [{ ...base, segments: [{ ...segment, tokens: metric(null) }] }],
        'round',
      )[0]!.segments[0]!.tokens.value,
    ).toBeNull()
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
      contextOccupancy({ ...fixture.snapshots[0]!, limitTokens: null }),
    ).toBeNull()
  })

  it('looks up snapshots by both agent and epoch', () => {
    expect(snapshotFor(fixture, 'agent-primary', 'epoch-2')?.snapshotId).toBe(
      'snap-primary-history',
    )
    expect(snapshotFor(fixture, 'agent-ui', 'epoch-2')).toBeUndefined()
  })
})
