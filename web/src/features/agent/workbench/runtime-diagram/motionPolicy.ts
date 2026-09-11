import type { HeaderPoint } from './headerTemplate'

export type WorkflowMotionSource = 'reset' | 'hydrate' | 'live'
export type WorkflowMotionNodeStatus =
  | 'idle' | 'unrecorded' | 'unknown' | 'running' | 'waiting'
  | 'succeeded' | 'success' | 'failed' | 'rejected' | 'danger'
  | 'cancelled' | 'interrupted' | 'muted'

export interface WorkflowMotionNode {
  id: string
  rootChatId: string
  family: 'header' | 'result'
  status: WorkflowMotionNodeStatus
  occurrenceId?: string
  sequence: number
  live: boolean
}

export interface WorkflowMotionEdge {
  id: string
  sourceId: string
  targetId: string
  family: 'header' | 'result'
  points: HeaderPoint[]
  evidenced: boolean
  targetOccurrenceId?: string
  targetStatus?: WorkflowMotionNodeStatus
  sequence: number
}

export interface WorkflowMotionFrame { nodes: WorkflowMotionNode[]; edges: WorkflowMotionEdge[] }
export interface WorkflowMotionContext {
  source: WorkflowMotionSource
  rootChatId: string
  synced: boolean
  replay: boolean
  suspended: boolean
  hidden: boolean
  spatial: boolean
  loops: boolean
  visibleNodeIds?: ReadonlySet<string>
  limit?: number
}

export type WorkflowMotionDecision =
  | { key: string; kind: 'node'; node: WorkflowMotionNode; phase: 'enter' | 'status' | 'settle'; spatial: boolean }
  | { key: string; kind: 'path'; edge: WorkflowMotionEdge; node: WorkflowMotionNode; spatial: boolean }
  | { key: string; kind: 'result-edge'; edge: WorkflowMotionEdge; node: WorkflowMotionNode; spatial: boolean }

const TERMINAL = new Set<WorkflowMotionNodeStatus>([
  'succeeded', 'success', 'failed', 'rejected', 'danger', 'cancelled', 'interrupted',
])
function canAnimate(context: WorkflowMotionContext): boolean {
  return context.source === 'live' && context.synced && !context.replay && !context.suspended && !context.hidden
}
function visible(node: WorkflowMotionNode, context: WorkflowMotionContext): boolean {
  return !context.visibleNodeIds || context.visibleNodeIds.has(node.id)
}

export function planWorkflowMotion(
  previous: WorkflowMotionFrame,
  next: WorkflowMotionFrame,
  context: WorkflowMotionContext,
): WorkflowMotionDecision[] {
  if (!canAnimate(context)) return []
  const before = new Map(previous.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, WorkflowMotionEdge[]>()
  for (const edge of next.edges) incoming.set(edge.targetId, [...(incoming.get(edge.targetId) ?? []), edge])
  const changes: WorkflowMotionDecision[][] = []
  const ordered = [...next.nodes].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
  for (const node of ordered) {
    if (node.rootChatId !== context.rootChatId || !visible(node, context)) continue
    const prior = before.get(node.id)
    const newIdentity = !!node.occurrenceId && prior?.occurrenceId !== node.occurrenceId
    const newResult = node.family === 'result' && !prior
    if (prior && prior.status === node.status && !newIdentity) continue
    const phase: 'enter' | 'status' | 'settle' = !prior
      ? TERMINAL.has(node.status) ? 'settle' : 'enter'
      : TERMINAL.has(node.status) ? 'settle' : 'status'
    const group: WorkflowMotionDecision[] = [
      { key: `node:${node.id}`, kind: 'node', node, phase, spatial: context.spatial },
    ]
    for (const edge of incoming.get(node.id) ?? []) {
      if (node.family === 'header') {
        if (!edge.evidenced || edge.targetOccurrenceId !== node.occurrenceId || edge.points.length < 2) continue
        group.push({ key: `path:${edge.id}`, kind: 'path', edge, node, spatial: context.spatial })
      } else if (newResult && edge.family === 'result') {
        group.push({ key: `result-edge:${edge.id}`, kind: 'result-edge', edge, node, spatial: context.spatial })
      }
    }
    changes.push(group)
  }
  const limit = Math.max(0, context.limit ?? 12)
  if (!limit) return []
  const selected: WorkflowMotionDecision[] = []
  for (let index = changes.length - 1; index >= 0 && selected.length < limit; index -= 1) {
    const remaining = limit - selected.length
    selected.unshift(...changes[index]!.slice(0, remaining))
  }
  return selected
}

export function selectWorkflowMotionLoops(
  frame: WorkflowMotionFrame,
  context: WorkflowMotionContext,
  limit = 8,
): WorkflowMotionNode[] {
  if (!context.loops || !canAnimate(context) || limit <= 0) return []
  return [...frame.nodes]
    .filter((node) => node.rootChatId === context.rootChatId && node.live && node.status === 'running' && visible(node, context))
    .sort((a, b) => b.sequence - a.sequence || b.id.localeCompare(a.id))
    .slice(0, limit)
}

export function polylineLength(points: readonly HeaderPoint[]): number {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!
    const end = points[index]!
    total += Math.hypot(end.x - start.x, end.y - start.y)
  }
  return total
}

export function pointAtPolylineProgress(points: readonly HeaderPoint[], progress: number): HeaderPoint {
  if (!points.length) return { x: 0, y: 0 }
  if (points.length === 1) return { ...points[0]! }
  const total = polylineLength(points)
  if (!total) return { ...points.at(-1)! }
  let remaining = Math.max(0, Math.min(1, progress)) * total
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!
    const end = points[index]!
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    if (remaining <= length || index === points.length - 1) {
      const ratio = length ? Math.min(1, remaining / length) : 1
      return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }
    }
    remaining -= length
  }
  return { ...points.at(-1)! }
}

export function orthogonalPathBetween(start: HeaderPoint, end: HeaderPoint): HeaderPoint[] {
  const middleX = start.x + (end.x - start.x) / 2
  return [{ ...start }, { x: middleX, y: start.y }, { x: middleX, y: end.y }, { ...end }]
}

export function workflowPathDurationMs(points: readonly HeaderPoint[]): number {
  return Math.max(1500, Math.min(3000, polylineLength(points) * 10))
}

/** Replaces effects atomically so rapid facts settle the latest state without a queue. */
export class WorkflowMotionRegistry {
  private readonly entries = new Map<string, () => void>()
  get size(): number { return this.entries.size }
  keys(): string[] { return [...this.entries.keys()] }
  track(key: string, cancel: () => void): () => void {
    this.cancel(key)
    this.entries.set(key, cancel)
    return () => { if (this.entries.get(key) === cancel) this.entries.delete(key) }
  }
  cancel(key: string): void {
    const cancel = this.entries.get(key)
    if (!cancel) return
    this.entries.delete(key)
    cancel()
  }
  cancelAll(): void {
    const pending = [...this.entries.values()]
    this.entries.clear()
    for (const cancel of pending) cancel()
  }
}
