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
  input: { key: 'input', glyph: '◌', accent: '#efc7ff', label: '我的指令' },
  unknown: { key: 'unknown', glyph: '?', accent: '#ff809b', label: '未识别节点' },
}

/** Every rendered execution-node kind has a read-only hover detail surface. */
export const NODE_HOVER_DETAIL_KINDS: Record<ExecutionNodeKind, true> = {
  start: true,
  message: true,
  'tool-batch': true,
  return: true,
  dispatch: true,
  system: true,
  spawn: true,
  fold: true,
  input: true,
  unknown: true,
}

export function hasNodeHoverDetail(node: ExecutionNode): boolean {
  return NODE_HOVER_DETAIL_KINDS[node.kind]
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
