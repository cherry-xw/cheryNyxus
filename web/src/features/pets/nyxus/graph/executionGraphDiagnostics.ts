import type { ExecutionEdgeFact, TimelineNode } from '@/services/agentApi'

export type ExecutionGraphDiagnosticCode =
  | 'cross-root-reference'
  | 'dangling-edge'
  | 'duplicate-edge-id'
  | 'duplicate-node-id'
  | 'duplicate-order-key'
  | 'illegal-user-child-input'
  | 'legacy-relation-unresolved'
  | 'synthetic-node-reference'
  | 'unknown-edge-kind'
  | 'unknown-node-kind'

export interface ExecutionGraphDiagnostic {
  code: ExecutionGraphDiagnosticCode
  factId: string
  message: string
  relatedIds: string[]
}

const PERSISTENT_NODE_KINDS = new Set([
  'message',
  'tool-batch',
  'return',
  'dispatch',
  'system',
  'spawn',
])
const PERSISTENT_EDGE_KINDS = new Set([
  'sequence',
  'spawn',
  'continue',
  'dispatch',
  'return',
  'return-continuation',
])

function diagnostic(
  code: ExecutionGraphDiagnosticCode,
  factId: string,
  message: string,
  relatedIds: string[] = [],
): ExecutionGraphDiagnostic {
  return { code, factId, message, relatedIds: [...relatedIds].sort() }
}

function duplicateDiagnostics<T extends { id: string; orderKey: number }>(
  facts: readonly T[],
  kind: 'node' | 'edge',
): ExecutionGraphDiagnostic[] {
  const diagnostics: ExecutionGraphDiagnostic[] = []
  const ids = new Map<string, number>()
  for (const fact of facts) {
    ids.set(fact.id, (ids.get(fact.id) ?? 0) + 1)
  }
  for (const [id, count] of ids) {
    if (count > 1) {
      diagnostics.push(
        diagnostic(
          kind === 'node' ? 'duplicate-node-id' : 'duplicate-edge-id',
          id,
          `Duplicate ${kind} id ${id} appears ${count} times`,
        ),
      )
    }
  }
  return diagnostics
}

function duplicateOrderKeyDiagnostics(
  nodes: readonly TimelineNode[],
  edges: readonly ExecutionEdgeFact[],
): ExecutionGraphDiagnostic[] {
  const factsByOrder = new Map<number, string[]>()
  for (const node of nodes) {
    const facts = factsByOrder.get(node.orderKey) ?? []
    facts.push(`node:${node.id}`)
    factsByOrder.set(node.orderKey, facts)
  }
  for (const edge of edges) {
    const facts = factsByOrder.get(edge.orderKey) ?? []
    facts.push(`edge:${edge.id}`)
    factsByOrder.set(edge.orderKey, facts)
  }
  return [...factsByOrder.entries()].flatMap(([orderKey, facts]) => {
    const uniqueFacts = [...new Set(facts)]
    return uniqueFacts.length > 1
      ? [
          diagnostic(
            'duplicate-order-key',
            `order:${orderKey}`,
            `Persistent orderKey ${orderKey} is shared by multiple facts`,
            uniqueFacts,
          ),
        ]
      : []
  })
}

export function diagnoseExecutionGraphFacts(
  rootChatId: string,
  nodes: readonly TimelineNode[],
  edges: readonly ExecutionEdgeFact[],
): ExecutionGraphDiagnostic[] {
  const diagnostics = [
    ...duplicateDiagnostics(nodes, 'node'),
    ...duplicateDiagnostics(edges, 'edge'),
    ...duplicateOrderKeyDiagnostics(nodes, edges),
  ]
  const nodeIds = new Set(nodes.map((node) => node.id))
  const explicitTargets = new Set(edges.map((edge) => edge.toNodeId))

  for (const node of nodes) {
    if (!PERSISTENT_NODE_KINDS.has(node.kind)) {
      diagnostics.push(
        diagnostic('unknown-node-kind', node.id, `Unknown persistent node kind: ${node.kind}`),
      )
    }
    if (node.rootChatId !== rootChatId) {
      diagnostics.push(
        diagnostic(
          'cross-root-reference',
          node.id,
          `Node root ${node.rootChatId} does not match projection root ${rootChatId}`,
          [node.rootChatId, rootChatId],
        ),
      )
    }
    if (
      node.actor.kind === 'user' &&
      (node.sourceChatId !== rootChatId ||
        (node.target?.kind === 'agent' && node.target.chatId !== rootChatId))
    ) {
      diagnostics.push(
        diagnostic(
          'illegal-user-child-input',
          node.id,
          'User input may only exist on the root agent branch',
          [node.sourceChatId],
        ),
      )
    }
    if ((node.parentNodeId || node.causationId) && !explicitTargets.has(node.id)) {
      diagnostics.push(
        diagnostic(
          'legacy-relation-unresolved',
          node.id,
          'Legacy relation metadata has no explicit edge fact and was not projected',
          [node.parentNodeId, node.causationId].filter(
            (id): id is string => typeof id === 'string',
          ),
        ),
      )
    }
  }

  for (const edge of edges) {
    if (!PERSISTENT_EDGE_KINDS.has(edge.kind)) {
      diagnostics.push(
        diagnostic('unknown-edge-kind', edge.id, `Unknown persistent edge kind: ${edge.kind}`),
      )
    }
    if (edge.rootChatId !== rootChatId) {
      diagnostics.push(
        diagnostic(
          'cross-root-reference',
          edge.id,
          `Edge root ${edge.rootChatId} does not match projection root ${rootChatId}`,
          [edge.rootChatId, rootChatId],
        ),
      )
    }
    const missing = [edge.fromNodeId, edge.toNodeId].filter((id) => !nodeIds.has(id))
    if (missing.length > 0) {
      diagnostics.push(
        diagnostic('dangling-edge', edge.id, 'Persistent edge references a missing node', missing),
      )
    }
    const syntheticIds = [edge.fromNodeId, edge.toNodeId].filter((id) => id.startsWith('start:'))
    if (syntheticIds.length > 0) {
      diagnostics.push(
        diagnostic(
          'synthetic-node-reference',
          edge.id,
          'Persistent edges cannot reference synthetic start nodes',
          syntheticIds,
        ),
      )
    }
  }

  return diagnostics.sort(
    (a, b) =>
      a.code.localeCompare(b.code) ||
      a.factId.localeCompare(b.factId) ||
      a.relatedIds.join('\0').localeCompare(b.relatedIds.join('\0')),
  )
}
