/**
 * Anthropic Provider（适配 Anthropic Messages API，原生 fetch）。
 *
 * 三层 adapter：
 * - LLM：POST {url}/messages（url 拼接规则见 docs/backend/agent/provider.md「URL 解析与端点拼接」：版本段 /v1 由用户填写、后端只拼 /messages；fullUrl=true 完全不拼接），header x-api-key + anthropic-version + content-type
 * - Message：buildMessages 返回 {system, messages} 元组（system 顶层分离）；content/thinking 来自 content blocks
 * - Sense：tool_use → {id, name, arguments:JSON.stringify(input)}；流式 delta 经 SenseCallAssembler 累积
 *
 * 复用：
 * - fetchBase.ts: assertChatOptions/brainHttpError/brainNetworkError/readErrorSnippet（provider 无关）
 * - openaiCompat.ts: acquireRpm
 * - compiler/utils.ts: buildBaseSenseFunction
 * - hooks/dispatch.ts: dispatch('PreLLMRequest', ...) 触发用户 hook 改写 body（thinking 适配）
 *
 * 不可复用 fetchBase 的 jsonRequest/streamSSE（硬编码 /chat/completions + Bearer + [DONE]）。
 *
 * 详见 [docs/backend/agent/provider.md](../../../docs/backend/agent/provider.md) + [docs/backend/agent/hooks.md](../../../docs/backend/agent/hooks.md)。
 */
import type { SenseFunction } from '@/core/sense'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter'
import { registerProviderUrlPattern } from '@/core/llm/urlPattern'
import {
  registerMessageAdapter,
  groupAttachmentsByMessage,
  orderedMessageInputs,
  type BuildMessagesOptions,
  type LLMResponse,
  type LLMAttachment,
  type MessageProviderAdapterConfig,
  type ServerToolCallDelta,
  type ServerToolCallInfo,
  type ServerToolSource,
  type ThinkingBlock,
  type ThinkingBlockDelta,
} from '@/core/message/adapter'
import {
  registerSenseAdapter,
  type Sense,
  type SenseCallData,
  type SenseAdapter,
} from '@/core/sense'
import type { ZodType } from 'zod'
import { buildBaseSenseFunction } from '@/core/sense/compiler/utils.js'
import {
  assertChatOptions,
  brainEmptyStream,
  brainHttpError,
  brainInvalidStream,
  brainNetworkError,
  resolveProviderUrl,
  readErrorSnippet,
} from './fetchBase.js'
import { acquireRpm } from './openaiCompat.js'
import { applyProtocolHook } from './protocolHook.js'
import { LlmProtocol } from '@chery/protocol'

// ========== 常量 ==========

export const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_DEFAULT_MAX_TOKENS = 16384

// ========== Anthropic 类型（局部定义，不引第三方 SDK）============

/** Anthropic content block 联合
 *  thinking 块的 signature 是扩展思考协议强制要求（多轮回传时 API 校验）；
 *  本地类型标为可选以兼容 legacy/手动构造数据（缺 signature 的 block 上传 API 必 400）。
 *  redacted_thinking 块 data 是不透明字符串，按 Anthropic 规定原样回传。 */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'server_tool_use'; id: string; name: string; input?: Record<string, unknown> }
  | {
      type: 'tool_result'
      tool_use_id: string
      content?: string | AnthropicContentBlock[] | unknown
      is_error?: boolean
    }
  | {
      type: 'web_search_tool_result'
      tool_use_id: string
      content?: unknown
      is_error?: boolean
    }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }

const SENSITIVE_URL_QUERY_KEY = /^(token|signature|sig|sign|x-(?:amz|goog|oss|tos)-[a-z0-9-]+|access_token|api_key|key|secret|auth|auth_key|awsaccesskeyid|ossaccesskeyid|key-pair-id|policy)$/i
const SENSITIVE_FIELD = /^(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|token|password|secret|cookie|set-cookie|signature|sig)$/i

export function sanitizeDisplayUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    let modified = false
    if (parsed.username || parsed.password) {
      parsed.username = '[REDACTED]'
      parsed.password = ''
      modified = true
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_QUERY_KEY.test(key)) {
        parsed.searchParams.set(key, '[REDACTED]')
        modified = true
      }
    }
    return modified ? parsed.toString() : rawUrl
  } catch {
    return rawUrl
  }
}

export function sanitizeServerToolArgs(input: Record<string, unknown> | undefined): string {
  if (!input || typeof input !== 'object') return '{}'
  return JSON.stringify(sanitizeServerToolValue(input))
}

function sanitizeServerToolValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeServerToolText(value)
  if (Array.isArray(value)) return value.map(sanitizeServerToolValue)
  if (!value || typeof value !== 'object') return value
  const isBase64 = 'type' in value && value.type === 'base64'
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key, SENSITIVE_FIELD.test(key) || (isBase64 && key === 'data')
      ? '[REDACTED]' : sanitizeServerToolValue(entry),
  ]))
}

export function sanitizeServerToolText(text: string): string {
  if (/^[\s]*[\[{]/.test(text)) {
    try {
      const parsed: unknown = JSON.parse(text)
      const clean = sanitizeServerToolValue(parsed)
      return JSON.stringify(parsed) === JSON.stringify(clean) ? text : JSON.stringify(clean)
    } catch {
      // 不完整参数仍需去除已经收到的凭据。
    }
  }
  return text
    .replace(/data:[^\s"'<>]*?;base64,[a-z0-9+/=]+/gi, (value) => `${value.slice(0, value.indexOf(';base64,') + 8)}[REDACTED]`)
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, sanitizeDisplayUrl)
    .replace(/("(?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|token|password|secret|cookie|signature|sig)"\s*:\s*")[^"\r\n]*/gi, '$1[REDACTED]')
}

function extractSourcesFromParsed(value: unknown, out: ServerToolSource[]): void {
  if (Array.isArray(value)) {
    for (const item of value) extractSourcesFromParsed(item, out)
    return
  }
  if (!value || typeof value !== 'object') return
  const rec = value as Record<string, unknown>
  const rawUrl = typeof rec.url === 'string' ? rec.url : typeof rec.link === 'string' ? rec.link : undefined
  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    out.push({
      url: sanitizeDisplayUrl(rawUrl),
      ...(typeof rec.title === 'string' && rec.title ? { title: sanitizeServerToolText(rec.title) } : {}),
      ...(typeof rec.content === 'string' && rec.content
        ? { snippet: sanitizeServerToolText(rec.content).slice(0, 240) }
        : typeof rec.snippet === 'string' && rec.snippet
          ? { snippet: sanitizeServerToolText(rec.snippet).slice(0, 240) }
          : {}),
      ...(typeof rec.refer === 'string' && rec.refer ? { refer: sanitizeServerToolText(rec.refer) } : {}),
    })
  }
  for (const entry of Object.values(rec)) {
    if (typeof entry === 'object') extractSourcesFromParsed(entry, out)
    else if (typeof entry === 'string' && /^[\s]*[\[{]/.test(entry)) {
      try { extractSourcesFromParsed(JSON.parse(entry), out) } catch { /* 普通文字不是来源结构。 */ }
    }
  }
}

export function formatAnthropicServerToolResult(content: unknown): {
  text: string
  sources?: ServerToolSource[]
  error?: string
} {
  const isToolError = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(isToolError)
    return !!value && typeof value === 'object' && 'type' in value &&
      typeof value.type === 'string' && value.type.endsWith('_tool_result_error')
  }
  if (isToolError(content)) {
    const text = sanitizeServerToolText(JSON.stringify(content))
    return { text, error: text }
  }
  const sources: ServerToolSource[] = []
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if ((trimmed.startsWith('[') || trimmed.startsWith('{')) && trimmed.length > 1) {
      try {
        const parsed = JSON.parse(trimmed)
        extractSourcesFromParsed(parsed, sources)
      } catch {
        // Not valid JSON, keep as plain string
      }
    }
    return {
      text: sanitizeServerToolText(content),
      ...(sources.length > 0 ? { sources } : {}),
    }
  }
  if (Array.isArray(content)) {
    extractSourcesFromParsed(content, sources)
    const textParts: string[] = []
    for (const item of content) {
      if (item && typeof item === 'object' && 'type' in item) {
        const block = item as { type?: string; text?: string; title?: string; url?: string }
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text)
        } else {
          textParts.push(JSON.stringify(item))
        }
      } else if (typeof item === 'string') {
        textParts.push(item)
      } else {
        textParts.push(JSON.stringify(item))
      }
    }
    return {
      text: textParts.map(sanitizeServerToolText).join('\n'),
      ...(sources.length > 0 ? { sources } : {}),
    }
  }
  if (content !== undefined && content !== null) {
    extractSourcesFromParsed(content, sources)
    return {
      text: sanitizeServerToolText(JSON.stringify(content)),
      ...(sources.length > 0 ? { sources } : {}),
    }
  }
  return { text: '' }
}

