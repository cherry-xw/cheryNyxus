import type { ToolAuthorization } from '@/core/security/index.js'
import type { ObservationEnvelope } from '@/core/sense/senseCreator.js'
import type { AssetKind, AssetVariant, LlmProtocol, MessagePart } from '@chery/protocol'
export type { MessagePart }

/**
 * Role 类型
 */
type Role = 'system' | 'user' | 'assistant' | 'sense' | 'function' | 'role' | 'subagent' // role=新（子 pet 回复）；subagent 仅旧历史消息兼容

/**
 * Sense Call 数据结构
 */
export interface SenseCallInfo {
  id: string
  name: string
  arguments: string
  /** 该工具调用的安全授权判定（authorizeToolCall 输出；缺省 = 无判定，兼容旧数据） */
  security?: ToolAuthorization
  /** 工具执行归属（local=本机/客户端执行，server=由模型服务执行）。 */
  executionOwner?: 'local' | 'server'
  /** 当同一响应已由服务端工具完成且以 end_turn 结束时，未在本地执行的普通调用状态。 */
  serverState?: 'started' | 'completed' | 'failed' | 'unknown' | 'skipped-local'
  /** 未在本地执行的说明或结果摘要。 */
  result?: string
}

export interface ServerToolSource {
  url: string
  title?: string
  snippet?: string
  refer?: string
}

/**
 * 服务端执行的工具调用记录（Anthropic server_tool_use/tool_result、OpenAI Responses web_search_call 等）。
 * 展示与审计独立保存，不进入本地 sense 调度或审批。
 */
export interface ServerToolCallInfo {
  id: string
  name: string
  arguments: string
  executionOwner: 'server'
  status: 'started' | 'completed' | 'failed' | 'unknown' | 'skipped-local'
  result?: string
  error?: string
  sources?: ServerToolSource[]
  protocol?: string
  responseId?: string
  index?: number
  truncated?: boolean
}

export type ServerToolCallDelta =
  | {
      kind: 'start'
      index: number
      id: string
      name: string
      arguments?: string
      status?: 'started' | 'completed' | 'failed' | 'unknown' | 'skipped-local'
      protocol?: string
      responseId?: string
    }
  | {
      kind: 'arguments_delta'
      index: number
      id?: string
      argumentsDelta: string
    }
  | {
      kind: 'result'
      index: number
      callId: string
      name?: string
      result?: string
      error?: string
      status?: 'completed' | 'failed' | 'unknown' | 'skipped-local'
      sources?: ServerToolSource[]
      truncated?: boolean
    }
  | {
      kind: 'citations'
      sources: ServerToolSource[]
    }

/**
 * Anthropic 扩展思考完整块（Anthropic 专属；其它 provider 仍走 thinking 字符串）。
 * 与 m.thinking 字符串并存：m.thinking 供 UI / token 估算 / 非 Anthropic 回退，
 * m.thinkingBlocks 供 Anthropic provider 原样回传（API 强制要求 thinking/redacted
 * 块带 signature 原样回返）。落库序列化为 JSON 单列 thinking_blocks。
 */
export type ThinkingBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

/**
 * 流式 thinking 增量（chat.ts / checkpointState 累积器的入参形态）。
 * 与 content_block_start/delta/stop 事件一一对应：start 播种；text 拼接；
 * signature 绑定到当前 index 的 block（不出块）；stop 关闭当前 block。
 */
export type ThinkingBlockDelta =
  | { kind: 'start'; index: number; type: 'thinking' | 'redacted_thinking' }
  | { kind: 'text'; index: number; text: string }
  | { kind: 'signature'; index: number; signature: string }
  | { kind: 'stop'; index: number }

/**
 * 消息替换信息
 */
export interface ReplaceInfo {
  /** 是否被替换 */
  state: boolean
  /** 替换者的 tool call id */
  by: string
  /** 替换后的内容 */
  content: string
}

/**
 * 统一 LLM 响应结构
 */
