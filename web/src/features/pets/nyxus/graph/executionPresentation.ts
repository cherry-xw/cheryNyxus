import {
  EXECUTION_LANE_GAP,
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

/**
 * Pure presentation projection. The canonical topology/lane/fold layout has
 * already finished before this runs; only world coordinates and adaptive column
 * gaps are rotated into a wide-screen signal bus.
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
  // 单次分桶：每列最宽半宽，避免 O(列 × 节点) 的逐行 filter。
  const columnHalfWidths = rows.map(() => 0)
  for (const node of priorityNodes) {
    const columnIndex = rowIndexByY.get(node.y)!
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
  // 2026-09-02 二轮返工：撤除走廊二次路由，连线回退最初方案——
  // rotatedEdges 不再分配 routeY（canonical 绕行边的 routeY 映射保留），
  // horizontalExecutionEdgeGeometry 收到 routeY=undefined 后从端口直连。
  return {
    ...layout,
    presentation: mode,
    nodes,
    edges: rotatedEdges,
    width: maxX - minX,
    height: maxY - minY,
    originX: -minX,
    bounds: { minX, minY, maxX, maxY },
  }
}