/** Anthropic message */
interface AnthropicMsg {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[] | string
}

/** Anthropic 顶层请求体。带 index signature 以直传 thinkingParams 片段（thinking/output_config 等
 *  协议字段由 model-catalog wire 声明，provider 不内置映射）。 */
interface AnthropicBody {
  [key: string]: unknown
  model: string
  max_tokens: number
  system?: string
  messages: AnthropicMsg[]
  tools?: AnthropicTool[]
  thinking?: { type: 'adaptive' | 'enabled' | 'disabled' }
  output_config?: { effort: 'low' | 'medium' | 'high' | 'max' }
  stream?: boolean
}

/** Anthropic tool 定义（普通工具或内置服务端工具如 web_search_20250305） */
interface AnthropicTool {
  type?: string
  name: string
  description?: string
  input_schema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
  max_uses?: number
}

/** Anthropic 非流式响应 */
interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  stop_reason: string | null
  usage: { input_tokens: number; output_tokens: number }
}

/** Anthropic SSE event 联合 */
type AnthropicSSEEvent =
  | { type: 'message_start'; message: AnthropicResponse }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: AnthropicDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      delta: { stop_reason: string | null }
      usage: { output_tokens: number }
    }
  | { type: 'message_stop' }
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } }

/** Anthropic content_block_delta 的 delta 类型 */
type AnthropicDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'signature_delta'; signature: string }

/** buildMessages 返回值：system 顶层分离 + messages（不含 system）*/
interface AnthropicSplitResult {
  system: string | null
  messages: AnthropicMsg[]
}

// ========== Message Adapter ==========

