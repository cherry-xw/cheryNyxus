import type { ExecutionEdge, ExecutionGraph, ExecutionNode } from './executionGraph'
import { executionEdgeGeometry } from './executionGeometry'

export const EXECUTION_LANE_GAP = 110
export const EXECUTION_ROW_GAP = 82
export const EXECUTION_TOP = 32
export const EXECUTION_LABEL_HALF_WIDTH = 48
export const EXECUTION_LABEL_HEIGHT = 66
export const EXECUTION_ICON_RADIUS = 15

export type ExecutionLayoutMode = 'timeline' | 'topology'

export interface PositionedExecutionNode extends ExecutionNode {
  x: number
  y: number
  lane: number
}

export interface PositionedExecutionEdge extends Omit<ExecutionEdge, 'from' | 'to'> {
  from: PositionedExecutionNode
  to: PositionedExecutionNode
  /** Lateral corridor reserved for this edge by the tree layout. */
  routeX?: number
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
  mode?: ExecutionLayoutMode
  /** Packs lower root subtrees nearer the main lane while preserving local fan-out. */
  branchPacking?: 'balanced' | 'inward'
}

function compareNodes(a: ExecutionNode, b: ExecutionNode): number {
  const slots = { start: 0, persistent: 1, transient: 2 } as const
  const slotOrder = slots[a.orderSlot] - slots[b.orderSlot]
  if (slotOrder !== 0) return slotOrder
  if (a.orderSlot === 'transient' && b.orderSlot === 'transient') {
    return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  }
  return (a.orderKey ?? 0) - (b.orderKey ?? 0) || a.id.localeCompare(b.id)
}

/**
 * Recursively packs each participant subtree around its own root lane. Direct
 * children are split across both sides of their parent; an odd fan-out puts
 * the extra child on the side farther from the global centre. Within either
 * side newer child subtrees are packed nearer their parent than older ones.
 */
