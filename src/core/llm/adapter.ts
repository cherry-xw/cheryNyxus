import type { LLMAdapter } from "../middleware/types";

export type { LLMAdapter };

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