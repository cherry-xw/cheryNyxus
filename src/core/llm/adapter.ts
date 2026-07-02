import type { SenseFunction } from "../sense/adapter";

/**
 * LLM 调用选项（P1-6：替代 Record<string, unknown>，消除 provider 内强转）。
 * 各 provider 按需读取；model 必选，其余可选。
 */
export interface LLMOptions {
  model: string;
  url?: string;
  key?: string;
  thinking?: boolean;
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

/**
 * 重置 LLM Adapter 注册表（P2-5：测试/热更清残留，与 resetSenses 并列）。
 */
export function resetLLMAdapters(): void {
  llmAdapterRegistry.clear();
}