function assignChildLanes(
  graph: ExecutionGraph,
  previous?: ReadonlyMap<string, number>,
  branchPacking: NonNullable<ExecutionLayoutOptions['branchPacking']> = 'balanced',
): Map<string, number> {
  const { nodes, rootChatId } = graph
  const weights = new Map<string, { firstOrder: number }>()
  for (const node of nodes) {
    // 仅排除归因主 chat 的节点（含主 start）。子 chat 的 start 计入权重，
    // 使刚 spawn 的子 agent（仅 start 节点）也能立刻获得 lane，创建即平衡。
    if (node.sourceChatId === rootChatId) continue
    const current = weights.get(node.sourceChatId)
    if (current) {
      current.firstOrder = Math.min(current.firstOrder, node.orderKey ?? Number.MAX_SAFE_INTEGER)
    } else {
      weights.set(node.sourceChatId, {
        firstOrder: node.orderKey ?? Number.MAX_SAFE_INTEGER,
      })
    }
  }

  const parentByChat = new Map<string, string>()
  const entryOrderByChat = new Map<string, number>()
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of graph.edges) {
    if (
      !['spawn', 'fork-continuation', 'fork-detail'].includes(edge.kind) ||
      edge.targetChatId === rootChatId
    )
      continue
    const parent = nodeById.get(edge.from)?.sourceChatId ?? edge.sourceChatId
    if (parent !== edge.targetChatId && !parentByChat.has(edge.targetChatId)) {
      parentByChat.set(edge.targetChatId, parent)
    }
    const entryOrder = nodeById.get(edge.from)?.orderKey ?? edge.orderKey
    if (entryOrder !== null && entryOrder !== undefined) {
      const current = entryOrderByChat.get(edge.targetChatId)
      entryOrderByChat.set(edge.targetChatId, Math.min(current ?? entryOrder, entryOrder))
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
  const compareEntryOrder = (a: string, b: string): number =>
    (entryOrderByChat.get(a) ?? weights.get(a)?.firstOrder ?? Number.MAX_SAFE_INTEGER) -
      (entryOrderByChat.get(b) ?? weights.get(b)?.firstOrder ?? Number.MAX_SAFE_INTEGER) ||
    a.localeCompare(b)
  for (const list of children.values()) list.sort(compareChats)

  const activeBranch = graph.branches?.find((branch) => branch.branchId === graph.activeBranchId)
  const activeChatId = activeBranch?.chatId
  const activeFork = activeBranch
    ? graph.edges.find(
        (edge) => edge.kind === 'fork-continuation' && edge.targetChatId === activeBranch.chatId,
      )
    : undefined
  const activeForkAnchor = activeFork ? nodeById.get(activeFork.from) : undefined
  const displacedSide: -1 | 1 = 1
  const forcedSideByChat = new Map<string, -1 | 1>()
  if (activeBranch?.sourceBranchId && activeForkAnchor) {
    for (const edge of graph.edges) {
      if (edge.kind !== 'return' && edge.kind !== 'return-continuation') continue
      const target = nodeById.get(edge.to)
      if (
        target?.sourceFact?.branchId === activeBranch.sourceBranchId &&
        target.orderSlot === 'persistent' &&
        (target.orderKey ?? Number.NEGATIVE_INFINITY) >
          (activeForkAnchor.orderKey ?? Number.POSITIVE_INFINITY) &&
        edge.sourceChatId !== rootChatId
      ) {
        forcedSideByChat.set(edge.sourceChatId, displacedSide)
      }
    }
  }

  const lanes = new Map<string, number>([[rootChatId, 0]])
  if (activeChatId) lanes.set(activeChatId, 0)

  // The active continuation shares lane 0 with the root. Its children are
  // therefore direct children of the same visual trunk for packing purposes.
  if (activeChatId) {
    const centreChildren = children.get(rootChatId) ?? []
    for (const child of children.get(activeChatId) ?? []) {
      if (!centreChildren.includes(child)) centreChildren.push(child)
    }
    centreChildren.sort(compareChats)
    children.set(
      rootChatId,
      centreChildren.filter((chatId) => chatId !== activeChatId),
    )
  }

  interface RelativeSubtree {
    positions: Map<string, number>
    min: number
    max: number
  }

  const buildSubtree = (
    chatId: string,
    outward: -1 | 1,
    visiting = new Set<string>(),
  ): RelativeSubtree => {
    if (visiting.has(chatId)) {
      return { positions: new Map([[chatId, 0]]), min: 0, max: 0 }
    }
    const next = new Set(visiting).add(chatId)
    const descendants = (children.get(chatId) ?? []).filter((child) => !next.has(child))
    const directionByChild = new Map<string, -1 | 1>()
    // Alternating chronologically gives the outward side ceil(n / 2) children
    // and the inward side floor(n / 2), including at every recursive level.
    descendants.forEach((child, index) => {
      directionByChild.set(child, index % 2 === 0 ? outward : (-outward as -1 | 1))
    })

    const positions = new Map<string, number>([[chatId, 0]])
    let min = 0
    let max = 0
    for (const direction of [-1, 1] as const) {
      let cursor: number = direction
      const group = descendants
        .filter((child) => directionByChild.get(child) === direction)
        .sort((a, b) => compareChats(b, a))
      for (const child of group) {
        const subtree = buildSubtree(child, outward, next)
        const offset = direction < 0 ? cursor - subtree.max : cursor - subtree.min
        for (const [descendant, relativeLane] of subtree.positions) {
          positions.set(descendant, offset + relativeLane)
        }
        min = Math.min(min, offset + subtree.min)
        max = Math.max(max, offset + subtree.max)
        cursor = direction < 0 ? offset + subtree.min - 1 : offset + subtree.max + 1
      }
    }
    return { positions, min, max }
  }

  const rootChildren = (children.get(rootChatId) ?? [])
    .filter((chatId) => chatId !== activeChatId)
    .sort(compareChats)
  const rootSide = new Map<string, -1 | 1>()
  let leftChildren = 0
  let rightChildren = 0
  for (const chatId of rootChildren) {
    const forced = forcedSideByChat.get(chatId)
    const hinted = previous?.get(chatId)
    const side = forced ?? (hinted ? (hinted < 0 ? -1 : 1) : leftChildren <= rightChildren ? -1 : 1)
    rootSide.set(chatId, side)
    if (side < 0) leftChildren += 1
    else rightChildren += 1
  }
  // Previous hints may all point to one side. Rebalance from newest to oldest;
  // this keeps appended work nearest the centre while enforcing count balance.
  while (Math.abs(leftChildren - rightChildren) > 1) {
    const crowded: -1 | 1 = leftChildren > rightChildren ? -1 : 1
    const candidate = rootChildren
      .slice()
      .reverse()
      .find((chatId) => rootSide.get(chatId) === crowded && !forcedSideByChat.has(chatId))
    if (!candidate) break
    rootSide.set(candidate, -crowded as -1 | 1)
    if (crowded < 0) {
      leftChildren -= 1
      rightChildren += 1
    } else {
      rightChildren -= 1
      leftChildren += 1
    }
  }

  for (const direction of [-1, 1] as const) {
    // Lane +1 belongs to the displaced old main suffix while a continuation is
    // active, so independent right-side subtrees begin at +2.
    let cursor = direction < 0 ? -1 : activeFork ? 2 : 1
    const compareRootChats = branchPacking === 'inward' ? compareEntryOrder : compareChats
    const group = rootChildren
      .filter((chatId) => rootSide.get(chatId) === direction)
      // Lower trunk entries claim the inner interval first. The recursive
      // subtree shape remains centred on its parent; only peer subtrees move.
      .sort((a, b) => compareRootChats(b, a))
    for (const child of group) {
      const subtree = buildSubtree(child, direction)
      const offset = direction < 0 ? cursor - subtree.max : cursor - subtree.min
      for (const [chatId, relativeLane] of subtree.positions) {
        lanes.set(chatId, offset + relativeLane)
      }
      cursor = direction < 0 ? offset + subtree.min - 1 : offset + subtree.max + 1
    }
  }

  // Malformed orphan/cyclic participants remain visible outside the packed
  // bounds without changing any valid subtree interval.
  for (const chatId of [...weights.keys()].sort(compareChats)) {
    if (lanes.has(chatId)) continue
    const minLane = Math.min(0, ...lanes.values())
    const maxLane = Math.max(0, ...lanes.values())
    lanes.set(chatId, Math.abs(minLane) <= Math.abs(maxLane) ? minLane - 1 : maxLane + 1)
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
    if (!from || !to) return []
    const routeLane =
      edge.kind === 'return' || edge.kind === 'return-continuation' ? from.lane : to.lane
    return [
      {
        ...edge,
        from,
        to,
        ...(from.lane === to.lane ? {} : { routeX: routeLane * EXECUTION_LANE_GAP }),
      },
    ]
  })
}

