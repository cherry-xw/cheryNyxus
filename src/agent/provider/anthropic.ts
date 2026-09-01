/**
 * Anthropic Provider（适配 Anthropic Messages API，原生 fetch）。
 *
 * 三层 adapter：
 * - LLM：POST {url}/messages（url 拼接规则见 docs/agent/provider.md「URL 解析与端点拼接」：版本段 /v1 由用户填写、后端只拼 /messages；fullUrl=true 完全不拼接），header x-api-key + anthropic-version + content-type
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
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md) + [docs/agent/hooks.md](../../../docs/agent/hooks.md)。
 */
import type { SenseFunction } from '@/core/sense'
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from '@/core/llm/adapter'
import { registerProviderUrlPattern } from '@/core/llm/urlPattern'
import {
  registerMessageAdapter,
  type BuildMessagesOptions,
  type LLMResponse,
  type LLMAttachment,
  type MessageProviderAdapterConfig,
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
import { dispatch, type HookPayloadMap } from '@/agent/hooks/index.js'
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
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicContentBlock[] }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

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

/** Anthropic tool 定义 */
interface AnthropicTool {
  name: string
  description?: string
  input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
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
    const messages = normalized.map((m) =>
      buildAnthropicMessage(m, attachments, {
        official,
        includeReasoning: buildOptions?.reasoningHistory !== 'omit',
      }),
    )
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
  const merged: LLMResponse[] = [norm[0]!]
  for (let i = 1; i < norm.length; i++) {
    const prev = merged[merged.length - 1]!
    const cur = norm[i]!
    if (prev.role === cur.role) {
      prev.content = `${prev.content}\n\n${cur.content}`
      // senseCalls/tools：合并时保留最后一个（实际场景极少连续 assistant）
    } else {
      merged.push(cur)
    }
  }
  return merged
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
  if (m.role === 'assistant' && m.senseCalls && m.senseCalls.length > 0) {
    const blocks: AnthropicContentBlock[] = []
    // thinking 必须在 text/tool_use 之前（Anthropic 约束）
    pushThinkingBlocks(blocks, m, buildOptions)
    if (m.content) blocks.push({ type: 'text', text: m.content })
    for (const sc of m.senseCalls) {
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
    const blocks: AnthropicContentBlock[] = [{ type: 'text', text: m.content }]
    for (const att of attachments) {
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
    const ev = chunk as AnthropicSSEEvent
    switch (ev.type) {
      case 'content_block_start': {
        const cb = ev.content_block
        if (cb.type !== 'tool_use') return []
        return [
          {
            index: ev.index,
            id: cb.id,
            name: cb.name,
            arguments: '',
          },
        ]
      }
      case 'content_block_delta': {
        if (ev.delta.type !== 'input_json_delta') return []
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

/** OpenAI 形状 → Anthropic tool 形状（chat() 内调用）*/
function transformSensesToAnthropic(senses: SenseFunction[]): AnthropicTool[] {
  return senses.map((s) => ({
    name: s.function.name,
    description: s.function.description,
    input_schema: s.function.parameters as AnthropicTool['input_schema'],
  }))
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
      const sensesAsAnthropic = transformSensesToAnthropic(senses)

      let body: AnthropicBody = {
        model,
        max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
        ...(messages.system ? { system: messages.system } : {}),
        messages: messages.messages,
        ...(sensesAsAnthropic.length > 0 ? { tools: sensesAsAnthropic } : {}),
        // thinking 片段直传（翻译在 chat middleware，见 docs/agent/provider.md）
        ...(options?.thinkingParams ?? {}),
      }

      // PreLLMRequest 钩子：handler 可改 body（thinking/max_tokens/tools） 或阻断
      if (options?.skipHooks !== true) body = await applyPreLLMRequest(body, options)

      return anthropicFetch(url, body, key, options?.fullUrl === true)
    },

    async chatStream(
      messages: AnthropicSplitResult,
      senses: SenseFunction[],
      options?: LLMOptions,
    ): Promise<AsyncIterable<AnthropicSSEEvent>> {
      const { model, url, key } = assertChatOptions(options)
      await acquireRpm(options)
      const sensesAsAnthropic = transformSensesToAnthropic(senses)

      let body: AnthropicBody = {
        model,
        max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
        ...(messages.system ? { system: messages.system } : {}),
        messages: messages.messages,
        ...(sensesAsAnthropic.length > 0 ? { tools: sensesAsAnthropic } : {}),
        // thinking 片段直传（翻译在 chat middleware，见 docs/agent/provider.md）
        ...(options?.thinkingParams ?? {}),
        stream: true,
      }

      if (options?.skipHooks !== true) body = await applyPreLLMRequest(body, options)

      return anthropicStreamSSE(url, body, key, options?.signal, options?.fullUrl === true)
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
  const payload: HookPayloadMap['PreLLMRequest'] = {
    provider: 'anthropic',
    model: body.model,
    url: options?.url ?? '',
    thinking: options?.thinking,
    stream: body.stream === true,
    body: body as unknown as Record<string, unknown>,
  }

  await dispatch('PreLLMRequest', payload, { brain: options?.brain ?? '' })

  // dispatch 内部已反写 payload.body（若 decision.body 存在）
  if (payload.body !== (body as unknown as Record<string, unknown>)) {
    return payload.body as unknown as AnthropicBody
  }
  return body
}

// ========== fetch + SSE ==========

/** 拼接 base URL + /messages（规则见 docs/agent/provider.md「URL 解析与端点拼接」，走统一入口 resolveProviderUrl）。
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
): Promise<AnthropicResponse> {
  let res: Response
  try {
    res = await fetch(joinAnthropicUrl(url, fullUrl), {
      method: 'POST',
      headers: anthropicHeaders(key, false),
      body: JSON.stringify(body),
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
    return (await res.json()) as AnthropicResponse
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
 * - 流完整性校验（docs/agent/provider.md「流完整性校验」）：伪 200（content-type
 *   非 event-stream，如网关 SPA 回退）→ validation；流结束 0 有效事件 → provider（空流）
 * - finally 必跑 controller.abort() + reader.cancel()
 */
async function* anthropicStreamSSE(
  url: string,
  body: AnthropicBody,
  key: string,
  signal?: AbortSignal,
  fullUrl = false,
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
          const ev = JSON.parse(payload) as AnthropicSSEEvent
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
