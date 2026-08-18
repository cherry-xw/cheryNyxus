import type { ConversationBranchSummary } from '@/services/agentApi'
import type { ExecutionGraph, ExecutionNode } from './executionGraph'

export interface CoreFlowProjection {
  coreNodeIds: ReadonlySet<string>
  detailNodeIds: ReadonlySet<string>
  /** Strict replacement-chain subgraph. */
  graph: ExecutionGraph
  /** Card reader subgraph: replacement chain plus every explanatory detail branch. */
  paperGraph: ExecutionGraph
}

interface BranchMetadata {
  byId: Map<string, ConversationBranchSummary>
  byChatId: Map<string, ConversationBranchSummary[]>
  canonicalNodesById: Map<string, ExecutionNode>
}

function allCoreProjection(graph: Readonly<ExecutionGraph>): CoreFlowProjection {
  const projection = copyGraph(graph)
  return {
    coreNodeIds: new Set(graph.nodes.map((node) => node.id)),
    detailNodeIds: new Set(),
    graph: projection,
    paperGraph: projection,
  }
}

function copyGraph(graph: Readonly<ExecutionGraph>): ExecutionGraph {
  return {
    ...graph,
    nodes: graph.nodes.slice(),
    edges: graph.edges.slice(),
    diagnostics: graph.diagnostics.slice(),
  }
}

function filterGraph(
  graph: Readonly<ExecutionGraph>,
  includedNodeIds: ReadonlySet<string>,
): ExecutionGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => includedNodeIds.has(node.id)),
    edges: graph.edges.filter(
      (edge) => includedNodeIds.has(edge.from) && includedNodeIds.has(edge.to),
    ),
    diagnostics: graph.diagnostics.slice(),
  }
}

function collectCanonicalNodes(
  node: ExecutionNode,
  result: Map<string, ExecutionNode>,
  visiting: Set<string>,
): boolean {
  if (visiting.has(node.id)) return false
  if (result.has(node.id)) return true
  result.set(node.id, node)
  if (node.kind !== 'fold') return true
  const projectionNodes = node.fold?.projectionNodes
  if (!projectionNodes?.length) return false
  visiting.add(node.id)
  for (const projected of projectionNodes) {
    if (!collectCanonicalNodes(projected, result, visiting)) return false
  }
  visiting.delete(node.id)
  return true
}

function buildBranchMetadata(graph: Readonly<ExecutionGraph>): BranchMetadata | undefined {
  const branches = graph.branches
  if (!graph.activeBranchId || !branches?.length) return undefined

  const byId = new Map<string, ConversationBranchSummary>()
  const byChatId = new Map<string, ConversationBranchSummary[]>()
  for (const branch of branches) {
    if (!branch.branchId || !branch.chatId || byId.has(branch.branchId)) return undefined
    byId.set(branch.branchId, branch)
    const chatBranches = byChatId.get(branch.chatId) ?? []
    chatBranches.push(branch)
    byChatId.set(branch.chatId, chatBranches)
  }
  if (!byId.has(graph.activeBranchId)) return undefined

  const canonicalNodesById = new Map<string, ExecutionNode>()
  for (const node of graph.nodes) {
    if (!collectCanonicalNodes(node, canonicalNodesById, new Set())) return undefined
  }

  for (const branch of branches) {
    if (branch.kind === 'original') {
      if (branch.sourceBranchId || branch.anchorNodeId) return undefined
      continue
    }
    if (!branch.sourceBranchId || !branch.anchorNodeId) return undefined
    const source = byId.get(branch.sourceBranchId)
    const anchor = canonicalNodesById.get(branch.anchorNodeId)
    if (
      !source ||
      source.branchId === branch.branchId ||
      !anchor ||
      anchor.sourceFact?.branchId !== source.branchId ||
      anchor.orderSlot !== 'persistent' ||
      anchor.orderKey === null
    ) {
      return undefined
    }
  }

  for (const branch of branches) {
    const visited = new Set<string>()
    let current: ConversationBranchSummary | undefined = branch
    while (current?.sourceBranchId) {
      if (visited.has(current.branchId)) return undefined
      visited.add(current.branchId)
      current = byId.get(current.sourceBranchId)
      if (!current) return undefined
    }
  }

  for (const node of canonicalNodesById.values()) {
    if (
      node.kind === 'start' ||
      node.kind === 'fold' ||
      node.kind === 'pack' ||
      node.orderSlot !== 'persistent'
    )
      continue
    const branchId = node.sourceFact?.branchId
    if (!branchId || !byId.has(branchId)) return undefined
  }

  return { byId, byChatId, canonicalNodesById }
}

