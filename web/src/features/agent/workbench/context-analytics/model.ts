export type MetricSource = 'provider' | 'estimate' | 'derived' | 'mixed' | 'unknown'
export type MetricCoverage = 'complete' | 'partial' | 'none'

export interface UsageMetric {
  value: number | null
  source: MetricSource
  coverage: MetricCoverage
  knownCount: number
  totalCount: number
}

export type ContextCategory =
  | 'system'
  | 'userRules'
  | 'memory'
  | 'skills'
  | 'tools'
  | 'conversation'
  | 'other'

export interface ContextSegmentView {
  key: ContextCategory
  label: string
  color: string
  tokens: UsageMetric
  count?: number
}

export interface ContextContentItem {
  itemId: string
  category: ContextCategory
  label: string
  preview: string
  content: string
  tokenEstimate: number | null
  sourceLabel: string
  contentState: 'available' | 'partial' | 'missing'
  kind: 'markdown' | 'plain' | 'tool'
  toolParameters?: Array<{
    name: string
    type: string
    required: boolean
    description: string
  }>
}

export interface ContextSnapshotView {
  snapshotId: string
  agentId: string
  epochId: string
  capturedAt: number | null
  origin: 'frozen' | 'reconstructed'
  quality: 'exact' | 'partial' | 'reconstructed'
  usedTokens: UsageMetric
  limitTokens: number | null
  segments: ContextSegmentView[]
  items: ContextContentItem[]
}

export interface AgentUsageView {
  agentId: string
  name: string
  role: string
  isMain: boolean
  status: 'running' | 'idle' | 'completed'
  cumulativeTokens: UsageMetric
  rounds: UsageMetric
  requests: UsageMetric
  durationMs: UsageMetric
  currentContext: ContextSnapshotView
  modelName?: string
  modelSource?: 'lastRequest' | 'configured'
}

export interface RequestComposition {
  step: number
  round: number
  agentId: string
  segments: ContextSegmentView[]
  summary?: string
  modelName?: string
}

export interface AnalyticsOperation {
  id: string
  step: number
  round: number
  agentId: string
  kind: 'command' | 'read' | 'write' | 'search' | 'compression'
  toolName: string
  description: string
  command?: string
  path?: string
  query?: string
  addedLines?: number
  removedLines?: number
  durationMs: number
  status: 'completed' | 'failed'
}

export function compositionTotal(segments: ContextSegmentView[]): number {
  return segments.reduce((sum, segment) => sum + (segment.tokens.value ?? 0), 0)
}

export function groupRequestComposition(requests: RequestComposition[], mode: 'step' | 'round'): RequestComposition[] {
  if (mode === 'step') return [...requests].sort((a, b) => a.step - b.step)
  const rounds = new Map<number, RequestComposition>()
  for (const request of requests) {
    let row = rounds.get(request.round)
    if (!row) {
      row = { step: request.step, round: request.round, agentId: '', segments: [] }
      rounds.set(request.round, row)
    }
    for (const segment of request.segments) {
      const existing = row.segments.find((item) => item.key === segment.key)
      if (!existing) row.segments.push({ ...segment, tokens: { ...segment.tokens } })
      else {
        const left = existing.tokens.value
        const right = segment.tokens.value
        existing.tokens.value = left === null && right === null ? null : (left ?? 0) + (right ?? 0)
        existing.tokens.knownCount += segment.tokens.knownCount
        existing.tokens.totalCount += segment.tokens.totalCount
        if (left === null || right === null || segment.tokens.coverage !== 'complete')
          existing.tokens.coverage = existing.tokens.value === null ? 'none' : 'partial'
      }
    }
  }
  return [...rounds.values()].sort((a, b) => a.round - b.round)
}

export interface UsageTrendPoint {
  round: number
  cumulativeTokens: number | null
  roundTokens: number | null
  contextTokens: number | null
  compressed?: boolean
}

export interface EpochView {
  epochId: string
  ordinal: number
  label: string
  status: 'active' | 'historical'
  transitionReason: string
  createdAt: number
  closedAt?: number
  handoffSummary?: string
  quality: 'exact' | 'partial' | 'reconstructed'
  availableAgentIds: string[]
}

