import {
  EXECUTION_LANE_GAP,
  type ExecutionLayout,
  type PositionedExecutionEdge,
  type PositionedExecutionNode,
} from './executionLayout'
import type { ExecutionNode } from './executionGraph'
import { toolBatchDetail } from './toolBatchDetails'

export type ExecutionPresentationMode = 'horizontal-signal' | 'vertical-classic'

export interface ExecutionNodeVisualBounds {
  left: number
  top: number
  right: number
  bottom: number
}

export const SIGNAL_LANE_GAP = 88
export const SIGNAL_ORIGIN_X = 76
export const SIGNAL_MIN_WIRE_GAP = 72
export const SIGNAL_ROUTE_STUB = 12
export const SIGNAL_ROUTE_CORNER_RADIUS = 8
export const SIGNAL_ROUTE_SLOT_GAP = 10

export type SignalNodeTier = 'hero' | 'structural' | 'tool'

export type SignalNodeFrameVariant =
  'signal-corners' | 'flow-rails' | 'action-split' | 'reference-notch'

export interface SignalNodeSize {
  width: number
  height: number
  icon: number
}

export const SIGNAL_NODE_SIZES: Record<SignalNodeTier, SignalNodeSize> = {
  hero: { width: 40, height: 40, icon: 24 },
  structural: { width: 40, height: 40, icon: 24 },
  tool: { width: 40, height: 40, icon: 24 },
}

/** Compatibility constants for callers that only need the smallest possible Signal stride. */
export const SIGNAL_NODE_SIZE = SIGNAL_NODE_SIZES.structural
export const SIGNAL_COLUMN_STRIDE = SIGNAL_NODE_SIZES.tool.width + SIGNAL_MIN_WIRE_GAP

export type ExecutionPresentationPriority =
  'hero-user' | 'hero-final' | 'hero-error' | 'fold' | 'process'

export const SIGNAL_TOOL_VISUAL_KINDS = [
  'tool-command',
  'tool-read',
  'tool-write',
  'tool-search',
  'tool-skill',
  'tool-spawn',
  'tool-child',
  'tool-question',
  'tool-media',
  'tool-todo',
  'tool-memory',
  'tool-config',
  'tool-navigate',
  'tool-role',
  'tool-web',
  'tool-data',
  'tool-git',
  'tool-time',
  'tool-notify',
  'tool-generic',
] as const

export type SignalToolVisualKind = (typeof SIGNAL_TOOL_VISUAL_KINDS)[number]

export const SIGNAL_NODE_VISUAL_KINDS = [
  'start',
  'input',
  'reply',
  'error',
  'fold',
  'process',
  'dispatch',
  'return',
  'system',
  ...SIGNAL_TOOL_VISUAL_KINDS,
] as const

export type SignalNodeVisualKind = (typeof SIGNAL_NODE_VISUAL_KINDS)[number]

export interface PositionedSignalNode extends PositionedExecutionNode {
  visualKind: SignalNodeVisualKind
  signalTier: SignalNodeTier
}

const HERO_KINDS = new Set<SignalNodeVisualKind>(['start', 'input', 'reply', 'error'])

const STRUCTURAL_KINDS = new Set<SignalNodeVisualKind>([
  'fold',
  'process',
  'dispatch',
  'return',
  'system',
])

const ACTION_TOOL_KINDS = new Set<SignalNodeVisualKind>([
  'tool-command',
  'tool-write',
  'tool-spawn',
  'tool-child',
  'tool-todo',
  'tool-config',
  'tool-navigate',
  'tool-git',
  'tool-time',
  'tool-notify',
])

export function signalNodeTierFor(kind: SignalNodeVisualKind): SignalNodeTier {
  if (HERO_KINDS.has(kind)) return 'hero'
  return STRUCTURAL_KINDS.has(kind) ? 'structural' : 'tool'
}

export function signalNodeSizeFor(kind: SignalNodeVisualKind): SignalNodeSize {
  return SIGNAL_NODE_SIZES[signalNodeTierFor(kind)]
}

