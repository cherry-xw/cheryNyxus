import type { ExecutionEdge, ExecutionGraph, ExecutionNode } from './executionGraph'

export const EXECUTION_LANE_GAP = 190
export const EXECUTION_ROW_GAP = 82
export const EXECUTION_TOP = 32
export const EXECUTION_LABEL_HALF_WIDTH = 86
export const EXECUTION_LABEL_HEIGHT = 66
export const EXECUTION_ICON_RADIUS = 15

export interface PositionedExecutionNode extends ExecutionNode {
  x: number
  y: number
  lane: number
}

export interface PositionedExecutionEdge extends Omit<ExecutionEdge, 'from' | 'to'> {
  from: PositionedExecutionNode
  to: PositionedExecutionNode
}

export interface ExecutionLayout {
  nodes: PositionedExecutionNode[]
  edges: PositionedExecutionEdge[]
  width: number
  height: number
  /** Converts semantic lane coordinates (root x=0) into positive world coordinates. */
  originX: number
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** Reuse as hints on the next incremental layout to avoid branch side changes. */
  laneByChat: Map<string, number>
}

export interface ExecutionLayoutOptions {
  previousLanes?: ReadonlyMap<string, number>
}

function compareNodes(a: ExecutionNode, b: ExecutionNode): number {
  const slots = { start: 0, persistent: 1, transient: 2 } as const
  const slotOrder = slots[a.orderSlot] - slots[b.orderSlot]
  if (slotOrder !== 0) return slotOrder
  if (a.orderSlot === 'transient' && b.orderSlot === 'transient') {
    return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  }
  return (
    (a.orderKey ?? 0) - (b.orderKey ?? 0) ||
    a.id.localeCompare(b.id)
  )
}

/**
 * Gives each non-main source chat a stable lateral lane. Root children reuse
 * the two adjacent lanes across sequential spawn batches, but siblings spawned
 * concurrently (same tool-batch) each get a distinct lane growing outward so
 * their live subtrees don't pile into one column. Descendant paths grow
 * outward, while a fan-out moves its parent outward so its children can occupy
 * both adjacent sides.
 */
