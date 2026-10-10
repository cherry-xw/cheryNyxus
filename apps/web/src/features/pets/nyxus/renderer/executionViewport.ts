import type {
  ExecutionLayout,
  PositionedExecutionEdge,
  PositionedExecutionNode,
} from '../graph/executionLayout'

export interface ExecutionCamera {
  scale: number
  x: number
  y: number
  width: number
  height: number
}

export interface ExecutionWorldBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface VisibleExecutionItems {
  bounds: ExecutionWorldBounds
  nodes: PositionedExecutionNode[]
  edges: PositionedExecutionEdge[]
}

export interface ExecutionViewportIndex {
  layout: Readonly<ExecutionLayout>
  nodeById: ReadonlyMap<string, PositionedExecutionNode>
  primaryAxis: 'x' | 'y'
  edgeBuckets: ReadonlyMap<number, readonly PositionedExecutionEdge[]>
  longEdges: readonly PositionedExecutionEdge[]
  edgesByNode: ReadonlyMap<string, readonly PositionedExecutionEdge[]>
}

export const EXECUTION_VIEWPORT_OVERSCAN = 220
export const EXECUTION_EDGE_BUCKET_SIZE = 512
const MAX_EDGE_BUCKET_SPAN = 64

export function cameraWorldBounds(
  camera: ExecutionCamera,
  overscan = EXECUTION_VIEWPORT_OVERSCAN,
): ExecutionWorldBounds {
  const scale = Math.max(0.0001, camera.scale)
  return {
    minX: (-camera.x - overscan) / scale,
    minY: (-camera.y - overscan) / scale,
    maxX: (camera.width - camera.x + overscan) / scale,
    maxY: (camera.height - camera.y + overscan) / scale,
  }
}

/** Whether the current camera (plus a screen-pixel safety margin) remains inside a retained selection. */
export function viewportSelectionContainsCamera(
  selection: Readonly<ExecutionWorldBounds>,
  camera: ExecutionCamera,
  safetyMargin = 0,
): boolean {
  const current = cameraWorldBounds(camera, safetyMargin)
  return (
    current.minX >= selection.minX &&
    current.minY >= selection.minY &&
    current.maxX <= selection.maxX &&
    current.maxY <= selection.maxY
  )
}

function firstNodeAtOrBelow(
  nodes: readonly PositionedExecutionNode[],
  axis: 'x' | 'y',
  minimum: number,
): number {
  let low = 0
  let high = nodes.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (nodes[middle]![axis] < minimum) low = middle + 1
    else high = middle
  }
  return low
}

export function executionWorldBoundsIntersect(
  viewport: Readonly<ExecutionWorldBounds>,
  item: Readonly<ExecutionWorldBounds>,
): boolean {
  return (
    item.maxX >= viewport.minX &&
    item.minX <= viewport.maxX &&
    item.maxY >= viewport.minY &&
    item.minY <= viewport.maxY
  )
}

export function createExecutionViewportIndex(
  layout: Readonly<ExecutionLayout>,
): ExecutionViewportIndex {
  const primaryAxis = layout.presentation === 'horizontal-signal' ? 'x' : 'y'
  const edgeBuckets = new Map<number, PositionedExecutionEdge[]>()
  const longEdges: PositionedExecutionEdge[] = []
  const edgesByNode = new Map<string, PositionedExecutionEdge[]>()
  for (const edge of layout.edges) {
    for (const nodeId of [edge.from.id, edge.to.id]) {
      const connected = edgesByNode.get(nodeId) ?? []
      connected.push(edge)
      edgesByNode.set(nodeId, connected)
    }
    const corridor = primaryAxis === 'x' ? edge.routeX : edge.routeY
    const firstBucket = Math.floor(
      Math.min(edge.from[primaryAxis], edge.to[primaryAxis], corridor ?? Number.POSITIVE_INFINITY) /
        EXECUTION_EDGE_BUCKET_SIZE,
    )
    const lastBucket = Math.floor(
      Math.max(edge.from[primaryAxis], edge.to[primaryAxis], corridor ?? Number.NEGATIVE_INFINITY) /
        EXECUTION_EDGE_BUCKET_SIZE,
    )
    if (lastBucket - firstBucket > MAX_EDGE_BUCKET_SPAN) {
      longEdges.push(edge)
      continue
    }
    for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
      const edges = edgeBuckets.get(bucket) ?? []
      edges.push(edge)
      edgeBuckets.set(bucket, edges)
    }
  }
  return {
    layout,
    primaryAxis,
    nodeById: new Map(layout.nodes.map((node) => [node.id, node] as const)),
    edgeBuckets,
    longEdges,
    edgesByNode,
  }
}

