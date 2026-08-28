export type ReferenceNodeKind =
  | 'user-input'
  | 'model-turn'
  | 'tool-batch'
  | 'dispatch'
  | 'spawn'
  | 'return'
  | 'terminal'
  | 'error'

export type ReferenceEdgeKind =
  | 'sequence'
  | 'tool'
  | 'continue'
  | 'dispatch'
  | 'spawn'
  | 'return'
  | 'return-continuation'
  | 'epoch'

export type ReferenceLifecycle = 'active' | 'retired' | 'abandoned' | 'archived'

export interface ProtocolNodeFact {
  id: string
  kind: ReferenceNodeKind
  rootChatId: string
  chatId: string
  epochId: string
  order: number
  runId?: string
  taskId?: string
  callIds?: string[]
  targetChatId?: string
  lifecycle?: ReferenceLifecycle
}

export interface ProtocolEdgeFact {
  id?: string
  from: string
  to: string
  kind: ReferenceEdgeKind
}

export interface ProtocolTreeSnapshot {
  rootChatId: string
  activeEpochByChat: Readonly<Record<string, string>>
  nodes: readonly ProtocolNodeFact[]
  edges: readonly ProtocolEdgeFact[]
}

export interface ReferenceExecutionNode extends ProtocolNodeFact {
  lifecycle: ReferenceLifecycle
  executable: boolean
}

export interface ReferenceExecutionEdge extends ProtocolEdgeFact {
  id: string
}

export interface ReferenceExecutionTree {
  rootChatId: string
  nodes: ReferenceExecutionNode[]
  edges: ReferenceExecutionEdge[]
  roots: string[]
}

export type CanonicalTimelineNodeKind =
  | 'message'
  | 'tool-batch'
  | 'return'
  | 'dispatch'
  | 'system'
  | 'tool-group'
  | 'spawn'

export type CanonicalTimelineEdgeKind =
  | 'sequence'
  | 'spawn'
  | 'continue'
  | 'dispatch'
  | 'return'
  | 'return-continuation'
  | 'fork-continuation'
  | 'fork-detail'

export interface CanonicalTimelineNodeFact {
  id: string
  rootChatId: string
  sourceChatId: string
  kind: CanonicalTimelineNodeKind
  orderKey: number
  toolCalls?: readonly { callId: string }[]
}

export interface CanonicalTimelineEdgeFact {
  id: string
  rootChatId: string
  fromNodeId: string
  toNodeId: string
  kind: CanonicalTimelineEdgeKind
  orderKey: number
  sourceChatId: string
  targetChatId: string
}

export interface CanonicalTimelineSnapshot {
  rootChatId: string
  nodes: readonly CanonicalTimelineNodeFact[]
  edges: readonly CanonicalTimelineEdgeFact[]
}

export interface ReferenceCanonicalTimelineTree {
  rootChatId: string
  nodes: CanonicalTimelineNodeFact[]
  edges: Array<CanonicalTimelineEdgeFact & { from: string; to: string }>
  roots: string[]
}

/**
 * Independent, test-only protocol projection. It deliberately does not call
 * either backend or frontend production graph projectors, so shared mistakes
 * cannot make both the implementation and its oracle pass together.
 */
export function buildReferenceExecutionTree(
  snapshot: ProtocolTreeSnapshot,
): ReferenceExecutionTree {
  if (!snapshot.rootChatId) throw new Error('rootChatId is required')
  const nodeIds = new Set<string>()
  const nodes = snapshot.nodes
    .map((fact) => {
      validateNode(fact, snapshot.rootChatId)
      if (nodeIds.has(fact.id)) throw new Error(`duplicate node id: ${fact.id}`)
      nodeIds.add(fact.id)
      const lifecycle = fact.lifecycle ?? 'active'
      const currentEpoch = snapshot.activeEpochByChat[fact.chatId]
      const executable =
        lifecycle === 'active' &&
        currentEpoch === fact.epochId &&
        fact.kind !== 'terminal' &&
        fact.kind !== 'error'
      return { ...fact, lifecycle, executable }
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))

  const edgeIds = new Set<string>()
  const inbound = new Map<string, number>()
  const edges = snapshot.edges.map((fact) => {
    if (!nodeIds.has(fact.from)) throw new Error(`dangling edge source: ${fact.from}`)
    if (!nodeIds.has(fact.to)) throw new Error(`dangling edge target: ${fact.to}`)
    if (fact.from === fact.to) throw new Error(`self edge is not allowed: ${fact.from}`)
    const id = fact.id ?? `${fact.kind}:${fact.from}->${fact.to}`
    if (edgeIds.has(id)) throw new Error(`duplicate edge id: ${id}`)
    edgeIds.add(id)
    inbound.set(fact.to, (inbound.get(fact.to) ?? 0) + 1)
    return { ...fact, id }
  })

  assertAcyclic(nodeIds, edges)
  return {
    rootChatId: snapshot.rootChatId,
    nodes,
    edges,
    roots: nodes.filter((node) => !inbound.has(node.id)).map((node) => node.id),
  }
}

