import type { SenseFunction } from '../sense/adapter'

/** 思考强度档位。
 * - off：关闭（provider 省略思考参数）
 * - on：开关模型的「开启」档（不传 reasoning_effort）；有显式强度档位的模型不列此值
 * - low/medium/high/xhigh：强度递增，各 provider 自行映射为请求参数
 * - 任意字符串：来自 `.chery/model-thinking.yaml` 的原样档位（如 DeepSeek 的 `max`）。
 *   `(string & {})` 保留对已知值的自动补全，又允许任何 string 通过编译。
 */
export type ThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high' | 'xhigh' | (string & {})

/**
 * LLM 调用选项（P1-6：替代 Record<string, unknown>，消除 provider 内强转）。
 * 各 provider 按需读取；model 必选，其余可选。
 */
export interface LLMOptions {
  model: string
  url?: string
  key?: string
  /** 思考强度档位（见 ThinkingLevel）；off=不发思考参数，其余按 provider 映射 */
  thinking?: ThinkingLevel
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