interface TopologyOrder {
  order: ExecutionNode[]
  cyclic: ExecutionNode[]
}

/**
 * Produces a deterministic topological order. Layout-only participant sequence
 * constraints preserve local chronology without forcing cross-lane relations
 * to consume an extra vertical row.
 */
function topologyOrder(graph: ExecutionGraph): TopologyOrder {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node] as const))
  const incomingCount = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, ExecutionEdge[]>()
  const constraints = graph.edges.slice()
  const constraintPairs = new Set(constraints.map((edge) => `${edge.from}\u0000${edge.to}`))
  // Older facts and UI-only projections do not always carry a sequence edge
  // between every pair of nodes. Preserve canonical order locally without
  // serialising unrelated branches behind one another.
  const nodesByParticipant = new Map<string, ExecutionNode[]>()
  for (const node of graph.nodes) {
    const key = `${node.sourceFact?.branchId ?? ''}\u0000${node.sourceChatId}`
    const entries = nodesByParticipant.get(key) ?? []
    entries.push(node)
    nodesByParticipant.set(key, entries)
  }
  for (const entries of nodesByParticipant.values()) {
    entries.sort(compareNodes)
    for (let index = 1; index < entries.length; index += 1) {
      const from = entries[index - 1]!
      const to = entries[index]!
      const pair = `${from.id}\u0000${to.id}`
      if (constraintPairs.has(pair)) continue
      constraints.push({
        id: `layout-sequence:${from.id}:${to.id}`,
        from: from.id,
        to: to.id,
        kind: 'sequence',
        orderSlot: 'persistent',
        orderKey: null,
        sourceChatId: from.sourceChatId,
        targetChatId: to.sourceChatId,
      })
      constraintPairs.add(pair)
    }
  }
  for (const edge of constraints) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue
    incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1)
    const edges = outgoing.get(edge.from) ?? []
    edges.push(edge)
    outgoing.set(edge.from, edges)
  }
  for (const edges of outgoing.values()) {
    edges.sort((a, b) => a.to.localeCompare(b.to) || a.id.localeCompare(b.id))
  }

  const order: ExecutionNode[] = []
  const ready = graph.nodes
    .filter((node) => (incomingCount.get(node.id) ?? 0) === 0)
    .sort(compareNodes)
  while (ready.length) {
    const node = ready.shift()!
    order.push(node)
    for (const edge of outgoing.get(node.id) ?? []) {
      const remaining = (incomingCount.get(edge.to) ?? 0) - 1
      incomingCount.set(edge.to, remaining)
      if (remaining === 0) {
        const target = nodesById.get(edge.to)!
        ready.push(target)
        ready.sort(compareNodes)
      }
    }
  }
  const orderedIds = new Set(order.map((node) => node.id))
  const cyclic = graph.nodes.filter((node) => !orderedIds.has(node.id)).sort(compareNodes)
  return { order, cyclic }
}

/**
 * A DAG layer may legitimately contain several unrelated nodes. Once those
 * nodes are projected onto participant lanes, however, two nodes on the same
 * lane must never share a row. Resolve collisions deterministically while
 * retaining every explicit parent-before-child constraint.
 */
function compactTopologyRows(
  graph: ExecutionGraph,
  laneByNode: ReadonlyMap<string, number>,
): Map<string, number> {
  const { order, cyclic } = topologyOrder(graph)
  const incoming = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const parents = incoming.get(edge.to) ?? []
    parents.push(edge.from)
    incoming.set(edge.to, parents)
  }
  const resolved = new Map<string, number>()
  const occupiedByLane = new Map<number, Set<number>>()
  const lastRowByLane = new Map<number, number>()
  for (const node of order) {
    const lane = laneByNode.get(node.id) ?? 0
    const occupied = occupiedByLane.get(lane) ?? new Set<number>()
    const parentFloor = Math.max(
      -1,
      ...(incoming.get(node.id) ?? []).map((parentId) => {
        const parentRow = resolved.get(parentId) ?? -1
        return parentRow + 1
      }),
      (lastRowByLane.get(lane) ?? -1) + 1,
    )
    let row = parentFloor
    while (occupied.has(row)) row += 1
    resolved.set(node.id, row)
    occupied.add(row)
    occupiedByLane.set(lane, occupied)
    lastRowByLane.set(lane, row)
  }
  let fallbackRow = Math.max(-1, ...resolved.values()) + 1
  for (const node of cyclic) {
    resolved.set(node.id, fallbackRow)
    fallbackRow += 1
  }
  return resolved
}

