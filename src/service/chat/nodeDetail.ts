import type { HandlerContext } from '../message/router.js'
import type {
  ChatTimelineNodeGetRequestData,
  ChatTimelineNodeGetResponseData,
  ChatTimelineNodeToolCursor,
  GraphToolCall,
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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** JavaScript offset 仍以 UTF-16 code unit 计数，但服务端生成的页边界不拆代理对。 */
function sliceUtf16Page(text: string, offset: number, limit: number): string {
  if (offset > 0 && isLowSurrogate(text.charCodeAt(offset))) {
    throw new Error('offset 不能位于 Unicode 代理对中间')
  }
  let end = Math.min(text.length, offset + limit)
  if (end < text.length && end > offset && isHighSurrogate(text.charCodeAt(end - 1))) end++
  return text.slice(offset, end)
}

function nextToolCursor(
  calls: readonly GraphToolCall[],
  cursor: ChatTimelineNodeToolCursor,
  consumed: number,
): ChatTimelineNodeToolCursor | undefined {
  const call = calls[cursor.callIndex]
  if (!call) return undefined
  const value = cursor.field === 'arguments' ? call.arguments : call.result
  const length = typeof value === 'string' ? value.length : 0
  const nextOffset = cursor.offset + consumed
  if (nextOffset < length) return { ...cursor, offset: nextOffset }
  if (cursor.field === 'arguments' && typeof call.result === 'string') {
    return { callIndex: cursor.callIndex, field: 'result', offset: 0 }
  }
  return cursor.callIndex + 1 < calls.length
    ? { callIndex: cursor.callIndex + 1, field: 'arguments', offset: 0 }
    : undefined
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
  const sliced =
    limit !== undefined
      ? sliceUtf16Page(text, offset, limit)
      : offset > 0
        ? text.slice(offset)
        : text
  const budget = Math.min(
    remainingBudgetBytes,
    limit !== undefined ? utf8ByteLength(sliced) : Number.MAX_SAFE_INTEGER,
  )
  const result = truncateByBytes(sliced, budget)
  return {
    text: result.text,
    ref: result.truncated
      ? {
          field: '',
          contentLength: utf8ByteLength(text),
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
  const { content: _fullContent, thinking: _fullThinking, toolCalls: fullToolCalls, ...rest } = full
  const result = { ...rest } as TimelineNode & {
    content?: string
    thinking?: string
    toolCalls?: typeof fullToolCalls
  }

  const refs: Array<{ field: string; contentLength: number; contentHash: string }> = []
  let hasMore = false
  let budget = TEXT_BUDGET_BYTES

  const plans: TextFieldPlan[] = []
  if (wantContent && typeof full.content === 'string')
    plans.push({ field: 'content', value: full.content })
  if (wantThinking && typeof full.thinking === 'string')
    plans.push({ field: 'thinking', value: full.thinking })

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
      refs.push({
        field: plan.field,
        contentLength: sliced.ref.contentLength,
        contentHash: sliced.ref.contentHash,
      })
      hasMore = true
    }
    if (plan.field === 'content') result.content = sliced.text
    else (result as { thinking?: string }).thinking = sliced.text
    budget -= utf8ByteLength(sliced.text)
  }

  // 新游标路径：每页只返回一个调用的一个字符串字段。数组下标、字段与字段内
  // UTF-16 offset 均由结构化游标携带，避免大量 toolCalls 的元数据一次性入帧。
  if (wantToolCalls && data.toolCursor && Array.isArray(fullToolCalls)) {
    const cursor = data.toolCursor
    const call = fullToolCalls[cursor.callIndex]
    if (!call) {
      result.toolCalls = []
      return {
        rootChatId: data.rootChatId,
        node: result,
        refs,
        hasMore: false,
        page: { section: 'toolCalls', cursor, consumed: 0 },
      }
    }
    const source = cursor.field === 'arguments' ? call.arguments : call.result
    if (typeof source !== 'string' || cursor.offset > source.length) {
      throw new Error('toolCursor 指向了不存在的工具字段位置')
    }
    const chunk = sliceUtf16Page(source, cursor.offset, data.limit ?? 32000)
    const nextCursor = nextToolCursor(fullToolCalls, cursor, chunk.length)
    const projectedCall: GraphToolCall = {
      ...call,
      arguments: cursor.field === 'arguments' ? chunk : '',
      ...(cursor.field === 'result' ? { result: chunk } : { result: undefined }),
    }
    result.toolCalls = [projectedCall]
    if (
      nextCursor?.callIndex === cursor.callIndex &&
      nextCursor.field === cursor.field &&
      nextCursor.offset > cursor.offset
    ) {
      refs.push(contentRef(`toolCalls.${cursor.callIndex}.${cursor.field}`, source))
    }
    return {
      rootChatId: data.rootChatId,
      node: result,
      refs,
      hasMore: !!nextCursor,
      page: {
        section: 'toolCalls',
        cursor,
        consumed: chunk.length,
        ...(nextCursor ? { nextCursor } : {}),
      },
    }
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
          refs.push({
            field: `toolCalls.${key}`,
            contentLength: sliced.ref.contentLength,
            contentHash: sliced.ref.contentHash,
          })
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