const anthropicMessageAdapterConfig = {
  content: (raw: AnthropicResponse) =>
    raw.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(''),

  thinking: (raw: AnthropicResponse) => {
    const parts = raw.content
      .filter((b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking')
      .map((b) => b.thinking)
    return parts.length > 0 ? parts.join('') : undefined
  },

  /** 完整 thinking blocks（含 signature / redacted_thinking）；Anthropic 扩展回传用。 */
  thinkingBlocks: (raw: AnthropicResponse): ThinkingBlock[] | undefined => {
    const blocks: ThinkingBlock[] = []
    for (const b of raw.content) {
      if (b.type === 'thinking') {
        blocks.push({ type: 'thinking', thinking: b.thinking, signature: b.signature ?? '' })
      } else if (b.type === 'redacted_thinking') {
        blocks.push({ type: 'redacted_thinking', data: b.data })
      }
    }
    return blocks.length > 0 ? blocks : undefined
  },

  stopReason: (raw: AnthropicResponse): string | undefined => raw.stop_reason ?? undefined,

  serverToolCalls: (raw: AnthropicResponse): ServerToolCallInfo[] | undefined => {
    const calls = new Map<string, ServerToolCallInfo>()
    const orphans: ServerToolCallInfo[] = []
    for (const [index, b] of raw.content.entries()) {
      if (b.type === 'server_tool_use') {
        const call: ServerToolCallInfo = {
          id: b.id,
          name: b.name,
          arguments: sanitizeServerToolArgs(b.input),
          executionOwner: 'server',
          status: 'started',
          protocol: 'anthropic-messages',
          responseId: raw.id,
          index,
        }
        calls.set(b.id, call)
      } else if (b.type === 'tool_result' || b.type === 'web_search_tool_result') {
        const formatted = formatAnthropicServerToolResult(b.content)
        const failed = b.is_error || formatted.error !== undefined
        const existing = calls.get(b.tool_use_id)
        if (existing) {
          existing.status = failed ? 'failed' : 'completed'
          existing.result = formatted.text
          if (failed) existing.error = formatted.text
          if (formatted.sources && formatted.sources.length > 0) {
            existing.sources = formatted.sources
          }
        } else {
          orphans.push({
            id: b.tool_use_id || `orphan-${index}`,
            name: b.type === 'web_search_tool_result' ? 'web_search' : 'server_tool',
            arguments: '{}',
            executionOwner: 'server',
            status: failed ? 'failed' : 'unknown',
            result: formatted.text,
            ...(failed ? { error: formatted.text } : {}),
            ...(formatted.sources && formatted.sources.length > 0
              ? { sources: formatted.sources }
              : {}),
            protocol: 'anthropic-messages',
            responseId: raw.id,
            index,
          })
        }
      }
    }
    const all = [...calls.values(), ...orphans]
    return all.length > 0 ? all : undefined
  },

  extractStreamStopReason: (chunk: AnthropicSSEEvent): string | undefined => {
    if (chunk.type === 'message_delta' && chunk.delta.stop_reason) {
      return chunk.delta.stop_reason
    }
    return undefined
  },

  extractStreamServerToolDeltas: (chunk: AnthropicSSEEvent): ServerToolCallDelta[] | undefined => {
    const tagged = chunk as AnthropicSSEEvent & { _blockType?: string }
    if (chunk.type === 'content_block_start') {
      const cb = chunk.content_block
      if (cb.type === 'server_tool_use') {
        const hasInitialInput = cb.input && Object.keys(cb.input).length > 0
        return [
          {
            kind: 'start',
            index: chunk.index,
            id: cb.id,
            name: cb.name,
            arguments: hasInitialInput ? sanitizeServerToolArgs(cb.input) : '',
            status: 'started',
            protocol: 'anthropic-messages',
          },
        ]
      }
      if (cb.type === 'tool_result' || cb.type === 'web_search_tool_result') {
        const formatted = formatAnthropicServerToolResult(cb.content)
        const failed = cb.is_error || formatted.error !== undefined
        return [
          {
            kind: 'result',
            index: chunk.index,
            callId: cb.tool_use_id,
            ...(cb.type === 'web_search_tool_result' ? { name: 'web_search' } : {}),
            result: formatted.text,
            ...(failed ? { error: formatted.text } : {}),
            status: failed ? 'failed' : 'completed',
            ...(formatted.sources && formatted.sources.length > 0
              ? { sources: formatted.sources }
              : {}),
          },
        ]
      }
    }
    if (
      chunk.type === 'content_block_delta' &&
      chunk.delta.type === 'input_json_delta' &&
      tagged._blockType === 'server_tool_use'
    ) {
      return [
        {
          kind: 'arguments_delta',
          index: chunk.index,
          argumentsDelta: chunk.delta.partial_json,
        },
      ]
    }
    return undefined
  },

  extractStreamDelta: (chunk: AnthropicSSEEvent): string => {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      return chunk.delta.text
    }
    return ''
  },

  extractStreamThinking: (chunk: AnthropicSSEEvent): string | undefined => {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'thinking_delta') {
      return chunk.delta.thinking
    }
    return undefined
  },

  /** 流式 thinking 增量翻译 — mirror extractSenseCallDeltas 形态
   *  返回该 chunk 触发的 ThinkingBlockDelta[]，由 middleware ThinkingBlockAssembler 聚合。 */
  extractStreamThinkingBlocks: (chunk: AnthropicSSEEvent): ThinkingBlockDelta[] => {
    if (chunk.type === 'content_block_start') {
      const cb = chunk.content_block
      if (cb.type === 'thinking') {
        return [{ kind: 'start', index: chunk.index, type: 'thinking' }]
      }
      if (cb.type === 'redacted_thinking') {
        return [{ kind: 'start', index: chunk.index, type: 'redacted_thinking' }]
      }
      return []
    }
    if (chunk.type === 'content_block_delta') {
      const d = chunk.delta
      if (d.type === 'thinking_delta') {
        return [{ kind: 'text', index: chunk.index, text: d.thinking }]
      }
      if (d.type === 'signature_delta') {
        return [{ kind: 'signature', index: chunk.index, signature: d.signature }]
      }
      return []
    }
    if (chunk.type === 'content_block_stop') {
      return [{ kind: 'stop', index: chunk.index }]
    }
    return []
  },

  /**
   * 把 LLMResponse[] + 可选 attachments 转换为 Anthropic 格式：
   * - 抽 role:'system' → 顶层 system（多条 \n\n 拼接）
   * - ensureAlternatingUserFirst：role:'role'/'subagent'→'user'；首条非 user 插入 '（继续）'；连续同 role 合并
   * - revoked 过滤
   * - sense → role:'user' + tool_result block（嵌 user 消息）
   * - assistant 带 senseCalls → content blocks: [thinking?, text?, tool_use...]
   * - user+image attachments → 多模态 blocks
   *
   * 返回元组（不是数组）：Anthropic system 顶层字段；messages 只剩 user/assistant
   */
  buildMessages: (
    history: LLMResponse[],
    attachments?: LLMAttachment[],
    buildOptions?: BuildMessagesOptions,
  ): AnthropicSplitResult => {
    let system: string | null = null
    const filtered: LLMResponse[] = []

    for (const m of history) {
      if (m.revoked) continue
      if (m.role === 'system') {
        system = system ? `${system}\n\n${m.content}` : m.content
        continue
      }
      filtered.push(m)
    }

    const normalized = ensureAlternatingUserFirst(filtered)
    const official = buildOptions?.anthropicOfficial === true
    const lastUser = [...normalized].reverse().find((m) => m.role === 'user')
    const attachmentsByMessage = groupAttachmentsByMessage(attachments, lastUser?.id)
    const unmerged = normalized.map((m) =>
      buildAnthropicMessage(m, attachmentsByMessage.get(m.id), {
        official,
        includeReasoning: buildOptions?.reasoningHistory !== 'omit',
      }),
    )
    const messages: AnthropicMsg[] = []
    for (const message of unmerged) {
      const previous = messages.at(-1)
      if (previous?.role === message.role) {
        const blocks = (value: AnthropicMsg['content']): AnthropicContentBlock[] => typeof value === 'string' ? [{ type: 'text', text: value }] : value
        previous.content = [...blocks(previous.content), ...blocks(message.content)]
      } else messages.push(message)
    }
    return { system, messages }
  },
}