interface LayoutScene {
  nodes: PositionedExecutionNode[]
  edges: PositionedExecutionEdge[]
  byNodeId: Map<string, PositionedExecutionNode>
  byEdgeId: Map<string, PositionedExecutionEdge>
  curves: Map<string, FlattenedCurve>
}

interface SceneRect {
  left: number
  top: number
  right: number
  bottom: number
}

interface ScenePoint {
  x: number
  y: number
}

interface FlattenedCurve {
  points: ScenePoint[]
  bounds: SceneRect
}

const GEOMETRY_EPSILON = 0.001
const CURVE_FLATNESS = 0.75
const MAX_CURVE_SUBDIVISIONS = 10

function nodeRect(node: PositionedExecutionNode): SceneRect {
  return {
    left: node.x - EXECUTION_LABEL_HALF_WIDTH,
    top: node.y - EXECUTION_ICON_RADIUS,
    right: node.x + EXECUTION_LABEL_HALF_WIDTH,
    bottom: node.y + EXECUTION_LABEL_HEIGHT,
  }
}

function rectsOverlap(a: SceneRect, b: SceneRect): boolean {
  return (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > GEOMETRY_EPSILON &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > GEOMETRY_EPSILON
  )
}

function boundsIntersect(a: SceneRect, b: SceneRect): boolean {
  return (
    Math.min(a.right, b.right) >= Math.max(a.left, b.left) - GEOMETRY_EPSILON &&
    Math.min(a.bottom, b.bottom) >= Math.max(a.top, b.top) - GEOMETRY_EPSILON
  )
}

function pointLineDistance(point: ScenePoint, from: ScenePoint, to: ScenePoint): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length <= GEOMETRY_EPSILON) return Math.hypot(point.x - from.x, point.y - from.y)
  return Math.abs(dy * point.x - dx * point.y + to.x * from.y - to.y * from.x) / length
}

function midpoint(a: ScenePoint, b: ScenePoint): ScenePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function appendFlattenedCubic(
  points: ScenePoint[],
  from: ScenePoint,
  control1: ScenePoint,
  control2: ScenePoint,
  to: ScenePoint,
  depth = 0,
): void {
  const flatness = Math.max(
    pointLineDistance(control1, from, to),
    pointLineDistance(control2, from, to),
  )
  if (flatness <= CURVE_FLATNESS || depth >= MAX_CURVE_SUBDIVISIONS) {
    points.push(to)
    return
  }
  const fromControl = midpoint(from, control1)
  const controls = midpoint(control1, control2)
  const controlTo = midpoint(control2, to)
  const leftControl = midpoint(fromControl, controls)
  const rightControl = midpoint(controls, controlTo)
  const split = midpoint(leftControl, rightControl)
  appendFlattenedCubic(points, from, fromControl, leftControl, split, depth + 1)
  appendFlattenedCubic(points, split, rightControl, controlTo, to, depth + 1)
}

function flattenEdge(edge: PositionedExecutionEdge): FlattenedCurve {
  const geometry = executionEdgeGeometry(edge.from, edge.to, EXECUTION_ICON_RADIUS, edge.routeX)
  const points: ScenePoint[] = [geometry.from]
  appendFlattenedCubic(points, geometry.from, geometry.control1, geometry.control2, geometry.to)
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    points,
    bounds: {
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
    },
  }
}

function createLayoutScene(
  graph: ExecutionGraph,
  nodes: PositionedExecutionNode[],
  previous?: LayoutScene,
  affectedEdgeIds?: ReadonlySet<string>,
): LayoutScene {
  const byNodeId = new Map(nodes.map((node) => [node.id, node]))
  const edges = displayEdges(graph, byNodeId)
  return {
    nodes,
    edges,
    byNodeId,
    byEdgeId: new Map(edges.map((edge) => [edge.id, edge])),
    curves: new Map(
      edges.map((edge) => [
        edge.id,
        previous && affectedEdgeIds && !affectedEdgeIds.has(edge.id)
          ? (previous.curves.get(edge.id) ?? flattenEdge(edge))
          : flattenEdge(edge),
      ]),
    ),
  }
}

function pointInRect(point: ScenePoint, rect: SceneRect): boolean {
  return (
    point.x >= rect.left - GEOMETRY_EPSILON &&
    point.x <= rect.right + GEOMETRY_EPSILON &&
    point.y >= rect.top - GEOMETRY_EPSILON &&
    point.y <= rect.bottom + GEOMETRY_EPSILON
  )
}

