/**
 * 长会话代际分割（Generations）。
 *
 * 每次 compact（手动 `[[command:/compact]]` 与 autoCompact 统一）把 root 历史切为一代：
 * 压缩产出的摘要 assistant 消息即该代定稿边界。代际为**推导计算**——
 * 边界检测用 messages 行的 `context_compaction=1` 持久标志（autoCompact 注入的 token
 * 经 persistedContent 剥离不落库，token 扫描会漏检自动压缩），nodeCount 从
 * `execution_nodes` 按 orderKey 区间统计。无新表，每次查询现算。
 *
 * 详见 docs/multi-agent-canonical-timeline.md §3.5 与 docs/service/chat.md「长会话代际分割」。
 */
import { getChat, getMessages } from '@/db/chat.js'
import { listExecutionEdges, listExecutionNodes } from '@/db/executionGraph.js'
import { extractSummaryBlock } from '@/core/middleware/messageJournal.js'
import type { HandlerContext } from '../message/router.js'
import type {
  ChatTimelineGenerationGetRequestData,
  ChatTimelineGenerationGetResponseData,
  ExecutionEdgeFact,
  GenerationEntry,
  TimelineNode,
} from '../message/types.js'

/** summary 提取失败（空 content）时的回退截断长度 */
const SUMMARY_FALLBACK_LIMIT = 500

/** send 侧 injectCommands 触发自动压缩的未消费计数（进程内存，重启即失）。 */
const autoCompactMarks = new Map<string, number>()

/**
 * send 预检阶段（injectCommands triggered=true）记录一次自动压缩。
 * computeGenerations 从尾部消费；重启后历史重算一律 manual（trigger 为装饰性字段，不追求精确）。
 */
export function recordAutoCompactTrigger(chatId: string): void {
  autoCompactMarks.set(chatId, (autoCompactMarks.get(chatId) ?? 0) + 1)
}

function summaryOf(content: string): string {
  const summary = extractSummaryBlock(content)
  if (summary) return summary
  return content.trim().slice(0, SUMMARY_FALLBACK_LIMIT)
}

interface CompactBoundary {
  boundaryMessageId: string
  createdAt: number
  summary: string
}

/** 扫描 root chat 持久消息，收集全部 compact 定稿边界（context_compaction=1 的 assistant 行）。 */
function detectBoundaries(rootChatId: string): CompactBoundary[] {
  const boundaries: CompactBoundary[] = []
  for (const row of getMessages(rootChatId)) {
    if (row.role !== 'assistant' || row.context_compaction !== 1) continue
    boundaries.push({
      boundaryMessageId: row.id,
      createdAt: row.created_at,
      summary: summaryOf(row.content ?? ''),
    })
  }
  return boundaries
}

/** 从尾部按计数把最近的边界标为 auto（与 send 侧触发次数对齐，best-effort）。 */
function markAutoTriggers(
  rootChatId: string,
  boundaries: Array<CompactBoundary & { trigger: 'manual' | 'auto' }>,
): void {
  let budget = autoCompactMarks.get(rootChatId) ?? 0
  autoCompactMarks.delete(rootChatId)
  for (let i = boundaries.length - 1; i >= 0 && budget > 0; i -= 1) {
    boundaries[i]!.trigger = 'auto'
    budget -= 1
  }
}

/**
 * 推导 root chat 的代际索引。区间为 (fromOrderKey, boundaryOrderKey]；
 * boundaryNodeId 取边界消息对应节点（消息 id 即节点 id），消息未成节点时回退区间内最后一个节点。
 */