function activeBranchChain(
  activeBranchId: string,
  metadata: BranchMetadata,
): ConversationBranchSummary[] | undefined {
  const chain: ConversationBranchSummary[] = []
  const visited = new Set<string>()
  let current = metadata.byId.get(activeBranchId)
  while (current) {
    if (visited.has(current.branchId)) return undefined
    visited.add(current.branchId)
    chain.push(current)
    if (!current.sourceBranchId) break
    current = metadata.byId.get(current.sourceBranchId)
    if (!current) return undefined
  }
  return chain
}

/**
 * Selects the active replacement chain without changing the full tree topology.
 * Each ancestor remains core through the child branch's fork anchor; the active
 * branch owns its complete suffix. Invalid branch facts fail open to the full graph.
 */
export function projectCoreFlowExecutionGraph(graph: Readonly<ExecutionGraph>): CoreFlowProjection {
  const metadata = buildBranchMetadata(graph)
  if (!metadata || !graph.activeBranchId) return allCoreProjection(graph)
  const chain = activeBranchChain(graph.activeBranchId, metadata)
  if (!chain?.length) return allCoreProjection(graph)

  const ancestorCutoffByBranch = new Map<string, number>()
  for (let index = 0; index < chain.length - 1; index += 1) {
    const child = chain[index]!
    const sourceBranchId = child.sourceBranchId
    const anchor = child.anchorNodeId
      ? metadata.canonicalNodesById.get(child.anchorNodeId)
      : undefined
    if (!sourceBranchId || anchor?.orderKey === null || anchor?.orderKey === undefined) {
      return allCoreProjection(graph)
    }
    ancestorCutoffByBranch.set(sourceBranchId, anchor.orderKey)
  }

  const classifyBranch = (branchId: string, orderKey: number | null): boolean => {
    if (branchId === graph.activeBranchId) return true
    const cutoff = ancestorCutoffByBranch.get(branchId)
    if (cutoff === undefined) return false
    // Transient facts have no stable order yet. Preserve them rather than
    // incorrectly removing a live item from the active card stream.
    return orderKey === null || orderKey <= cutoff
  }

  const isDetailBranch = (branchId: string): boolean =>
    metadata.byId.get(branchId)?.kind === 'detail'

  const classifyNode = (node: ExecutionNode, visiting = new Set<string>()): boolean => {
    if (node.kind === 'start') return true
    if (node.kind === 'fold') {
      if (visiting.has(node.id)) return true
      const projected = node.fold?.projectionNodes
      if (!projected?.length) return true
      visiting.add(node.id)
      const core = projected.every((member) => classifyNode(member, visiting))
      visiting.delete(node.id)
      return core
    }
    const branchId = node.sourceFact?.branchId
    if (branchId) return classifyBranch(branchId, node.orderKey)
    if (node.orderSlot === 'persistent') return true

    const chatBranches = metadata.byChatId.get(node.sourceChatId)
    if (chatBranches?.length !== 1) return true
    return classifyBranch(chatBranches[0]!.branchId, null)
  }

  const classifyDetailNode = (node: ExecutionNode, visiting = new Set<string>()): boolean => {
    if (node.kind === 'start') return false
    if (node.kind === 'fold') {
      if (visiting.has(node.id)) return false
      const projected = node.fold?.projectionNodes
      if (!projected?.length) return false
      visiting.add(node.id)
      const detail = projected.every((member) => classifyDetailNode(member, visiting))
      visiting.delete(node.id)
      return detail
    }
    const branchId = node.sourceFact?.branchId
    if (branchId) return isDetailBranch(branchId)
    if (node.orderSlot === 'persistent') return false

    const chatBranches = metadata.byChatId.get(node.sourceChatId)
    return chatBranches?.length === 1 && isDetailBranch(chatBranches[0]!.branchId)
  }

  const coreNodeIds = new Set(
    graph.nodes.filter((node) => classifyNode(node)).map((node) => node.id),
  )
  const detailNodeIds = new Set(
    graph.nodes.filter((node) => classifyDetailNode(node)).map((node) => node.id),
  )
  const paperNodeIds = new Set([...coreNodeIds, ...detailNodeIds])
  return {
    coreNodeIds,
    detailNodeIds,
    graph: filterGraph(graph, coreNodeIds),
    paperGraph: filterGraph(graph, paperNodeIds),
  }
}
