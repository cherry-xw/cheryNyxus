import {
  EXECUTION_LANE_GAP,
  type ExecutionLayout,
  type PositionedExecutionEdge,
  type PositionedExecutionNode,
} from './executionLayout'
import { toolBatchDetail } from './toolBatchDetails'

export type ExecutionPresentationMode = 'horizontal-signal' | 'vertical-classic'

export interface ExecutionNodeVisualBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export const SIGNAL_LANE_GAP = 72
/** 所有 Signal 节点统一固定尺寸（零文本徽记，2026-09-02 二轮返工）。 */
export const SIGNAL_NODE_SIZE = { width: 56, height: 40 } as const
export const SIGNAL_ORIGIN_X = 76
/** 相邻两列节点矩形之间的最小走线净距。 */
export const SIGNAL_MIN_WIRE_GAP = 64
/** 统一尺寸下的列步进：节点宽 + 净距。 */
export const SIGNAL_COLUMN_STRIDE = SIGNAL_NODE_SIZE.width + SIGNAL_MIN_WIRE_GAP

export type ExecutionPresentationPriority =
  | 'hero-user'
  | 'hero-final'
  | 'hero-error'
  | 'fold'
  | 'process'

/** tool-batch 的内建工具徽记细分（数据层判定，渲染器只消费）。 */
export type SignalToolVisualKind =
  | 'tool-command'
  | 'tool-read'
  | 'tool-write'
  | 'tool-search'
  | 'tool-skill'
  | 'tool-spawn'
  | 'tool-media'
  | 'tool-question'
  | 'tool-todo'
  | 'tool-generic'

/** Signal 节点徽记类型：基础类型 + 工具细分，每个类型一个独特 canvas 图形。 */
export type SignalNodeVisualKind =
  | 'start'
  | 'input'
  | 'reply'
  | 'error'
  | 'fold'
  | 'process'
  | 'dispatch'
  | 'return'
  | 'system'
  | SignalToolVisualKind

/** Signal 投影节点：在布局节点上附加徽记类型（2026-09-02 二轮返工）。 */
export interface PositionedSignalNode extends PositionedExecutionNode {
  visualKind: SignalNodeVisualKind
}

/** tool-batch → 内建工具徽记：按首个工具调用名关键词归类（同工具元数据命名习惯）。 */
export function toolVisualKindFor(node: PositionedExecutionNode): SignalToolVisualKind {
  const call = toolBatchDetail(node)?.calls[0]
  if (!call) return 'tool-generic'
  const name = call.name.toLowerCase()
  if (/skill/.test(name)) return 'tool-skill'
  if (/read|cat|view|open/.test(name)) return 'tool-read'
  if (/write|edit|create|mkdir|move|delete|remove/.test(name)) return 'tool-write'
  if (/search|grep|find|glob|list/.test(name)) return 'tool-search'
  if (/question|ask|input|approval/.test(name)) return 'tool-question'
  if (/spawn|dispatch|delegate|agent/.test(name)) return 'tool-spawn'
  if (/media|image|audio|video|screenshot/.test(name)) return 'tool-media'
  if (/todo|plan|task/.test(name)) return 'tool-todo'
  if (/command|exec|run|bash|shell|terminal/.test(name)) return 'tool-command'
  return 'tool-generic'
}

/** 节点 → 徽记类型：形状即类型语义（零文本原则），错误消息节点独立断框徽记。 */
export function signalVisualKindFor(
  node: PositionedExecutionNode,
  priority: ExecutionPresentationPriority,
): SignalNodeVisualKind {
  if (node.kind === 'start') return 'start'
  if (node.kind === 'fold' || node.kind === 'pack') return 'fold'
  if (node.kind === 'tool-batch') return toolVisualKindFor(node)
  if (node.kind === 'spawn' || node.kind === 'dispatch') return 'dispatch'
  if (node.kind === 'return') return 'return'
  if (node.kind === 'system') return 'system'
  if (node.kind === 'input') return 'input'
  if (priority === 'hero-error') return 'error'
  if (priority === 'hero-user') return 'input'
  if (priority === 'hero-final') return 'reply'
  return 'process'
}

/** UI-only priority projection. Canonical nodes and folding remain untouched. */
export function projectExecutionNodePriorities(
  nodes: readonly PositionedExecutionNode[],
): PositionedSignalNode[] {
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
    return {
      ...node,
      presentationPriority: priority,
      visualKind: signalVisualKindFor(node, priority),
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

/** 统一固定尺寸：所有 Signal 节点共用同一矩形（零文本徽记不再分级）。 */
function signalNodeBounds(node: Pick<PositionedExecutionNode, 'x' | 'y'>): ExecutionNodeVisualBounds {
  return {
    left: node.x - SIGNAL_NODE_SIZE.width / 2,
    top: node.y - SIGNAL_NODE_SIZE.height / 2,
    right: node.x + SIGNAL_NODE_SIZE.width / 2,
    bottom: node.y + SIGNAL_NODE_SIZE.height / 2,
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
  const nodeById = new Map<string, PositionedSignalNode>()
  const priorityNodes = projectExecutionNodePriorities(layout.nodes)
  const rows = [...new Set(priorityNodes.map((node) => node.y))].sort((a, b) => a - b)
  const rowIndexByY = new Map(rows.map((row, index) => [row, index] as const))
  // 统一固定尺寸：列心按固定步进排布（节点宽 + 走线净距），不再按节点宽度自适应。
  const rowCenters: number[] = []
  rows.forEach((_, index) => {
    rowCenters[index] =
      SIGNAL_ORIGIN_X + index * SIGNAL_COLUMN_STRIDE + SIGNAL_NODE_SIZE.width / 2
  })
  const nodes = priorityNodes
    .map((node) => {
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