export interface LLMResponse {
  id: string
  role: Role
  content: string
  /** 有序消息部分（text/asset/directive/role_mention/workspace_ref），权威结构；content 为文本边界派生投影 */
  parts?: MessagePart[]
  fileOperations?: import('@chery/protocol').FileOperationRecord[]
  /** 拼接的思考文本（UI 展示 + token 估算用；非 Anthropic provider 也可填写） */
  thinking?: string
  /** Anthropic 扩展思考完整块（含 signature / redacted_thinking）— 供 Anthropic provider 原样回传 */
  thinkingBlocks?: ThinkingBlock[]
  /** 供应商多轮编辑/工具续接上下文（如 OpenAI previous_response_id 或 Gemini thoughtSignature） */
  providerContinuation?: Record<string, unknown>
  senseCalls?: SenseCallInfo[]
  /** 服务端已执行的工具调用记录（与本地 senseCalls 分离，不阻塞 loop/canResume） */
  serverToolCalls?: ServerToolCallInfo[]
  createdAt: number
  updateAt: number
  /** 感官执行结果的 hash（仅 sense 消息有） */
  hash?: string
  /** Structured observation metadata; absent on legacy sense messages. */
  observation?: ObservationEnvelope
  /** 替换信息（sense消息被后续相同hash调用替换时） */
  replace?: ReplaceInfo
  /** 原内容（被替换时保留，用于溯源/前端显示） */
  originalContent?: string
  /** 已撤回（chat.resume 撤回 pending sense + 对应 assistant，buildMessages 过滤） */
  revoked?: boolean
  /** Timed-out partial reply: shown in history, never sent as prior model context. */
  modelExcluded?: boolean
  /** 此 assistant 内容是一次 /compact 生成的摘要，并作为后续上下文的边界。 */
  contextCompaction?: boolean
  /** 本次压缩释放的对话上下文 token（estimateTokens 估算）。 */
  contextCompactionTokens?: number
  /** 仅供当前运行的模型上下文使用，不进入持久化历史。 */
  ephemeral?: boolean
}

/**
 * 多模态附件：buildMessages 临时参数（不进 LLMResponse/DB）。
 * 由上下文请求计划按模型原生能力 + 资产版本现场构造，provider 调用后丢弃。
 */
export interface LLMAttachment {
  mimeType: string
  data: Buffer
  /** 资产或媒体类型（image/video/audio/document/file），供 provider 区分处理 */
  kind?: AssetKind
  /** 该附件归属的消息 id（history 中 LLMResponse.id）；缺省 = 最后一条 user 消息。 */
  messageId?: string
  /** 对应的有序 partId（保持同一消息内图文交错位置） */
  partId?: string
  /** 资产 ID 与固定版本标识（预算与审计追踪用） */
  assetId?: string
  assetVersionId?: string
  variant?: AssetVariant
}

/**
 * 把扁平 attachments 按归属消息 id 分组。
 * 无 messageId 的附件归入 lastUserMessageId（不存在则丢弃）。
 * 供各 provider 的 buildMessages 按消息挂图（避免把全部附件挂到每条 user 消息）。
 */
export function groupAttachmentsByMessage(
  attachments: LLMAttachment[] | undefined,
  lastUserMessageId: string | undefined,
): Map<string, LLMAttachment[]> {
  const grouped = new Map<string, LLMAttachment[]>()
  if (!attachments?.length) return grouped
  for (const attachment of attachments) {
    const key = attachment.messageId ?? lastUserMessageId
    if (!key) continue
    const list = grouped.get(key)
    if (list) list.push(attachment)
    else grouped.set(key, [attachment])
  }
  return grouped
}

