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
  start: { key: 'start', glyph: '◉', accent: '#f6c85f', label: '任务起点' },
  message: { key: 'message', glyph: '✦', accent: '#67d7ff', label: '对话内容' },
  user: { key: 'user', glyph: '●', accent: '#58d7f0', label: '我' },
  'root-agent': { key: 'root-agent', glyph: '✹', accent: '#7da7ff', label: 'Cherry Nyxus' },
  'child-agent': { key: 'child-agent', glyph: '◆', accent: '#ed79bd', label: '协作节点' },
  'tool-batch': { key: 'tool-batch', glyph: '⬡', accent: '#ffca73', label: '工具执行' },
  fold: { key: 'fold', glyph: '⋯', accent: '#9dd8ee', label: '过程组' },
  return: { key: 'return', glyph: '↩', accent: '#8bf0b1', label: '结果返回' },
  dispatch: { key: 'dispatch', glyph: '⇢', accent: '#e29aff', label: '任务委派' },
  spawn: { key: 'spawn', glyph: '⑂', accent: '#e29aff', label: '创建协作节点' },
  system: { key: 'system', glyph: '◇', accent: '#b7a7ff', label: '系统事件' },
  pack: { key: 'pack', glyph: '❒', accent: '#22d3ee', label: '打包历史' },
  input: { key: 'input', glyph: '◌', accent: '#efc7ff', label: '我的指令' },
  unknown: { key: 'unknown', glyph: '?', accent: '#ff809b', label: '未识别节点' },
}

/**
 * 浅色主题下的节点强调色（比深色版更饱和，保证浅底上可读）。
 * NODE_SKINS 的 accent 是深色树所用；浅色树换用此表。
 */
export const NODE_ACCENT_LIGHT: Record<NodeSkinKey, string> = {
  start: '#b7791f',
  message: '#0e9bb8',
  user: '#0e6f88',
  'root-agent': '#3b6fd4',
  'child-agent': '#c026d3',
  'tool-batch': '#b7791f',
  fold: '#16789a',
  return: '#1a9e6b',
  dispatch: '#7a5bd6',
  spawn: '#7a5bd6',
  system: '#6d5bd6',
  pack: '#b7791f',
  input: '#b05bd6',
  unknown: '#d6455d',
}

/** 按主题取某类节点的强调色（浅色用 NODE_ACCENT_LIGHT，否则用 NODE_SKINS 深色版）。 */
export function accentForTheme(theme: 'light' | 'dark', key: NodeSkinKey): string {
  return (theme === 'light' ? NODE_ACCENT_LIGHT[key] : NODE_SKINS[key].accent) ?? NODE_SKINS.unknown.accent
}

/** Interactive execution-node kinds that open a read-only hover detail surface.
 *  start 是纯装饰节点，不参与 hover/点击。 */
export const NODE_HOVER_DETAIL_KINDS: Partial<Record<ExecutionNodeKind, true>> = {
  message: true,
  'tool-batch': true,
  return: true,
  dispatch: true,
  system: true,
  spawn: true,
  pack: true,
  fold: true,
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