/** role 归一 + 强制首条 user + 合并连续同 role */
function ensureAlternatingUserFirst(history: LLMResponse[]): LLMResponse[] {
  if (history.length === 0) return history

  // role 归一（subagent/role → user；system 已在 buildMessages 抽走）
  const norm = history.map((m) => {
    if (m.role === 'subagent' || m.role === 'role') {
      return { ...m, role: 'user' as const }
    }
    return m
  })

  // 首条非 user 插入合成 user（Anthropic 拒非 user 首条）
  if (norm[0]!.role !== 'user') {
    norm.unshift({
      id: '_synthetic_continue',
      role: 'user',
      content: '（继续）',
      createdAt: Date.now(),
      updateAt: Date.now(),
    })
  }

  // 连续同 role 合并 content（Anthropic 拒非交替）
  return norm
}

/** 把 LLMResponse 上的 thinking 块原样 emit 到 Anthropic content blocks
 *  优先 m.thinkingBlocks（完整块含 signature）；无则降级用 m.thinking 字符串
 *  （legacy 回退，Anthropic 会拒 400 — 文档化为已知限制）。
 *
 *  options?.official=false（默认）时 strip redacted_thinking 块，
 *  兼容第三方 Anthropic 模式端点（coding-plan 代理通常不实现 redacted_thinking）。 */
function pushThinkingBlocks(
  blocks: AnthropicContentBlock[],
  m: LLMResponse,
  options?: { official?: boolean; includeReasoning?: boolean },
): void {
  if (options?.includeReasoning === false) return
  if (m.thinkingBlocks && m.thinkingBlocks.length > 0) {
    for (const tb of m.thinkingBlocks) {
      if (tb.type === 'thinking') {
        blocks.push({
          type: 'thinking',
          thinking: tb.thinking,
          ...(tb.signature ? { signature: tb.signature } : {}),
        })
      } else if (tb.type === 'redacted_thinking') {
        // 非官方 Anthropic：strip redacted_thinking（3rd-party 端点不支持）
        if (options?.official === true) {
          blocks.push({ type: 'redacted_thinking', data: tb.data })
        }
      }
    }
    return
  }
  if (m.thinking) {
    blocks.push({ type: 'thinking', thinking: m.thinking })
  }
}

