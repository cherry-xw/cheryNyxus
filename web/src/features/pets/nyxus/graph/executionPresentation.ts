import {
  EXECUTION_LANE_GAP,
  EXECUTION_ROW_GAP,
  EXECUTION_TOP,
  type ExecutionLayout,
  type PositionedExecutionEdge,
  type PositionedExecutionNode,
} from './executionLayout'

export type ExecutionPresentationMode = 'horizontal-signal' | 'vertical-classic'

export interface ExecutionNodeVisualBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export const SIGNAL_LANE_GAP = 112
export const SIGNAL_NODE_WIDTH = 104
export const SIGNAL_NODE_HEIGHT = 40
export const SIGNAL_ORIGIN_X = 76
/** 相邻两列节点矩形之间的最小走线净距（列距自适应的下限组成项）。 */
export const SIGNAL_MIN_WIRE_GAP = 64
/** 同一列间隙内两条走廊 routeY 的最小间隔。 */
export const SIGNAL_ROUTE_SLOT_GAP = 14
/** 走廊带与节点矩形的膨胀边距。 */
export const SIGNAL_CORRIDOR_MARGIN = 6
/** mono 10-11px 标签的每字符像素宽度（截断预算公式项）。 */
export const SIGNAL_LABEL_CHAR_PX = 6.6
/** 标签横向预留：左图标区 30px + 右余量 12px。 */
export const SIGNAL_LABEL_RESERVED_PX = 42

export const SIGNAL_NODE_SIZES = {
  'hero-user': { width: 192, height: 64 },
  'hero-final': { width: 192, height: 64 },
  'hero-error': { width: 192, height: 58 },
  fold: { width: 128, height: 44 },
  process: { width: 104, height: 40 },
} as const

export type ExecutionPresentationPriority = keyof typeof SIGNAL_NODE_SIZES

/**
 * Signal 标签截断预算：按节点宽度推导每档可用字符数，process 只保留协议码。
 * 纯静态计算（不逐帧测量）；summary 变化经 labelSignature 自然触发标签重建。
 */
export function signalLabelBudget(priority: ExecutionPresentationPriority): number {
  const byWidth = Math.floor(
    (SIGNAL_NODE_SIZES[priority].width - SIGNAL_LABEL_RESERVED_PX) / SIGNAL_LABEL_CHAR_PX,
  )
  const cap = priority === 'process' ? 0 : priority === 'fold' ? 10 : 22
  return Math.min(cap, byWidth)
}

function protocolCode(node: PositionedExecutionNode): string {
  if (node.kind === 'fold' || node.kind === 'pack') return 'FOLD'
  if (node.kind === 'tool-batch') return 'TOOL'
  if (node.kind === 'spawn' || node.kind === 'dispatch') return 'FORK'
  if (node.kind === 'return') return 'RET'
  if (node.actor.kind === 'user') return 'USR'
  if (node.actor.kind === 'agent') return 'LLM'
  if (node.kind === 'start') return 'BOOT'
  return 'SYS'
}

function summarize(content: string): string {
  const value = content.replace(/\s+/g, ' ').trim()
  return value.length > 56 ? `${value.slice(0, 55)}…` : value
}

/** UI-only priority projection. Canonical nodes and folding remain untouched. */
export function projectExecutionNodePriorities(
  nodes: readonly PositionedExecutionNode[],
): PositionedExecutionNode[] {
  const orderedByChat = new Map<string, PositionedExecutionNode[]>()
  for (const node of nodes) {
    const list = orderedByChat.get(node.sourceChatId) ?? []
    list.push(node)
    orderedByChat.set(node.sourceChatId, list)
  }
  const finalAgentIds = new Set<string>()
  for (const list of orderedByChat.values()) {
    list.sort((a, b) => (a.orderKey ?? a.createdAt) - (b.orderKey ?? b.createdAt))
    // 单次反向扫描判定 finalAgent：窗口 (i, nextUser) 内不存在非错误 agent-to-user
    // 即记为收尾回复；用户节点截断窗口。等价于旧 O(n²) 的逐节点 slice 扫描。
    let laterAgent = false
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const node = list[index]!
      if (node.actor.kind === 'agent' && node.direction === 'agent-to-user' && !laterAgent) {
        finalAgentIds.add(node.id)
      }
      if (node.actor.kind === 'user') {
        laterAgent = false
      } else if (
        node.actor.kind === 'agent' &&
        node.direction === 'agent-to-user' &&
        node.sourceFact?.termination?.code !== 'error'
      ) {
        laterAgent = true
      }
    }
  }
  return nodes.map((node) => {
    const error = node.sourceFact?.termination?.code === 'error'
    const priority: ExecutionPresentationPriority = error
      ? 'hero-error'
      : node.kind === 'fold' || node.kind === 'pack'
        ? 'fold'
        : node.actor.kind === 'user' && node.direction === 'user-to-agent'
          ? 'hero-user'
          : finalAgentIds.has(node.id)
            ? 'hero-final'
            : 'process'
    // 标签预算内截断（超限加 …）；process 预算为 0，仅由协议码标签呈现。
    const budget = signalLabelBudget(priority)
    const summary = summarize(node.content)
    const label =
      summary.length > budget ? `${summary.slice(0, Math.max(1, budget - 1))}…` : summary
    return {
      ...node,
      presentationPriority: priority,
      protocolCode: protocolCode(node),
      summary: budget > 0 ? label : '',
      effect:
        priority === 'hero-error'
          ? 'corruption'
          : priority === 'hero-user'
            ? 'projection'
            : priority === 'hero-final'
              ? 'convergence'
              : priority === 'fold'
                ? 'orbit'
                : 'trail',
    }
  })
}

