import { describe, expect, it, vi } from 'vitest'
import {
  planWorkflowMotion,
  orthogonalPathBetween,
  pointAtPolylineProgress,
  polylineLength,
  selectWorkflowMotionLoops,
  workflowPathDurationMs,
  WorkflowMotionRegistry,
  type WorkflowMotionContext,
  type WorkflowMotionEdge,
  type WorkflowMotionFrame,
  type WorkflowMotionNode,
} from '../../src/features/agent/workbench/runtime-diagram/motionPolicy'

function node(id: string, overrides: Partial<WorkflowMotionNode> = {}): WorkflowMotionNode {
  return {
    id,
    rootChatId: 'root',
    family: 'header',
    status: 'running',
    occurrenceId: `occurrence:${id}`,
    sequence: 1,
    live: true,
    ...overrides,
  }
}

function edge(
  id: string,
  target: WorkflowMotionNode,
  overrides: Partial<WorkflowMotionEdge> = {},
): WorkflowMotionEdge {
  return {
    id,
    sourceId: 'source',
    targetId: target.id,
    family: target.family,
    points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }],
    evidenced: true,
    targetOccurrenceId: target.occurrenceId,
    targetStatus: target.status,
    sequence: target.sequence,
    ...overrides,
  }
}

function frame(nodes: WorkflowMotionNode[], edges: WorkflowMotionEdge[] = []): WorkflowMotionFrame {
  return { nodes, edges }
}

function context(overrides: Partial<WorkflowMotionContext> = {}): WorkflowMotionContext {
  return {
    source: 'live',
    rootChatId: 'root',
    synced: true,
    replay: false,
    suspended: false,
    hidden: false,
    spatial: true,
    loops: true,
    ...overrides,
  }
}

describe('workflow runtime motion policy', () => {
  it('moves only along an evidenced template path for the exact occurrence', () => {
    const target = node('target')
    const decisions = planWorkflowMotion(
      frame([]),
      frame([target], [
        edge('exact', target),
        edge('inferred', target, { evidenced: false }),
        edge('wrong-occurrence', target, { targetOccurrenceId: 'other' }),
      ]),
      context(),
    )

    expect(
      decisions.map((decision) =>
        `${decision.kind}:${decision.kind === 'node' ? decision.node.id : decision.edge.id}`,
      ),
    ).toEqual(['node:target', 'path:exact'])
  })

  it('animates a canonical result and its explicit incoming fact edge once', () => {
    const result = node('result', {
      family: 'result',
      occurrenceId: undefined,
      status: 'success',
      live: false,
      sequence: 8,
    })
    expect(planWorkflowMotion(frame([]), frame([result], [edge('fact', result)]), context()))
      .toMatchObject([
        { kind: 'node', node: { id: 'result' }, phase: 'settle' },
        { kind: 'result-edge', edge: { id: 'fact' }, node: { id: 'result' } },
      ])
    expect(planWorkflowMotion(frame([result]), frame([result], [edge('fact', result)]), context()))
      .toEqual([])
  })

  it.each([
    ['hydrate', { source: 'hydrate' as const }],
    ['replay', { replay: true }],
    ['background', { hidden: true }],
    ['minimized', { suspended: true }],
    ['disconnected', { synced: false }],
  ])('keeps %s snapshots static', (_label, overrides) => {
    expect(planWorkflowMotion(frame([]), frame([node('new')]), context(overrides))).toEqual([])
  })

  it('settles rapid terminal replacement and ignores identical snapshots', () => {
    const running = node('same')
    const failed = node('same', { status: 'failed', live: false, sequence: 2 })
    expect(planWorkflowMotion(frame([running]), frame([failed]), context())[0]).toMatchObject({
      kind: 'node',
      node: { id: 'same' },
      phase: 'settle',
    })
    expect(planWorkflowMotion(frame([failed]), frame([failed]), context())).toEqual([])
  })

  it('isolates roots, visibility and the twelve-effect one-shot budget', () => {
    const values = Array.from({ length: 14 }, (_, index) =>
      node(`node-${index}`, { sequence: index }),
    )
    values.push(node('other-root', { rootChatId: 'other', sequence: 99 }))
    const visibleNodeIds = new Set(
      values.filter((item) => item.rootChatId === 'root').map((item) => item.id),
    )
    const decisions = planWorkflowMotion(
      frame([]),
      frame(values),
      context({ visibleNodeIds, limit: 12 }),
    )
    expect(decisions).toHaveLength(12)
    expect(decisions.map((decision) => decision.node.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => `node-${index + 2}`),
    )
  })

  it('limits continuous motion to the newest visible running nodes', () => {
    const values = Array.from({ length: 10 }, (_, index) =>
      node(`loop-${index}`, { sequence: index }),
    )
    values.push(node('waiting', { status: 'waiting', sequence: 20 }))
    expect(selectWorkflowMotionLoops(frame(values), context(), 3).map((item) => item.id))
      .toEqual(['loop-9', 'loop-8', 'loop-7'])
    expect(selectWorkflowMotionLoops(frame(values), context({ loops: false }), 8)).toEqual([])
    expect(selectWorkflowMotionLoops(frame(values), context({ replay: true }), 8)).toEqual([])
  })

  it('interpolates every orthogonal segment and clamps path timing', () => {
    const points = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }]
    expect(polylineLength(points)).toBe(70)
    expect(pointAtPolylineProgress(points, 20 / 70)).toEqual({ x: 20, y: 0 })
    expect(pointAtPolylineProgress(points, 55 / 70)).toEqual({ x: 40, y: 15 })
    expect(pointAtPolylineProgress(points, -1)).toEqual({ x: 0, y: 0 })
    expect(pointAtPolylineProgress(points, 2)).toEqual({ x: 40, y: 30 })
    expect(workflowPathDurationMs(points)).toBe(1500)
    expect(workflowPathDurationMs([{ x: 0, y: 0 }, { x: 220, y: 0 }])).toBe(2200)
    expect(workflowPathDurationMs([{ x: 0, y: 0 }, { x: 500, y: 0 }])).toBe(3000)
  })

  it('builds a deterministic orthogonal relationship path in either direction', () => {
    expect(orthogonalPathBetween({ x: 100, y: 20 }, { x: 20, y: 80 })).toEqual([
      { x: 100, y: 20 },
      { x: 60, y: 20 },
      { x: 60, y: 80 },
      { x: 20, y: 80 },
    ])
  })

  it('replaces stale handles atomically and clears teardown work', () => {
    const registry = new WorkflowMotionRegistry()
    const first = vi.fn()
    const latest = vi.fn()
    const other = vi.fn()
    const releaseFirst = registry.track('same', first)
    const releaseLatest = registry.track('same', latest)
    registry.track('other', other)

    expect(first).toHaveBeenCalledOnce()
    releaseFirst()
    expect(registry.size).toBe(2)
    releaseLatest()
    expect(registry.size).toBe(1)
    registry.cancelAll()
    expect(latest).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalledOnce()
    expect(registry.size).toBe(0)
  })
})
