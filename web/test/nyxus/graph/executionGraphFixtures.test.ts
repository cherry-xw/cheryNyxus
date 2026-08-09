import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot, TimelineNode } from '../../../src/services/agentApi'
import {
  projectExecutionGraph,
  projectPersistentExecutionGraph,
  type ExecutionGraph,
  type VirtualInputNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'

interface TopologyFixture {
  coverage: string[]
  snapshot: RootTimelineSnapshot
  expected: {
    nodeIds: string[]
    edgeIds: string[]
    diagnostics: unknown[]
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), 'utf8')) as T
}

function pendingProjection(snapshot: RootTimelineSnapshot): VirtualInputNode[] {
  return snapshot.pendingInputs.map((input, index) => ({
    id: input.messageId ?? `input:${input.inputId}`,
    content: input.content,
    createdAt: input.acceptedAt ?? input.createdAt ?? index,
    state: 'pending',
    ...(input.queueSequence === undefined ? {} : { queueSequence: input.queueSequence }),
  }))
}

function auditProjection(graph: ExecutionGraph) {
  return {
    nodeIds: graph.nodes.map((node) => node.id),
    edgeIds: graph.edges.map((edge) => edge.id),
    diagnostics: graph.diagnostics,
  }
}

describe('topology fixtures', () => {
  it('projects the complete synthetic matrix to the stable auditable graph', async () => {
    const fixture = await readJson<TopologyFixture>('test/fixtures/cp3-topology-matrix.json')
    const graph = projectExecutionGraph(fixture.snapshot, pendingProjection(fixture.snapshot))

    expect(auditProjection(graph)).toEqual(fixture.expected)
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length)
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length)
    const nodeIds = new Set(graph.nodes.map((node) => node.id))
    expect(graph.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(true)
  })

  it('directly proves spawn fan-out, nested return paths, no-return termination and dispatch', async () => {
    const fixture = await readJson<TopologyFixture>('test/fixtures/cp3-topology-matrix.json')
    const graph = projectPersistentExecutionGraph(fixture.snapshot)
    const outgoing = graph.edges.filter((edge) => edge.from === 'root-spawn-batch')

    expect(outgoing.map((edge) => [edge.kind, edge.to])).toEqual([
      ['spawn', 'child-a-start'],
      ['spawn', 'child-b-start'],
      ['continue', 'root-continue'],
    ])
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'return',
          from: 'grandchild-output',
          to: 'grandchild-return',
        }),
        expect.objectContaining({
          kind: 'return-continuation',
          from: 'grandchild-return',
          to: 'child-a-continue',
        }),
        expect.objectContaining({
          kind: 'return',
          from: 'child-a-continue',
          to: 'child-a-return',
        }),
        expect.objectContaining({
          kind: 'return-continuation',
          from: 'child-a-return',
          to: 'root-after-return',
        }),
        expect.objectContaining({
          kind: 'dispatch',
          from: 'root-dispatch',
          to: 'child-b-next',
        }),
      ]),
    )
    expect(graph.edges.some((edge) => edge.from === 'child-b-terminated' && edge.kind === 'return')).toBe(
      false,
    )
    expect(graph.nodes.find((node) => node.id === 'child-b-terminated')).toMatchObject({
      status: 'revoked',
      activeRuns: [{ runId: 'run-child-b', status: 'paused' }],
    })
  })

  it('is invariant to input array insertion order', async () => {
    const fixture = await readJson<TopologyFixture>('test/fixtures/cp3-topology-matrix.json')
    const forward = projectExecutionGraph(fixture.snapshot, pendingProjection(fixture.snapshot))
    const shuffledSnapshot = {
      ...fixture.snapshot,
      nodes: fixture.snapshot.nodes.slice().reverse(),
      edges: fixture.snapshot.edges.slice().reverse(),
      activeRuns: fixture.snapshot.activeRuns.slice().reverse(),
    }
    const reversed = projectExecutionGraph(shuffledSnapshot, pendingProjection(shuffledSnapshot))

    expect(reversed).toEqual(forward)
  })

  it('does not guess cross-agent edges for the real legacy capture', async () => {
    const fixture = await readJson<{
      rootTimeline: { rootChatId: string; nodes: TimelineNode[] }
    }>('test/fixtures/cp0/real/root-67dabe81.json')
    const graph = projectPersistentExecutionGraph({
      rootChatId: fixture.rootTimeline.rootChatId,
      nodes: fixture.rootTimeline.nodes,
      edges: [],
      activeRuns: [],
    })

    expect(graph.edges.filter((edge) => edge.orderSlot === 'persistent')).toEqual([])
    expect(graph.edges.filter((edge) => edge.kind === 'start')).toHaveLength(1)
    expect(graph.diagnostics.some((item) => item.code === 'unknown-node-kind')).toBe(true)
    expect(graph.diagnostics.some((item) => item.code === 'legacy-relation-unresolved')).toBe(true)
  })
})
