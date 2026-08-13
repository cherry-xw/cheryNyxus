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
import {
  projectFullFoldExecutionGraph,
  projectParticipantFoldExecutionGraph,
} from '../../../src/features/pets/nyxus/graph/foldProjection'
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
  it('packs independent peers together while keeping their merge on the next row', () => {
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

  it('keeps every direct edge descending while independent nodes may share a row', () => {
    const graph = topologyGraph()
    const topology = layoutExecutionGraph(graph, { mode: 'topology' })
    const byId = new Map(topology.nodes.map((node) => [node.id, node]))

    expect(byId.get('left-2')!.y).toBeGreaterThan(byId.get('left-1')!.y)
    for (const edge of graph.edges) {
      const from = byId.get(edge.from)!
      const to = byId.get(edge.to)!
      expect(to.y).toBeGreaterThan(from.y)
    }
    expect(byId.get('left-1')!.y).toBe(byId.get('right-1')!.y)
    expect(new Set(topology.nodes.map((node) => node.y))).toHaveLength(4)
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
    engine.layout(
      {
        ...graph,
        nodes: graph.nodes.map((node) => ({ ...node, content: `${node.content} streamed` })),
      },
      { mode: 'topology' },
    )
    expect(engine.recomputations()).toBe(2)
    engine.layout(graph, { mode: 'topology', branchPacking: 'inward' })
    expect(engine.recomputations()).toBe(3)
  })

  it('reuses an inner lane when root subtrees occupy disjoint topology rows', () => {
    const nodes = [
      executionNode('root', 0),
      executionNode('anchor-a', 1),
      executionNode('outer-left', 2, 'outer-left'),
      executionNode('spacer', 3),
      executionNode('anchor-b', 4),
      executionNode('inner-left', 5, 'inner-left'),
      executionNode('anchor-c', 6),
      executionNode('right', 7, 'right'),
    ]
    const spawn = (from: string, to: string, targetChatId: string) => ({
      id: `spawn:${to}`,
      from,
      to,
      kind: 'spawn' as const,
      orderSlot: 'persistent' as const,
      orderKey: nodes.find((node) => node.id === to)!.orderKey,
      sourceChatId: 'root',
      targetChatId,
    })
    const graph: ExecutionGraph = {
      rootChatId: 'root',
      nodes,
      edges: [
        spawn('anchor-a', 'outer-left', 'outer-left'),
        spawn('anchor-b', 'inner-left', 'inner-left'),
        spawn('anchor-c', 'right', 'right'),
      ],
      diagnostics: [],
    }
    const previousLanes = new Map([
      ['outer-left', -1],
      ['inner-left', -1],
      ['right', 1],
    ])
    const timeline = layoutExecutionGraph(graph, { mode: 'timeline', previousLanes })
    const topology = layoutExecutionGraph(graph, { mode: 'topology', previousLanes })

    expect(timeline.laneByChat.get('outer-left')).toBe(-2)
    expect(topology.laneByChat.get('outer-left')).toBe(-1)
    expect(topology.laneByChat.get('inner-left')).toBe(-1)
    expect(topology.width).toBe(timeline.width - EXECUTION_LANE_GAP)
    expect(new Set(timeline.nodes.map((node) => node.y))).toHaveLength(timeline.nodes.length)

    const blocker = executionNode('inner-blocker', 3, 'inner-left')
    const grown = layoutExecutionGraph(
      {
        ...graph,
        nodes: [...graph.nodes, blocker],
        edges: [
          ...graph.edges,
          {
            id: 'spawn:inner-blocker',
            from: 'anchor-a',
            to: blocker.id,
            kind: 'spawn',
            orderSlot: 'persistent',
            orderKey: blocker.orderKey,
            sourceChatId: 'root',
            targetChatId: 'inner-left',
          },
        ],
      },
      { mode: 'topology', previousLanes: topology.laneByChat },
    )
    expect(grown.nodes.find((node) => node.id === 'inner-blocker')!.y).toBe(
      grown.nodes.find((node) => node.id === 'outer-left')!.y,
    )
    expect(grown.laneByChat.get('outer-left')).toBe(-2)
  })

  it('keeps an outer subtree in place when its nearest lane has a same-row node', () => {
    const nodes = [
      executionNode('root', 0),
      executionNode('dispatch', 1),
      executionNode('outer-left', 2, 'outer-left'),
      executionNode('inner-left', 3, 'inner-left'),
      executionNode('right', 4, 'right'),
    ]
    const spawn = (to: string, targetChatId: string) => ({
      id: `spawn:${to}`,
      from: 'dispatch',
      to,
      kind: 'spawn' as const,
      orderSlot: 'persistent' as const,
      orderKey: nodes.find((node) => node.id === to)!.orderKey,
      sourceChatId: 'root',
      targetChatId,
    })
    const layout = layoutExecutionGraph(
      {
        rootChatId: 'root',
        nodes,
        edges: [
          spawn('outer-left', 'outer-left'),
          spawn('inner-left', 'inner-left'),
          spawn('right', 'right'),
        ],
        diagnostics: [],
      },
      {
        mode: 'topology',
        previousLanes: new Map([
          ['outer-left', -1],
          ['inner-left', -1],
          ['right', 1],
        ]),
      },
    )

    expect(layout.laneByChat.get('outer-left')).toBe(-2)
    expect(layout.nodes.find((node) => node.id === 'outer-left')!.y).toBe(
      layout.nodes.find((node) => node.id === 'inner-left')!.y,
    )
  })

  it('rejects an inward move when the rerouted edge would pass through a node', () => {
    const nodes = [
      executionNode('root', 0),
      executionNode('dispatch', 1),
      executionNode('outer-target', 2, 'outer-left'),
      executionNode('anchor-two', 3),
      executionNode('inner-obstacle', 4, 'inner-left'),
      executionNode('anchor-three', 5),
      executionNode('right', 6, 'right'),
      executionNode('late-anchor', 7),
    ]
    const edge = (
      id: string,
      from: string,
      to: string,
      targetChatId: string,
    ): ExecutionGraph['edges'][number] => ({
      id,
      from,
      to,
      kind: 'spawn',
      orderSlot: 'persistent',
      orderKey: nodes.find((node) => node.id === to)!.orderKey,
      sourceChatId: 'root',
      targetChatId,
    })
    const layout = layoutExecutionGraph(
      {
        rootChatId: 'root',
        nodes,
        edges: [
          edge('outer-long', 'root', 'outer-target', 'outer-left'),
          {
            ...edge('outer-delay', 'late-anchor', 'outer-target', 'outer-left'),
            kind: 'sequence',
          },
          edge('inner-spawn', 'dispatch', 'inner-obstacle', 'inner-left'),
          edge('right-spawn', 'dispatch', 'right', 'right'),
        ],
        diagnostics: [],
      },
      {
        mode: 'topology',
        previousLanes: new Map([
          ['outer-left', -1],
          ['inner-left', -1],
          ['right', 1],
        ]),
      },
    )
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))

    expect(byId.get('outer-target')!.y).toBeGreaterThan(byId.get('inner-obstacle')!.y)
    expect(layout.laneByChat.get('outer-left')).toBe(-2)
  })

  it('rejects an inward move when it would add an edge crossing', () => {
    const nodes = [
      executionNode('root', 0),
      executionNode('outer-return', 1, 'outer-left'),
      executionNode('root-one', 2),
      executionNode('root-two', 3),
      executionNode('root-three', 4),
      executionNode('root-target', 5),
      executionNode('inner-target', 6, 'inner-left'),
      executionNode('right', 7, 'right'),
    ]
    const graph: ExecutionGraph = {
      rootChatId: 'root',
      nodes,
      edges: [
        {
          id: 'outer-return-edge',
          from: 'outer-return',
          to: 'root-target',
          kind: 'return',
          orderSlot: 'persistent',
          orderKey: 8,
          sourceChatId: 'outer-left',
          targetChatId: 'root',
        },
        {
          id: 'inner-spawn',
          from: 'root',
          to: 'inner-target',
          kind: 'spawn',
          orderSlot: 'persistent',
          orderKey: 9,
          sourceChatId: 'root',
          targetChatId: 'inner-left',
        },
        {
          id: 'inner-floor',
          from: 'root-two',
          to: 'inner-target',
          kind: 'sequence',
          orderSlot: 'persistent',
          orderKey: 10,
          sourceChatId: 'root',
          targetChatId: 'inner-left',
        },
      ],
      diagnostics: [],
    }
    const layout = layoutExecutionGraph(graph, {
      mode: 'topology',
      previousLanes: new Map([
        ['outer-left', -1],
        ['inner-left', -1],
        ['right', 1],
      ]),
    })
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))

    expect(byId.get('outer-return')!.y).toBe(byId.get('root')!.y)
    expect(byId.get('inner-target')!.y).toBe(byId.get('root-three')!.y)
    expect(layout.laneByChat.get('outer-left')).toBe(-2)
  })

  it('keeps the full fold layout-independent and strictly more minimal than participant fold', () => {
    const user = {
      ...executionNode('user', 1),
      actor: { kind: 'user' as const, actorId: 'human' },
      target: { kind: 'agent' as const, chatId: 'root' },
      direction: 'user-to-agent' as const,
    }
    const child = (id: string, orderKey: number, sourceChatId: string) => ({
      ...executionNode(id, orderKey, sourceChatId),
      direction: 'internal' as const,
    })
    const reply = executionNode('reply', 8)
    const nodes = [
      executionNode('root', 0),
      user,
      child('left-work-1', 2, 'left'),
      child('right-work-1', 3, 'right'),
      child('left-work-2', 4, 'left'),
      child('right-work-2', 5, 'right'),
      reply,
    ]
    const edge = (
      id: string,
      from: string,
      to: string,
      kind: 'sequence' | 'spawn' = 'sequence',
    ) => ({
      id,
      from,
      to,
      kind,
      orderSlot: 'persistent' as const,
      orderKey: nodes.find((node) => node.id === to)?.orderKey ?? 0,
      sourceChatId: nodes.find((node) => node.id === from)!.sourceChatId,
      targetChatId: nodes.find((node) => node.id === to)!.sourceChatId,
    })
    const fullGraph: ExecutionGraph = {
      rootChatId: 'root',
      nodes,
      edges: [
        edge('start-user', 'root', 'user'),
        edge('user-left', 'user', 'left-work-1', 'spawn'),
        edge('user-right', 'user', 'right-work-1', 'spawn'),
        edge('left-sequence', 'left-work-1', 'left-work-2'),
        edge('right-sequence', 'right-work-1', 'right-work-2'),
        edge('left-reply', 'left-work-2', 'reply'),
        edge('right-reply', 'right-work-2', 'reply'),
      ],
      diagnostics: [],
    }
    const projected = projectFullFoldExecutionGraph(fullGraph).graph
    const thirdLevelGraph = projectParticipantFoldExecutionGraph(fullGraph).graph
    const timeline = layoutExecutionGraph(projected, { mode: 'timeline' })
    const topology = layoutExecutionGraph(projected, { mode: 'topology' })

    // The fourth fold level collapses the round into a single backbone card and
    // no longer depends on the row-overlap layout toggle, so the rendered node
    // count is identical in both modes and strictly below the participant fold.
    expect(projected.nodes.filter((node) => node.kind === 'fold')).toHaveLength(1)
    expect(timeline.nodes.length).toBe(topology.nodes.length)
    expect(projected.nodes.length).toBeLessThan(thirdLevelGraph.nodes.length)
    for (const edge of projected.edges) {
      const from = topology.nodes.find((node) => node.id === edge.from)!
      const to = topology.nodes.find((node) => node.id === edge.to)!
      expect(to.y).toBeGreaterThan(from.y)
    }
  })

  it('keeps topology compact when the parent leaves and re-enters around child returns', () => {
    const node = (
      id: string,
      orderKey: number,
      sourceChatId: string,
      kind: ExecutionNode['kind'] = 'message',
    ): ExecutionNode => ({
      ...executionNode(id, orderKey, sourceChatId),
      kind,
      direction:
        kind === 'dispatch'
          ? 'parent-to-child'
          : kind === 'return'
            ? 'child-to-parent'
            : 'agent-to-user',
    })
    const nodes = [
      {
        ...executionNode('user', 1),
        actor: { kind: 'user' as const, actorId: 'human' },
        target: { kind: 'agent' as const, chatId: 'root' },
        direction: 'user-to-agent' as const,
      },
      node('root-before-1', 2, 'root'),
      node('root-before-2', 3, 'root'),
      node('dispatch-left', 4, 'left', 'dispatch'),
      node('left-1', 5, 'left'),
      node('left-2', 6, 'left'),
      node('dispatch-right', 7, 'right', 'dispatch'),
      node('right-1', 8, 'right'),
      node('right-2', 9, 'right'),
      node('return-left', 10, 'left', 'return'),
      node('root-between-1', 11, 'root'),
      node('root-between-2', 12, 'root'),
      node('return-right', 13, 'right', 'return'),
      node('reply', 14, 'root'),
    ]
    const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]))
    const edge = (
      id: string,
      from: string,
      to: string,
      kind: ExecutionGraph['edges'][number]['kind'],
    ) => ({
      id,
      from,
      to,
      kind,
      orderSlot: 'persistent' as const,
      orderKey: byId.get(to)!.orderKey,
      sourceChatId: byId.get(from)!.sourceChatId,
      targetChatId: byId.get(to)!.sourceChatId,
    })
    const graph: ExecutionGraph = {
      rootChatId: 'root',
      nodes,
      edges: [
        edge('root-before-1', 'user', 'root-before-1', 'sequence'),
        edge('root-before-2', 'root-before-1', 'root-before-2', 'sequence'),
        edge('user-left', 'root-before-2', 'dispatch-left', 'spawn'),
        edge('left-1', 'dispatch-left', 'left-1', 'sequence'),
        edge('left-2', 'left-1', 'left-2', 'sequence'),
        edge('user-right', 'root-before-2', 'dispatch-right', 'spawn'),
        edge('right-1', 'dispatch-right', 'right-1', 'sequence'),
        edge('right-2', 'right-1', 'right-2', 'sequence'),
        edge('left-return', 'left-2', 'return-left', 'return'),
        edge('left-continue', 'return-left', 'root-between-1', 'return-continuation'),
        edge('root-between', 'root-between-1', 'root-between-2', 'sequence'),
        edge('right-return', 'right-2', 'return-right', 'return'),
        edge('right-continue', 'return-right', 'reply', 'return-continuation'),
        edge('root-reply', 'root-between-2', 'reply', 'sequence'),
      ],
      diagnostics: [],
    }
    const projected = projectParticipantFoldExecutionGraph(graph).graph
    const timeline = layoutExecutionGraph(projected, { mode: 'timeline' })
    const topology = layoutExecutionGraph(projected, { mode: 'topology' })
    const incoming = new Map(projected.nodes.map((candidate) => [candidate.id, 0]))
    const outgoing = new Map<string, string[]>()
    for (const candidate of projected.edges) {
      incoming.set(candidate.to, (incoming.get(candidate.to) ?? 0) + 1)
      const targets = outgoing.get(candidate.from) ?? []
      targets.push(candidate.to)
      outgoing.set(candidate.from, targets)
    }
    const ready = [...incoming].filter(([, count]) => count === 0).map(([id]) => id)
    let visited = 0
    while (ready.length) {
      const id = ready.shift()!
      visited += 1
      for (const target of outgoing.get(id) ?? []) {
        const count = (incoming.get(target) ?? 0) - 1
        incoming.set(target, count)
        if (count === 0) ready.push(target)
      }
    }

    expect(visited).toBe(projected.nodes.length)
    expect(topology.height).toBeLessThan(timeline.height)
    expect(new Set(topology.nodes.map((candidate) => candidate.y)).size).toBeLessThan(
      topology.nodes.length,
    )
    expect(topology.nodes.every((candidate) => Number.isFinite(candidate.y))).toBe(true)
  })

  it('does not let a full-fold summary cross a visible fork anchor', () => {
    const user = {
      ...executionNode('user', 1),
      actor: { kind: 'user' as const, actorId: 'human' },
      target: { kind: 'agent' as const, chatId: 'root' },
      direction: 'user-to-agent' as const,
    }
    const beforeA = executionNode('before-a', 2)
    const beforeB = executionNode('before-b', 3)
    const anchor = {
      ...executionNode('anchor', 4),
      sourceFact: {
        id: 'anchor',
        rootChatId: 'root',
        sourceChatId: 'root',
        kind: 'tool-batch' as const,
        actor: { kind: 'agent' as const, chatId: 'root' },
        direction: 'internal' as const,
        visibility: 'detail' as const,
        content: '',
        orderKey: 4,
        createdAt: 4,
        updatedAt: 4,
        status: 'committed' as const,
        forkAnchor: true,
      },
    }
    const afterA = executionNode('after-a', 5)
    const afterB = executionNode('after-b', 6)
    const reply = executionNode('reply', 7)
    const nodes = [user, beforeA, beforeB, anchor, afterA, afterB, reply]
    const edges = nodes.slice(1).map((node, index) => ({
      id: `edge-${index}`,
      from: nodes[index]!.id,
      to: node.id,
      kind: 'sequence' as const,
      orderSlot: 'persistent' as const,
      orderKey: node.orderKey,
      sourceChatId: 'root',
      targetChatId: 'root',
    }))
    const projected = projectFullFoldExecutionGraph({
      rootChatId: 'root',
      nodes,
      edges,
      diagnostics: [],
    }).graph
    const folds = projected.nodes.filter((node) => node.kind === 'fold')
    const layout = layoutExecutionGraph(projected, { mode: 'topology' })
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))

    expect(folds).toHaveLength(2)
    expect(
      folds.every((fold) => !fold.fold?.projectionNodes.some((node) => node.id === 'anchor')),
    ).toBe(true)
    expect(byId.get(folds[0]!.id)!.y).toBeLessThan(byId.get('anchor')!.y)
    expect(byId.get(folds[1]!.id)!.y).toBeGreaterThan(byId.get('anchor')!.y)
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

  it('keeps canonical time descending with the root centered and a later descendant nearer the centre', async () => {
    const fixture = await json<TopologyFixture>('test/fixtures/cp3-topology-matrix.json')
    const layout = layoutExecutionGraph(projectPersistentExecutionGraph(fixture.snapshot))
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))

    for (let index = 1; index < layout.nodes.length; index += 1) {
      expect(layout.nodes[index]!.y).toBeGreaterThan(layout.nodes[index - 1]!.y)
    }
    expect(layout.nodes.filter((node) => node.main).every((node) => node.x === 0)).toBe(true)
    expect(Math.abs(byId.get('grandchild-start')!.x)).toBe(EXECUTION_LANE_GAP)
    expect(Math.abs(byId.get('child-a-start')!.x)).toBe(2 * EXECUTION_LANE_GAP)
    expect(Math.sign(byId.get('grandchild-start')!.x)).toBe(Math.sign(byId.get('child-a-start')!.x))
    expect(Math.sign(byId.get('child-a-start')!.x)).not.toBe(
      Math.sign(byId.get('child-b-start')!.x),
    )
    expect(layout.bounds.minX).toBeLessThan(0)
    expect(layout.bounds.maxX).toBeGreaterThan(0)
  })

  it('balances every fan-out around its parent and puts an odd extra child outward', () => {
    const nodes = [
      executionNode('root', 0),
      executionNode('root-dispatch', 1),
      executionNode('upper', 2, 'upper'),
      executionNode('lower-one', 3, 'lower-one'),
      executionNode('lower-two', 4, 'lower-two'),
      executionNode('lower-three', 5, 'lower-three'),
      executionNode('grand-one', 6, 'grand-one'),
      executionNode('grand-two', 7, 'grand-two'),
    ]
    const structuralEdge = (
      id: string,
      from: string,
      to: string,
      sourceChatId: string,
      targetChatId: string,
    ) => ({
      id,
      from,
      to,
      kind: 'spawn' as const,
      orderSlot: 'persistent' as const,
      orderKey: 1,
      sourceChatId,
      targetChatId,
    })
    const layout = layoutExecutionGraph(
      {
        rootChatId: 'root',
        nodes,
        edges: [
          structuralEdge('root-upper', 'root-dispatch', 'upper', 'root', 'upper'),
          structuralEdge('upper-lower-one', 'upper', 'lower-one', 'upper', 'lower-one'),
          structuralEdge('upper-lower-two', 'upper', 'lower-two', 'upper', 'lower-two'),
          structuralEdge('upper-lower-three', 'upper', 'lower-three', 'upper', 'lower-three'),
          structuralEdge(
            'lower-three-grand-one',
            'lower-three',
            'grand-one',
            'lower-three',
            'grand-one',
          ),
          structuralEdge(
            'lower-three-grand-two',
            'lower-three',
            'grand-two',
            'lower-three',
            'grand-two',
          ),
        ],
        diagnostics: [],
      },
      {
        previousLanes: new Map([
          ['upper', 1],
          ['lower-one', 1],
          ['lower-two', 1],
          ['lower-three', 1],
          ['grand-one', 1],
          ['grand-two', 1],
        ]),
      },
    )

    const upper = layout.laneByChat.get('upper')!
    const children = ['lower-one', 'lower-two', 'lower-three'].map((chatId) =>
      layout.laneByChat.get(chatId)!,
    )
    expect(upper).toBeGreaterThan(0)
    expect(children.filter((lane) => lane < upper)).toHaveLength(1)
    expect(children.filter((lane) => lane > upper)).toHaveLength(2)

    const lowerThree = layout.laneByChat.get('lower-three')!
    const grandchildren = ['grand-one', 'grand-two'].map((chatId) => layout.laneByChat.get(chatId)!)
    expect(grandchildren.filter((lane) => lane < lowerThree)).toHaveLength(1)
    expect(grandchildren.filter((lane) => lane > lowerThree)).toHaveLength(1)

    const mirrored = layoutExecutionGraph(
      {
        rootChatId: 'root',
        nodes: nodes.filter((node) => !node.sourceChatId.startsWith('grand-')),
        edges: [
          structuralEdge('root-upper', 'root-dispatch', 'upper', 'root', 'upper'),
          structuralEdge('upper-lower-one', 'upper', 'lower-one', 'upper', 'lower-one'),
          structuralEdge('upper-lower-two', 'upper', 'lower-two', 'upper', 'lower-two'),
          structuralEdge('upper-lower-three', 'upper', 'lower-three', 'upper', 'lower-three'),
        ],
        diagnostics: [],
      },
      {
        previousLanes: new Map([
          ['upper', -1],
          ['lower-one', -1],
          ['lower-two', -1],
          ['lower-three', -1],
        ]),
      },
    )
    const mirroredParent = mirrored.laneByChat.get('upper')!
    const mirroredChildren = ['lower-one', 'lower-two', 'lower-three'].map((chatId) =>
      mirrored.laneByChat.get(chatId)!,
    )
    expect(mirroredParent).toBeLessThan(0)
    expect(mirroredChildren.filter((lane) => lane < mirroredParent)).toHaveLength(2)
    expect(mirroredChildren.filter((lane) => lane > mirroredParent)).toHaveLength(1)
  })

  it('packs lower fourth-level subtrees inward while preserving their local fan-out', () => {
    const nodes = [
      executionNode('root', 0),
      executionNode('upper-anchor', 10),
      executionNode('right-upper-anchor', 20),
      executionNode('lower-anchor', 30),
      executionNode('right-lower-anchor', 35),
      executionNode('lower', 40, 'lower'),
      executionNode('lower-child-one', 50, 'lower-child-one'),
      executionNode('lower-child-two', 60, 'lower-child-two'),
      executionNode('right-lower', 70, 'right-lower'),
      executionNode('right-upper', 80, 'right-upper'),
      // The upper branch answers last even though its trunk anchor is above the
      // lower branch. Sorting by child facts instead of anchors reverses them.
      executionNode('upper', 100, 'upper'),
    ]
    const spawn = (from: string, to: string, sourceChatId: string, targetChatId: string) => ({
      id: `spawn:${from}:${to}`,
      from,
      to,
      kind: 'spawn' as const,
      orderSlot: 'persistent' as const,
      orderKey: nodes.find((node) => node.id === to)?.orderKey ?? 0,
      sourceChatId,
      targetChatId,
    })
    const projected = projectFullFoldExecutionGraph({
      rootChatId: 'root',
      nodes,
      edges: [
        spawn('upper-anchor', 'upper', 'root', 'upper'),
        spawn('lower-anchor', 'lower', 'root', 'lower'),
        spawn('lower', 'lower-child-one', 'lower', 'lower-child-one'),
        spawn('lower', 'lower-child-two', 'lower', 'lower-child-two'),
        spawn('right-upper-anchor', 'right-upper', 'root', 'right-upper'),
        spawn('right-lower-anchor', 'right-lower', 'root', 'right-lower'),
      ],
      diagnostics: [],
    }).graph
    const layout = layoutExecutionGraph(projected, {
      branchPacking: 'inward',
      previousLanes: new Map([
        ['upper', -1],
        ['lower', -1],
        ['right-upper', 1],
        ['right-lower', 1],
      ]),
    })

    expect(layout.laneByChat.get('upper')).toBe(-4)
    expect(layout.laneByChat.get('lower')).toBe(-2)
    expect(
      ['lower-child-one', 'lower-child-two']
        .map((chatId) => layout.laneByChat.get(chatId)!)
        .sort((a, b) => a - b),
    ).toEqual([-3, -1])
    expect(layout.laneByChat.get('right-upper')).toBe(2)
    expect(layout.laneByChat.get('right-lower')).toBe(1)
  })

  it('balances root children while keeping newer siblings nearer the centre on each side', () => {
    const nodes = [
      executionNode('root', 0),
      executionNode('dispatch', 1),
      executionNode('early', 2, 'early'),
      executionNode('middle', 3, 'middle'),
      executionNode('late', 4, 'late'),
    ]
    const spawn = (chatId: string, orderKey: number) => ({
      id: `spawn:${chatId}`,
      from: 'dispatch',
      to: chatId,
      kind: 'spawn' as const,
      orderSlot: 'persistent' as const,
      orderKey,
      sourceChatId: 'root',
      targetChatId: chatId,
    })
    const layout = layoutExecutionGraph(
      {
        rootChatId: 'root',
        nodes,
        edges: [spawn('early', 2), spawn('middle', 3), spawn('late', 4)],
        diagnostics: [],
      },
      {
        previousLanes: new Map([
          ['early', 1],
          ['middle', 1],
          ['late', 1],
        ]),
      },
    )

    const lanes = ['early', 'middle', 'late'].map((chatId) => layout.laneByChat.get(chatId)!)
    expect(lanes.filter((lane) => lane < 0)).toHaveLength(1)
    expect(lanes.filter((lane) => lane > 0)).toHaveLength(2)
    expect(Math.abs(layout.laneByChat.get('middle')!)).toBeLessThan(
      Math.abs(layout.laneByChat.get('early')!),
    )
  })

  it('keeps a returning child beside the displaced old main branch without crossing the centre', () => {
    const originalBranchId = 'original-branch'
    const activeBranchId = 'active-branch'
    const anchor = {
      ...executionNode('anchor', 10),
      sourceFact: { branchId: originalBranchId } as TimelineNode,
    }
    const suffix = {
      ...executionNode('old-suffix', 20),
      sourceFact: { branchId: originalBranchId } as TimelineNode,
    }
    const child = executionNode('child-result', 15, 'child')
    const active = {
      ...executionNode('active-input', 30, 'active-chat'),
      sourceFact: { branchId: activeBranchId } as TimelineNode,
    }
    const edge = (
      id: string,
      from: string,
      to: string,
      kind: ExecutionGraph['edges'][number]['kind'],
      sourceChatId: string,
      targetChatId: string,
      orderKey: number,
    ) => ({
      id,
      from,
      to,
      kind,
      orderSlot: 'persistent' as const,
      orderKey,
      sourceChatId,
      targetChatId,
    })
    const graph: ExecutionGraph = {
      rootChatId: 'root',
      activeBranchId,
      branches: [
        {
          branchId: originalBranchId,
          taskId: 'task',
          chatId: 'root',
          kind: 'original',
          createdAt: 1,
        },
        {
          branchId: activeBranchId,
          taskId: 'task',
          chatId: 'active-chat',
          kind: 'continuation',
          sourceBranchId: originalBranchId,
          createdAt: 2,
        },
      ],
      nodes: [executionNode('root', 0), anchor, child, suffix, active],
      edges: [
        edge('spawn-child', 'anchor', 'child-result', 'spawn', 'root', 'child', 11),
        edge(
          'fork-active',
          'anchor',
          'active-input',
          'fork-continuation',
          'root',
          'active-chat',
          31,
        ),
        edge(
          'return-old',
          'child-result',
          'old-suffix',
          'return-continuation',
          'child',
          'root',
          21,
        ),
        edge(
          'return-active',
          'child-result',
          'active-input',
          'return-continuation',
          'child',
          'active-chat',
          32,
        ),
      ],
      diagnostics: [],
    }
    const layout = layoutExecutionGraph(graph, { mode: 'topology' })
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))
    const returnEdges = layout.edges.filter((candidate) => candidate.id.startsWith('return-'))

    expect(byId.get('old-suffix')!.lane).toBe(1)
    expect(layout.laneByChat.get('child')).toBe(2)
    expect(byId.get('active-input')!.lane).toBe(0)
    expect(returnEdges.map((candidate) => candidate.routeX)).toEqual([
      2 * EXECUTION_LANE_GAP,
      2 * EXECUTION_LANE_GAP,
    ])
    expect(returnEdges.every((candidate) => candidate.routeX! > 0)).toBe(true)

    const coordinates = new Set(layout.nodes.map((node) => `${node.x}:${node.y}`))
    expect(coordinates.size).toBe(layout.nodes.length)
  })

  it('uses the final displaced lane when resolving same-row collisions', () => {
    const originalBranchId = 'original'
    const activeBranchId = 'active'
    const fact = (branchId: string) => ({ branchId }) as TimelineNode
    const graph: ExecutionGraph = {
      rootChatId: 'root',
      activeBranchId,
      branches: [
        {
          branchId: originalBranchId,
          taskId: 'task',
          chatId: 'root',
          kind: 'original',
          createdAt: 1,
        },
        {
          branchId: activeBranchId,
          taskId: 'task',
          chatId: 'active-chat',
          kind: 'continuation',
          sourceBranchId: originalBranchId,
          createdAt: 2,
        },
      ],
      nodes: [
        executionNode('root', 0),
        { ...executionNode('anchor', 1), sourceFact: fact(originalBranchId) },
        { ...executionNode('old-suffix', 2), sourceFact: fact(originalBranchId) },
        executionNode('side-node', 3, 'side-chat'),
        { ...executionNode('active', 4, 'active-chat'), sourceFact: fact(activeBranchId) },
      ],
      edges: [
        {
          id: 'fork',
          from: 'anchor',
          to: 'active',
          kind: 'fork-continuation',
          orderSlot: 'persistent',
          orderKey: 4,
          sourceChatId: 'root',
          targetChatId: 'active-chat',
        },
        {
          id: 'spawn',
          from: 'anchor',
          to: 'side-node',
          kind: 'spawn',
          orderSlot: 'persistent',
          orderKey: 3,
          sourceChatId: 'root',
          targetChatId: 'side-chat',
        },
      ],
      diagnostics: [],
    }
    const layout = layoutExecutionGraph(graph, {
      mode: 'topology',
      previousLanes: new Map([['side-chat', 1]]),
    })

    const coordinates = layout.nodes.map((node) => `${node.x}:${node.y}`)
    expect(new Set(coordinates).size).toBe(coordinates.length)
  })

  it('does not move child-agent nodes onto the displaced main-branch suffix lane', () => {
    const originalBranchId = 'original'
    const activeBranchId = 'active'
    const fact = (branchId: string) => ({ branchId }) as TimelineNode
    const anchor = { ...executionNode('anchor', 10), sourceFact: fact(originalBranchId) }
    const childBefore = {
      ...executionNode('child-before', 12, 'child-chat'),
      sourceFact: fact(originalBranchId),
    }
    const childAfter = {
      ...executionNode('child-after', 20, 'child-chat'),
      sourceFact: fact(originalBranchId),
    }
    const active = {
      ...executionNode('active', 30, 'active-chat'),
      sourceFact: fact(activeBranchId),
    }
    const graph: ExecutionGraph = {
      rootChatId: 'root',
      activeBranchId,
      branches: [
        {
          branchId: originalBranchId,
          taskId: 'task',
          chatId: 'root',
          kind: 'original',
          createdAt: 1,
        },
        {
          branchId: activeBranchId,
          taskId: 'task',
          chatId: 'active-chat',
          kind: 'continuation',
          sourceBranchId: originalBranchId,
          createdAt: 2,
        },
      ],
      nodes: [executionNode('root', 0), anchor, childBefore, childAfter, active],
      edges: [
        {
          id: 'spawn-child',
          from: 'anchor',
          to: 'child-before',
          kind: 'spawn',
          orderSlot: 'persistent',
          orderKey: 11,
          sourceChatId: 'root',
          targetChatId: 'child-chat',
        },
        {
          id: 'child-sequence',
          from: 'child-before',
          to: 'child-after',
          kind: 'sequence',
          orderSlot: 'persistent',
          orderKey: 20,
          sourceChatId: 'child-chat',
          targetChatId: 'child-chat',
        },
        {
          id: 'fork',
          from: 'anchor',
          to: 'active',
          kind: 'fork-continuation',
          orderSlot: 'persistent',
          orderKey: 30,
          sourceChatId: 'root',
          targetChatId: 'active-chat',
        },
      ],
      diagnostics: [],
    }
    const layout = layoutExecutionGraph(graph, {
      mode: 'topology',
      previousLanes: new Map([['child-chat', 1]]),
    })
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))

    expect(layout.laneByChat.get('child-chat')).toBe(2)
    expect(byId.get('child-before')!.lane).toBe(2)
    expect(byId.get('child-after')!.lane).toBe(2)
    expect(byId.get('child-before')!.x).toBe(byId.get('child-after')!.x)
  })

  it('places a continuation immediately below its real fork anchor', () => {
    const rootAnchor = executionNode('anchor', 10)
    const rootSuffix = executionNode('suffix', 20)
    const continuation = {
      ...executionNode('continuation', 100, 'continuation-chat'),
      sourceFact: { branchId: 'continuation-branch' } as TimelineNode,
    }
    const graph: ExecutionGraph = {
      rootChatId: 'root',
      activeBranchId: 'continuation-branch',
      branches: [
        {
          branchId: 'continuation-branch',
          taskId: 'task',
          chatId: 'continuation-chat',
          kind: 'continuation',
          createdAt: 1,
        },
      ],
      nodes: [executionNode('root', 0), rootAnchor, rootSuffix, continuation],
      edges: [
        {
          id: 'fork',
          from: rootAnchor.id,
          to: continuation.id,
          kind: 'fork-continuation',
          orderSlot: 'persistent',
          orderKey: 101,
          sourceChatId: 'root',
          targetChatId: 'continuation-chat',
        },
      ],
      diagnostics: [],
    }
    const layout = layoutExecutionGraph(graph, { mode: 'topology' })
    const byId = new Map(layout.nodes.map((node) => [node.id, node]))

    expect(byId.get('continuation')!.y - byId.get('anchor')!.y).toBeGreaterThanOrEqual(
      EXECUTION_ROW_GAP,
    )
    expect(layout.laneByChat.get('continuation-chat')).toBe(0)
    expect(new Set(layout.nodes.map((node) => `${node.x}:${node.y}`)).size).toBe(
      layout.nodes.length,
    )
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

  it('routes a cross-lane curve through the reserved subtree corridor', () => {
    const geometry = executionEdgeGeometry(
      { x: 0, y: 82 },
      { x: -220, y: 246 },
      EXECUTION_ICON_RADIUS,
      -110,
    )

    expect(geometry.control1.x).toBe(-110)
    expect(geometry.control2.x).toBe(-110)
    expect(geometry.from.x).toBe(0)
    expect(geometry.to.x).toBe(-220)
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