export interface ToolUsageView {
  name: string
  calls: number
  failures: number
  rejected: number
  totalDurationMs: number | null
}

export interface ContextAnalyticsDemo {
  taskKey: string
  taskTitle: string
  asOf: number
  totalTokens: UsageMetric
  rounds: UsageMetric
  requests: UsageMetric
  agents: AgentUsageView[]
  trend: UsageTrendPoint[]
  requestComposition?: RequestComposition[]
  operations?: AnalyticsOperation[]
  imageCount?: number | null
  audioCount?: number | null
  cacheHitRequests?: number | null
  epochs: EpochView[]
  snapshots: ContextSnapshotView[]
  cache: {
    readTokens: UsageMetric
    writeTokens: UsageMetric
    reportedRequests: number
    totalRequests: number
  }
  taskDurationMs: UsageMetric
  activeDurationMs: UsageMetric
  tools: ToolUsageView[]
}

export interface RankedAgent {
  agent: AgentUsageView
  rank: number | null
  detailedByDefault: boolean
}

export const CATEGORY_ORDER: ContextCategory[] = [
  'system',
  'userRules',
  'memory',
  'skills',
  'tools',
  'conversation',
  'other',
]

export function rankAgents(agents: AgentUsageView[]): RankedAgent[] {
  const known = agents
    .filter((agent) => agent.cumulativeTokens.value !== null)
    .sort(
      (a, b) =>
        (b.cumulativeTokens.value ?? 0) - (a.cumulativeTokens.value ?? 0) ||
        a.agentId.localeCompare(b.agentId),
    )
  const unknown = agents
    .filter((agent) => agent.cumulativeTokens.value === null)
    .sort((a, b) => a.agentId.localeCompare(b.agentId))
  const ranked = [...known, ...unknown]
  return ranked.map((agent, index) => ({
    agent,
    rank: agent.cumulativeTokens.value === null ? null : index + 1,
    detailedByDefault: agent.cumulativeTokens.value !== null && index < 3,
  }))
}

export function metricPercent(part: UsageMetric, total: UsageMetric): number | null {
  if (part.value === null || total.value === null || total.value <= 0) return null
  return Math.min(100, Math.max(0, (part.value / total.value) * 100))
}

export function contextOccupancy(snapshot: ContextSnapshotView): number | null {
  if (snapshot.usedTokens.value === null || !snapshot.limitTokens || snapshot.limitTokens <= 0)
    return null
  return Math.min(100, Math.max(0, (snapshot.usedTokens.value / snapshot.limitTokens) * 100))
}

export function metricStateLabel(metric: UsageMetric): string {
  if (metric.value === null) return '未知'
  if (metric.coverage === 'partial') return `已记录 ${metric.knownCount}/${metric.totalCount}`
  if (metric.source === 'estimate') return '估算'
  return '完整记录'
}

export function snapshotFor(
  model: ContextAnalyticsDemo,
  agentId: string,
  epochId: string,
): ContextSnapshotView | undefined {
  return model.snapshots.find(
    (snapshot) => snapshot.agentId === agentId && snapshot.epochId === epochId,
  )
}

export function categoryCount(snapshot: ContextSnapshotView, category: ContextCategory): number {
  return snapshot.items.filter((item) => item.category === category).length
}

export function assertDemoConsistency(model: ContextAnalyticsDemo): string[] {
  const errors: string[] = []
  if (!model.agents.some((agent) => agent.isMain)) errors.push('缺少主 Agent')
  if (new Set(model.agents.map((agent) => agent.agentId)).size !== model.agents.length)
    errors.push('Agent 标识重复')
  for (const agent of model.agents) {
    if (!model.snapshots.some((snapshot) => snapshot.snapshotId === agent.currentContext.snapshotId))
      errors.push(`${agent.name} 当前快照未登记`)
  }
  for (const epoch of model.epochs) {
    for (const agentId of epoch.availableAgentIds) {
      if (!snapshotFor(model, agentId, epoch.epochId))
        errors.push(`${epoch.label} 声称存在但缺少 ${agentId} 快照`)
    }
  }
  return errors
}