function signalNodeBounds(
  node: Pick<PositionedExecutionNode, 'x' | 'y' | 'presentationPriority'>,
): ExecutionNodeVisualBounds {
  const size = SIGNAL_NODE_SIZES[node.presentationPriority ?? 'process']
  return {
    left: node.x - size.width / 2,
    top: node.y - size.height / 2,
    right: node.x + size.width / 2,
    bottom: node.y + size.height / 2,
  }
}

interface CorridorBand {
  top: number
  bottom: number
}

/**
 * 计算一列节点矩形之间的空闲纵向带（走廊可安放区间），矩形向外膨胀
 * SIGNAL_CORRIDOR_MARGIN，确保走廊不贴边穿过节点。
 */
function freeCorridorBands(
  rects: readonly ExecutionNodeVisualBounds[],
  worldTop: number,
  worldBottom: number,
): CorridorBand[] {
  const merged = [...rects].sort((a, b) => a.top - b.top)
  const bands: CorridorBand[] = []
  let cursor = worldTop
  for (const rect of merged) {
    const blockedTop = rect.top - SIGNAL_CORRIDOR_MARGIN
    if (blockedTop > cursor) bands.push({ top: cursor, bottom: Math.min(blockedTop, worldBottom) })
    cursor = Math.max(cursor, rect.bottom + SIGNAL_CORRIDOR_MARGIN)
    if (cursor >= worldBottom) break
  }
  if (cursor < worldBottom) bands.push({ top: cursor, bottom: worldBottom })
  return bands.filter((band) => band.bottom - band.top >= 2)
}

function bandAt(bands: readonly CorridorBand[], y: number): CorridorBand | undefined {
  return bands.find((band) => y >= band.top + 3 && y <= band.bottom - 3)
}

/** 两列空闲带求交：跨多列边的走廊必须同时落在每条被穿越列的空闲带内。 */
function intersectBands(a: readonly CorridorBand[], b: readonly CorridorBand[]): CorridorBand[] {
  const result: CorridorBand[] = []
  for (const first of a) {
    for (const second of b) {
      const top = Math.max(first.top, second.top)
      const bottom = Math.min(first.bottom, second.bottom)
      if (bottom - top >= 2) result.push({ top, bottom })
    }
  }
  return result
}

/** 在空闲带中寻找距 preferred 最近且与已占用 routeY 保持最小间隔的走廊 y。 */
function placeCorridor(
  bands: readonly CorridorBand[],
  preferred: number,
  occupied: readonly number[],
  worldTop: number,
  worldBottom: number,
): number | undefined {
  const limit = worldBottom - worldTop
  for (let step = 0; step * SIGNAL_ROUTE_SLOT_GAP <= limit; step += 1) {
    const candidates =
      step === 0
        ? [preferred]
        : [preferred + step * SIGNAL_ROUTE_SLOT_GAP, preferred - step * SIGNAL_ROUTE_SLOT_GAP]
    for (const y of candidates) {
      if (y < worldTop || y > worldBottom) continue
      if (!bandAt(bands, y)) continue
      if (occupied.every((slot) => Math.abs(slot - y) >= SIGNAL_ROUTE_SLOT_GAP)) return y
    }
  }
  return undefined
}