/** Four restrained frame motifs distinguish node semantics without adding labels or changing size. */
export function signalNodeFrameVariantFor(kind: SignalNodeVisualKind): SignalNodeFrameVariant {
  if (HERO_KINDS.has(kind)) return 'signal-corners'
  if (STRUCTURAL_KINDS.has(kind)) return 'flow-rails'
  return ACTION_TOOL_KINDS.has(kind) ? 'action-split' : 'reference-notch'
}

const SIGNAL_ACCENTS_DARK: Record<SignalNodeVisualKind, string> = {
  start: '#8bf0b1',
  input: '#67d7ff',
  reply: '#8bf0b1',
  error: '#ff718c',
  fold: '#b7a7ff',
  process: '#7da7ff',
  dispatch: '#e29aff',
  return: '#8bf0b1',
  system: '#c4f06b',
  'tool-command': '#a78bfa',
  'tool-read': '#67d7ff',
  'tool-write': '#4dd4ac',
  'tool-search': '#38bdf8',
  'tool-skill': '#f472b6',
  'tool-spawn': '#e29aff',
  'tool-child': '#c084fc',
  'tool-question': '#f6c85f',
  'tool-media': '#22d3ee',
  'tool-todo': '#7da7ff',
  'tool-memory': '#b7a7ff',
  'tool-config': '#a3e635',
  'tool-navigate': '#60a5fa',
  'tool-role': '#c4f06b',
  'tool-web': '#38bdf8',
  'tool-data': '#2dd4bf',
  'tool-git': '#f472b6',
  'tool-time': '#fb923c',
  'tool-notify': '#a3e635',
  'tool-generic': '#cbd5e1',
}

const SIGNAL_ACCENTS_LIGHT: Record<SignalNodeVisualKind, string> = {
  start: '#1a8f5a',
  input: '#0e8ead',
  reply: '#1a8f5a',
  error: '#d6455d',
  fold: '#6d5bd6',
  process: '#3b6fd4',
  dispatch: '#a63cb6',
  return: '#1a8f5a',
  system: '#5c7c16',
  'tool-command': '#6d4fc2',
  'tool-read': '#087ea4',
  'tool-write': '#16886b',
  'tool-search': '#087ea4',
  'tool-skill': '#b83280',
  'tool-spawn': '#a63cb6',
  'tool-child': '#8b46b6',
  'tool-question': '#b7791f',
  'tool-media': '#0e8ead',
  'tool-todo': '#3b6fd4',
  'tool-memory': '#6d5bd6',
  'tool-config': '#5c7c16',
  'tool-navigate': '#3b6fd4',
  'tool-role': '#5c7c16',
  'tool-web': '#087ea4',
  'tool-data': '#0f8578',
  'tool-git': '#b83280',
  'tool-time': '#c46514',
  'tool-notify': '#5c7c16',
  'tool-generic': '#475569',
}

export function signalAccentForTheme(theme: 'light' | 'dark', kind: SignalNodeVisualKind): string {
  return (theme === 'light' ? SIGNAL_ACCENTS_LIGHT : SIGNAL_ACCENTS_DARK)[kind]
}

/** A Fold keeps its canonical members, so visual summaries can surface hidden failures. */
export function foldContainsErrorMessage(node: ExecutionNode): boolean {
  return (
    node.kind === 'fold' &&
    !!node.fold?.projectionNodes.some(
      (member) =>
        member.kind === 'message' && member.sourceFact?.termination?.code === 'error',
    )
  )
}

const EXACT_TOOL_KINDS: Readonly<Record<string, SignalToolVisualKind>> = {
  execute_command: 'tool-command',
  read_file: 'tool-read',
  write_file: 'tool-write',
  search_codebase: 'tool-search',
  install_skill: 'tool-skill',
  skill: 'tool-skill',
  spawn_role: 'tool-spawn',
  spawn_agent: 'tool-spawn',
  send_to_child: 'tool-child',
  stop_child: 'tool-child',
  ask_user_question: 'tool-question',
  generate_image: 'tool-media',
  generate_audio: 'tool-media',
  generate_video: 'tool-media',
  update_todo: 'tool-todo',
  memory_manage: 'tool-memory',
  history_recall: 'tool-memory',
  config_manage: 'tool-config',
  select_conversation: 'tool-navigate',
  role_acceptance: 'tool-role',
}

