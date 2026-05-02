import { type Role, type LLMResponse } from "./messageFactory.ts";

/**
 * Adapter 接口：定义响应提取策略
 */
export type ProviderAdapter<T = unknown, TStream = unknown> = {
  /** 从完整响应提取 role */
  role: (raw: T) => Role;
  /** 从完整响应提取 content */
  content: (raw: T) => string;
  /** 从完整响应提取 thinking（可选） */
  thinking?: (raw: T) => string | undefined;
  /** 从完整响应提取 toolCalls 列表（可选） */
  extractToolCalls?: (raw: T) => unknown[];
  /** 从流式 chunk 提取 content delta */
  extractStreamDelta: (chunk: TStream) => string;
  /** 从流式 chunk 提取 thinking delta（可选） */
  extractStreamThinking?: (chunk: TStream) => string | undefined;
  /** 从流式 chunk 提取 toolCall deltas（可选） */
  extractStreamToolCallDeltas?: (chunk: TStream) => unknown[];
  /** 包装最终响应为统一结构 */
  wrapFinalResponse: (
    threadId: string,
    content: string,
    thinking?: string,
    raw?: T
  ) => LLMResponse<T | null>;
};

/**
 * Provider 注册表
 */
export const providerRegistry = new Map<string, ProviderAdapter>();

/**
 * 注册 provider 的 adapter
 */
export function registerAdapter<T, TStream = unknown>(
  provider: string,
  adapter: ProviderAdapter<T, TStream>,
): void {
  providerRegistry.set(provider, adapter as ProviderAdapter);
}

/**
 * 获取 provider 的 adapter
 */
export function getAdapter<T = unknown, TStream = unknown>(
  provider: string,
): ProviderAdapter<T, TStream> | undefined {
  return providerRegistry.get(provider) as ProviderAdapter<T, TStream> | undefined;
}
