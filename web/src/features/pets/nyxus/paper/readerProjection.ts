import type { RootTimelineSnapshot, SenseToolInfo } from '@/application/backend/public'
import { projectCoreFlowExecutionGraph } from '../graph/coreFlowProjection'
import {
  projectPersistentExecutionGraph,
  type ExecutionGraph,
  type ExecutionNode,
} from '../graph/executionGraph'
import {
  projectFoldExecutionGraph,
  projectFullFoldExecutionGraph,
  projectParticipantFoldExecutionGraph,
} from '../graph/foldProjection'
import { skinForNode, skinKeyForNode } from '../graph/nodeSkins'
import { buildPaperStack, type PaperStackEntry } from './paperStackModel'

export type NyxusReaderFoldMode = 'none' | 'partial' | 'full' | 'participant'

export interface NyxusContentSelection {
  nodeId: string
  sourceChatId: string
}

export interface NyxusResolvedSelection {
  entryId: string
  index: number
  callId?: string
}

function emptyGraph(rootChatId: string): ExecutionGraph {
  return { rootChatId, nodes: [], edges: [], diagnostics: [] }
}

/** Shared fold projection used by both the topology and the card reader. */
export function projectNyxusFoldedGraph(
  timeline: RootTimelineSnapshot | undefined,
  foldMode: NyxusReaderFoldMode,
  fallbackRootChatId = '',
): ExecutionGraph {
  if (!timeline) return emptyGraph(fallbackRootChatId)
  const graph = projectPersistentExecutionGraph(timeline)
  if (foldMode === 'none') return graph
  if (foldMode === 'full') return projectFullFoldExecutionGraph(graph).graph
  if (foldMode === 'participant') return projectParticipantFoldExecutionGraph(graph).graph
  return projectFoldExecutionGraph(graph).graph
}

/** The reader follows the active replacement chain and keeps explanatory branches readable. */
export function projectNyxusReaderGraph(
  timeline: RootTimelineSnapshot | undefined,
  foldMode: NyxusReaderFoldMode,
  fallbackRootChatId = '',
): ExecutionGraph {
  return projectCoreFlowExecutionGraph(
    projectNyxusFoldedGraph(timeline, foldMode, fallbackRootChatId),
  ).paperGraph
}

function toolName(name: string, tools: readonly SenseToolInfo[]): string {
  return tools.find((tool) => tool.name === name)?.label?.trim() || name || '工具'
}

export function nyxusReaderNodeTitle(
  node: ExecutionNode,
  tools: readonly SenseToolInfo[] = [],
): string {
  if (node.kind === 'start') return '任务起点'
  if (node.kind === 'input') return '我的指令'
  if (node.kind === 'pack') {
    const firstLine = node.content
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
    return firstLine ? `打包 · ${firstLine}` : '打包历史'
  }
  if (node.kind === 'return') return '结果返回'
  if (node.direction === 'parent-to-child') return '委派任务'
  if (node.kind === 'tool-batch') {
    const calls = node.sourceFact?.toolCalls ?? []
    if (calls.length === 1) return toolName(calls[0]!.name, tools)
    return calls.length ? `工具执行 · ${calls.length} 项` : '工具执行'
  }
  if (node.kind === 'fold') return skinForNode(node).label
  if (node.kind === 'dispatch') return '任务委派'
  if (node.kind === 'spawn') return '创建协作节点'
  if (node.actor.kind === 'user') return node.actor.displayName?.trim() || '我'
  if (node.actor.kind === 'agent') {
    return (
      node.actor.roleType?.trim() ||
      (node.sourceChatId === node.rootChatId ? 'Cherry Nyxus' : '协作节点')
    )
  }
  if (node.actor.kind === 'tool') return toolName(node.actor.toolName, tools)
  return '系统事件'
}

export function buildNyxusReaderEntries(
  graph: Readonly<ExecutionGraph>,
  tools: readonly SenseToolInfo[] = [],
): PaperStackEntry[] {
  return buildPaperStack(graph.nodes, (node) => nyxusReaderNodeTitle(node, tools))
}

function nestedNodes(node: ExecutionNode): ExecutionNode[] {
  const nodes = [node]
  for (const projected of node.fold?.projectionNodes ?? []) nodes.push(...nestedNodes(projected))
  return nodes
}

function matchSelection(
  node: ExecutionNode,
  selection: NyxusContentSelection,
): { rank: number; callId?: string } | undefined {
  const fact = node.sourceFact
  if (
    node.id === selection.nodeId ||
    fact?.id === selection.nodeId ||
    fact?.batchId === selection.nodeId
  )
    return { rank: 3 }
  if (fact?.sourceMessageId === selection.nodeId) return { rank: 2 }
  const call = fact?.toolCalls?.find((candidate) => candidate.callId === selection.nodeId)
  return call ? { rank: 1, callId: call.callId } : undefined
}

/** Resolves graph selections after message/tool visual merging and fold projection. */
export function resolveNyxusReaderSelection(
  entries: readonly PaperStackEntry[],
  selection: NyxusContentSelection | undefined,
): NyxusResolvedSelection | undefined {
  if (!selection) return undefined
  let best:
    { entryId: string; index: number; callId?: string; rank: number; scoped: boolean } | undefined
  entries.forEach((entry, index) => {
    for (const node of nestedNodes(entry.node)) {
      const match = matchSelection(node, selection)
      if (!match) continue
      const scoped = node.sourceChatId === selection.sourceChatId
      if (
        !best ||
        Number(scoped) > Number(best.scoped) ||
        (scoped === best.scoped && match.rank > best.rank)
      ) {
        best = { entryId: entry.id, index, callId: match.callId, rank: match.rank, scoped }
      }
    }
  })
  if (!best) return undefined
  return {
    entryId: best.entryId,
    index: best.index,
    ...(best.callId ? { callId: best.callId } : {}),
  }
}

/** Maps a canonical anchor to the currently rendered fold/content node. */
export function resolveNyxusRenderedNode(
  graph: Readonly<ExecutionGraph>,
  selection: NyxusContentSelection,
): { node: ExecutionNode; callId?: string } | undefined {
  const entries = graph.nodes.map((node) => ({
    id: node.id,
    node,
    title: '',
    skin: skinKeyForNode(node),
    scatter: { x: 0, y: 0, rotation: 0 },
  })) satisfies PaperStackEntry[]
  const resolved = resolveNyxusReaderSelection(entries, selection)
  if (!resolved) return undefined
  const node = graph.nodes[resolved.index]
  return node ? { node, ...(resolved.callId ? { callId: resolved.callId } : {}) } : undefined
}