const TOOL_KIND_PATTERNS: ReadonlyArray<readonly [SignalToolVisualKind, RegExp]> = [
  ['tool-child', /child|send|stop/],
  ['tool-memory', /memory|note|recall|history|remember/],
  ['tool-config', /config|setting|preference/],
  ['tool-navigate', /(?:^|[_-])(navigate|session|tab|route|switch|select)(?:$|[_-])/],
  ['tool-role', /role|persona|character/],
  ['tool-skill', /skill/],
  ['tool-question', /question|ask|input|approval/],
  ['tool-spawn', /spawn|dispatch|delegate|agent/],
  ['tool-media', /media|image|audio|video|screenshot/],
  ['tool-todo', /todo|plan|task/],
  ['tool-web', /web|http|fetch|browse|crawl|url|download|upload|network|request/],
  ['tool-data', /database|sql|query|table|data|db/],
  ['tool-git', /git|commit|branch|merge|push|pull|rebase|checkout|diff/],
  ['tool-time', /timer|schedule|cron|wait|delay|sleep|timeout|remind/],
  ['tool-notify', /notify|mail|message/],
  [
    'tool-write',
    /write|edit|create|mkdir|move|delete|remove|copy|paste|rename|zip|extract|archive/,
  ],
  ['tool-read', /read|cat|view|open/],
  ['tool-search', /search|grep|find|glob|list/],
  ['tool-command', /command|exec|run|bash|shell|terminal/],
]

export function toolVisualKindFor(node: PositionedExecutionNode): SignalToolVisualKind {
  const call = toolBatchDetail(node)?.calls[0]
  if (!call) return 'tool-generic'
  const name = call.name.toLowerCase()
  const exact = EXACT_TOOL_KINDS[name]
  if (exact) return exact
  return TOOL_KIND_PATTERNS.find(([, pattern]) => pattern.test(name))?.[0] ?? 'tool-generic'
}

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
    let laterAgent = false
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const node = list[index]!
      if (node.actor.kind === 'agent' && node.direction === 'agent-to-user' && !laterAgent)
        finalAgentIds.add(node.id)
      if (node.actor.kind === 'user') laterAgent = false
      else if (
        node.actor.kind === 'agent' &&
        node.direction === 'agent-to-user' &&
        node.sourceFact?.termination?.code !== 'error'
      )
        laterAgent = true
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
    const visualKind = signalVisualKindFor(node, priority)
    return {
      ...node,
      presentationPriority: priority,
      visualKind,
      signalTier: signalNodeTierFor(visualKind),
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
  node: Pick<PositionedSignalNode, 'x' | 'y' | 'visualKind'>,
): ExecutionNodeVisualBounds {
  const size = signalNodeSizeFor(node.visualKind)
  return {
    left: node.x - size.width / 2,
    top: node.y - size.height / 2,
    right: node.x + size.width / 2,
    bottom: node.y + size.height / 2,
  }
}

function routeSignalEdges(
  edges: readonly PositionedExecutionEdge[],
  nodeById: ReadonlyMap<string, PositionedSignalNode>,
): PositionedExecutionEdge[] {
  const groups = new Map<string, PositionedExecutionEdge[]>()
  const projected = edges.flatMap((edge): PositionedExecutionEdge[] => {
    const from = nodeById.get(edge.from.id)
    const to = nodeById.get(edge.to.id)
    if (!from || !to) return []
    const next = { ...edge, from, to, routeX: undefined, routeY: undefined }
    const merge = edge.kind === 'return' || edge.kind === 'return-continuation'
    const key = `${merge ? 'to' : 'from'}:${merge ? to.id : from.id}`
    const group = groups.get(key) ?? []
    group.push(next)
    groups.set(key, group)
    return [next]
  })
  for (const group of groups.values()) {
    group.sort(
      (left, right) =>
        (left.to.orderKey ?? left.to.createdAt) - (right.to.orderKey ?? right.to.createdAt) ||
        left.id.localeCompare(right.id),
    )
    const merge = group[0]!.kind === 'return' || group[0]!.kind === 'return-continuation'
    if (group.length === 1 && group[0]!.from.y === group[0]!.to.y) continue
    const corridorStart = Math.max(...group.map((edge) => edge.from.visualBounds!.right))
    const corridorEnd = Math.min(...group.map((edge) => edge.to.visualBounds!.left))
    const room = Math.max(SIGNAL_ROUTE_STUB * 2, corridorEnd - corridorStart)
    const inset = Math.max(
      SIGNAL_ROUTE_STUB,
      Math.min(32 + Math.min(2, group.length - 1) * SIGNAL_ROUTE_SLOT_GAP, room / 2),
    )
    const routeX = merge ? corridorEnd - inset : corridorStart + inset
    for (const edge of group) edge.routeX = routeX
  }
  return projected
}

