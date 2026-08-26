import type {
  ConversationBranchSummary,
  RootTimelineSnapshot,
  TimelineNode,
} from '@/application/backend/public'

/**
 * Return the committed conversation path that led to a detail branch's fork anchor.
 *
 * The task timeline is a DAG, so the path is recovered from authoritative edges instead
 * of relying on timestamps or chat ids. Starting at the anchor intentionally excludes the
 * detail branch's own first message while still following earlier forks when a detail branch
 * was created from another branch.
 */
export function detailBranchContextNodes(
  snapshot: RootTimelineSnapshot | undefined,
  branch: ConversationBranchSummary | undefined,
): TimelineNode[] {
  if (!snapshot || branch?.kind !== 'detail' || !branch.anchorNodeId) return []

  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]))
  if (!nodesById.has(branch.anchorNodeId)) return []

  const incoming = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    const parents = incoming.get(edge.toNodeId) ?? []
    parents.push(edge.fromNodeId)
    incoming.set(edge.toNodeId, parents)
  }

  const visited = new Set<string>()
  const pending = [branch.anchorNodeId]
  while (pending.length > 0) {
    const nodeId = pending.pop()!
    if (visited.has(nodeId)) continue
    visited.add(nodeId)
    pending.push(...(incoming.get(nodeId) ?? []))
  }

  return [...visited]
    .map((nodeId) => nodesById.get(nodeId))
    .filter(
      (node): node is TimelineNode =>
        !!node &&
        node.status === 'committed' &&
        (node.visibility === 'conversation' || !!node.termination),
    )
    .sort((a, b) => a.orderKey - b.orderKey || a.id.localeCompare(b.id))
}
