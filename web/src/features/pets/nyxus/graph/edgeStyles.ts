import type { ExecutionEdgeKind } from './executionGraph'

export interface ExecutionEdgeStyle {
  color: string
}

const DEFAULT_EDGE_STYLE: ExecutionEdgeStyle = { color: '#8ce8ff' }
export const DETAIL_BRANCH_COLOR = '#55d9ff'

export const EXECUTION_EDGE_STYLES: Partial<Record<ExecutionEdgeKind, ExecutionEdgeStyle>> = {
  start: { color: '#ffd84d' },
  spawn: { color: '#f0a8ff' },
  dispatch: { color: '#f0a8ff' },
  return: { color: '#8dffc0' },
  'return-continuation': { color: '#8dffc0' },
  'fork-detail': { color: DETAIL_BRANCH_COLOR },
}

const LIGHT_EDGE_STYLES: Partial<Record<ExecutionEdgeKind, ExecutionEdgeStyle>> = {
  start: { color: '#a85f00' },
  spawn: { color: '#9625c9' },
  dispatch: { color: '#9625c9' },
  return: { color: '#087a49' },
  'return-continuation': { color: '#087a49' },
  'fork-detail': { color: '#007ca8' },
}
const LIGHT_DEFAULT_EDGE_STYLE: ExecutionEdgeStyle = { color: '#007ca8' }

export function edgeStyle(
  kind: ExecutionEdgeKind,
  theme: 'light' | 'dark' = 'dark',
): ExecutionEdgeStyle {
  if (theme === 'light') return LIGHT_EDGE_STYLES[kind] ?? LIGHT_DEFAULT_EDGE_STYLE
  return EXECUTION_EDGE_STYLES[kind] ?? DEFAULT_EDGE_STYLE
}
