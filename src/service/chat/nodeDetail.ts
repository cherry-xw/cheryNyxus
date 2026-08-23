import type { HandlerContext } from '../message/router.js'
import type {
  ChatTimelineNodeGetRequestData,
  ChatTimelineNodeGetResponseData,
  TimelineNode,
} from '../message/types.js'
import { listExecutionNodes } from '@/db/executionGraph.js'
import { getChat } from '@/db/chat.js'
import { truncateByBytes, contentRef, utf8ByteLength } from '@/utils/boundedContent.js'

/**
 * chat.timeline.node.get（lite profile P0，canonical-timeline.md §3.6.3）。
 *
 * lean 摘要的按需全文出口：返回完整 TimelineNode（非 lean）。
 * 低频、用户触发、只读——不改变 snapshot/patch 权威性（F2：历史以 timeline 为准）。
 * 数据源 = execution_nodes 持久行（含 content/thinking/toolCalls 全文；与
 * chat.timeline.generation.get 同源）。节流位（RATE_LIMITED，D13 预留）落地时
 * 在此 handler 顶部接入。
 */

/** 单响应硬上限：32KB（docs/mcu-lite-api.md §3.5/§3.7）。 */
const MAX_RESPONSE_BYTES = 32 * 1024

/** 32KB 减去 JSON 结构/其余字段的安全余量后，正文文本的可用预算。 */
const TEXT_BUDGET_BYTES = MAX_RESPONSE_BYTES - 2048

interface TextFieldPlan {
  field: 'content' | 'thinking'
  value: string
}

/**
 * 按字节预算切分文本段：先应用请求 offset/limit（字符语义），再保证总字节 ≤ 预算。
 * 返回截断后的文本 + 引用（原文字节数与 sha256，供对账与续拉）。
 */
function sliceTextField(
  text: string,
  offset: number,
  limit: number | undefined,
  remainingBudgetBytes: number,
): { text: string; ref: { field: string; contentLength: number; contentHash: string } | null } {
  const sliced = offset > 0 || limit !== undefined ? text.slice(offset, limit !== undefined ? offset + limit : undefined) : text
  const budget = Math.min(
    remainingBudgetBytes,
    limit !== undefined ? utf8ByteLength(sliced) : Number.MAX_SAFE_INTEGER,
  )
  const result = truncateByBytes(sliced, budget)
  const originalFull = text
  return {
    text: result.text,
    ref: result.truncated
      ? {
          field: '',
          contentLength: utf8ByteLength(originalFull),
          contentHash: result.contentHash,
        }
      : null,
  }
}

export async function handleChatTimelineNodeGet(
  _ctx: HandlerContext,
  data: ChatTimelineNodeGetRequestData,
): Promise<ChatTimelineNodeGetResponseData> {
  if (!getChat(data.rootChatId)) throw new Error('这个会话不见了')
  const node = listExecutionNodes(data.rootChatId).find((row) => row.id === data.nodeId)
  if (!node) throw new Error(`节点 ${data.nodeId} 不存在`)

  const full = node as unknown as TimelineNode
  const sections = data.sections ?? ['content', 'thinking', 'toolCalls']
  const wantContent = sections.includes('content')
  const wantThinking = sections.includes('thinking')
  const wantToolCalls = sections.includes('toolCalls')
  const offset = data.offset ?? 0

  // 构建响应节点：未请求的 section 字段省略（重建对象，避免 delete 非可选字段）。
  const { content: fullContent, thinking: fullThinking, toolCalls: fullToolCalls, ...rest } = full
  const result = { ...rest } as TimelineNode & { content?: string; thinking?: string; toolCalls?: typeof fullToolCalls }

  const refs: Array<{ field: string; contentLength: number; contentHash: string }> = []
  let hasMore = false
  let budget = TEXT_BUDGET_BYTES

  const plans: TextFieldPlan[] = []
  if (wantContent && typeof full.content === 'string') plans.push({ field: 'content', value: full.content })
  if (wantThinking && typeof full.thinking === 'string') plans.push({ field: 'thinking', value: full.thinking })

  for (const plan of plans) {
    if (budget <= 0) {
      // 预算耗尽：该字段本次不返回，标记 hasMore 供续拉。
      hasMore = true
      refs.push(contentRef(plan.field, plan.value))
      if (plan.field === 'content') result.content = ''
      else (result as { thinking?: string }).thinking = ''
      continue
    }
    const sliced = sliceTextField(plan.value, offset, data.limit, budget)
    if (sliced.ref) {
      refs.push({ field: plan.field, contentLength: sliced.ref.contentLength, contentHash: sliced.ref.contentHash })
      hasMore = true
    }
    if (plan.field === 'content') result.content = sliced.text
    else (result as { thinking?: string }).thinking = sliced.text
    budget -= utf8ByteLength(sliced.text)
  }

  // toolCalls：按 call 数组整体返回（单条 arguments/result 各自按剩余预算截断附引用）。
  if (wantToolCalls && Array.isArray(full.toolCalls)) {
    const calls = full.toolCalls.map((call) => ({ ...call }))
    for (const call of calls) {
      for (const key of ['arguments', 'result'] as const) {
        const value = call[key]
        if (typeof value !== 'string' || budget <= 0) continue
        const sliced = sliceTextField(value, offset, data.limit, budget)
        if (sliced.ref) {
          refs.push({ field: `toolCalls.${key}`, contentLength: sliced.ref.contentLength, contentHash: sliced.ref.contentHash })
          hasMore = true
        }
        call[key] = sliced.text as typeof value
        budget -= utf8ByteLength(sliced.text)
      }
    }
    result.toolCalls = calls
  }

  return { rootChatId: data.rootChatId, node: result, refs, hasMore }
}
