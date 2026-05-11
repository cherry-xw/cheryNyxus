import type { llmAdapter } from "../middleware/types";

export type { llmAdapter };

/**
 * LLM Adapter 注册表
 */
const llmAdapterRegistry = new Map<string, llmAdapter>();

/**
 * 注册 LLM Adapter
 */
export function registerLLMAdapter(
  name: string,
  adapter: llmAdapter,
): void {
  llmAdapterRegistry.set(name, adapter);
}

/**
 * 获取 LLM Adapter
 */
export function getLLMAdapter(
  provider: string,
): llmAdapter | undefined {
  return llmAdapterRegistry.get(provider);
}