/** 单条 LLMResponse → Anthropic message */
function buildAnthropicMessage(
  m: LLMResponse,
  attachments?: LLMAttachment[],
  buildOptions?: { official?: boolean; includeReasoning?: boolean },
): AnthropicMsg {
  // case 1: sense → user 消息含 tool_result block
  if (m.role === 'sense') {
    const content = m.replace?.state ? m.replace.content : m.content
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.id ?? '',
          content,
        },
      ],
    }
  }

  // case 2: assistant 带 senseCalls → content blocks
  const localSenseCalls = (m.senseCalls ?? []).filter(
    (sc) => sc.executionOwner !== 'server' && sc.serverState !== 'skipped-local',
  )
  if (m.role === 'assistant' && localSenseCalls.length > 0) {
    const blocks: AnthropicContentBlock[] = []
    // thinking 必须在 text/tool_use 之前（Anthropic 约束）
    pushThinkingBlocks(blocks, m, buildOptions)
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const sc of localSenseCalls) {
      let input: Record<string, unknown> = {}
      if (sc.arguments) {
        try {
          input = JSON.parse(sc.arguments) as Record<string, unknown>
        } catch {
          input = {}
        }
      }
      blocks.push({
        type: 'tool_use',
        id: sc.id,
        name: sc.name ?? '',
        input,
      })
    }
    return { role: 'assistant', content: blocks }
  }

  // case 3: assistant 无 senseCalls → [thinking?, text?]
  if (m.role === 'assistant') {
    const blocks: AnthropicContentBlock[] = []
    pushThinkingBlocks(blocks, m, buildOptions)
    if (m.content) blocks.push({ type: 'text', text: m.content })
    // 全空时用 [{text:''}] 兜底（Anthropic 拒空 content）
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
    return { role: 'assistant', content: blocks }
  }

  // case 4: user + image attachments → 多模态
  if (m.role === 'user' && attachments && attachments.length > 0) {
    const blocks: AnthropicContentBlock[] = []
    for (const segment of orderedMessageInputs(m, attachments)) {
      if (segment.type === 'text') { blocks.push({ type: 'text', text: segment.text }); continue }
      const att = segment.attachment
      if (att.mimeType === 'application/pdf') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.data.toString('base64') } })
        continue
      }
      if (att.mimeType.startsWith('image/')) {
        blocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: att.mimeType,
            data: att.data.toString('base64'),
          },
        })
      }
      // video/audio：Anthropic 不原生支持 → chat.ts enrichMediaInputs 旧路径已文本转写
    }
    return { role: 'user', content: blocks }
  }

  // case 5: 普通 user
  return { role: 'user', content: [{ type: 'text', text: m.content }] }
}

// ========== Sense Adapter ==========

const anthropicSenseAdapterConfig: SenseAdapter<AnthropicResponse> = {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[] {
    // 返回 OpenAI 形状（接口契约）；chat() 内 transformSensesToAnthropic 转
    return senses.map((s) => ({
      type: 'function',
      function: buildBaseSenseFunction(s),
    })) as unknown as SenseFunction[]
  },

  senseCalls(response: AnthropicResponse): SenseCallData[] {
    return response.content
      .filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
          b.type === 'tool_use',
      )
      .map((b, index) => ({
        index,
        id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      }))
  },

  /**
   * 流式 sense delta：
   * - content_block_start(tool_use)：播种 {index, id, name, arguments:''}
   * - content_block_delta(input_json_delta)：累加 {index, arguments:partial_json}（id 占位）
   * - 其它事件：返回 []
   */
  extractSenseCallDeltas(chunk: unknown): SenseCallData[] {
    const ev = chunk as AnthropicSSEEvent & { _blockType?: string }
    switch (ev.type) {
      case 'content_block_start': {
        const cb = ev.content_block
        if (cb.type !== 'tool_use') return []
        const hasInitialInput = cb.input && Object.keys(cb.input).length > 0
        return [
          {
            index: ev.index,
            id: cb.id,
            name: cb.name,
            arguments: hasInitialInput ? JSON.stringify(cb.input) : '',
          },
        ]
      }
      case 'content_block_delta': {
        if (ev.delta.type !== 'input_json_delta') return []
        // 若已知该 block 是 server_tool_use 等非本地 tool_use，不得混入本地 senseDelta
        if (ev._blockType && ev._blockType !== 'tool_use') return []
        return [
          {
            index: ev.index,
            id: `sense-${ev.index}`, // 占位：Assembler 取首非空 id 不覆盖
            name: undefined, // 不传：Assembler 不覆盖 name
            arguments: ev.delta.partial_json,
          },
        ]
      }
      default:
        return []
    }
  },
}

function isGlmModel(model: string): boolean {
  return /(?:^|[/_.:-])glm[-_.]?\d/i.test(model)
}

/** OpenAI 形状 → Anthropic tool 形状（chat() 内调用）。
 *  若当前模型为 GLM Messages 且角色开启了 web_search，转换或保留服务端搜索声明 web_search_20250305。 */
function transformSensesToAnthropic(senses: SenseFunction[], model?: string): AnthropicTool[] {
  const useServerSearch = model ? isGlmModel(model) : false
  return senses.map((s) => {
    if (useServerSearch && s.function.name === 'web_search') {
      return {
        type: 'web_search_20250305',
        name: 'web_search',
      }
    }
    return {
      name: s.function.name,
      description: s.function.description,
      input_schema: s.function.parameters as AnthropicTool['input_schema'],
    }
  })
}

// ========== LLM Adapter ==========