function assignChildLanes(graph: ExecutionGraph, previous?: ReadonlyMap<string, number>): Map<string, number> {
  const { nodes, rootChatId } = graph
  const weights = new Map<string, { firstOrder: number; count: number }>()
  for (const node of nodes) {
    // 仅排除归因主 chat 的节点（含主 start）。子 chat 的 start 计入权重，
    // 使刚 spawn 的子 agent（仅 start 节点）也能立刻获得 lane，创建即平衡。
    if (node.sourceChatId === rootChatId) continue
    const current = weights.get(node.sourceChatId)
    if (current) {
      current.count += 1
      current.firstOrder = Math.min(current.firstOrder, node.orderKey ?? Number.MAX_SAFE_INTEGER)
    } else {
      weights.set(node.sourceChatId, {
        firstOrder: node.orderKey ?? Number.MAX_SAFE_INTEGER,
        count: 1,
      })
    }
  }

  const parentByChat = new Map<string, string>()
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of graph.edges) {
    if (edge.kind !== 'spawn' || edge.targetChatId === rootChatId) continue
    const parent = nodeById.get(edge.from)?.sourceChatId ?? edge.sourceChatId
    if (parent !== edge.targetChatId && !parentByChat.has(edge.targetChatId)) {
      parentByChat.set(edge.targetChatId, parent)
    }
  }
  for (const chatId of weights.keys()) {
    if (!parentByChat.has(chatId)) parentByChat.set(chatId, rootChatId)
  }
  const children = new Map<string, string[]>()
  for (const [chatId, parent] of parentByChat) {
    const list = children.get(parent) ?? []
    list.push(chatId)
    children.set(parent, list)
  }
  const compareChats = (a: string, b: string): number =>
    (weights.get(a)?.firstOrder ?? Number.MAX_SAFE_INTEGER) -
      (weights.get(b)?.firstOrder ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)
  for (const list of children.values()) list.sort(compareChats)

  const subtreeWeight = (chatId: string, visiting = new Set<string>()): number => {
    if (visiting.has(chatId)) return 0
    const next = new Set(visiting).add(chatId)
    return (
      (weights.get(chatId)?.count ?? 0) +
      (children.get(chatId) ?? []).reduce((sum, child) => sum + subtreeWeight(child, next), 0)
    )
  }
  const lanes = new Map<string, number>([[rootChatId, 0]])
  let leftWeight = 0
  let rightWeight = 0

  const assignBranch = (
    chatId: string,
    innerLane: number,
    side: -1 | 1,
    visiting = new Set<string>(),
  ): void => {
    if (visiting.has(chatId)) return
    const next = new Set(visiting).add(chatId)
    const descendants = children.get(chatId) ?? []
    if (descendants.length < 2) {
      lanes.set(chatId, innerLane)
      const [onlyChild] = descendants
      if (onlyChild) assignBranch(onlyChild, innerLane + side, side, next)
      return
    }

    const parentLane = innerLane + side
    lanes.set(chatId, parentLane)
    descendants.forEach((child, index) => {
      const childInnerLane = index === 0 ? innerLane : parentLane + side * index
      assignBranch(child, childInnerLane, side, next)
    })
  }

  // Outermost lane a subtree actually occupies, so the next concurrent sibling
  // clears the whole fan-out, not just the root child's own lane.
  const subtreeOuterLane = (chatId: string, side: -1 | 1): number => {
    const visited = new Set<string>()
    let outer = lanes.get(chatId) ?? 0
    const stack = [chatId]
    while (stack.length) {
      const cur = stack.pop()
      if (cur === undefined || visited.has(cur)) continue
      visited.add(cur)
      const l = lanes.get(cur)
      if (l != null && (side < 0 ? l < outer : l > outer)) outer = l
      for (const c of children.get(cur) ?? []) stack.push(c)
    }
    return outer
  }

  // Concurrent siblings share a spawn source (the tool-batch node); give each a
  // distinct lane so simultaneous subtrees don't overlap one column. Sequential
  // batches reset the cursor so finished lanes get reused.
  const spawnSourceByChat = new Map<string, string>()
  for (const edge of graph.edges) {
    if (edge.kind !== 'spawn' || edge.targetChatId === rootChatId) continue
    if (!spawnSourceByChat.has(edge.targetChatId)) {
      spawnSourceByChat.set(edge.targetChatId, edge.from)
    }
  }
  let currentGroup: string | undefined
  let groupOuterLeft = -1
  let groupOuterRight = 1
  for (const chatId of children.get(rootChatId) ?? []) {
    const group = spawnSourceByChat.get(chatId) ?? chatId
    if (group !== currentGroup) {
      currentGroup = group
      groupOuterLeft = -1
      groupOuterRight = 1
    }
    const hintedLane = previous?.get(chatId)
    const side: -1 | 1 = hintedLane
      ? hintedLane < 0
        ? -1
        : 1
      : leftWeight <= rightWeight
        ? -1
        : 1
    const lane = side < 0 ? groupOuterLeft : groupOuterRight
    const weight = subtreeWeight(chatId)
    assignBranch(chatId, lane, side)
    const outer = subtreeOuterLane(chatId, side)
    if (side < 0) groupOuterLeft = outer + side
    else groupOuterRight = outer + side
    if (side < 0) leftWeight += weight
    else rightWeight += weight
  }
  // Malformed cyclic/orphan chat topology remains visible on deterministic lanes.
  for (const chatId of [...weights.keys()].sort(compareChats)) {
    if (!lanes.has(chatId)) {
      const side: -1 | 1 = leftWeight <= rightWeight ? -1 : 1
      assignBranch(chatId, side, side)
      if (side < 0) leftWeight += subtreeWeight(chatId)
      else rightWeight += subtreeWeight(chatId)
    }
  }
  return lanes
}

