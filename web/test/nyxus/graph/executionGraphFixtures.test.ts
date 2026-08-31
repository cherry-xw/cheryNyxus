import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot } from '../../../src/services/agentApi'
import {
  projectExecutionGraph,
  projectPersistentExecutionGraph,
  type ExecutionGraph,
  type VirtualInputNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  legacyRelationSnapshot,
  topologyMatrixSnapshot,
} from '../../fixtures/executionGraphFixtures'

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
  it('projects the complete synthetic matrix to the stable auditable graph', () => {
    const snapshot = topologyMatrixSnapshot()
    const graph = projectExecutionGraph(snapshot, pendingProjection(snapshot))

    const audit = auditProjection(graph)
    expect(audit.diagnostics).toEqual([])
    expect(audit.nodeIds).toEqual(expect.arrayContaining(snapshot.nodes.map((node) => node.id)))
    expect(audit.edgeIds).toEqual(expect.arrayContaining(snapshot.edges.map((edge) => edge.id)))
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length)
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length)
    const nodeIds = new Set(graph.nodes.map((node) => node.id))
    expect(graph.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(true)
  })

  it('directly proves spawn fan-out, nested return paths, no-return termination and dispatch', () => {
    const graph = projectPersistentExecutionGraph(topologyMatrixSnapshot())
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

  it('is invariant to input array insertion order', () => {
    const snapshot = topologyMatrixSnapshot()
    const forward = projectExecutionGraph(snapshot, pendingProjection(snapshot))
    const shuffledSnapshot = {
      ...snapshot,
      nodes: snapshot.nodes.slice().reverse(),
      edges: snapshot.edges.slice().reverse(),
      activeRuns: snapshot.activeRuns.slice().reverse(),
    }
    const reversed = projectExecutionGraph(shuffledSnapshot, pendingProjection(shuffledSnapshot))

    expect(reversed).toEqual(forward)
  })

  it('does not guess cross-agent edges from legacy relation metadata', () => {
    const graph = projectPersistentExecutionGraph(legacyRelationSnapshot())

    expect(graph.edges.filter((edge) => edge.orderSlot === 'persistent')).toEqual([])
    expect(graph.edges.filter((edge) => edge.kind === 'start')).toHaveLength(1)
    expect(graph.diagnostics.some((item) => item.code === 'unknown-node-kind')).toBe(true)
    expect(graph.diagnostics.some((item) => item.code === 'legacy-relation-unresolved')).toBe(true)
  })
})
