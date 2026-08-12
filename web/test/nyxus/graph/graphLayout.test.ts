import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot, TimelineNode } from '../../../src/services/agentApi'
import {
  projectPersistentExecutionGraph,
  type ExecutionGraph,
  type ExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  EXECUTION_ICON_RADIUS,
  EXECUTION_LANE_GAP,
  EXECUTION_ROW_GAP,
  createIncrementalExecutionLayout,
  layoutExecutionGraph,
} from '../../../src/features/pets/nyxus/graph/executionLayout'
import { executionEdgeGeometry } from '../../../src/features/pets/nyxus/graph/executionGeometry'

interface TopologyFixture {
  snapshot: RootTimelineSnapshot
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as T
}

function executionNode(id: string, orderKey: number, sourceChatId = 'root'): ExecutionNode {
  return {
    id,
    kind: orderKey === 0 ? 'start' : 'message',
    rootChatId: 'root',
    sourceChatId,
    actor: orderKey === 0 ? { kind: 'system' } : { kind: 'agent', chatId: sourceChatId },
    direction: orderKey === 0 ? 'internal' : 'agent-to-user',
    content: id,
    createdAt: orderKey,
    status: 'committed',
    main: sourceChatId === 'root',
    orderSlot: orderKey === 0 ? 'start' : 'persistent',
    orderKey: orderKey === 0 ? null : orderKey,
    activeRuns: [],
  }
}

function topologyGraph(): ExecutionGraph {
  const nodes = [
    executionNode('root', 0),
    executionNode('left-1', 1, 'left'),
    executionNode('left-2', 4, 'left'),
    executionNode('right-1', 3, 'right'),
    executionNode('merge', 5),
  ]
  const edge = (id: string, from: string, to: string) => ({
    id,
    from,
    to,
    kind: 'sequence' as const,
    orderSlot: 'persistent' as const,
    orderKey: 1,
    sourceChatId: nodes.find((node) => node.id === from)!.sourceChatId,
    targetChatId: nodes.find((node) => node.id === to)!.sourceChatId,
  })
  return {
    rootChatId: 'root',
    nodes,
    edges: [
      edge('root-left', 'root', 'left-1'),
      edge('left-chain', 'left-1', 'left-2'),
      edge('root-right', 'root', 'right-1'),
      edge('left-merge', 'left-2', 'merge'),
      edge('right-merge', 'right-1', 'merge'),
    ],
    diagnostics: [],
  }
}