const anthropicLLMAdapter: LLMAdapter<AnthropicSplitResult, AnthropicResponse, AnthropicSSEEvent> =
  {
    async chat(
      messages: AnthropicSplitResult,
      senses: SenseFunction[],
      options?: LLMOptions,
    ): Promise<AnthropicResponse> {
      const { model, url, key } = assertChatOptions(options)
      await acquireRpm(options)
      const sensesAsAnthropic = transformSensesToAnthropic(senses, model)

      let body: AnthropicBody = {
        model,
        max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
        ...(messages.system ? { system: messages.system } : {}),
        messages: messages.messages,
        ...(sensesAsAnthropic.length > 0 ? { tools: sensesAsAnthropic } : {}),
        // thinking 片段直传（翻译在 chat middleware，见 docs/backend/agent/provider.md）
        ...(options?.thinkingParams ?? {}),
      }

      // PreLLMRequest 钩子：handler 可改 body（thinking/max_tokens/tools） 或阻断
      if (options?.skipHooks !== true) body = await applyPreLLMRequest(body, options)

      options?.observation?.start(body.model)
      return anthropicFetch(
        url,
        body,
        key,
        options?.fullUrl === true,
        options?.observation,
        options?.signal,
      )
    },

    async chatStream(
      messages: AnthropicSplitResult,
      senses: SenseFunction[],
      options?: LLMOptions,
    ): Promise<AsyncIterable<AnthropicSSEEvent>> {
      const { model, url, key } = assertChatOptions(options)
      await acquireRpm(options)
      const sensesAsAnthropic = transformSensesToAnthropic(senses, model)

      let body: AnthropicBody = {
        model,
        max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
        ...(messages.system ? { system: messages.system } : {}),
        messages: messages.messages,
        ...(sensesAsAnthropic.length > 0 ? { tools: sensesAsAnthropic } : {}),
        // thinking 片段直传（翻译在 chat middleware，见 docs/backend/agent/provider.md）
        ...(options?.thinkingParams ?? {}),
        stream: true,
      }

      if (options?.skipHooks !== true) body = await applyPreLLMRequest(body, options)

      options?.observation?.start(body.model)
      return anthropicStreamSSE(
        url,
        body,
        key,
        options?.signal,
        options?.fullUrl === true,
        options?.observation,
      )
    },
  }

/**
 * PreLLMRequest hook 应用：dispatch 到 hooks 系统，可能替换 body 或抛 ClassifiedError。
 * dispatch 内部已反写 payload.body（若 decision.body 存在），调用方读回 options 即可。
 * brain name：本轮 chat.ts 拿不到（RuntimeConfig 未存 brainName），传空字符串
 * → registry 合并按 config 读与 dispatch 时 brain name 无关；handler stdin 的 ctx.brain 为空。
 */
async function applyPreLLMRequest(
  body: AnthropicBody,
  options?: LLMOptions,
): Promise<AnthropicBody> {
  return (await applyProtocolHook(
    body as unknown as Record<string, unknown>,
    options,
    'anthropic',
  )) as unknown as AnthropicBody
}

// ========== fetch + SSE ==========

/** 拼接 base URL + /messages（规则见 docs/backend/agent/provider.md「URL 解析与端点拼接」，走统一入口 resolveProviderUrl）。
 * - fullUrl=true：URL 原样使用，不拼接（仅去尾斜杠）
 * - 否则：base + /messages（版本段 /v1 由用户填写，后端只拼端点；url 未含版本段时请求落点缺 /v1）
 */
function joinAnthropicUrl(base: string, fullUrl = false): string {
  return resolveProviderUrl('anthropic', base, { fullUrl, kind: 'chat' })
}

/** Anthropic headers：x-api-key + anthropic-version + content-type */
function anthropicHeaders(key: string, stream: boolean): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(stream ? { accept: 'text/event-stream' } : {}),
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
  }
}

/** 非流式 fetch：POST {base}/messages → AnthropicResponse。
 * 伪 200（content-type 非 JSON / 响应体非法 JSON，如网关 SPA 回退）→ validation 配置错误。 */
