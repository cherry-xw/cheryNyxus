import type { ExecutionEdgeKind } from './executionGraph'

export interface ExecutionEdgeStyle {
  color: string
}

const DEFAULT_EDGE_STYLE: ExecutionEdgeStyle = { color: '#6bcff7' }

export const EXECUTION_EDGE_STYLES: Partial<Record<ExecutionEdgeKind, ExecutionEdgeStyle>> = {
  start: { color: '#f6c85f' },
  spawn: { color: '#e29aff' },
  dispatch: { color: '#e29aff' },
  return: { color: '#89efaf' },
  'return-continuation': { color: '#89efaf' },
}

export function edgeStyle(kind: ExecutionEdgeKind): ExecutionEdgeStyle {
  return EXECUTION_EDGE_STYLES[kind] ?? DEFAULT_EDGE_STYLE
}