function displayEdges(
  graph: ExecutionGraph,
  byId: ReadonlyMap<string, PositionedExecutionNode>,
): PositionedExecutionEdge[] {
  return graph.edges.flatMap((edge) => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    return from && to ? [{ ...edge, from, to }] : []
  })
}

/**
 * Vertical execution layout. The globally ordered row index is intentional:
 * a later canonical `orderKey` can never render above an earlier node.
 */
export function layoutExecutionGraph(
  graph: ExecutionGraph,
  options: ExecutionLayoutOptions = {},
): ExecutionLayout {
  const lanes = assignChildLanes(graph, options.previousLanes)
  const ordered = graph.nodes.slice().sort(compareNodes)
  const positioned = ordered.map((node, index) => {
    const lane = lanes.get(node.sourceChatId) ?? 0
    return {
      ...node,
      lane,
      x: lane * EXECUTION_LANE_GAP,
      y: EXECUTION_TOP + index * EXECUTION_ROW_GAP,
    }
  })
  const byId = new Map(positioned.map((node) => [node.id, node]))
  const edges = displayEdges(graph, byId)
  const lanesInUse = positioned.map((node) => node.lane)
  const minLane = Math.min(0, ...lanesInUse)
  const maxLane = Math.max(0, ...lanesInUse)
  const horizontalPadding = EXECUTION_LABEL_HALF_WIDTH + 48
  const minX = minLane * EXECUTION_LANE_GAP - horizontalPadding
  const maxX = maxLane * EXECUTION_LANE_GAP + horizontalPadding
  const minY = 0
  const maxY =
    (positioned[positioned.length - 1]?.y ?? EXECUTION_TOP) +
    EXECUTION_LABEL_HEIGHT +
    EXECUTION_TOP
  return {
    nodes: positioned,
    edges,
    width: maxX - minX,
    height: maxY - minY,
    originX: -minX,
    bounds: { minX, minY, maxX, maxY },
    laneByChat: lanes,
  }
}

function topologySignature(graph: Readonly<ExecutionGraph>): string {
  return [
    graph.rootChatId,
    ...graph.nodes.map((node) =>
      [node.id, node.kind, node.sourceChatId, node.orderSlot, node.orderKey ?? '', node.createdAt].join(
        '\u0001',
      ),
    ),
    '\u0002',
    ...graph.edges.map((edge) =>
      [edge.id, edge.from, edge.to, edge.kind, edge.sourceChatId, edge.targetChatId].join('\u0001'),
    ),
  ].join('\u0000')
}

function refreshLayout(previous: ExecutionLayout, graph: Readonly<ExecutionGraph>): ExecutionLayout {
  const coordinates = new Map(previous.nodes.map((node) => [node.id, node] as const))
  const nodes = graph.nodes.map((node) => {
    const position = coordinates.get(node.id)!
    return { ...node, x: position.x, y: position.y, lane: position.lane }
  })
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  return {
    ...previous,
    nodes,
    edges: displayEdges(graph as ExecutionGraph, byId),
  }
}

export interface IncrementalExecutionLayout {
  layout(graph: Readonly<ExecutionGraph>): ExecutionLayout
  recomputations(): number
  reset(): void
}

/** Reuses stable coordinates when streaming content changes without changing graph topology. */
export function createIncrementalExecutionLayout(): IncrementalExecutionLayout {
  let signature = ''
  let previous: ExecutionLayout | undefined
  let count = 0
  return {
    layout(graph) {
      const nextSignature = topologySignature(graph)
      if (previous && signature === nextSignature) {
        previous = refreshLayout(previous, graph)
        return previous
      }
      previous = layoutExecutionGraph(graph as ExecutionGraph, {
        previousLanes: previous?.laneByChat,
      })
      signature = nextSignature
      count += 1
      return previous
    },
    recomputations: () => count,
    reset() {
      signature = ''
      previous = undefined
      count = 0
    },
  }
}
