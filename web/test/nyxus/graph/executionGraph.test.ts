import { describe, expect, it } from 'vitest'
import type { ActiveRunFact, ExecutionEdgeFact, TimelineNode } from '../../../src/services/agentApi'
import {
  projectActiveTurnNodes,
  projectExecutionGraph,
  projectPersistentExecutionGraph,
  type ExecutionGraphSnapshot,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  EXECUTION_LANE_GAP,
  EXECUTION_ROW_GAP,
  layoutExecutionGraph,
} from '../../../src/features/pets/nyxus/graph/executionLayout'
import { skinKeyForNode } from '../../../src/features/pets/nyxus/graph/nodeSkins'

function node(id: string, orderKey: number, partial: Partial<TimelineNode> = {}): TimelineNode {
  return {
    id,
    rootChatId: 'root',
    sourceChatId: 'root',
    kind: 'message',
    actor: { kind: 'agent', chatId: 'root' },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: id,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
    ...partial,
  }
}

function edge(
  id: string,
  orderKey: number,
  fromNodeId: string,
  toNodeId: string,
  kind: ExecutionEdgeFact['kind'] = 'sequence',
  partial: Partial<ExecutionEdgeFact> = {},
): ExecutionEdgeFact {
  return {
    id,
    rootChatId: 'root',
    fromNodeId,
    toNodeId,
    kind,
    orderKey,
    sourceChatId: 'root',
    targetChatId: 'root',
    ...partial,
  }
}

function snapshot(
  nodes: TimelineNode[],
  edges: ExecutionEdgeFact[] = [],
  activeRuns: ActiveRunFact[] = [],
): ExecutionGraphSnapshot {
  return { rootChatId: 'root', nodes, edges, activeRuns }
}

function topology(graph: ReturnType<typeof projectExecutionGraph>) {
  return {
    nodes: graph.nodes.map(({ id, kind, orderSlot, orderKey, sourceChatId }) => ({
      id,
      kind,
      orderSlot,
      orderKey,
      sourceChatId,
    })),
    edges: graph.edges.map(({ id, from, to, kind, orderSlot, orderKey }) => ({
      id,
      from,
      to,
      kind,
      orderSlot,
      orderKey,
    })),
    diagnostics: graph.diagnostics,
  }
}

