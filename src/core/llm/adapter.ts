import type { SenseFunction } from '../sense/adapter'

/** 思考档位「显示词」。
 * - off/on/low/medium/high/xhigh + 任意字符串（来自 `.chery/model-thinking.yaml` 的自定义档位，如 DeepSeek 的 `max`）。
 * - 仅用于日志与 PreLLMRequest hook payload；**不进请求体**。
 * - 请求参数由 `thinkingParams` 承载：显示词 → 参数片段的映射在 model-thinking.yaml 显式声明，
 *   chat middleware 统一翻译（resolveThinkingParams），provider 只 spread 直传。
 */
export type ThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high' | 'xhigh' | (string & {})

/**
 * LLM 调用选项（P1-6：替代 Record<string, unknown>，消除 provider 内强转）。
 * 各 provider 按需读取；model 必选，其余可选。
 */
export interface LLMOptions {
  model: string
  /** Internal execution identity used by deterministic providers and tracing. */
  chatId?: string
  runId?: string
  url?: string
  key?: string
  /** 思考档位显示词（见 ThinkingLevel）；仅日志 / hook payload 用，不进请求体 */
  thinking?: ThinkingLevel
  /** thinking 显示词翻译出的请求参数片段（来自 `.chery/model-thinking.yaml`）。
   *  由 chat middleware 统一翻译注入；provider 原样 spread 进请求 body，不内置映射。
   *  undefined / 空对象 = 不追加任何思考参数。 */
  thinkingParams?: Record<string, unknown>
  /** 每分钟最大请求数（RPM）限额，provider 层滑动窗口限流，未配置则不限流 */
  rpm?: number
  /** brain name（如 'anthropic-main'），供 hooks dispatcher 注入 ctx.brain（handler stdin 可见） */
  brain?: string
  /** 内部 Provider 探测跳过 Hook；正式 chat 缺省 false。 */
  skipHooks?: boolean
  /** Anthropic 官方 API 开关：true=完整扩展思考协议（保留 redacted_thinking 原样回传）；
   *  false=strip redacted_thinking 块（默认；兼容第三方 Anthropic 模式端点）。
   *  仅 Anthropic provider 读取，其它 provider 忽略。 */
  anthropicOfficial?: boolean
  /** true=URL 已含完整端点（如 /v1/messages），provider 完全不拼接、原样访问；缺省只拼端点（版本段 /v1 由用户填写）。
   *  端点拼接是注册 provider 的注册能力，规则见 docs/agent/provider.md「URL 解析与端点拼接」。 */
  fullUrl?: boolean
  /** 当前 chat run 的取消信号。watchdog/用户 abort 时 provider 应立即终止请求流。 */
  signal?: AbortSignal
}

/**
 * LLM Adapter 接口
 * 泛型参数支持 provider 侧类型强化，默认参数保持向后兼容。
 */
export interface LLMAdapter<TMessages = unknown[], TResponse = unknown, TStreamChunk = unknown> {
  chat(messages: TMessages, senses: SenseFunction[], options?: LLMOptions): Promise<TResponse>
  chatStream(
    messages: TMessages,
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<TStreamChunk>>
}

/**
 * LLM Adapter 注册表
 */
const llmAdapterRegistry = new Map<string, LLMAdapter>()

/**
 * 注册 LLM Adapter
 */
export function registerLLMAdapter(name: string, adapter: LLMAdapter): void {
  llmAdapterRegistry.set(name, adapter)
}

/**
 * 获取 LLM Adapter
 */
export function getLLMAdapter(provider: string): LLMAdapter | undefined {
  return llmAdapterRegistry.get(provider)
}