/**
 * Protocol-level oracle for the canonical root timeline. This validates only
 * durable facts and explicit edges; it does not share backend persistence or
 * frontend collapse logic with either production projector.
 */
export function buildReferenceCanonicalTimelineTree(
  snapshot: CanonicalTimelineSnapshot,
): ReferenceCanonicalTimelineTree {
  if (!snapshot.rootChatId) throw new Error('rootChatId is required')
  const nodeIds = new Set<string>()
  const orderOwners = new Map<number, string>()
  const nodes = snapshot.nodes
    .map((node) => {
      if (!node.id) throw new Error('canonical node id is required')
      if (nodeIds.has(node.id)) throw new Error(`duplicate canonical node id: ${node.id}`)
      if (node.rootChatId !== snapshot.rootChatId) {
        throw new Error(`canonical node ${node.id} belongs to the wrong root`)
      }
      if (!node.sourceChatId) throw new Error(`canonical node ${node.id} has no source chat`)
      if (!Number.isFinite(node.orderKey)) {
        throw new Error(`canonical node ${node.id} has an invalid order key`)
      }
      if (node.kind === 'tool-batch' && !node.toolCalls?.length) {
        throw new Error(`canonical tool batch ${node.id} has no calls`)
      }
      claimOrderKey(orderOwners, node.orderKey, `node:${node.id}`)
      nodeIds.add(node.id)
      return { ...node }
    })
    .sort((a, b) => a.orderKey - b.orderKey || a.id.localeCompare(b.id))

  const edgeIds = new Set<string>()
  const inbound = new Map<string, number>()
  const edges = snapshot.edges
    .map((edge) => {
      if (!edge.id) throw new Error('canonical edge id is required')
      if (edgeIds.has(edge.id)) throw new Error(`duplicate canonical edge id: ${edge.id}`)
      if (edge.rootChatId !== snapshot.rootChatId) {
        throw new Error(`canonical edge ${edge.id} belongs to the wrong root`)
      }
      if (!nodeIds.has(edge.fromNodeId)) {
        throw new Error(`canonical edge ${edge.id} has a dangling source`)
      }
      if (!nodeIds.has(edge.toNodeId)) {
        throw new Error(`canonical edge ${edge.id} has a dangling target`)
      }
      if (edge.fromNodeId === edge.toNodeId) {
        throw new Error(`canonical edge ${edge.id} is a self edge`)
      }
      if (!Number.isFinite(edge.orderKey)) {
        throw new Error(`canonical edge ${edge.id} has an invalid order key`)
      }
      claimOrderKey(orderOwners, edge.orderKey, `edge:${edge.id}`)
      edgeIds.add(edge.id)
      inbound.set(edge.toNodeId, (inbound.get(edge.toNodeId) ?? 0) + 1)
      return { ...edge, from: edge.fromNodeId, to: edge.toNodeId }
    })
    .sort((a, b) => a.orderKey - b.orderKey || a.id.localeCompare(b.id))

  assertAcyclic(nodeIds, edges)
  return {
    rootChatId: snapshot.rootChatId,
    nodes,
    edges,
    roots: nodes.filter((node) => !inbound.has(node.id)).map((node) => node.id),
  }
}

function claimOrderKey(owners: Map<number, string>, orderKey: number, owner: string): void {
  const existing = owners.get(orderKey)
  if (existing) throw new Error(`canonical order key ${orderKey} is shared by ${existing} and ${owner}`)
  owners.set(orderKey, owner)
}

function validateNode(node: ProtocolNodeFact, rootChatId: string): void {
  if (!node.id) throw new Error('node id is required')
  if (node.rootChatId !== rootChatId) {
    throw new Error(`node ${node.id} belongs to root ${node.rootChatId}, expected ${rootChatId}`)
  }
  if (!node.chatId || !node.epochId) throw new Error(`node ${node.id} is missing chat/epoch ownership`)
  if (!Number.isFinite(node.order)) throw new Error(`node ${node.id} has invalid order`)
  if (node.kind === 'tool-batch' && !node.callIds?.length) {
    throw new Error(`tool batch ${node.id} has no call ids`)
  }
  if (node.kind === 'spawn' || node.kind === 'dispatch') {
    if (!node.taskId || !node.targetChatId) {
      throw new Error(`${node.kind} node ${node.id} is missing task/target ownership`)
    }
  }
  if (node.kind === 'return' && (!node.taskId || !node.targetChatId)) {
    throw new Error(`return node ${node.id} is missing task/target ownership`)
  }
}

function assertAcyclic(
  nodeIds: ReadonlySet<string>,
  edges: readonly ReferenceExecutionEdge[],
): void {
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = outgoing.get(edge.from) ?? []
    targets.push(edge.to)
    outgoing.set(edge.from, targets)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`cycle detected at node: ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of outgoing.get(id) ?? []) visit(target)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of nodeIds) visit(id)
}