/**
 * Selects only the graph primitives that can affect the current frame. Nodes
 * are globally Y ordered, so the hot path is O(log N + visible nodes). Edges
 * are conservatively retained when their endpoint box intersects the view.
 */
export function selectVisibleExecutionItems(
  layout: Readonly<ExecutionLayout>,
  camera: ExecutionCamera,
  forceNodeIds: ReadonlySet<string> = new Set(),
  suppliedIndex?: Readonly<ExecutionViewportIndex>,
  overscan = EXECUTION_VIEWPORT_OVERSCAN,
  fullRenderThreshold?: number,
): VisibleExecutionItems {
  // 全量短路：节点数低于阈值时跳过裁剪，整套可见集合与 camera 解耦，
  // 平移期 GPU 场景与 DOM hit-target 不再随节点进出视图而增删（消除平移卡顿）。
  // fullRenderThreshold=0 → `length <= 0` 恒 false（空图除外），即始终裁剪。
  if (fullRenderThreshold !== undefined && layout.nodes.length <= fullRenderThreshold) {
    return { bounds: layout.bounds, nodes: [...layout.nodes], edges: [...layout.edges] }
  }
  const bounds = cameraWorldBounds(camera, overscan)
  const index =
    suppliedIndex?.layout === layout ? suppliedIndex : createExecutionViewportIndex(layout)
  const axis = index.primaryAxis
  const minimum = axis === 'x' ? bounds.minX : bounds.minY
  const maximum = axis === 'x' ? bounds.maxX : bounds.maxY
  const start = Math.max(0, firstNodeAtOrBelow(layout.nodes, axis, minimum) - 1)
  const selected: PositionedExecutionNode[] = []
  const selectedIds = new Set<string>()
  for (let index = start; index < layout.nodes.length; index += 1) {
    const node = layout.nodes[index]!
    if (node[axis] > maximum) break
    if (
      node.x >= bounds.minX &&
      node.x <= bounds.maxX &&
      node.y >= bounds.minY &&
      node.y <= bounds.maxY
    ) {
      selected.push(node)
      selectedIds.add(node.id)
    }
  }
  for (const id of forceNodeIds) {
    if (selectedIds.has(id)) continue
    const node = index.nodeById.get(id)
    if (node) {
      selected.push(node)
      selectedIds.add(node.id)
    }
  }

  const edgeCandidates = new Set<PositionedExecutionEdge>(index.longEdges)
  const firstBucket = Math.floor(minimum / EXECUTION_EDGE_BUCKET_SIZE)
  const lastBucket = Math.floor(maximum / EXECUTION_EDGE_BUCKET_SIZE)
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
    for (const edge of index.edgeBuckets.get(bucket) ?? []) edgeCandidates.add(edge)
  }
  for (const nodeId of forceNodeIds) {
    for (const edge of index.edgesByNode.get(nodeId) ?? []) edgeCandidates.add(edge)
  }
  const edges = [...edgeCandidates].filter((edge) => {
    const minX = Math.min(edge.from.x, edge.to.x, edge.routeX ?? Number.POSITIVE_INFINITY)
    const minY = Math.min(edge.from.y, edge.to.y, edge.routeY ?? Number.POSITIVE_INFINITY)
    const maxX = Math.max(edge.from.x, edge.to.x, edge.routeX ?? Number.NEGATIVE_INFINITY)
    const maxY = Math.max(edge.from.y, edge.to.y, edge.routeY ?? Number.NEGATIVE_INFINITY)
    return (
      selectedIds.has(edge.from.id) ||
      selectedIds.has(edge.to.id) ||
      executionWorldBoundsIntersect(bounds, { minX, minY, maxX, maxY })
    )
  })

  return { bounds, nodes: selected, edges }
}

export function visibleItemsKey(items: Readonly<VisibleExecutionItems>): string {
  return `${items.nodes.map((node) => node.id).join('\u0001')}\u0002${items.edges
    .map((edge) => edge.id)
    .join('\u0001')}`
}