describe('execution graph projector', () => {
  it('returns only the permanent start node for an empty snapshot', () => {
    const graph = projectExecutionGraph(snapshot([]))

    expect(graph.nodes.map((item) => item.id)).toEqual(['start:root'])
    expect(graph.edges).toEqual([])
    expect(graph.diagnostics).toEqual([])
  })

  it('keeps one permanent start node and only links the first root fact', () => {
    const graph = projectExecutionGraph(
      snapshot([
        node('child-first', 1, { sourceChatId: 'child' }),
        node('root-first', 2),
        node('root-second', 3),
      ]),
    )

    expect(graph.nodes[0]).toMatchObject({
      id: 'start:root',
      kind: 'start',
      orderSlot: 'start',
      orderKey: null,
    })
    expect(graph.edges.filter((item) => item.kind === 'start')).toEqual([
      expect.objectContaining({ from: 'start:root', to: 'root-first' }),
    ])
  })

  it('projects explicit DAG edges without guessing missing cross-agent relations', () => {
    const nodes = [
      node('batch', 1, { kind: 'tool-batch' }),
      node('child-a', 2, { sourceChatId: 'child-a' }),
      node('child-b', 3, { sourceChatId: 'child-b' }),
      node('root-next', 4),
    ]
    const edges = [
      edge('spawn-a', 5, 'batch', 'child-a', 'spawn', { targetChatId: 'child-a' }),
      edge('spawn-b', 6, 'batch', 'child-b', 'spawn', { targetChatId: 'child-b' }),
      edge('continue', 7, 'batch', 'root-next', 'continue'),
    ]
    const graph = projectPersistentExecutionGraph(snapshot(nodes, edges))

    expect(graph.edges.filter((item) => item.from === 'batch')).toEqual([
      expect.objectContaining({ id: 'spawn-a', kind: 'spawn', to: 'child-a' }),
      expect.objectContaining({ id: 'spawn-b', kind: 'spawn', to: 'child-b' }),
      expect.objectContaining({ id: 'continue', kind: 'continue', to: 'root-next' }),
    ])
    expect(graph.edges.some((item) => item.from === 'child-a' && item.to === 'root-next')).toBe(
      false,
    )
  })

  it('collapses a resolved spawn target into the durable child delegation input', () => {
    const graph = projectPersistentExecutionGraph(
      snapshot(
        [
          node('batch', 1, { kind: 'tool-batch' }),
          node('spawn-target:task-child', 2, {
            sourceChatId: 'child',
            kind: 'dispatch',
            actor: { kind: 'agent', chatId: 'root' },
            target: { kind: 'agent', chatId: 'child' },
            direction: 'parent-to-child',
            visibility: 'internal',
          }),
          node('child-input', 3, {
            sourceChatId: 'child',
            actor: { kind: 'agent', chatId: 'root' },
            target: { kind: 'agent', chatId: 'child' },
            direction: 'parent-to-child',
          }),
        ],
        [
          edge('spawn-edge', 4, 'batch', 'spawn-target:task-child', 'spawn', {
            targetChatId: 'child',
          }),
          edge('target-sequence', 5, 'spawn-target:task-child', 'child-input', 'sequence', {
            sourceChatId: 'child',
            targetChatId: 'child',
          }),
        ],
      ),
    )

    expect(graph.nodes.some((item) => item.id === 'spawn-target:task-child')).toBe(false)
    expect(graph.nodes.filter((item) => item.direction === 'parent-to-child')).toHaveLength(1)
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        id: 'spawn-edge',
        from: 'batch',
        to: 'child-input',
        kind: 'spawn',
      }),
    )
    expect(graph.edges.some((item) => item.id === 'target-sequence')).toBe(false)
  })

  it('retains revoked facts, termination and exact active-run references', () => {
    const run: ActiveRunFact = {
      rootChatId: 'root',
      chatId: 'child',
      runId: 'run-child',
      nodeId: 'revoked',
      status: 'paused',
    }
    const revoked = node('revoked', 1, {
      sourceChatId: 'child',
      status: 'revoked',
      termination: { actor: 'user', code: 'user_abort', at: 10 },
    })
    const graph = projectExecutionGraph(snapshot([revoked], [], [run]))

    expect(graph.nodes.find((item) => item.id === 'revoked')).toMatchObject({
      status: 'revoked',
      activeRuns: [run],
      sourceFact: { termination: { actor: 'user', code: 'user_abort', at: 10 } },
    })
  })

  it('preserves concurrent child returns into one parent continuation as a DAG', () => {
    const nodes = [
      node('child-a-end', 1, { sourceChatId: 'child-a' }),
      node('child-b-end', 2, { sourceChatId: 'child-b' }),
      node('return-a', 3, { sourceChatId: 'child-a', kind: 'return' }),
      node('return-b', 4, { sourceChatId: 'child-b', kind: 'return' }),
      node('parent-next', 5),
    ]
    const edges = [
      edge('return-a-edge', 6, 'child-a-end', 'return-a', 'return', {
        sourceChatId: 'child-a',
      }),
      edge('return-b-edge', 7, 'child-b-end', 'return-b', 'return', {
        sourceChatId: 'child-b',
      }),
      edge('continue-a', 8, 'return-a', 'parent-next', 'return-continuation', {
        sourceChatId: 'child-a',
      }),
      edge('continue-b', 9, 'return-b', 'parent-next', 'return-continuation', {
        sourceChatId: 'child-b',
      }),
    ]
    const graph = projectExecutionGraph(snapshot(nodes, edges))

    expect(
      graph.edges.filter((item) => item.to === 'parent-next' && item.orderSlot === 'persistent'),
    ).toEqual([
      expect.objectContaining({ id: 'continue-a' }),
      expect.objectContaining({ id: 'continue-b' }),
    ])
  })

  it('deduplicates repeated patch facts and is deterministic under shuffled input', () => {
    const nodes = [node('n2', 2), node('n1', 1)]
    const edges = [edge('e1', 3, 'n1', 'n2')]
    const repeated = projectExecutionGraph(snapshot([...nodes, nodes[0]!], [...edges, edges[0]!]))
    const shuffled = projectExecutionGraph(
      snapshot(nodes.slice().reverse(), edges.slice().reverse()),
    )

    expect(repeated.nodes.filter((item) => item.id === 'n2')).toHaveLength(1)
    expect(repeated.edges.filter((item) => item.id === 'e1')).toHaveLength(1)
    expect(topology(projectExecutionGraph(snapshot(nodes, edges)))).toEqual(topology(shuffled))
    expect(repeated.diagnostics.map((item) => item.code)).toEqual([
      'duplicate-edge-id',
      'duplicate-node-id',
    ])
  })

  it('injects ordered input nodes without mutating the persistent graph', () => {
    const persistent = projectPersistentExecutionGraph(snapshot([node('root-node', 1)]))
    const projected = projectExecutionGraph(snapshot([node('root-node', 1)]), [
      { id: 'draft', content: '', createdAt: 3, state: 'editing' },
      { id: 'pending', content: 'queued', createdAt: 2, state: 'pending', queueSequence: 1 },
    ])

    expect(persistent.nodes.map((item) => item.id)).toEqual(['start:root', 'root-node'])
    expect(projected.nodes.map((item) => item.id)).toEqual([
      'start:root',
      'root-node',
      'pending',
      'draft',
    ])
    expect(projected.edges.slice(-2)).toEqual([
      expect.objectContaining({ from: 'root-node', to: 'pending', kind: 'input' }),
      expect.objectContaining({ from: 'pending', to: 'draft', kind: 'input' }),
    ])
  })

  it('projects a live response node immediately and lets the canonical fact take over by ID', () => {
    const run: ActiveRunFact = {
      rootChatId: 'root',
      chatId: 'root',
      runId: 'run-live',
      status: 'running',
      nodeId: 'assistant-live',
    }
    const turn = {
      chatId: 'root',
      turnId: 'turn-live',
      runId: 'run-live',
      messageId: 'assistant-live',
      thinking: 'planning',
      content: 'first delta',
      status: 'running' as const,
      createdAt: 3,
    }
    const pendingGraph = projectExecutionGraph(snapshot([node('root-node', 1)]), [
      { id: 'user-live', content: 'go', createdAt: 2, state: 'pending' },
    ])
    const live = projectActiveTurnNodes(pendingGraph, [turn], [run])

    expect(live.nodes.find((item) => item.id === 'assistant-live')).toMatchObject({
      kind: 'message',
      orderSlot: 'transient',
      content: 'first delta',
      activeRuns: [{ runId: 'run-live', status: 'running' }],
    })
    expect(live.edges.at(-1)).toMatchObject({
      from: 'user-live',
      to: 'assistant-live',
      kind: 'stream',
    })
    const liveLayout = layoutExecutionGraph(live)
    expect(liveLayout.nodes.find((item) => item.id === 'user-live')!.y).toBeLessThan(
      liveLayout.nodes.find((item) => item.id === 'assistant-live')!.y,
    )

    const canonical = projectActiveTurnNodes(
      projectExecutionGraph(
        snapshot(
          [node('root-node', 1), node('assistant-live', 3, { content: 'sealed response' })],
          [edge('canonical-live', 4, 'root-node', 'assistant-live')],
          [run],
        ),
      ),
      [turn],
      [run],
    )
    expect(canonical.nodes.filter((item) => item.id === 'assistant-live')).toEqual([
      expect.objectContaining({ orderSlot: 'persistent', content: 'sealed response' }),
    ])
    expect(canonical.edges.some((item) => item.kind === 'stream')).toBe(false)
  })

  it('anchors a child turn to its dispatch target before the child response is durable', () => {
    const dispatchTarget = node('dispatch:child', 2, {
      sourceChatId: 'root',
      kind: 'dispatch',
      actor: { kind: 'agent', chatId: 'root' },
      target: { kind: 'agent', chatId: 'child' },
      direction: 'parent-to-child',
    })
    const childTurn = {
      chatId: 'child',
      turnId: 'child:turn',
      runId: 'child:run',
      messageId: 'child:message',
      thinking: '',
      content: 'child delta',
      status: 'running' as const,
      createdAt: 3,
    }
    const live = projectActiveTurnNodes(
      projectExecutionGraph(
        snapshot(
          [node('root-node', 1), dispatchTarget],
          [edge('dispatch-edge', 3, 'root-node', 'dispatch:child', 'dispatch')],
        ),
      ),
      [childTurn],
      [],
    )

    expect(live.nodes.find((item) => item.id === 'child:message')).toMatchObject({
      sourceChatId: 'child',
      orderSlot: 'transient',
      activeRuns: [{ chatId: 'child', runId: 'child:run', status: 'running' }],
    })
    expect(live.edges.at(-1)).toMatchObject({
      from: 'dispatch:child',
      to: 'child:message',
      kind: 'stream',
    })
  })

  it('reports malformed facts without deleting their nodes or fabricating edges', () => {
    const malformed = node('foreign-user', 1, {
      rootChatId: 'other-root',
      sourceChatId: 'child',
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: 'child' },
    })
    const unknown = { ...node('legacy', 1), kind: 'legacy-kind' } as unknown as TimelineNode
    const dangling = edge('dangling', 2, 'legacy', 'missing')
    const graph = projectExecutionGraph(snapshot([malformed, unknown], [dangling]))

    expect(graph.nodes.map((item) => item.id)).toEqual(['start:root', 'foreign-user', 'legacy'])
    expect(graph.edges.some((item) => item.id === 'dangling')).toBe(true)
    expect(graph.edges.map((item) => item.kind)).toEqual(['start', 'sequence'])
    expect(graph.diagnostics.map((item) => item.code)).toEqual([
      'cross-root-reference',
      'dangling-edge',
      'duplicate-order-key',
      'illegal-user-child-input',
      'unknown-node-kind',
    ])
  })

  it('lays out persistent facts by orderKey rather than createdAt', () => {
    const graph = projectExecutionGraph(
      snapshot([node('later', 2, { createdAt: 1 }), node('earlier', 1, { createdAt: 100 })]),
    )
    const layout = layoutExecutionGraph(graph)

    expect(layout.nodes.find((item) => item.id === 'earlier')!.y).toBeLessThan(
      layout.nodes.find((item) => item.id === 'later')!.y,
    )
  })

  it('keeps persistent coordinates stable when a transient editing draft is added', () => {
    const facts = snapshot([node('root-1', 1), node('root-2', 2)])
    const persistent = layoutExecutionGraph(projectExecutionGraph(facts))
    const withDraft = layoutExecutionGraph(
      projectExecutionGraph(facts, [{ id: 'draft', content: '', createdAt: 3, state: 'editing' }]),
    )

    expect(EXECUTION_LANE_GAP).toBe(190)
    expect(EXECUTION_ROW_GAP).toBe(82)
    for (const nodeId of ['start:root', 'root-1', 'root-2']) {
      expect(withDraft.nodes.find((item) => item.id === nodeId)).toMatchObject(
        persistent.nodes.find((item) => item.id === nodeId)!,
      )
    }
    expect(withDraft.height - persistent.height).toBe(EXECUTION_ROW_GAP)
  })

  it('renders the canonical root trunk and child return without synthesizing layout edges', () => {
    const nodes = [
      node('root-before', 1, { kind: 'tool-batch' }),
      node('child-output', 2, { sourceChatId: 'child' }),
      node('child-return', 3, { sourceChatId: 'child', kind: 'return' }),
      node('root-after', 4),
    ]
    const edges = [
      edge('root-trunk', 5, 'root-before', 'root-after', 'continue'),
      edge('child-return-edge', 6, 'child-output', 'child-return', 'return', {
        sourceChatId: 'child',
      }),
      edge('child-return-continuation', 8, 'child-return', 'root-after', 'return-continuation', {
        sourceChatId: 'child',
      }),
    ]
    const graph = projectExecutionGraph(snapshot(nodes, edges))
    const layout = layoutExecutionGraph(graph)

    expect(layout.edges.some((item) => item.id.startsWith('layout:'))).toBe(false)
    expect(layout.edges.map((item) => item.id)).toEqual(
      expect.arrayContaining(edges.map((item) => item.id)),
    )
    expect(layout.edges.find((item) => item.id === 'root-trunk')).toMatchObject({
      from: { id: 'root-before', x: 0 },
      to: { id: 'root-after', x: 0 },
    })
    expect(layout.edges.find((item) => item.id === 'child-return-continuation')).toMatchObject({
      from: { id: 'child-return', x: -EXECUTION_LANE_GAP },
      to: { id: 'root-after', x: 0 },
    })
  })

  it('distinguishes user, root agent and child agent message skins', () => {
    const graph = projectExecutionGraph(
      snapshot([
        node('user', 1, { actor: { kind: 'user', actorId: 'human' } }),
        node('root-agent', 2),
        node('child-agent', 3, {
          sourceChatId: 'child',
          actor: { kind: 'agent', chatId: 'child', roleType: 'researcher' },
        }),
      ]),
    )
    const byId = new Map(graph.nodes.map((item) => [item.id, item]))

    expect(skinKeyForNode(byId.get('user')!)).toBe('user')
    expect(skinKeyForNode(byId.get('root-agent')!)).toBe('root-agent')
    expect(skinKeyForNode(byId.get('child-agent')!)).toBe('child-agent')
  })

  it('lays out one thousand nodes without using created-at or content-sized viewport assumptions', () => {
    const nodes = Array.from({ length: 1_000 }, (_, index) => node(`node-${index}`, index + 1))
    const layout = layoutExecutionGraph(projectExecutionGraph(snapshot(nodes)))

    expect(layout.nodes).toHaveLength(1_001)
    expect(layout.nodes.at(-1)!.y).toBeGreaterThan(80_000)
    expect(layout.originX).toBeGreaterThan(0)
    expect(layout.width).toBeLessThan(400)
  })
})
