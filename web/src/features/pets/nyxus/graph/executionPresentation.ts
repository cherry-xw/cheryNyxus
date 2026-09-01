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

export const SIGNAL_COLUMN_GAP = 136
export const SIGNAL_LANE_GAP = 112
export const SIGNAL_NODE_WIDTH = 92
export const SIGNAL_NODE_HEIGHT = 42
export const SIGNAL_ORIGIN_X = 76

export const SIGNAL_NODE_SIZES = {
  'hero-user': { width: 248, height: 76 },
  'hero-final': { width: 248, height: 76 },
  'hero-error': { width: 232, height: 68 },
  fold: { width: 104, height: 48 },
  process: { width: 96, height: 44 },
} as const

export type ExecutionPresentationPriority = keyof typeof SIGNAL_NODE_SIZES

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
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index]!
      if (node.actor.kind !== 'agent' || node.direction !== 'agent-to-user') continue
      const nextUser = list.slice(index + 1).find((candidate) => candidate.actor.kind === 'user')
      const laterAgent = list
        .slice(index + 1, nextUser ? list.indexOf(nextUser) : undefined)
        .some(
          (candidate) =>
            candidate.actor.kind === 'agent' &&
            candidate.direction === 'agent-to-user' &&
            candidate.sourceFact?.termination?.code !== 'error',
        )
      if (!laterAgent) finalAgentIds.add(node.id)
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
      protocolCode: protocolCode(node),
      summary: summarize(node.content),
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
 * already finished before this runs; only world coordinates and edge routing
 * corridors are rotated into a wide-screen signal bus.
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
  const rowWidths = rows.map((row) =>
    Math.max(
      ...priorityNodes
        .filter((node) => node.y === row)
        .map((node) => SIGNAL_NODE_SIZES[node.presentationPriority ?? 'process'].width),
    ),
  )
  const rowCenters: number[] = []
  rows.forEach((_, index) => {
    rowCenters[index] =
      index === 0
        ? SIGNAL_ORIGIN_X + rowWidths[index]! / 2
        : rowCenters[index - 1]! + rowWidths[index - 1]! / 2 + SIGNAL_COLUMN_GAP + rowWidths[index]! / 2
  })
  const nodes = priorityNodes
    .map((node): PositionedExecutionNode => {
      const projected = {
        ...node,
        x: rowCenters[rows.indexOf(node.y)] ?? SIGNAL_ORIGIN_X,
        y: laneOriginY + (node.x / EXECUTION_LANE_GAP) * SIGNAL_LANE_GAP,
      }
      projected.visualBounds = signalNodeBounds(projected)
      nodeById.set(projected.id, projected)
      return projected
    })
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))

  const edges = layout.edges.flatMap((edge): PositionedExecutionEdge[] => {
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
