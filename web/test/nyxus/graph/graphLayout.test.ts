import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot, TimelineNode } from '../../../src/services/agentApi'
import { projectPersistentExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  EXECUTION_ICON_RADIUS,
  EXECUTION_LANE_GAP,
  layoutExecutionGraph,
} from '../../../src/features/pets/nyxus/graph/executionLayout'
import { executionEdgeGeometry } from '../../../src/features/pets/nyxus/graph/executionGeometry'

interface TopologyFixture {
  snapshot: RootTimelineSnapshot
}

async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as T
}

describe('execution layout and edge geometry', () => {
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
