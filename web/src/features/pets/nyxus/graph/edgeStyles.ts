import type { ExecutionEdgeKind } from './executionGraph'

export interface ExecutionEdgeStyle {
  color: string
}

const DEFAULT_EDGE_STYLE: ExecutionEdgeStyle = { color: '#6bcff7' }
export const DETAIL_BRANCH_COLOR = '#38bdf8'

export const EXECUTION_EDGE_STYLES: Partial<Record<ExecutionEdgeKind, ExecutionEdgeStyle>> = {
  start: { color: '#f6c85f' },
  spawn: { color: '#e29aff' },
  dispatch: { color: '#e29aff' },
  return: { color: '#89efaf' },
  'return-continuation': { color: '#89efaf' },
  'fork-detail': { color: DETAIL_BRANCH_COLOR },
}

const LIGHT_EDGE_STYLES: Partial<Record<ExecutionEdgeKind, ExecutionEdgeStyle>> = {
  start: { color: '#92400e' },
  spawn: { color: '#7e22ce' },
  dispatch: { color: '#7e22ce' },
  return: { color: '#166534' },
  'return-continuation': { color: '#166534' },
  'fork-detail': { color: '#0369a1' },
}
const LIGHT_DEFAULT_EDGE_STYLE: ExecutionEdgeStyle = { color: '#0369a1' }

export function edgeStyle(
  kind: ExecutionEdgeKind,
  theme: 'light' | 'dark' = 'dark',
): ExecutionEdgeStyle {
  if (theme === 'light') return LIGHT_EDGE_STYLES[kind] ?? LIGHT_DEFAULT_EDGE_STYLE
  return EXECUTION_EDGE_STYLES[kind] ?? DEFAULT_EDGE_STYLE
}
