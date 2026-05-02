import type { ToolAdapter } from "./toolAdapter";
import { OpenAIAdapter } from "./openaiAdapter";
import { OllamaAdapter } from "./ollamaAdapter";

/**
 * Adapter Map
 * key: provider 名称（与 config.yaml 中 provider 字段对应）
 * value: ToolAdapter 实例（共享）
 */
export const adapterMap: Record<string, ToolAdapter> = {
  openai: new OpenAIAdapter(),
  ollama: new OllamaAdapter(),
};

/**
 * 根据 provider 获取 adapter
 * @param provider - provider 名称
 * @returns ToolAdapter 实例
 * @throws Error 如果 provider 不支持
 */
export function getAdapter(provider: string): ToolAdapter {
  const adapter = adapterMap[provider];
  if (!adapter) {
    throw new Error(`Unsupported provider: ${provider}. Available: ${Object.keys(adapterMap).join(", ")}`);
  }
  return adapter;
}

// 导出 adapter 类（供外部扩展使用）
export { OpenAIAdapter, OllamaAdapter };
export { type ToolAdapter } from "./toolAdapter";