async function anthropicFetch(
  url: string,
  body: AnthropicBody,
  key: string,
  fullUrl = false,
  observation?: LLMOptions['observation'],
  signal?: AbortSignal,
): Promise<AnthropicResponse> {
  signal?.throwIfAborted()
  let res: Response
  try {
    res = await fetch(joinAnthropicUrl(url, fullUrl), {
      method: 'POST',
      headers: anthropicHeaders(key, false),
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    throw brainNetworkError((err as Error).message, err)
  }
  if (!res.ok) {
    const snippet = await readErrorSnippet(res)
    throw brainHttpError(res.status, snippet)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('json')) {
    throw brainInvalidStream(
      `端点返回的不是 JSON 响应（content-type: ${contentType || '未知'}；url 可能缺 /v1 前缀）`,
    )
  }
  try {
    const value = (await res.json()) as AnthropicResponse
    observation?.response(value)
    return value
  } catch (err) {
    throw brainInvalidStream(
      `响应体不是合法 JSON（${err instanceof Error ? err.message : String(err)}；url 可能缺 /v1 前缀）`,
    )
  }
}

/**
 * 流式 SSE：POST {base}/messages（stream:true）→ yield 每条 data: JSON
 *
 * 仿 fetchBase.ts 的行缓冲骨架，但改：
 * - endpoint /messages（url 解析规则见 joinAnthropicUrl）
 * - 终止 message_stop（非 [DONE]）
 * - 流完整性校验（docs/backend/agent/provider.md「流完整性校验」）：伪 200（content-type
 *   非 event-stream，如网关 SPA 回退）→ validation；流结束 0 有效事件 → provider（空流）
 * - finally 必跑 controller.abort() + reader.cancel()
 */
async function* anthropicStreamSSE(
  url: string,
  body: AnthropicBody,
  key: string,
  signal?: AbortSignal,
  fullUrl = false,
  observation?: LLMOptions['observation'],
): AsyncGenerator<AnthropicSSEEvent, void, unknown> {
  const controller = new AbortController()
  const abortFromParent = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', abortFromParent, { once: true })
  let res: Response
  try {
    res = await fetch(joinAnthropicUrl(url, fullUrl), {
      method: 'POST',
      headers: anthropicHeaders(key, true),
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    controller.abort()
    signal?.removeEventListener('abort', abortFromParent)
    throw brainNetworkError((err as Error).message, err)
  }
  if (!res.ok || !res.body) {
    const snippet = await readErrorSnippet(res)
    controller.abort()
    signal?.removeEventListener('abort', abortFromParent)
    throw brainHttpError(res.status, snippet)
  }
  // 伪 200 拦截：SSE 请求收到非事件流（典型如网关对未知路径回退 Web 控制台 HTML）
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('event-stream')) {
    controller.abort()
    signal?.removeEventListener('abort', abortFromParent)
    throw brainInvalidStream(
      `端点返回的不是事件流（content-type: ${contentType || '未知'}；url 可能缺 /v1 前缀）`,
    )
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let yielded = 0
  const blockTypes = new Map<number, string>()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        const line = rawLine.trim()
        if (line === '') continue // SSE 事件分隔空行
        if (line.startsWith(':')) continue // SSE 注释 / 心跳
        // Anthropic SSE 是 "event: type\ndata: json" 双行，但 JSON 自带 type 字段
        // 实际只需 data: 行解析（event: 行作注释丢弃）
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          const ev = JSON.parse(payload) as AnthropicSSEEvent & { _blockType?: string }
          if (ev.type === 'content_block_start' && ev.content_block?.type) {
            blockTypes.set(ev.index, ev.content_block.type)
          } else if (ev.type === 'content_block_delta') {
            const bt = blockTypes.get(ev.index)
            if (bt) ev._blockType = bt
          }
          observation?.response(ev)
          yield ev
          yielded++
          // message_stop 主动结束（与 OpenAI [DONE] 等价）
          if (ev.type === 'message_stop') {
            controller.abort()
            return
          }
        } catch {
          // 单行 JSON 解析失败跳过
        }
      }
    }
    // 流正常关闭但 0 有效事件（连 message_start 都没收到）→ 空流
    if (yielded === 0) throw brainEmptyStream()
  } finally {
    controller.abort()
    await reader.cancel().catch(() => {})
    signal?.removeEventListener('abort', abortFromParent)
  }
}

// ========== 注册 ==========

export function registerAnthropicAdapter(): void {
  for (const key of ['anthropic', LlmProtocol.ANTHROPIC_MESSAGES]) {
    registerMessageAdapter<AnthropicResponse, AnthropicSSEEvent, AnthropicSplitResult>(
      key,
      anthropicMessageAdapterConfig as unknown as MessageProviderAdapterConfig<
        AnthropicResponse,
        AnthropicSSEEvent,
        AnthropicSplitResult
      >,
    )
    registerSenseAdapter<AnthropicResponse>(
      key,
      anthropicSenseAdapterConfig as unknown as SenseAdapter<AnthropicResponse>,
    )
    registerLLMAdapter(key, anthropicLLMAdapter as unknown as LLMAdapter)
    registerProviderUrlPattern(key, {
      chatEndpoint: '/messages',
      modelsEndpoint: '/models?limit=1000',
    })
  }
}
