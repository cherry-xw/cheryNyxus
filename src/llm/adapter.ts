import type { llmAdapter } from "@/middleware/types";

export type { llmAdapter };

/**
 * LLM Adapter 注册表
 */
const providerRegistry = new Map<string, llmAdapter>();

/**
 * 注册 LLM Adapter
 */
export function registerLLMAdapter(
  adapter: llmAdapter,
): void {
  providerRegistry.set(adapter.name, adapter);
}

/**
 * 获取 LLM Adapter
 */
export function getLLMAdapter(
  provider: string,
): llmAdapter | undefined {
  return providerRegistry.get(provider);
}