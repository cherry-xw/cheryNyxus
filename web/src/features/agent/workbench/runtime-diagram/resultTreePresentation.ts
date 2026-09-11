import type { ExecutionNode } from '@/features/pets/nyxus/public'

export type ResultNodeVisualKind =
  'input' | 'message' | 'tool' | 'branch' | 'return' | 'group' | 'system'

export type ResultNodeStatusTone = 'running' | 'waiting' | 'success' | 'danger' | 'muted'

export interface ResultNodePresentation {
  visualKind: ResultNodeVisualKind
  statusText: string
  statusTone: ResultNodeStatusTone
  detail: string
  ariaLabel: string
  toolCount: number
}

function visualKind(node: ExecutionNode): ResultNodeVisualKind {
  if (node.kind === 'input' || (node.kind === 'message' && node.actor.kind === 'user'))
    return 'input'
  if (node.kind === 'message') return 'message'
  if (node.kind === 'tool-batch') return 'tool'
  if (node.kind === 'dispatch' || node.kind === 'spawn') return 'branch'
  if (node.kind === 'return') return 'return'
  if (node.kind === 'fold' || node.kind === 'pack') return 'group'
  return 'system'
}

function nodeStatus(
  node: ExecutionNode,
): Pick<ResultNodePresentation, 'statusText' | 'statusTone'> {
  if (node.status === 'revoked') return { statusText: '已撤回', statusTone: 'danger' }
  if (node.inputState === 'editing') return { statusText: '正在输入', statusTone: 'running' }
  if (node.inputState === 'pending') return { statusText: '等待接收', statusTone: 'waiting' }
  if (node.inputState === 'consuming') return { statusText: '正在接收', statusTone: 'running' }
  if (node.status === 'transient') return { statusText: '正在生成', statusTone: 'running' }
  if (node.activeRuns.some((run) => run.status === 'failed'))
    return { statusText: '执行失败', statusTone: 'danger' }
  if (node.activeRuns.some((run) => run.status === 'paused' || run.status === 'waiting'))
    return { statusText: '等待继续', statusTone: 'waiting' }
  if (node.activeRuns.some((run) => run.status === 'running'))
    return { statusText: '正在执行', statusTone: 'running' }
  return { statusText: '已记录', statusTone: 'success' }
}

function nodeDetail(node: ExecutionNode, fallback: string): string {
  const calls = node.sourceFact?.toolCalls ?? []
  if (calls.length) return [...new Set(calls.map((call) => call.name))].join('、')
  if (node.kind === 'fold') return `${node.fold?.members.length ?? 0} 个过程条目`
  if (node.kind === 'pack') return `${node.pack?.nodeCount ?? 0} 个历史节点`
  if ((node.kind === 'dispatch' || node.kind === 'spawn') && node.target?.kind === 'agent')
    return node.target.roleType || '子 Agent'
  if (node.kind === 'return' && node.actor.kind === 'agent')
    return node.actor.roleType || '子 Agent 返回'
  return fallback
}

export function presentResultNode(
  node: ExecutionNode,
  title: string,
  preview: string,
): ResultNodePresentation {
  const status = nodeStatus(node)
  const detail = nodeDetail(node, preview)
  return {
    visualKind: visualKind(node),
    ...status,
    detail,
    ariaLabel: `${title}，${status.statusText}，${detail}`,
    toolCount: node.sourceFact?.toolCalls?.length ?? 0,
  }
}

export function resultEdgeLabel(relation: string): string | undefined {
  if (relation === 'dispatch') return '派发'
  if (relation === 'spawn') return '创建协作'
  if (relation === 'return') return '返回'
  if (relation === 'return-continuation') return '汇入'
  if (relation === 'return-continuation') return '汇入'
  if (relation === 'fork' || relation.startsWith('fork-')) return '分支'
  return undefined
}