describe('execution layout and edge geometry', () => {
  it('places topology peers on the same row and a merge below its deepest parent', () => {
    const graph = topologyGraph()
    const timeline = layoutExecutionGraph(graph)
    const topology = layoutExecutionGraph(graph, { mode: 'topology' })
    const byId = new Map(topology.nodes.map((node) => [node.id, node]))

    expect(byId.get('left-1')!.y).toBe(byId.get('right-1')!.y)
    expect(byId.get('left-2')!.y - byId.get('left-1')!.y).toBe(EXECUTION_ROW_GAP)
    expect(byId.get('merge')!.y - byId.get('left-2')!.y).toBe(EXECUTION_ROW_GAP)
    expect(topology.height).toBeLessThan(timeline.height)
    expect(EXECUTION_LANE_GAP).toBe(110)
  })

  it('recomputes incremental coordinates when the layout mode changes', () => {
    const engine = createIncrementalExecutionLayout()
    const graph = topologyGraph()
    engine.layout(graph, { mode: 'timeline' })
    const topology = engine.layout(graph, { mode: 'topology' })

    expect(engine.recomputations()).toBe(2)
    expect(topology.nodes.find((node) => node.id === 'left-1')!.y).toBe(
      topology.nodes.find((node) => node.id === 'right-1')!.y,
    )
    engine.layout({
      ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, content: `${node.content} streamed` })),
    }, { mode: 'topology' })
    expect(engine.recomputations()).toBe(2)
  })

  it('renders malformed topology cycles deterministically', () => {
    const graph = topologyGraph()
    const cycle = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          ...graph.edges[0]!,
          id: 'cycle',
          from: 'merge',
          to: 'left-1',
        },
      ],
    }
    const first = layoutExecutionGraph(cycle, { mode: 'topology' })
    const second = layoutExecutionGraph(cycle, { mode: 'topology' })

    expect(first.nodes.map(({ id, y }) => ({ id, y }))).toEqual(
      second.nodes.map(({ id, y }) => ({ id, y })),
    )
    expect(first.nodes.every((node) => Number.isFinite(node.y))).toBe(true)
  })

  it('keeps canonical time strictly descending with the root centered and a single descendant one lane outward', async () => {
    const fixture = await json<TopologyFixture>('test/fixtures/cp3-topology-matrix.json')
    const layout = layoutExecutionGraph(projectPersistentExecutionGraph(fixture.snapshot))
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))

    for (let index = 1; index < layout.nodes.length; index += 1) {
      expect(layout.nodes[index]!.y).toBeGreaterThan(layout.nodes[index - 1]!.y)
    }
    expect(layout.nodes.filter((node) => node.main).every((node) => node.x === 0)).toBe(true)
    expect(Math.abs(byId.get('child-a-start')!.x)).toBe(EXECUTION_LANE_GAP)
    expect(byId.get('grandchild-start')!.x).toBe(byId.get('child-a-start')!.x - EXECUTION_LANE_GAP)
    expect(Math.sign(byId.get('child-a-start')!.x)).not.toBe(
      Math.sign(byId.get('child-b-start')!.x),
    )
    expect(layout.bounds.minX).toBeLessThan(0)
    expect(layout.bounds.maxX).toBeGreaterThan(0)
  })

  it('moves a branching parent outward and places its grandchildren on both adjacent lanes', async () => {
    const fixture = await json<TopologyFixture>('test/fixtures/cp3-topology-matrix.json')
    const graph = projectPersistentExecutionGraph(fixture.snapshot)
    const firstGrandchild = graph.nodes.find((node) => node.id === 'grandchild-start')!
    const spawn = graph.edges.find((edge) => edge.id === 'edge-grand-spawn')!
    const layout = layoutExecutionGraph({
      ...graph,
      nodes: [
        ...graph.nodes,
        { ...firstGrandchild, id: 'grandchild-two-start', sourceChatId: 'grandchild-two', orderKey: 16 },
      ],
      edges: [
        ...graph.edges,
        { ...spawn, id: 'edge-grand-two-spawn', to: 'grandchild-two-start', targetChatId: 'grandchild-two' },
      ],
    })

    expect(layout.laneByChat.get('child-a')).toBe(-2)
    expect(layout.laneByChat.get('grandchild')).toBe(-1)
    expect(layout.laneByChat.get('grandchild-two')).toBe(-3)
  })

  it('preserves existing branch lanes when an increment changes subtree weights', async () => {
    const fixture = await json<TopologyFixture>('test/fixtures/cp3-topology-matrix.json')
    const initialGraph = projectPersistentExecutionGraph(fixture.snapshot)
    const initial = layoutExecutionGraph(initialGraph)
    const appendedNodes: TimelineNode[] = Array.from({ length: 12 }, (_, index) => ({
      ...fixture.snapshot.nodes.find((node) => node.id === 'child-a-continue')!,
      id: `child-a-appended-${index}`,
      orderKey: 100 + index,
      createdAt: 1_800_000_000_000 + index,
      updatedAt: 1_800_000_000_000 + index,
    }))
    const nextGraph = projectPersistentExecutionGraph({
      ...fixture.snapshot,
      nodes: [...fixture.snapshot.nodes, ...appendedNodes],
    })
    const next = layoutExecutionGraph(nextGraph, { previousLanes: initial.laneByChat })

    for (const chatId of ['child-a', 'child-b', 'grandchild']) {
      expect(next.laneByChat.get(chatId)).toBe(initial.laneByChat.get(chatId))
    }
  })

  it('starts and ends every curve on the icon circumference', () => {
    const source = { x: -190, y: 82 }
    const target = { x: 190, y: 246 }
    const geometry = executionEdgeGeometry(source, target, EXECUTION_ICON_RADIUS)

    expect(Math.hypot(geometry.from.x - source.x, geometry.from.y - source.y)).toBe(
      EXECUTION_ICON_RADIUS,
    )
    expect(Math.hypot(geometry.to.x - target.x, geometry.to.y - target.y)).toBe(
      EXECUTION_ICON_RADIUS,
    )
    expect(geometry.control1.y).toBeGreaterThan(geometry.from.y)
    expect(geometry.control2.y).toBeLessThan(geometry.to.y)
  })

  it('lays out the redacted real capture without changing fact coordinates by viewport size', async () => {
    const fixture = await json<{
      rootTimeline: { rootChatId: string; nodes: TimelineNode[] }
    }>('test/fixtures/cp0/real/root-67dabe81.json')
    const graph = projectPersistentExecutionGraph({
      rootChatId: fixture.rootTimeline.rootChatId,
      nodes: fixture.rootTimeline.nodes,
      edges: [],
      activeRuns: [],
    })
    const first = layoutExecutionGraph(graph)
    const second = layoutExecutionGraph(graph, { previousLanes: first.laneByChat })

    expect(first.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      second.nodes.map(({ id, x, y }) => ({ id, x, y })),
    )
    expect(first.nodes.filter((node) => node.main).every((node) => node.x === 0)).toBe(true)
  })
})
