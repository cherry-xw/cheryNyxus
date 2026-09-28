import type { useNyxusHost } from '../application/host'
import type { PositionedExecutionNode } from '../graph/executionLayout'
import type { ExecutionNode } from '../graph/executionGraph'
import { toolBatchDetail } from '../graph/toolBatchDetails'
import { skinForNode } from '../graph/nodeSkins'
import { terminationDisplay } from '../graph/termination'

/** Node labels and spoken status derived from the same rendered facts. */
export function useTreeNodeLabels({
  agents,
  runningTailIds,
  isPaused,
  isError,
}: {
  agents: ReturnType<typeof useNyxusHost>['agents']
  runningTailIds: () => Set<string>
  isPaused: (node: PositionedExecutionNode) => boolean
  isError: (node: PositionedExecutionNode) => boolean
}) {
  function actorLabel(node: ExecutionNode): string {
    const actor = node.actor
    if (actor.kind === 'user') return actor.displayName?.trim() || '我'
    if (actor.kind === 'agent') {
      return (
        actor.roleType?.trim() ||
        (node.sourceChatId === node.rootChatId ? 'Cherry Nyxus' : '协作节点')
      )
    }
    if (actor.kind === 'tool') return toolDisplayName(actor.toolName)
    return '系统事件'
  }
  function toolDisplayName(name: string): string {
    return agents.senseTools.find((tool) => tool.name === name)?.label?.trim() || name
  }
  function nodeTitle(node: ExecutionNode): string {
    if (node.kind === 'start') return '任务起点'
    if (node.kind === 'input') return '我的指令'
    if (node.kind === 'epoch') return '设置已切换'
    if (node.kind === 'pack') {
      // 打包节点标题 = 摘要首行（compactNodeTitle 统一截断）。
      const firstLine = node.content
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean)
      return firstLine ? `打包 · ${firstLine}` : '打包历史'
    }
    if (node.kind === 'return') return '结果返回'
    if (node.direction === 'parent-to-child') return '委派任务'
    if (node.kind === 'tool-batch') {
      const detail = toolBatchDetail(node)
      if (detail?.calls.length === 1) return toolDisplayName(detail.calls[0]!.name)
      return detail?.calls.length ? `工具执行 · ${detail.calls.length} 项` : '工具执行'
    }
    if (node.kind === 'fold') return skinForNode(node).label
    if (node.kind === 'dispatch') return '任务委派'
    if (node.kind === 'spawn') return '创建协作节点'
    return actorLabel(node)
  }
  function compactNodeTitle(node: ExecutionNode): string {
    const title = nodeTitle(node)
    return title.length > 10 ? `${title.slice(0, 9)}…` : title
  }
  function nodeAriaLabel(node: PositionedExecutionNode): string {
    const states = [
      runningTailIds().has(node.id) ? '运行中' : '',
      isPaused(node) ? '已暂停' : '',
      isError(node) ? '执行错误' : '',
      node.sourceFact?.termination ? terminationDisplay(node.sourceFact.termination).label : '',
    ].filter(Boolean)
    return `${nodeTitle(node)}，${skinForNode(node).label}${states.length ? `，${states.join('，')}` : ''}`
  }
  return { actorLabel, nodeTitle, compactNodeTitle, nodeAriaLabel }
}
