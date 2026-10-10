import type {
  GenerationEntry,
  TimelineActor,
  TimelineDirection,
} from '@/application/backend/public'
import type { ExecutionEdge, ExecutionGraph, ExecutionNode } from './executionGraph'

function compareNodes(a: ExecutionNode, b: ExecutionNode): number {
  return (
    (a.orderKey ?? Number.MAX_SAFE_INTEGER) - (b.orderKey ?? Number.MAX_SAFE_INTEGER) ||
    a.id.localeCompare(b.id)
  )
}

function generationOwner(entry: GenerationEntry, rootChatId: string): string {
  return entry.sourceRootChatId ?? rootChatId
}

function packNode(rootChatId: string, entry: GenerationEntry): ExecutionNode {
  const ownerRootChatId = generationOwner(entry, rootChatId)
  const ownerSuffix = ownerRootChatId === rootChatId ? '' : `:${ownerRootChatId}`
  return {
    id: `pack:gen${ownerSuffix}:${entry.index}`,
    kind: 'pack',
    rootChatId,
    sourceChatId: ownerRootChatId,
    ...(entry.branchId ? { branchId: entry.branchId } : {}),
    ...(entry.epochId ? { epochId: entry.epochId } : {}),
    actor: { kind: 'system' } as TimelineActor,
    direction: 'internal' as TimelineDirection,
    content: entry.summary,
    createdAt: entry.createdAt,
    status: 'transient',
    main: ownerRootChatId === rootChatId,
    orderSlot: 'persistent',
    orderKey: entry.fromOrderKey,
    activeRuns: [],
    pack: {
      generationIndex: entry.index,
      boundaryNodeId: entry.boundaryNodeId,
      nodeCount: entry.nodeCount,
      trigger: entry.trigger,
      sourceRootChatId: ownerRootChatId,
    },
  }
}

function sequenceEdge(
  from: ExecutionNode,
  to: ExecutionNode,
  kind: ExecutionEdge['kind'] = 'sequence',
): ExecutionEdge {
  return {
    id: `history:${kind}:${from.id}->${to.id}`,
    from: from.id,
    to: to.id,
    kind,
    orderSlot: from.kind === 'start' ? 'start' : 'persistent',
    orderKey: to.orderKey,
    sourceChatId: from.sourceChatId,
    targetChatId: to.sourceChatId,
  }
}

/**
 * Keeps the current segment and the most recently compacted segment as real nodes.
 * Every older segment becomes one pack node, grouped by its owning branch root.
 */
export function projectPackedGenerations(
  graph: ExecutionGraph,
  generations: readonly GenerationEntry[],
): ExecutionGraph {
  if (generations.length === 0) return graph

  const byOwner = new Map<string, GenerationEntry[]>()
  for (const entry of generations) {
    const owner = generationOwner(entry, graph.rootChatId)
    const entries = byOwner.get(owner) ?? []
    entries.push(entry)
    byOwner.set(owner, entries)
  }

  const nodes = graph.nodes.slice()
  let edges = graph.edges.slice()
  const start = nodes.find((node) => node.kind === 'start')

  for (const [ownerRootChatId, entries] of byOwner) {
    const ordered = entries.slice().sort((a, b) => a.index - b.index)
    const packedEntries = ordered.slice(0, -1)
    if (packedEntries.length === 0) continue

    const packs = packedEntries.map((entry) => packNode(graph.rootChatId, entry))
    const firstVisible = nodes
      .filter(
        (node) =>
          node.kind !== 'start' && node.kind !== 'pack' && node.sourceChatId === ownerRootChatId,
      )
      .sort(compareNodes)[0]
    if (!firstVisible) continue

    const chain = [...packs, firstVisible]

    if (ownerRootChatId === graph.rootChatId && start) {
      nodes.push(...packs)
      edges = edges.filter((edge) => !(edge.from === start.id && edge.to === firstVisible.id))
      let previous = start
      for (const next of chain) {
        edges.push(sequenceEdge(previous, next, previous.kind === 'start' ? 'start' : 'sequence'))
        previous = next
      }
      continue
    }

    const incomingForks = edges.filter(
      (edge) =>
        edge.to === firstVisible.id &&
        (edge.kind === 'fork-continuation' || edge.kind === 'fork-detail'),
    )
    if (incomingForks.length === 0) continue
    nodes.push(...packs)
    const firstPack = packs[0]!
    const incomingIds = new Set(incomingForks.map((edge) => edge.id))
    edges = edges.map((edge) =>
      incomingIds.has(edge.id)
        ? { ...edge, id: `history:${edge.id}:${firstPack.id}`, to: firstPack.id }
        : edge,
    )
    let previous = firstPack
    for (const next of chain.slice(1)) {
      edges.push(sequenceEdge(previous, next))
      previous = next
    }
  }

  return { ...graph, nodes, edges }
}

function boundaryOrderKey(from: ExecutionNode, to: ExecutionNode): number | null {
  if (from.orderKey === null) return to.orderKey
  if (to.orderKey === null) return from.orderKey
  if (from.orderKey === to.orderKey) return to.orderKey - 0.25
  return from.orderKey + (to.orderKey - from.orderKey) / 2
}

/** Inserts a visible divider only where an explicit local edge crosses known epochs. */
export function projectEpochBoundaries(graph: ExecutionGraph): ExecutionGraph {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const markerByTarget = new Map<string, ExecutionNode>()
  const edges: ExecutionEdge[] = []

  for (const edge of graph.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    const crossesKnownEpoch =
      (edge.kind === 'sequence' || edge.kind === 'continue') &&
      from?.epochId &&
      to?.epochId &&
      from.epochId !== to.epochId
    if (!from || !to || !crossesKnownEpoch) {
      edges.push(edge)
      continue
    }

    let marker = markerByTarget.get(to.id)
    if (!marker) {
      marker = {
        id: `epoch-transition:${to.epochId}:${to.id}`,
        kind: 'epoch',
        rootChatId: graph.rootChatId,
        sourceChatId: to.sourceChatId,
        ...(to.branchId ? { branchId: to.branchId } : {}),
        epochId: to.epochId,
        actor: { kind: 'system' },
        direction: 'internal',
        content: '设置已切换',
        createdAt: to.createdAt,
        status: 'transient',
        main: to.main,
        orderSlot: 'persistent',
        orderKey: boundaryOrderKey(from, to),
        activeRuns: [],
      }
      markerByTarget.set(to.id, marker)
      byId.set(marker.id, marker)
    }

    edges.push({ ...edge, id: `epoch-before:${edge.id}`, to: marker.id })
    edges.push({
      ...edge,
      id: `epoch-after:${edge.id}`,
      from: marker.id,
      kind: 'sequence',
      sourceChatId: marker.sourceChatId,
      targetChatId: to.sourceChatId,
    })
  }

  if (markerByTarget.size === 0) return graph
  return { ...graph, nodes: [...graph.nodes, ...markerByTarget.values()], edges }
}