/** Pure horizontal presentation projection. Canonical topology and lanes are not modified. */
export function projectExecutionPresentation(
  layout: Readonly<ExecutionLayout>,
  mode: ExecutionPresentationMode,
): ExecutionLayout {
  if (mode === 'vertical-classic')
    return layout.presentation === mode
      ? (layout as ExecutionLayout)
      : { ...layout, presentation: mode }
  const minLane = Math.min(0, ...layout.nodes.map((node) => node.lane))
  const laneOriginY = 76 - minLane * SIGNAL_LANE_GAP
  const priorityNodes = projectExecutionNodePriorities(layout.nodes)
  const rows = [...new Set(priorityNodes.map((node) => node.y))].sort((a, b) => a - b)
  const rowIndexByY = new Map(rows.map((row, index) => [row, index] as const))
  const rowWidthByY = new Map<number, number>()
  for (const node of priorityNodes) {
    rowWidthByY.set(
      node.y,
      Math.max(rowWidthByY.get(node.y) ?? 0, signalNodeSizeFor(node.visualKind).width),
    )
  }
  const rowWidths = rows.map((row) => rowWidthByY.get(row) ?? SIGNAL_NODE_SIZES.tool.width)
  const rowCenters: number[] = []
  rows.forEach((_, index) => {
    rowCenters[index] =
      index === 0
        ? SIGNAL_ORIGIN_X + rowWidths[index]! / 2
        : rowCenters[index - 1]! +
          rowWidths[index - 1]! / 2 +
          SIGNAL_MIN_WIRE_GAP +
          rowWidths[index]! / 2
  })
  const nodeById = new Map<string, PositionedSignalNode>()
  const nodes = priorityNodes
    .map((node) => {
      const columnIndex = rowIndexByY.get(node.y)!
      const projected: PositionedSignalNode = {
        ...node,
        x: rowCenters[columnIndex] ?? SIGNAL_ORIGIN_X,
        y: laneOriginY + (node.x / EXECUTION_LANE_GAP) * SIGNAL_LANE_GAP,
      }
      projected.visualBounds = signalNodeBounds(projected)
      nodeById.set(projected.id, projected)
      return projected
    })
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))
  const routedEdges = routeSignalEdges(layout.edges, nodeById)
  const visualBounds = nodes.map((node) => node.visualBounds ?? signalNodeBounds(node))
  const routeXs = routedEdges.flatMap((edge) => (edge.routeX === undefined ? [] : [edge.routeX]))
  const minX = Math.min(0, ...visualBounds.map((bounds) => bounds.left), ...routeXs) - 36
  const minY = Math.min(0, ...visualBounds.map((bounds) => bounds.top)) - 38
  const maxX =
    Math.max(SIGNAL_ORIGIN_X, ...visualBounds.map((bounds) => bounds.right), ...routeXs) + 64
  const maxY = Math.max(76, ...visualBounds.map((bounds) => bounds.bottom)) + 48
  return {
    ...layout,
    presentation: mode,
    nodes,
    edges: routedEdges,
    width: maxX - minX,
    height: maxY - minY,
    originX: -minX,
    bounds: { minX, minY, maxX, maxY },
  }
}