function orientation(a: ScenePoint, b: ScenePoint, c: ScenePoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function pointOnSegment(point: ScenePoint, from: ScenePoint, to: ScenePoint): boolean {
  return (
    Math.abs(orientation(from, to, point)) <= GEOMETRY_EPSILON &&
    point.x >= Math.min(from.x, to.x) - GEOMETRY_EPSILON &&
    point.x <= Math.max(from.x, to.x) + GEOMETRY_EPSILON &&
    point.y >= Math.min(from.y, to.y) - GEOMETRY_EPSILON &&
    point.y <= Math.max(from.y, to.y) + GEOMETRY_EPSILON
  )
}

function segmentsIntersect(a: ScenePoint, b: ScenePoint, c: ScenePoint, d: ScenePoint): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (
    ((abC > GEOMETRY_EPSILON && abD < -GEOMETRY_EPSILON) ||
      (abC < -GEOMETRY_EPSILON && abD > GEOMETRY_EPSILON)) &&
    ((cdA > GEOMETRY_EPSILON && cdB < -GEOMETRY_EPSILON) ||
      (cdA < -GEOMETRY_EPSILON && cdB > GEOMETRY_EPSILON))
  ) {
    return true
  }
  return (
    (Math.abs(abC) <= GEOMETRY_EPSILON && pointOnSegment(c, a, b)) ||
    (Math.abs(abD) <= GEOMETRY_EPSILON && pointOnSegment(d, a, b)) ||
    (Math.abs(cdA) <= GEOMETRY_EPSILON && pointOnSegment(a, c, d)) ||
    (Math.abs(cdB) <= GEOMETRY_EPSILON && pointOnSegment(b, c, d))
  )
}

function segmentIntersectsRect(from: ScenePoint, to: ScenePoint, rect: SceneRect): boolean {
  if (pointInRect(from, rect) || pointInRect(to, rect)) return true
  const topLeft = { x: rect.left, y: rect.top }
  const topRight = { x: rect.right, y: rect.top }
  const bottomRight = { x: rect.right, y: rect.bottom }
  const bottomLeft = { x: rect.left, y: rect.bottom }
  return (
    segmentsIntersect(from, to, topLeft, topRight) ||
    segmentsIntersect(from, to, topRight, bottomRight) ||
    segmentsIntersect(from, to, bottomRight, bottomLeft) ||
    segmentsIntersect(from, to, bottomLeft, topLeft)
  )
}

function curveIntersectsNode(
  edge: PositionedExecutionEdge,
  curve: FlattenedCurve,
  node: PositionedExecutionNode,
): boolean {
  if (edge.from.id === node.id || edge.to.id === node.id) return false
  const rect = nodeRect(node)
  if (!boundsIntersect(curve.bounds, rect)) return false
  for (let index = 1; index < curve.points.length; index += 1) {
    if (segmentIntersectsRect(curve.points[index - 1]!, curve.points[index]!, rect)) return true
  }
  return false
}

function isSharedEndpointSegment(
  first: PositionedExecutionEdge,
  second: PositionedExecutionEdge,
  firstIndex: number,
  secondIndex: number,
  firstLast: number,
  secondLast: number,
): boolean {
  return (
    (first.from.id === second.from.id && firstIndex === 1 && secondIndex === 1) ||
    (first.from.id === second.to.id && firstIndex === 1 && secondIndex === secondLast) ||
    (first.to.id === second.from.id && firstIndex === firstLast && secondIndex === 1) ||
    (first.to.id === second.to.id && firstIndex === firstLast && secondIndex === secondLast)
  )
}

function curvesIntersect(
  first: PositionedExecutionEdge,
  firstCurve: FlattenedCurve,
  second: PositionedExecutionEdge,
  secondCurve: FlattenedCurve,
): boolean {
  if (!boundsIntersect(firstCurve.bounds, secondCurve.bounds)) return false
  const firstLast = firstCurve.points.length - 1
  const secondLast = secondCurve.points.length - 1
  for (let firstIndex = 1; firstIndex < firstCurve.points.length; firstIndex += 1) {
    const firstFrom = firstCurve.points[firstIndex - 1]!
    const firstTo = firstCurve.points[firstIndex]!
    for (let secondIndex = 1; secondIndex < secondCurve.points.length; secondIndex += 1) {
      const secondFrom = secondCurve.points[secondIndex - 1]!
      const secondTo = secondCurve.points[secondIndex]!
      if (!segmentsIntersect(firstFrom, firstTo, secondFrom, secondTo)) continue
      if (isSharedEndpointSegment(first, second, firstIndex, secondIndex, firstLast, secondLast)) {
        continue
      }
      return true
    }
  }
  return false
}