export function computeGenerations(rootChatId: string): GenerationEntry[] {
  const boundaries = detectBoundaries(rootChatId)
  if (boundaries.length === 0) return []
  const nodes = listExecutionNodes(rootChatId)
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const marked: Array<CompactBoundary & { trigger: 'manual' | 'auto' }> = boundaries.map(
    (boundary) => ({ ...boundary, trigger: 'manual' as const }),
  )
  markAutoTriggers(rootChatId, marked)

  const entries: GenerationEntry[] = []
  let fromOrderKey = 0
  for (let i = 0; i < marked.length; i += 1) {
    const boundary = marked[i]!
    const nextAnchor = marked
      .slice(i + 1)
      .map((item) => nodeById.get(item.boundaryMessageId))
      .find(Boolean)
    const upperBound = nextAnchor ? nextAnchor.orderKey : Number.POSITIVE_INFINITY
    const own = nodeById.get(boundary.boundaryMessageId)
    let boundaryNodeId: string | undefined
    let boundaryOrderKey: number | undefined
    if (own) {
      boundaryNodeId = own.id
      boundaryOrderKey = own.orderKey
    } else {
      // 边界消息未成节点（被过滤等）：回退取区间内最后一个节点
      const fallback = nodes.findLast(
        (node) => node.orderKey > fromOrderKey && node.orderKey < upperBound,
      )
      if (fallback) {
        boundaryNodeId = fallback.id
        boundaryOrderKey = fallback.orderKey
      }
    }
    // 边界完全无法定位到任何节点（图尚未构建）：跳过该代，不推进 fromOrderKey
    if (boundaryNodeId === undefined || boundaryOrderKey === undefined) continue
    entries.push({
      index: entries.length + 1,
      boundaryMessageId: boundary.boundaryMessageId,
      boundaryNodeId,
      boundaryOrderKey,
      fromOrderKey,
      summary: boundary.summary,
      nodeCount: nodes.filter(
        (node) => node.orderKey > fromOrderKey && node.orderKey <= boundaryOrderKey,
      ).length,
      createdAt: boundary.createdAt,
      trigger: boundary.trigger,
    })
    fromOrderKey = boundaryOrderKey
  }
  return entries
}

/**
 * timeline 代际窗口下界：默认完整展示两代（当前代 + 上一代）。
 * 不足两代（0/1 次 compact）返回 0 = 全量。
 */
export function generationWindowFloor(generations: GenerationEntry[]): number {
  return generations.length >= 2 ? generations[generations.length - 2]!.boundaryOrderKey : 0
}

/**
 * computeGenerations → system prompt `<history_generations>` 段注入用的最小投影
 * （结构兼容 agent/prompt HistoryGenerationInfo；agent 层不依赖 service 类型，此处结构化对齐）。
 * ensureChat / contextUsage / promptSnapshot 共用，保证 init 计量与快照一致。
 */
export function computeHistoryGenerationInfos(chatId: string): Array<{
  index: number
  summary: string
  nodeCount: number
  createdAt: number
  trigger: 'manual' | 'auto'
}> {
  return computeGenerations(chatId).map((gen) => ({
    index: gen.index,
    summary: gen.summary,
    nodeCount: gen.nodeCount,
    createdAt: gen.createdAt,
    trigger: gen.trigger,
  }))
}

/**
 * anchor 节点是否属已打包代（非当前代）。generations 为空返回 false（不限制）；
 * 节点不存在返回 false（交由既有 eligible 校验给出通用原因）。
 */
export function isNodeInPackedGeneration(rootChatId: string, nodeId: string): boolean {
  const generations = computeGenerations(rootChatId)
  const last = generations.at(-1)
  if (!last) return false
  const node = listExecutionNodes(rootChatId).find((item) => item.id === nodeId)
  if (!node) return false
  return node.orderKey <= last.boundaryOrderKey
}

/**
 * 按需拉取单个已打包代际的完整图：直接按 orderKey 区间读持久事实，
 * 不重跑 buildRootTimeline（不触发回填），edges 两端均在区间内。
 */
export async function handleChatTimelineGenerationGet(
  _ctx: HandlerContext,
  data: ChatTimelineGenerationGetRequestData,
): Promise<ChatTimelineGenerationGetResponseData> {
  if (!getChat(data.rootChatId)) throw new Error('这个会话不见了')
  const generation = computeGenerations(data.rootChatId).find(
    (entry) => entry.index === data.generationIndex,
  )
  if (!generation) throw new Error(`代际 ${data.generationIndex} 不存在`)
  const nodes = listExecutionNodes(data.rootChatId).filter(
    (node) =>
      node.orderKey > generation.fromOrderKey && node.orderKey <= generation.boundaryOrderKey,
  )
  const nodeIds = new Set(nodes.map((node) => node.id))
  const edges = listExecutionEdges(data.rootChatId).filter(
    (edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId),
  )
  return {
    rootChatId: data.rootChatId,
    generation,
    nodes: nodes as unknown as TimelineNode[],
    edges: edges as unknown as ExecutionEdgeFact[],
  }
}
