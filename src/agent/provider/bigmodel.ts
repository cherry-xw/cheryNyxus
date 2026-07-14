/**
 * 智谱 BigModel provider（OpenAI 兼容协议，fetch 实现）。
 *
 * LLMAdapter 用原生 fetch（[fetchBase](./fetchBase.js)）；message/sense adapter 复用
 * [openaiCompat](./openaiCompat.js)（自动获得 reasoning_content 解析 + image 多模态 + tool_calls）。
 *
 * 思考参数：reasoning_effort（low/medium/high），与 OpenAI o1 系一致。
 * base_url 默认 https://open.bigmodel.cn/api/paas/v4/（可配，也能指向聚合端点）。
 *
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md) 「bigmodel provider」。
 */
import type { SenseFunction } from "@/core/sense";
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from "@/core/llm/adapter";
import { registerMessageAdapter, type MessageProviderAdapterConfig } from "@/core/message/adapter";
import { registerSenseAdapter, type SenseAdapter } from "@/core/sense";
import {
  openaiMessageAdapterConfig,
  openaiSenseAdapterConfig,
  acquireRpm,
  mapThinkingToReasoningEffort,
} from "./openaiCompat.js";
import { assertChatOptions, jsonRequest, streamSSE } from "./fetchBase.js";

// ========== LLM Adapter 定义 ==========

const bigmodelLLMAdapter: LLMAdapter = {
  async chat(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<unknown> {
    const { model, url, key } = assertChatOptions(options);
    const effort = mapThinkingToReasoningEffort(options?.thinking);
    await acquireRpm(options);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      // 思考强度：low/medium/high → reasoning_effort；off/undefined 省略
      ...(effort && { reasoning_effort: effort }),
      ...(senses.length > 0 && { tools: senses }),
    };
    return jsonRequest(url, body, key);
  },
  async chatStream(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<unknown>> {
    const { model, url, key } = assertChatOptions(options);
    const effort = mapThinkingToReasoningEffort(options?.thinking);
    await acquireRpm(options);
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      ...(effort && { reasoning_effort: effort }),
      ...(senses.length > 0 && { tools: senses }),
    };
    return streamSSE(url, body, key);
  },
};

// ========== 注册函数 ==========
export function registerBigmodelAdapter(): void {
  // message/sense adapter 复用 openaiCompat（OpenAI 兼容协议，结构同形，鸭子类型解析）
  registerMessageAdapter(
    "bigmodel",
    openaiMessageAdapterConfig as MessageProviderAdapterConfig,
  );
  registerSenseAdapter("bigmodel", openaiSenseAdapterConfig as unknown as SenseAdapter<Record<string, unknown>>);
  registerLLMAdapter("bigmodel", bigmodelLLMAdapter);
}