function pairKey(first: string, second: string): string {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`
}

function rootParticipantSubtrees(graph: ExecutionGraph): Map<string, Set<string>> {
  const participants = new Set(
    graph.nodes.map((node) => node.sourceChatId).filter((chatId) => chatId !== graph.rootChatId),
  )
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const parentByChat = new Map<string, string>()
  for (const edge of graph.edges) {
    if (
      !['spawn', 'fork-continuation', 'fork-detail'].includes(edge.kind) ||
      edge.targetChatId === graph.rootChatId
    ) {
      continue
    }
    const parent = nodeById.get(edge.from)?.sourceChatId ?? edge.sourceChatId
    if (parent !== edge.targetChatId && !parentByChat.has(edge.targetChatId)) {
      parentByChat.set(edge.targetChatId, parent)
    }
  }
  const activeChatId = graph.branches?.find(
    (branch) => branch.branchId === graph.activeBranchId,
  )?.chatId
  const centreParticipants = new Set([graph.rootChatId, ...(activeChatId ? [activeChatId] : [])])
  const groups = new Map<string, Set<string>>()
  for (const chatId of participants) {
    if (centreParticipants.has(chatId)) continue
    let root = chatId
    let parent = parentByChat.get(root) ?? graph.rootChatId
    const visiting = new Set([root])
    let malformed = false
    while (!centreParticipants.has(parent)) {
      if (visiting.has(parent) || !participants.has(parent)) {
        malformed = true
        break
      }
      visiting.add(parent)
      root = parent
      parent = parentByChat.get(root) ?? graph.rootChatId
    }
    if (malformed) continue
    const group = groups.get(root) ?? new Set<string>()
    group.add(chatId)
    groups.set(root, group)
  }
  return groups
}

/**
 * Reuses empty row intervals after topology rows are known. A root participant
 * subtree moves as one rigid lane block and only keeps a candidate that adds no
 * node overlap, edge/node crossing, or edge/edge crossing to the initial scene.
 */
function compactTopologySubtrees(
  graph: ExecutionGraph,
  nodes: PositionedExecutionNode[],
  lanes: ReadonlyMap<string, number>,
): {
  nodes: PositionedExecutionNode[]
  edges: PositionedExecutionEdge[]
  lanes: Map<string, number>
} {
  const groups = [...rootParticipantSubtrees(graph)]
    .map(([rootChatId, chatIds]) => {
      const memberNodes = nodes.filter((node) => chatIds.has(node.sourceChatId))
      return {
        rootChatId,
        chatIds,
        entryY: Math.min(...memberNodes.map((node) => node.y)),
      }
    })
    .filter((group) => Number.isFinite(group.entryY))
    .sort((a, b) => a.entryY - b.entryY || a.rootChatId.localeCompare(b.rootChatId))
  const reservedSideLanes = new Set(
    nodes.filter((node) => node.main && node.lane !== 0).map((node) => node.lane),
  )
  const activeChatId = graph.branches?.find(
    (branch) => branch.branchId === graph.activeBranchId,
  )?.chatId
  if (
    activeChatId &&
    graph.edges.some(
      (edge) => edge.kind === 'fork-continuation' && edge.targetChatId === activeChatId,
    )
  ) {
    reservedSideLanes.add(1)
  }
  const movableGroups = groups.filter(({ chatIds }) => {
    const groupLanes = [...chatIds].flatMap((chatId) => {
      const lane = lanes.get(chatId)
      return lane === undefined ? [] : [lane]
    })
    if (!groupLanes.length) return false
    const minLane = Math.min(...groupLanes)
    const maxLane = Math.max(...groupLanes)
    if (minLane < 0 && maxLane > 0) return false
    return maxLane < -1 || minLane > 1
  })
  if (!movableGroups.length)
    return {
      nodes,
      edges: displayEdges(graph, new Map(nodes.map((node) => [node.id, node]))),
      lanes: new Map(lanes),
    }

  const baseline = createLayoutScene(graph, nodes)
  let scene = baseline
  const compactedLanes = new Map(lanes)
  const baselineNodeOverlap = new Map<string, boolean>()
  const baselineEdgeNodeCrossing = new Map<string, boolean>()
  const baselineEdgeCrossing = new Map<string, boolean>()

  const nodeOverlapExisted = (firstId: string, secondId: string): boolean => {
    const key = pairKey(firstId, secondId)
    const cached = baselineNodeOverlap.get(key)
    if (cached !== undefined) return cached
    const result = rectsOverlap(
      nodeRect(baseline.byNodeId.get(firstId)!),
      nodeRect(baseline.byNodeId.get(secondId)!),
    )
    baselineNodeOverlap.set(key, result)
    return result
  }
  const edgeNodeCrossingExisted = (edgeId: string, nodeId: string): boolean => {
    const key = `${edgeId}\u0000${nodeId}`
    const cached = baselineEdgeNodeCrossing.get(key)
    if (cached !== undefined) return cached
    const edge = baseline.byEdgeId.get(edgeId)!
    const result = curveIntersectsNode(
      edge,
      baseline.curves.get(edgeId)!,
      baseline.byNodeId.get(nodeId)!,
    )
    baselineEdgeNodeCrossing.set(key, result)
    return result
  }
  const edgeCrossingExisted = (firstId: string, secondId: string): boolean => {
    const key = pairKey(firstId, secondId)
    const cached = baselineEdgeCrossing.get(key)
    if (cached !== undefined) return cached
    const first = baseline.byEdgeId.get(firstId)!
    const second = baseline.byEdgeId.get(secondId)!
    const result = curvesIntersect(
      first,
      baseline.curves.get(firstId)!,
      second,
      baseline.curves.get(secondId)!,
    )
    baselineEdgeCrossing.set(key, result)
    return result
  }

  for (const group of movableGroups) {
    const groupLanes = [...group.chatIds].flatMap((chatId) => {
      const lane = compactedLanes.get(chatId)
      return lane === undefined ? [] : [lane]
    })
    if (!groupLanes.length) continue
    const minLane = Math.min(...groupLanes)
    const maxLane = Math.max(...groupLanes)
    if (minLane < 0 && maxLane > 0) continue
    const side: -1 | 0 | 1 = maxLane < 0 ? -1 : minLane > 0 ? 1 : 0
    if (side === 0) continue
    const maximumShift = side < 0 ? -1 - maxLane : minLane - 1
    if (maximumShift <= 0) continue
    const movingNodeIds = new Set(
      scene.nodes.filter((node) => group.chatIds.has(node.sourceChatId)).map((node) => node.id),
    )
    const affectedEdgeIds = new Set(
      scene.edges
        .filter((edge) => movingNodeIds.has(edge.from.id) || movingNodeIds.has(edge.to.id))
        .map((edge) => edge.id),
    )

    for (let amount = maximumShift; amount >= 1; amount -= 1) {
      const laneShift = side < 0 ? amount : -amount
      if (groupLanes.some((lane) => reservedSideLanes.has(lane + laneShift))) continue
      const candidateNodes = scene.nodes.map((node) =>
        movingNodeIds.has(node.id)
          ? { ...node, lane: node.lane + laneShift, x: node.x + laneShift * EXECUTION_LANE_GAP }
          : node,
      )
      const candidate = createLayoutScene(graph, candidateNodes, scene, affectedEdgeIds)
      let rejected = false

      for (const movingId of movingNodeIds) {
        const moving = candidate.byNodeId.get(movingId)!
        for (const other of candidate.nodes) {
          if (movingId === other.id) continue
          if (
            rectsOverlap(nodeRect(moving), nodeRect(other)) &&
            !nodeOverlapExisted(movingId, other.id)
          ) {
            rejected = true
            break
          }
        }
        if (rejected) break
      }
      if (rejected) continue

      for (const edge of candidate.edges) {
        const nodesToCheck = affectedEdgeIds.has(edge.id)
          ? candidate.nodes
          : candidate.nodes.filter((node) => movingNodeIds.has(node.id))
        for (const node of nodesToCheck) {
          if (
            curveIntersectsNode(edge, candidate.curves.get(edge.id)!, node) &&
            !edgeNodeCrossingExisted(edge.id, node.id)
          ) {
            rejected = true
            break
          }
        }
        if (rejected) break
      }
      if (rejected) continue

      const comparedEdgePairs = new Set<string>()
      for (const firstId of affectedEdgeIds) {
        const first = candidate.byEdgeId.get(firstId)
        if (!first) continue
        for (const second of candidate.edges) {
          if (first.id === second.id) continue
          const key = pairKey(first.id, second.id)
          if (comparedEdgePairs.has(key)) continue
          comparedEdgePairs.add(key)
          if (
            curvesIntersect(
              first,
              candidate.curves.get(first.id)!,
              second,
              candidate.curves.get(second.id)!,
            ) &&
            !edgeCrossingExisted(first.id, second.id)
          ) {
            rejected = true
            break
          }
        }
        if (rejected) break
      }
      if (rejected) continue

      scene = candidate
      for (const chatId of group.chatIds) {
        const lane = compactedLanes.get(chatId)
        if (lane !== undefined) compactedLanes.set(chatId, lane + laneShift)
      }
      break
    }
  }
  return { nodes: scene.nodes, edges: scene.edges, lanes: compactedLanes }
}

/** Vertical execution layout driven by causality in every display mode. */
export function layoutExecutionGraph(
  graph: ExecutionGraph,
  options: ExecutionLayoutOptions = {},
): ExecutionLayout {
  const lanes = assignChildLanes(graph, options.previousLanes, options.branchPacking)
  const ordered = graph.nodes.slice().sort(compareNodes)
  const activeBranch = graph.branches?.find((branch) => branch.branchId === graph.activeBranchId)
  const activeFork = activeBranch
    ? graph.edges.find(
        (edge) => edge.kind === 'fork-continuation' && edge.targetChatId === activeBranch.chatId,
      )
    : undefined
  const activeForkAnchor = activeFork
    ? graph.nodes.find((node) => node.id === activeFork.from)
    : undefined
  const displacedLane = (() => {
    if (!activeBranch?.sourceBranchId || !activeForkAnchor) return undefined
    const hinted = options.previousLanes?.get(activeForkAnchor.sourceChatId)
    return hinted && hinted !== 0 ? hinted : 1
  })()
  const laneByNode = new Map<string, number>()
  for (const node of ordered) {
    const displacedSuffix =
      displacedLane !== undefined &&
      node.sourceFact?.branchId === activeBranch?.sourceBranchId &&
      node.sourceChatId === activeForkAnchor?.sourceChatId &&
      node.orderSlot === 'persistent' &&
      (node.orderKey ?? Number.NEGATIVE_INFINITY) >
        (activeForkAnchor?.orderKey ?? Number.POSITIVE_INFINITY)
    laneByNode.set(node.id, displacedSuffix ? displacedLane : (lanes.get(node.sourceChatId) ?? 0))
  }
  const rows =
    options.mode === 'topology'
      ? compactTopologyRows(graph, laneByNode)
      : new Map(ordered.map((node, index) => [node.id, index] as const))
  let positioned = ordered
    .map((node) => {
      const lane = laneByNode.get(node.id) ?? 0
      return {
        ...node,
        lane,
        x: lane * EXECUTION_LANE_GAP,
        y: EXECUTION_TOP + (rows.get(node.id) ?? 0) * EXECUTION_ROW_GAP,
      }
    })
    .sort((a, b) => a.y - b.y || a.lane - b.lane || compareNodes(a, b))
  let finalLanes = lanes
  let edges: PositionedExecutionEdge[]
  if (options.mode === 'topology') {
    const compacted = compactTopologySubtrees(graph, positioned, lanes)
    finalLanes = compacted.lanes
    positioned = compacted.nodes
      .slice()
      .sort((a, b) => a.y - b.y || a.lane - b.lane || compareNodes(a, b))
    edges = compacted.edges
  } else {
    edges = displayEdges(graph, new Map(positioned.map((node) => [node.id, node])))
  }
  const lanesInUse = positioned.map((node) => node.lane)
  const minLane = Math.min(0, ...lanesInUse)
  const maxLane = Math.max(0, ...lanesInUse)
  const horizontalPadding = EXECUTION_LABEL_HALF_WIDTH + 48
  const minX = minLane * EXECUTION_LANE_GAP - horizontalPadding
  const maxX = maxLane * EXECUTION_LANE_GAP + horizontalPadding
  const minY = 0
  const maxY =
    Math.max(EXECUTION_TOP, ...positioned.map((node) => node.y)) +
    EXECUTION_LABEL_HEIGHT +
    EXECUTION_TOP
  return {
    nodes: positioned,
    edges,
    width: maxX - minX,
    height: maxY - minY,
    originX: -minX,
    bounds: { minX, minY, maxX, maxY },
    laneByChat: finalLanes,
  }
}

function topologySignature(graph: Readonly<ExecutionGraph>): string {
  return [
    graph.rootChatId,
    graph.activeBranchId ?? '',
    ...(graph.branches ?? []).map((branch) =>
      [branch.branchId, branch.chatId, branch.sourceBranchId ?? '', branch.anchorNodeId ?? ''].join(
        '\u0001',
      ),
    ),
    '\u0004',
    ...graph.nodes.map((node) =>
      [
        node.id,
        node.kind,
        node.sourceChatId,
        node.orderSlot,
        node.orderKey ?? '',
        node.createdAt,
      ].join('\u0001'),
    ),
    '\u0002',
    ...graph.edges.map((edge) =>
      [edge.id, edge.from, edge.to, edge.kind, edge.sourceChatId, edge.targetChatId].join('\u0001'),
    ),
  ].join('\u0000')
}

function refreshLayout(
  previous: ExecutionLayout,
  graph: Readonly<ExecutionGraph>,
): ExecutionLayout {
  const coordinates = new Map(previous.nodes.map((node) => [node.id, node] as const))
  const nodes = graph.nodes
    .map((node) => {
      const position = coordinates.get(node.id)!
      return { ...node, x: position.x, y: position.y, lane: position.lane }
    })
    .sort((a, b) => a.y - b.y || a.lane - b.lane || compareNodes(a, b))
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  return {
    ...previous,
    nodes,
    edges: displayEdges(graph as ExecutionGraph, byId),
  }
}

export interface IncrementalExecutionLayout {
  layout(graph: Readonly<ExecutionGraph>, options?: ExecutionLayoutOptions): ExecutionLayout
  recomputations(): number
  reset(): void
}

/** Reuses stable coordinates when streaming content changes without changing graph topology. */
export function createIncrementalExecutionLayout(): IncrementalExecutionLayout {
  let signature = ''
  let previous: ExecutionLayout | undefined
  let count = 0
  return {
    layout(graph, options = {}) {
      const nextSignature = `${options.mode ?? 'timeline'}\u0003${options.branchPacking ?? 'balanced'}\u0003${topologySignature(graph)}`
      if (previous && signature === nextSignature) {
        previous = refreshLayout(previous, graph)
        return previous
      }
      previous = layoutExecutionGraph(graph as ExecutionGraph, {
        previousLanes: previous?.laneByChat,
        mode: options.mode,
        branchPacking: options.branchPacking,
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
