import type {
  ActiveTurnSnapshot,
  ActiveRunFact,
  ExecutionEdgeFact,
  RootTimelineSnapshot,
  TimelineActor,
  TimelineDirection,
  TimelineNode,
} from '@/services/agentApi'
import {
  diagnoseExecutionGraphFacts,
  type ExecutionGraphDiagnostic,
} from './executionGraphDiagnostics'

export type PersistentExecutionNodeKind =
  'message' | 'tool-batch' | 'return' | 'dispatch' | 'system' | 'spawn'
export type ExecutionNodeKind = 'start' | PersistentExecutionNodeKind | 'fold' | 'input' | 'unknown'
export type PersistentExecutionEdgeKind = ExecutionEdgeFact['kind']
export type ExecutionEdgeKind = 'start' | PersistentExecutionEdgeKind | 'input' | 'stream'
export type ExecutionOrderSlot = 'start' | 'persistent' | 'transient'

export interface ExecutionNode {
  id: string
  kind: ExecutionNodeKind
  rootChatId: string
  sourceChatId: string
  actor: TimelineActor
  target?: TimelineActor
  direction: TimelineDirection
  content: string
  thinking?: string
  createdAt: number
  status: TimelineNode['status'] | 'transient'
  main: boolean
  orderSlot: ExecutionOrderSlot
  /** Canonical facts use their durable key; a fold projection reuses its first child's key. */
  orderKey: number | null
  activeRuns: ActiveRunFact[]
  sourceFact?: TimelineNode
  inputState?: VirtualInputNode['state']
  fold?: ExecutionFold
}

export interface ExecutionFold {
  firstNodeId: string
  lastNodeId: string
  /** Semantic pages shown in the Fold card's left rail. */
  members: ExecutionFoldMember[]
  /** All canonical nodes replaced by this projection, including structural owner messages. */
  projectionNodes: ExecutionNode[]
}

export interface ExecutionFoldMember {
  id: string
  displayNode: ExecutionNode
  nodes: ExecutionNode[]
}

export interface ExecutionEdge {
  id: string
  from: string
  to: string
  kind: ExecutionEdgeKind
  orderSlot: ExecutionOrderSlot
  orderKey: number | null
  sourceChatId: string
  targetChatId: string
  sourceFact?: ExecutionEdgeFact
}

export interface ExecutionGraph {
  rootChatId: string
  activeBranchId?: string
  branches?: RootTimelineSnapshot['branches']
  nodes: ExecutionNode[]
  edges: ExecutionEdge[]
  diagnostics: ExecutionGraphDiagnostic[]
}

export interface VirtualInputNode {
  id: string
  content: string
  createdAt: number
  state: 'editing' | 'pending' | 'consuming'
  queueSequence?: number
}

/** Common boundary for future fold and other UI-only graph projections. */
export type ExecutionGraphProjection = (graph: Readonly<ExecutionGraph>) => ExecutionGraph

export type ExecutionGraphSnapshot = Pick<
  RootTimelineSnapshot,
  'rootChatId' | 'activeBranchId' | 'branches' | 'nodes' | 'edges' | 'activeRuns'
>

const PERSISTENT_NODE_KINDS = new Set<PersistentExecutionNodeKind>([
  'message',
  'tool-batch',
  'return',
  'dispatch',
  'system',
  'spawn',
])

function comparePersistentFacts(
  a: { id: string; orderKey: number },
  b: { id: string; orderKey: number },
): number {
  return a.orderKey - b.orderKey || a.id.localeCompare(b.id)
}

function compareInputs(a: VirtualInputNode, b: VirtualInputNode): number {
  return (
    (a.queueSequence ?? Number.MAX_SAFE_INTEGER) - (b.queueSequence ?? Number.MAX_SAFE_INTEGER) ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  )
}

function compareActiveTurns(a: ActiveTurnSnapshot, b: ActiveTurnSnapshot): number {
  return (
    (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) ||
    a.turnId.localeCompare(b.turnId)
  )
}

function stableFactValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableFactValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableFactValue(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

function uniqueFacts<T extends { id: string; orderKey: number }>(facts: readonly T[]): T[] {
  const ordered = facts
    .slice()
    .sort(
      (a, b) =>
        comparePersistentFacts(a, b) || stableFactValue(a).localeCompare(stableFactValue(b)),
    )
  const byId = new Map<string, T>()
  for (const fact of ordered) if (!byId.has(fact.id)) byId.set(fact.id, fact)
  return [...byId.values()]
}

function graphKind(node: TimelineNode): ExecutionNodeKind {
  return PERSISTENT_NODE_KINDS.has(node.kind as PersistentExecutionNodeKind)
    ? (node.kind as PersistentExecutionNodeKind)
    : 'unknown'
}

function indexActiveRuns(activeRuns: readonly ActiveRunFact[]): Map<string, ActiveRunFact[]> {
  const index = new Map<string, ActiveRunFact[]>()
  for (const run of activeRuns) {
    for (const id of new Set(
      [run.nodeId, run.batchId].filter((value): value is string => !!value),
    )) {
      const entries = index.get(id) ?? []
      entries.push(run)
      index.set(id, entries)
    }
  }
  for (const entries of index.values()) {
    entries.sort((a, b) => a.runId.localeCompare(b.runId) || a.chatId.localeCompare(b.chatId))
  }
  return index
}

function projectPersistentNode(
  rootChatId: string,
  node: TimelineNode,
  activeRunsByAnchor: ReadonlyMap<string, ActiveRunFact[]>,
): ExecutionNode {
  const activeRuns = new Map<string, ActiveRunFact>()
  for (const id of new Set([node.id, node.batchId].filter((value): value is string => !!value))) {
    for (const run of activeRunsByAnchor.get(id) ?? []) {
      activeRuns.set(`${run.chatId}:${run.runId}`, run)
    }
  }
  return {
    id: node.id,
    kind: graphKind(node),
    rootChatId: node.rootChatId,
    sourceChatId: node.sourceChatId,
    actor: node.actor,
    ...(node.target ? { target: node.target } : {}),
    direction: node.direction,
    content: node.content,
    ...(node.thinking ? { thinking: node.thinking } : {}),
    createdAt: node.createdAt,
    status: node.status,
    main: node.sourceChatId === rootChatId,
    orderSlot: 'persistent',
    orderKey: node.orderKey,
    activeRuns: [...activeRuns.values()].sort(
      (a, b) => a.runId.localeCompare(b.runId) || a.chatId.localeCompare(b.chatId),
    ),
    sourceFact: node,
  }
}

function projectPersistentEdge(edge: ExecutionEdgeFact): ExecutionEdge {
  return {
    id: edge.id,
    from: edge.fromNodeId,
    to: edge.toNodeId,
    kind: edge.kind,
    orderSlot: 'persistent',
    orderKey: edge.orderKey,
    sourceChatId: edge.sourceChatId,
    targetChatId: edge.targetChatId,
    sourceFact: edge,
  }
}

/**
 * A spawn target is a temporary structural anchor used before the child input
 * exists. Once the backend provides an explicit spawn -> target -> sequence ->
 * child chain, render the durable child input as the single delegation node.
 */
function collapseResolvedSpawnTargets(
  nodes: readonly ExecutionNode[],
  edges: readonly ExecutionEdge[],
): { nodes: ExecutionNode[]; edges: ExecutionEdge[] } {
  const removedNodeIds = new Set<string>()
  const removedEdgeIds = new Set<string>()
  const redirectedEdges = new Map<string, ExecutionEdge>()

  for (const node of nodes) {
    if (!node.id.startsWith('spawn-target:') || node.kind !== 'dispatch') continue
    const incoming = edges.filter((edge) => edge.to === node.id && edge.kind === 'spawn')
    const outgoing = edges.filter((edge) => edge.from === node.id && edge.kind === 'sequence')
    const incident = edges.filter((edge) => edge.from === node.id || edge.to === node.id)
    if (incoming.length === 0 || outgoing.length !== 1) continue
    if (incident.length !== incoming.length + outgoing.length) continue
    const successor = outgoing[0]!
    if (!nodes.some((candidate) => candidate.id === successor.to)) continue

    removedNodeIds.add(node.id)
    removedEdgeIds.add(successor.id)
    for (const edge of incoming) {
      redirectedEdges.set(edge.id, {
        ...edge,
        to: successor.to,
        targetChatId: successor.targetChatId,
      })
    }
  }

  return {
    nodes: nodes.filter((node) => !removedNodeIds.has(node.id)),
    edges: edges
      .filter((edge) => !removedEdgeIds.has(edge.id))
      .map((edge) => redirectedEdges.get(edge.id) ?? edge),
  }
}

function responseIdentity(node: ExecutionNode): string | undefined {
  const sourceMessageId = node.sourceFact?.sourceMessageId
  return sourceMessageId ? `${node.sourceChatId}:${sourceMessageId}` : undefined
}

/**
 * The tree snapshot keeps one assistant response as two canonical facts:
 * message(thinking/content) -> tool-batch(calls). They remain separate in the
 * protocol, but the execution UI presents that explicit sourceMessageId pair
 * as one tool node without changing the durable batch identity or its exits.
 */
function collapseToolResponseMessages(
  nodes: readonly ExecutionNode[],
  edges: readonly ExecutionEdge[],
): { nodes: ExecutionNode[]; edges: ExecutionEdge[] } {
  const messagesByResponse = new Map<string, ExecutionNode>()
  for (const node of nodes) {
    const identity = responseIdentity(node)
    if (
      identity &&
      node.kind === 'message' &&
      node.actor.kind === 'agent' &&
      node.direction === 'agent-to-user' &&
      !node.sourceFact?.termination &&
      !messagesByResponse.has(identity)
    ) {
      messagesByResponse.set(identity, node)
    }
  }

  const batchByMessageId = new Map<string, string>()
  const mergedBatches = new Map<string, ExecutionNode>()
  for (const batch of nodes) {
    const identity = responseIdentity(batch)
    if (!identity || batch.kind !== 'tool-batch') continue
    const message = messagesByResponse.get(identity)
    if (!message) continue
    batchByMessageId.set(message.id, batch.id)
    const activeRuns = new Map<string, ActiveRunFact>()
    for (const run of [...message.activeRuns, ...batch.activeRuns]) {
      activeRuns.set(`${run.chatId}:${run.runId}`, run)
    }
    mergedBatches.set(batch.id, {
      ...batch,
      content: message.content,
      ...(message.thinking ? { thinking: message.thinking } : {}),
      activeRuns: [...activeRuns.values()].sort(
        (a, b) => a.runId.localeCompare(b.runId) || a.chatId.localeCompare(b.chatId),
      ),
    })
  }

  if (batchByMessageId.size === 0) return { nodes: [...nodes], edges: [...edges] }
  return {
    nodes: nodes
      .filter((node) => !batchByMessageId.has(node.id))
      .map((node) => mergedBatches.get(node.id) ?? node),
    edges: edges.flatMap((edge) => {
      const from = batchByMessageId.get(edge.from) ?? edge.from
      const to = batchByMessageId.get(edge.to) ?? edge.to
      return from === to ? [] : [{ ...edge, from, to }]
    }),
  }
}

/** Canonical graph facts -> deterministic UI-neutral persistent graph. */
export function projectPersistentExecutionGraph(snapshot: ExecutionGraphSnapshot): ExecutionGraph {
  const canonicalNodes = uniqueFacts(snapshot.nodes)
  const canonicalEdges = uniqueFacts(snapshot.edges)
  const activeRunsByAnchor = indexActiveRuns(snapshot.activeRuns)
  const projectedNodes = canonicalNodes.map((node) =>
    projectPersistentNode(snapshot.rootChatId, node, activeRunsByAnchor),
  )
  const projectedEdges = canonicalEdges.map(projectPersistentEdge)
  const withoutSpawnTargets = collapseResolvedSpawnTargets(projectedNodes, projectedEdges)
  const { nodes: persistentNodes, edges: persistentEdges } = collapseToolResponseMessages(
    withoutSpawnTargets.nodes,
    withoutSpawnTargets.edges,
  )
  const firstMain = persistentNodes.find(
    (node) => node.sourceChatId === snapshot.rootChatId && node.rootChatId === snapshot.rootChatId,
  )
  const startId = `start:${snapshot.rootChatId}`
  const nodes: ExecutionNode[] = [
    {
      id: startId,
      kind: 'start',
      rootChatId: snapshot.rootChatId,
      sourceChatId: snapshot.rootChatId,
      actor: { kind: 'system' },
      direction: 'internal',
      content: '开始',
      createdAt: Number.NEGATIVE_INFINITY,
      status: 'transient',
      main: true,
      orderSlot: 'start',
      orderKey: null,
      activeRuns: [],
    },
    ...persistentNodes,
  ]
  const edges = persistentEdges
  if (firstMain) {
    edges.unshift({
      id: `start:${snapshot.rootChatId}->${firstMain.id}`,
      from: startId,
      to: firstMain.id,
      kind: 'start',
      orderSlot: 'start',
      orderKey: null,
      sourceChatId: snapshot.rootChatId,
      targetChatId: snapshot.rootChatId,
    })
  }
  return {
    rootChatId: snapshot.rootChatId,
    activeBranchId: snapshot.activeBranchId,
    branches: snapshot.branches,
    nodes,
    edges,
    diagnostics: diagnoseExecutionGraphFacts(snapshot.rootChatId, snapshot.nodes, snapshot.edges),
  }
}

export function mainExecutionEndpoint(graph: ExecutionGraph): ExecutionNode {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const outgoingMainIds = new Set(
    graph.edges
      .filter((edge) => {
        const from = nodesById.get(edge.from)
        const to = nodesById.get(edge.to)
        return from?.main && to?.main
      })
      .map((edge) => edge.from),
  )
  const terminals = graph.nodes.filter((node) => node.main && !outgoingMainIds.has(node.id))
  return terminals.at(-1) ?? graph.nodes[0]!
}

/** Adds UI-only draft/pending nodes without mutating or rewriting canonical graph facts. */
export function projectInputNodes(
  graph: ExecutionGraph,
  virtualInputs: readonly VirtualInputNode[],
): ExecutionGraph {
  if (virtualInputs.length === 0) return graph
  const nodes = [...graph.nodes]
  const edges = [...graph.edges]
  const canonicalIds = new Set(
    graph.nodes.filter((node) => node.orderSlot === 'persistent').map((node) => node.id),
  )
  let previous = mainExecutionEndpoint(graph)
  for (const input of virtualInputs.slice().sort(compareInputs)) {
    // The durable user fact reuses the preallocated messageId. Once it exists,
    // it is already the entity node and must not be deleted/reinserted visually.
    if (canonicalIds.has(input.id)) {
      previous = nodes.find((node) => node.id === input.id) ?? previous
      continue
    }
    const node: ExecutionNode = {
      id: input.id,
      kind: 'input',
      rootChatId: graph.rootChatId,
      sourceChatId: graph.rootChatId,
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: graph.rootChatId },
      direction: 'user-to-agent',
      content: input.content,
      createdAt: input.createdAt,
      status: 'transient',
      main: true,
      orderSlot: 'transient',
      orderKey: null,
      activeRuns: [],
      inputState: input.state,
    }
    nodes.push(node)
    edges.push({
      id: `input:${previous.id}->${node.id}`,
      from: previous.id,
      to: node.id,
      kind: 'input',
      orderSlot: 'transient',
      orderKey: null,
      sourceChatId: graph.rootChatId,
      targetChatId: graph.rootChatId,
    })
    previous = node
  }
  return { ...graph, nodes, edges }
}

