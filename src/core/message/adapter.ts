import type { MediaKind } from '@/service/media/index.js'
import type { ToolAuthorization } from '@/core/security/index.js'
import type { LlmProtocol } from '@chery/protocol'

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
  /** 拼接的思考文本（UI 展示 + token 估算用；非 Anthropic provider 也可填写） */
  thinking?: string
  /** Anthropic 扩展思考完整块（含 signature / redacted_thinking）— 供 Anthropic provider 原样回传 */
  thinkingBlocks?: ThinkingBlock[]
  senseCalls?: SenseCallInfo[]
  createdAt: number
  updateAt: number
  /** 感官执行结果的 hash（仅 sense 消息有） */
  hash?: string
  /** 替换信息（sense消息被后续相同hash调用替换时） */
  replace?: ReplaceInfo
  /** 原内容（被替换时保留，用于溯源/前端显示） */
  originalContent?: string
  /** 已撤回（chat.resume 撤回 pending sense + 对应 assistant，buildMessages 过滤） */
  revoked?: boolean
  /** 此 assistant 内容是一次 /compact 生成的摘要，并作为后续上下文的边界。 */
  contextCompaction?: boolean
  /** 本次压缩释放的对话上下文 token（estimateTokens 估算）。 */
  contextCompactionTokens?: number
  /** 仅供当前运行的模型上下文使用，不进入持久化历史。 */
  ephemeral?: boolean
}

/**
 * 多模态附件：buildMessages 临时参数（不进 LLMResponse/DB）。
 * 由 enrichMediaInputs 在 chat.ts 内据脑 capabilities + [[media:]] marker 现场构造，
 * provider 调用前同步 readMediaAsset → base64；provider 调用后丢弃。
 * 支持 image/video/audio 类型，provider 据 mimeType/kind 决定 content part 格式。
 */
export interface LLMAttachment {
  mimeType: string
  data: Buffer
  /** 媒体类型（image/video/audio），供 provider 区分处理 */
  kind?: MediaKind
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
  extractStreamDelta: (chunk: TStream) => string
  extractStreamThinking?: (chunk: TStream) => string | undefined
  /** Anthropic 扩展：流式 blocks 增量（每次返回该 chunk 触发的 blocks 增量）。
   *  由 middleware 累积器聚合成完整 blocks；非 Anthropic provider 不实现。 */
  extractStreamThinkingBlocks?: (chunk: TStream) => ThinkingBlockDelta[] | undefined
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
