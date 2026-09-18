import type { ExecutionNode, ExecutionNodeKind } from './executionGraph'

export type NodeSkinKey = ExecutionNodeKind | 'user' | 'root-agent' | 'child-agent'

export interface NodeSkin {
  key: NodeSkinKey
  glyph: string
  accent: string
  label: string
}

/** Internal skin registry: rendering selects semantic keys, never hardcodes a theme in graph data. */
export const NODE_SKINS: Record<NodeSkinKey, NodeSkin> = {
  start: { key: 'start', glyph: '◉', accent: '#ffd21f', label: '任务起点' },
  message: { key: 'message', glyph: '✦', accent: '#00dcff', label: '对话内容' },
  user: { key: 'user', glyph: '●', accent: '#00e5ff', label: '我' },
  'root-agent': { key: 'root-agent', glyph: '✹', accent: '#4d8dff', label: 'Cherry Nyxus' },
  'child-agent': { key: 'child-agent', glyph: '◆', accent: '#ff4fcb', label: '协作节点' },
  'tool-batch': { key: 'tool-batch', glyph: '⬡', accent: '#ffb51f', label: '工具执行' },
  fold: { key: 'fold', glyph: '⋯', accent: '#62dfff', label: '过程组' },
  return: { key: 'return', glyph: '↩', accent: '#00f59b', label: '结果返回' },
  dispatch: { key: 'dispatch', glyph: '⇢', accent: '#d867ff', label: '任务委派' },
  spawn: { key: 'spawn', glyph: '⑂', accent: '#d867ff', label: '创建协作节点' },
  system: { key: 'system', glyph: '◇', accent: '#9b7cff', label: '系统事件' },
  pack: { key: 'pack', glyph: '❒', accent: '#00e7ff', label: '旧历史' },
  epoch: { key: 'epoch', glyph: '↹', accent: '#b9f227', label: '设置已切换' },
  input: { key: 'input', glyph: '◌', accent: '#f06bff', label: '我的指令' },
  unknown: { key: 'unknown', glyph: '?', accent: '#ff4268', label: '未识别节点' },
}

/**
 * 浅色主题下的节点强调色（比深色版更饱和，保证浅底上可读）。
 * NODE_SKINS 的 accent 是深色树所用；浅色树换用此表。
 */
export const NODE_ACCENT_LIGHT: Record<NodeSkinKey, string> = {
  start: '#b88100',
  message: '#008eaa',
  user: '#007e99',
  'root-agent': '#1762e8',
  'child-agent': '#c000d8',
  'tool-batch': '#b86b00',
  fold: '#007d9f',
  return: '#008d59',
  dispatch: '#8a32df',
  spawn: '#8a32df',
  system: '#653ee0',
  pack: '#008da8',
  epoch: '#568300',
  input: '#aa20d4',
  unknown: '#d9003f',
}

/** 按主题取某类节点的强调色（浅色用 NODE_ACCENT_LIGHT，否则用 NODE_SKINS 深色版）。 */
export function accentForTheme(theme: 'light' | 'dark', key: NodeSkinKey): string {
  return (
    (theme === 'light' ? NODE_ACCENT_LIGHT[key] : NODE_SKINS[key].accent) ??
    NODE_SKINS.unknown.accent
  )
}

/** Interactive execution-node kinds that open a read-only hover detail surface.
 *  start 是纯装饰节点，不参与 hover/点击（工作台非 staticView 下另有彩蛋点击位）。
 *  epoch（设置已切换）是真实时间标记，同样需要吸附 + hover 详情。 */
export const NODE_HOVER_DETAIL_KINDS: Partial<Record<ExecutionNodeKind, true>> = {
  message: true,
  'tool-batch': true,
  return: true,
  dispatch: true,
  system: true,
  spawn: true,
  pack: true,
  fold: true,
  epoch: true,
  input: true,
  unknown: true,
}

export function hasNodeHoverDetail(node: ExecutionNode): boolean {
  return !!NODE_HOVER_DETAIL_KINDS[node.kind]
}

/** Keep click-to-pin scoped to the detail nodes that already supported that interaction. */
export function canPinNodeDetail(node: ExecutionNode): boolean {
  return (
    !!node.sourceFact?.termination ||
    node.kind === 'tool-batch' ||
    node.kind === 'fold' ||
    node.kind === 'return' ||
    node.kind === 'dispatch'
  )
}

export function skinKeyForNode(node: ExecutionNode): NodeSkinKey {
  if (node.kind !== 'message') return node.kind
  if (node.actor.kind === 'user') return 'user'
  if (node.actor.kind === 'agent') {
    return node.sourceChatId === node.rootChatId ? 'root-agent' : 'child-agent'
  }
  if (node.actor.kind === 'tool') return 'tool-batch'
  return 'system'
}

export function skinForNode(node: ExecutionNode): NodeSkin {
  return NODE_SKINS[skinKeyForNode(node)] ?? NODE_SKINS.unknown
}