/**
 * Adds one UI-only response node as soon as turn.started arrives. The node uses
 * the preallocated messageId, so the durable canonical fact replaces it in
 * place instead of creating a second visual entity.
 */
export function projectActiveTurnNodes(
  graph: ExecutionGraph,
  activeTurns: readonly ActiveTurnSnapshot[],
  activeRuns: readonly ActiveRunFact[],
): ExecutionGraph {
  const liveTurns = activeTurns
    .filter((turn) => turn.chatId && turn.status !== 'completed' && turn.status !== 'error')
    .slice()
    .sort(compareActiveTurns)
  if (liveTurns.length === 0) return graph
  const nodes = [...graph.nodes]
  const edges = [...graph.edges]
  const previousByChat = new Map<string, ExecutionNode>()
  for (const node of nodes) {
    if (node.kind === 'start') continue
    previousByChat.set(node.sourceChatId, node)
    if ((node.kind === 'dispatch' || node.kind === 'spawn') && node.target?.kind === 'agent') {
      previousByChat.set(node.target.chatId, node)
    }
  }
  const start = nodes.find((node) => node.kind === 'start') ?? nodes[0]
  const latestCreatedAt = Math.max(0, ...nodes.map((node) => node.createdAt))

  for (const [index, turn] of liveTurns.entries()) {
    const chatId = turn.chatId!
    const existing = nodes.find((node) => node.id === turn.messageId)
    if (existing) {
      previousByChat.set(chatId, existing)
      continue
    }
    const run = activeRuns.find(
      (candidate) => candidate.chatId === chatId && (!turn.runId || candidate.runId === turn.runId),
    )
    const projectedRun =
      run ??
      (turn.runId
        ? {
            rootChatId: graph.rootChatId,
            chatId,
            runId: turn.runId,
            status: turn.status === 'paused' ? ('paused' as const) : ('running' as const),
            turnId: turn.turnId,
            nodeId: turn.messageId,
          }
        : undefined)
    const previous = previousByChat.get(chatId) ?? start
    if (!previous) continue
    const node: ExecutionNode = {
      id: turn.messageId,
      kind: 'message',
      rootChatId: graph.rootChatId,
      sourceChatId: chatId,
      actor: { kind: 'agent', chatId },
      direction: 'agent-to-user',
      content: turn.content || turn.thinking,
      createdAt: turn.createdAt ?? latestCreatedAt + index + 1,
      status: 'transient',
      main: chatId === graph.rootChatId,
      orderSlot: 'transient',
      orderKey: null,
      activeRuns: projectedRun ? [projectedRun] : [],
    }
    nodes.push(node)
    edges.push({
      id: `stream:${previous.id}->${node.id}`,
      from: previous.id,
      to: node.id,
      kind: 'stream',
      orderSlot: 'transient',
      orderKey: null,
      sourceChatId: chatId,
      targetChatId: chatId,
    })
    previousByChat.set(chatId, node)
  }
  return { ...graph, nodes, edges }
}

export function projectExecutionGraph(
  snapshot: ExecutionGraphSnapshot,
  virtualInputs: readonly VirtualInputNode[] = [],
): ExecutionGraph {
  return projectInputNodes(projectPersistentExecutionGraph(snapshot), virtualInputs)
}
