import type { GraphToolCall, TimelineNodeDetailResponse } from '@/services/agentApi'

export type LiteDetailSectionName = 'content' | 'thinking' | 'toolCalls'

export interface LiteDetailReference {
  field: string
  contentLength: number
  contentHash: string
}

export interface LiteDetailSectionState {
  loaded: boolean
  text: string
  toolCalls: GraphToolCall[]
  offset: number
  hasMore: boolean
  refs: LiteDetailReference[]
  error: string | null
}

export interface LiteNodeDetailCache {
  content: LiteDetailSectionState
  thinking: LiteDetailSectionState
  toolCalls: LiteDetailSectionState
}

export function createLiteDetailSectionState(): LiteDetailSectionState {
  return {
    loaded: false,
    text: '',
    toolCalls: [],
    offset: 0,
    hasMore: false,
    refs: [],
    error: null,
  }
}

export function createLiteNodeDetailCache(): LiteNodeDetailCache {
  return {
    content: createLiteDetailSectionState(),
    thinking: createLiteDetailSectionState(),
    toolCalls: createLiteDetailSectionState(),
  }
}

function mergeRefs(
  current: readonly LiteDetailReference[],
  incoming: readonly LiteDetailReference[],
): LiteDetailReference[] {
  const refs = new Map(current.map((ref) => [`${ref.field}:${ref.contentHash}`, ref]))
  for (const ref of incoming) refs.set(`${ref.field}:${ref.contentHash}`, ref)
  return [...refs.values()]
}

function mergeToolCalls(
  current: readonly GraphToolCall[],
  incoming: readonly GraphToolCall[],
  append: boolean,
): GraphToolCall[] {
  if (!append) return incoming.map((call) => ({ ...call }))
  const byKey = new Map(current.map((call) => [call.callId || String(call.index), { ...call }]))
  for (const call of incoming) {
    const key = call.callId || String(call.index)
    const previous = byKey.get(key)
    byKey.set(key, {
      ...previous,
      ...call,
      arguments:
        typeof previous?.arguments === 'string' && typeof call.arguments === 'string'
          ? previous.arguments + call.arguments
          : call.arguments,
      ...(typeof call.result === 'string'
        ? {
            result:
              typeof previous?.result === 'string' ? previous.result + call.result : call.result,
          }
        : previous?.result !== undefined
          ? { result: previous.result }
          : {}),
    })
  }
  return [...byKey.values()].sort((a, b) => a.index - b.index)
}

function toolChunkLength(calls: readonly GraphToolCall[]): number {
  return calls.reduce(
    (largest, call) => Math.max(largest, call.arguments?.length ?? 0, call.result?.length ?? 0),
    0,
  )
}

/** Merge exactly one requested section so every section advances its own cursor. */
export function mergeDetailSectionPage(
  current: LiteDetailSectionState,
  section: LiteDetailSectionName,
  response: TimelineNodeDetailResponse,
  requestedOffset: number,
  requestedLimit?: number,
): LiteDetailSectionState {
  const node = response.node as TimelineNodeDetailResponse['node'] & {
    content?: string
    thinking?: string
    toolCalls?: GraphToolCall[]
  }
  const append = requestedOffset > 0
  const chunkText = section === 'content' ? (node.content ?? '') : (node.thinking ?? '')
  const incomingCalls = section === 'toolCalls' ? (node.toolCalls ?? []) : []
  const consumed = section === 'toolCalls' ? toolChunkLength(incomingCalls) : chunkText.length
  const stalled = response.hasMore && consumed === 0
  // Older node.get implementations do not set hasMore when `limit` itself
  // performed the slice. A full page is therefore treated as resumable; an
  // exact-length payload costs at most one final empty probe and never skips.
  const fullPage = requestedLimit !== undefined && consumed >= requestedLimit

  return {
    loaded: true,
    text: section === 'toolCalls' ? '' : append ? current.text + chunkText : chunkText,
    toolCalls:
      section === 'toolCalls' ? mergeToolCalls(current.toolCalls, incomingCalls, append) : [],
    offset: requestedOffset + consumed,
    hasMore: (response.hasMore || fullPage) && !stalled,
    refs: mergeRefs(append ? current.refs : [], response.refs),
    error: stalled ? '详情分页未返回新内容，请稍后重试' : null,
  }
}

export function formatDetailValue(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value ?? '')
  }
}
