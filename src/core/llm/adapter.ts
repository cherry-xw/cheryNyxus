import type { SenseFunction } from "../sense/adapter";

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
    options?: Record<string, unknown>,
  ): Promise<TResponse>;
  chatStream(
    messages: TMessages,
    senses: SenseFunction[],
    options?: Record<string, unknown>,
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