/**
 * 横向二次路由消解：把投影后仍在互相穿插/穿越节点的边线收敛到互不重叠的
 * 走廊槽位（routeY）。规则（见 nyxus-node-tree-maintenance.md 返工契约）：
 * - 跨多列长边优先分配外侧走廊（先处理、先占带），走廊带取所有被穿越列空闲带的交集；
 * - 单列间隙边仅当 canonical 布局本就要求绕行（routeX）时才需要走廊，组内按来源 y
 *   排序依次安放，最小间隔 SIGNAL_ROUTE_SLOT_GAP；
 * - 走廊不得穿过任何节点矩形；找不到可用走廊时回退直连（routeY = undefined）。
 */
export function resolveSignalEdgeCorridors(
  edges: readonly PositionedExecutionEdge[],
  columnOfNode: ReadonlyMap<string, number>,
  columnRects: readonly (readonly ExecutionNodeVisualBounds[])[],
  worldTop: number,
  worldBottom: number,
): Map<string, number | undefined> {
  const resolved = new Map<string, number | undefined>()
  interface Crosser {
    edge: PositionedExecutionEdge
    fromColumn: number
    toColumn: number
    preferred: number
  }
  const crossers: Crosser[] = []
  for (const edge of edges) {
    const fromColumn = columnOfNode.get(edge.from.id)
    const toColumn = columnOfNode.get(edge.to.id)
    if (fromColumn === undefined || toColumn === undefined || toColumn <= fromColumn) continue
    crossers.push({ edge, fromColumn, toColumn, preferred: (edge.from.y + edge.to.y) / 2 })
  }

  // 每个列间隙的已占用 routeY：跨多列边先登记，单列间隙边随后避让。
  const gapOccupancy = new Map<number, number[]>()
  const occupy = (fromColumn: number, toColumn: number, y: number): void => {
    for (let gap = fromColumn; gap < toColumn; gap += 1) {
      const slots = gapOccupancy.get(gap) ?? []
      slots.push(y)
      gapOccupancy.set(gap, slots)
    }
  }

  // 1) 跨多列长边：先到先得，优先外侧走廊。
  const multi = crossers
    .filter((crosser) => crosser.toColumn - crosser.fromColumn > 1)
    .sort(
      (a, b) =>
        b.toColumn - b.fromColumn - (a.toColumn - a.fromColumn) ||
        a.preferred - b.preferred ||
        a.edge.id.localeCompare(b.edge.id),
    )
  for (const crosser of multi) {
    let bands = freeCorridorBands(columnRects[crosser.fromColumn + 1] ?? [], worldTop, worldBottom)
    for (let column = crosser.fromColumn + 2; column < crosser.toColumn; column += 1) {
      bands = intersectBands(
        bands,
        freeCorridorBands(columnRects[column] ?? [], worldTop, worldBottom),
      )
    }
    const occupied: number[] = []
    for (let gap = crosser.fromColumn; gap < crosser.toColumn; gap += 1) {
      occupied.push(...(gapOccupancy.get(gap) ?? []))
    }
    const y = placeCorridor(bands, crosser.preferred, occupied, worldTop, worldBottom)
    if (y === undefined) {
      resolved.set(crosser.edge.id, undefined)
      continue
    }
    resolved.set(crosser.edge.id, y)
    occupy(crosser.fromColumn, crosser.toColumn, y)
  }

  // 2) 单列间隙绕行边：组内按来源 y 排序，槽位互不重叠；无可用槽位则直连。
  const singles = crossers.filter((crosser) => crosser.toColumn - crosser.fromColumn === 1)
  const byGap = new Map<number, Crosser[]>()
  for (const crosser of singles) {
    // 直连本就安全的相邻边（canonical 无绕行）不需要走廊。
    if (crosser.edge.routeX === undefined) continue
    const list = byGap.get(crosser.fromColumn) ?? []
    list.push(crosser)
    byGap.set(crosser.fromColumn, list)
  }
  for (const [gap, list] of byGap) {
    const bands = freeCorridorBands(
      [...(columnRects[gap] ?? []), ...(columnRects[gap + 1] ?? [])],
      worldTop,
      worldBottom,
    )
    const occupied = [...(gapOccupancy.get(gap) ?? [])]
    for (const crosser of [...list].sort(
      (a, b) => a.preferred - b.preferred || a.edge.id.localeCompare(b.edge.id),
    )) {
      const y = placeCorridor(bands, crosser.preferred, occupied, worldTop, worldBottom)
      if (y === undefined) {
        resolved.set(crosser.edge.id, undefined)
        continue
      }
      resolved.set(crosser.edge.id, y)
      occupied.push(y)
      occupy(crosser.fromColumn, crosser.toColumn, y)
    }
  }
  return resolved
}

/**
 * Pure presentation projection. The canonical topology/lane/fold layout has
 * already finished before this runs; only world coordinates, adaptive column
 * gaps and edge routing corridors are rotated into a wide-screen signal bus.
 */
