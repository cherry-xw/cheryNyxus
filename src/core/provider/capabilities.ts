/**
 * Provider 能力配置接口
 * 用于查询 Provider 支持的特性，避免硬编码 Provider 特定逻辑
 */
export interface ProviderCapabilities {
  /** 是否支持流式响应 */
  supportsStreaming: boolean;
  /** 是否支持工具调用 */
  supportsToolCalls: boolean;
  /** 是否支持 reasoning/thinking 功能 */
  supportsReasoning: boolean;
  /** 是否支持 strict schema 模式 */
  supportsStrictSchema: boolean;
  /** 是否原生生成 tool call ID（Ollama 需要手动生成） */
  generatesToolCallIds: boolean;
}

/**
 * OpenAI Provider 能力配置
 */
export const openaiCapabilities: ProviderCapabilities = {
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsReasoning: true,  // 支持 reasoning_content 字段
  supportsStrictSchema: true,
  generatesToolCallIds: true,
};

/**
 * Ollama Provider 能力配置
 */
export const ollamaCapabilities: ProviderCapabilities = {
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsReasoning: true,  // 支持 thinking 字段
  supportsStrictSchema: false,
  generatesToolCallIds: false,  // 需要手动生成 tool-${index}
};