import type { SenseFunction } from "../sense/adapter";

/** 思考强度档位。
 * - off：关闭（provider 省略思考参数）
 * - thinking：开关模型的「开启」档（不传 reasoning_effort）；有显式强度档位的模型不列此值
 * - low/medium/high：强度递增，各 provider 自行映射为请求参数（如 OpenAI 兼容端点 reasoning_effort）
 */
export type ThinkingLevel = "off" | "thinking" | "low" | "medium" | "high";

/**
 * LLM 调用选项（P1-6：替代 Record<string, unknown>，消除 provider 内强转）。
 * 各 provider 按需读取；model 必选，其余可选。
 */
export interface LLMOptions {
  model: string;
  url?: string;
  key?: string;
  /** 思考强度档位（见 ThinkingLevel）；off=不发思考参数，其余按 provider 映射 */
  thinking?: ThinkingLevel;
  /** 每分钟最大请求数（RPM）限额，provider 层滑动窗口限流，未配置则不限流 */
  rpm?: number;
}

/**
 * LLM Adapter 接口
 * 泛型参数支持 provider 侧类型强化，默认参数保持向后兼容。
 */
export interface LLMAdapter<
  TMessages = unknown[],
  TResponse = unknown,
  TStreamChunk = unknown,
> {
  chat(
    messages: TMessages,
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<TResponse>;
  chatStream(
    messages: TMessages,
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<TStreamChunk>>;
}

/**
 * LLM Adapter 注册表
 */
const llmAdapterRegistry = new Map<string, LLMAdapter>();

/**
 * 注册 LLM Adapter
 */
export function registerLLMAdapter(
  name: string,
  adapter: LLMAdapter,
): void {
  llmAdapterRegistry.set(name, adapter);
}

/**
 * 获取 LLM Adapter
 */
export function getLLMAdapter(
  provider: string,
): LLMAdapter | undefined {
  return llmAdapterRegistry.get(provider);
}