export function projectExecutionPresentation(
  layout: Readonly<ExecutionLayout>,
  mode: ExecutionPresentationMode,
): ExecutionLayout {
  if (mode === 'vertical-classic') {
    return layout.presentation === mode ? (layout as ExecutionLayout) : { ...layout, presentation: mode }
  }

  const minLane = Math.min(0, ...layout.nodes.map((node) => node.lane))
  const laneOriginY = 72 - minLane * SIGNAL_LANE_GAP
  const nodeById = new Map<string, PositionedExecutionNode>()
  const priorityNodes = projectExecutionNodePriorities(layout.nodes)
  const rows = [...new Set(priorityNodes.map((node) => node.y))].sort((a, b) => a - b)
  const rowIndexByY = new Map(rows.map((row, index) => [row, index] as const))
  // 单次分桶：每列节点列表 + 最宽半宽，避免 O(列 × 节点) 的逐行 filter。
  const columnBuckets: PositionedExecutionNode[][] = rows.map(() => [])
  const columnHalfWidths = rows.map(() => 0)
  for (const node of priorityNodes) {
    const columnIndex = rowIndexByY.get(node.y)!
    columnBuckets[columnIndex]!.push(node)
    const halfWidth = SIGNAL_NODE_SIZES[node.presentationPriority ?? 'process'].width / 2
    if (halfWidth > columnHalfWidths[columnIndex]!) columnHalfWidths[columnIndex] = halfWidth
  }
  // 列距自适应：相邻列矩形净距 ≥ SIGNAL_MIN_WIRE_GAP，由两列最宽节点半宽共同决定。
  const rowCenters: number[] = []
  rows.forEach((_, index) => {
    rowCenters[index] =
      index === 0
        ? SIGNAL_ORIGIN_X + columnHalfWidths[index]!
        : rowCenters[index - 1]! +
          columnHalfWidths[index - 1]! +
          SIGNAL_MIN_WIRE_GAP +
          columnHalfWidths[index]!
  })
  const columnOfNode = new Map<string, number>()
  const nodes = priorityNodes
    .map((node): PositionedExecutionNode => {
      const columnIndex = rowIndexByY.get(node.y)!
      const projected = {
        ...node,
        x: rowCenters[columnIndex] ?? SIGNAL_ORIGIN_X,
        y: laneOriginY + (node.x / EXECUTION_LANE_GAP) * SIGNAL_LANE_GAP,
      }
      projected.visualBounds = signalNodeBounds(projected)
      nodeById.set(projected.id, projected)
      columnOfNode.set(projected.id, columnIndex)
      return projected
    })
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))

  const rotatedEdges = layout.edges.flatMap((edge): PositionedExecutionEdge[] => {
    const from = nodeById.get(edge.from.id)
    const to = nodeById.get(edge.to.id)
    if (!from || !to) return []
    return [
      {
        ...edge,
        from,
        to,
        routeX: undefined,
        ...(edge.routeX === undefined
          ? {}
          : { routeY: laneOriginY + (edge.routeX / EXECUTION_LANE_GAP) * SIGNAL_LANE_GAP }),
      },
    ]
  })

  const visualBounds = nodes.map((node) => node.visualBounds ?? signalNodeBounds(node))
  const minX = Math.min(0, ...visualBounds.map((bounds) => bounds.left)) - 28
  const minY = Math.min(0, ...visualBounds.map((bounds) => bounds.top)) - 32
  const maxX = Math.max(SIGNAL_ORIGIN_X, ...visualBounds.map((bounds) => bounds.right)) + 56
  const maxY = Math.max(72, ...visualBounds.map((bounds) => bounds.bottom)) + 42
  // 横向二次路由消解：走廊 y 与节点矩形同一坐标系，直接在世界纵向范围内安放。
  const columnRects = columnBuckets.map((bucket) =>
    bucket
      .map((node) => nodeById.get(node.id)?.visualBounds)
      .filter((bounds): bounds is ExecutionNodeVisualBounds => bounds !== undefined),
  )
  const corridors = resolveSignalEdgeCorridors(
    rotatedEdges,
    columnOfNode,
    columnRects,
    minY + 16,
    maxY - 16,
  )
  const edges = rotatedEdges.map((edge) =>
    corridors.has(edge.id) ? { ...edge, routeY: corridors.get(edge.id) } : edge,
  )
  return {
    ...layout,
    presentation: mode,
    nodes,
    edges,
    width: maxX - minX,
    height: maxY - minY,
    originX: -minX,
    bounds: { minX, minY, maxX, maxY },
  }
}