/** 保留固定 parts 顺序；没有结构化部分的消息才使用整段文字加附件。 */
export function orderedMessageInputs(message: LLMResponse, attachments: readonly LLMAttachment[]): Array<{ type: 'text'; text: string } | { type: 'attachment'; attachment: LLMAttachment }> {
  if (!message.parts?.length) return [
    ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
    ...attachments.map(attachment => ({ type: 'attachment' as const, attachment })),
  ]
  const output: Array<{ type: 'text'; text: string } | { type: 'attachment'; attachment: LLMAttachment }> = []
  const used = new Set<LLMAttachment>()
  for (const part of message.parts) {
    if (part.type === 'asset') {
      for (const attachment of attachments.filter(item => item.partId === part.partId)) { used.add(attachment); output.push({ type: 'attachment', attachment }) }
    } else {
      const text = part.type === 'text' ? part.text : part.type === 'directive' ? `/${part.command}${part.args ? ` ${part.args}` : ''}` : part.type === 'role_mention' ? `@${part.roleName}` : part.path
      if (text) output.push({ type: 'text', text })
    }
  }
  for (const attachment of attachments) if (!used.has(attachment) && !attachment.partId) output.push({ type: 'attachment', attachment })
  return output
}

/** buildMessages 可选的 provider 级选项（如 Anthropic 的 anthropicOfficial 开关）。
 *  非 Anthropic provider 可忽略此参数。 */
export interface BuildMessagesOptions {
  /** Anthropic：true=完整协议（保留 redacted_thinking）；false=strip（默认） */
  anthropicOfficial?: boolean
  protocol?: LlmProtocol
  /** 当前模型按该协议回传历史思考内容的编码方式。 */
  reasoningHistory?: 'assistant-field' | 'reasoning-item' | 'thinking-block' | 'omit'
}

/**
 * MessageProvider 适配器接口
 */
export type MessageProviderAdapterConfig<T = unknown, TStream = unknown, TMessage = unknown> = {
  content: (raw: T) => string
  thinking?: (raw: T) => string | undefined
  /** Anthropic 扩展：完整 thinking blocks（含 signature）。非 Anthropic provider 不实现。 */
  thinkingBlocks?: (raw: T) => ThinkingBlock[] | undefined
  /** 提取非流式响应中的服务端工具调用记录 */
  serverToolCalls?: (raw: T) => ServerToolCallInfo[] | undefined
  /** 提取非流式响应的结束原因（如 end_turn / tool_use / completed） */
  stopReason?: (raw: T) => string | undefined
  extractStreamDelta: (chunk: TStream) => string
  extractStreamThinking?: (chunk: TStream) => string | undefined
  /** Anthropic 扩展：流式 blocks 增量（每次返回该 chunk 触发的 blocks 增量）。
   *  由 middleware 累积器聚合成完整 blocks；非 Anthropic provider 不实现。 */
  extractStreamThinkingBlocks?: (chunk: TStream) => ThinkingBlockDelta[] | undefined
  /** 提取流式事件中的服务端工具调用/结果增量 */
  extractStreamServerToolDeltas?: (chunk: TStream) => ServerToolCallDelta[] | undefined
  /** 提取流式事件中的结束原因（如 message_delta.delta.stop_reason 或 response.completed） */
  extractStreamStopReason?: (chunk: TStream) => string | undefined
  /** P5b：attachments 为可选多模态附件，provider 据 mimeType/类型决定走原生多模态（image）还是忽略。
   *  buildOptions：provider 级开关（Anthropic 官方模式等），默认 undefined 即用 provider 默认行为。 */
  buildMessages: (
    history: LLMResponse[],
    attachments?: LLMAttachment[],
    buildOptions?: BuildMessagesOptions,
  ) => TMessage[]
}

/**
 * MessageProvider 适配器注册表（静态）
 */
const messageProviderRegistry = new Map<string, MessageProviderAdapterConfig>()

/**
 * 注册 provider 适配器
 */
export function registerMessageAdapter<T, TStream = unknown, TMessage = unknown>(
  provider: string,
  adapter: MessageProviderAdapterConfig<T, TStream, TMessage>,
): void {
  messageProviderRegistry.set(provider, adapter as MessageProviderAdapterConfig)
}

/**
 * 获取 provider 适配器配置
 */
export function getMessageAdapter(provider: string): MessageProviderAdapterConfig | undefined {
  return messageProviderRegistry.get(provider)
}
