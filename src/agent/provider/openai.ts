/**
 * OpenAI（含兼容服务）provider。
 *
 * LLMAdapter 用官方 SDK（保留原有依赖）；message/sense adapter 与 thinking 映射、RPM 限流、
 * 必填项校验复用 [openaiCompat](./openaiCompat.js) 与 [fetchBase](./fetchBase.js)。
 *
 * 思考参数：按 ThinkingLevel 映射为 reasoning_effort（off 省略）。
 * 历史问题：曾硬编码 `thinking: { type: "enabled" }`，被聚合端点忽略导致思考丢失；
 * 现按 reasoning_effort 映射（OpenAI o1 系 / 智谱 bigmodel / 兼容聚合端点均认）。
 *
 * 详见 [docs/agent/provider.md](../../../docs/agent/provider.md)。
 */
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from "@/core/llm/adapter";
import { registerMessageAdapter } from "@/core/message/adapter";
import { registerSenseAdapter, type SenseFunction } from "@/core/sense";
import {
  openaiMessageAdapterConfig,
  openaiSenseAdapterConfig,
  acquireRpm,
  mapThinkingToReasoningEffort,
} from "./openaiCompat.js";
import { assertChatOptions } from "./fetchBase.js";

// ========== LLM Adapter 定义 ==========

const openaiLLMAdapter: LLMAdapter = {
  async chat(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<unknown> {
    const { model, url, key } = assertChatOptions(options);
    const msgArray = messages as ChatCompletionMessageParam[];
    const effort = mapThinkingToReasoningEffort(options?.thinking);
    await acquireRpm(options);
    const client = new OpenAI({ baseURL: url, apiKey: key });
    return client.chat.completions.create({
      model,
      messages: msgArray,
      // 思考强度：low/medium/high → reasoning_effort；off/undefined 省略（非推理模型也安全）
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(senses.length > 0 && { tools: senses }),
    });
  },
  async chatStream(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<unknown>> {
    const { model, url, key } = assertChatOptions(options);
    const msgArray = messages as ChatCompletionMessageParam[];
    const effort = mapThinkingToReasoningEffort(options?.thinking);
    await acquireRpm(options);
    const client = new OpenAI({ baseURL: url, apiKey: key });
    const stream = await client.chat.completions.create({
      model,
      messages: msgArray,
      stream: true,
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(senses.length > 0 && { tools: senses }),
    });
    return stream as AsyncIterable<unknown>;
  },
};

// ========== 注册函数 ==========
export function registerOpenAIAdapter(): void {
  registerMessageAdapter<
    ChatCompletion,
    OpenAI.Chat.Completions.ChatCompletionChunk,
    ChatCompletionMessageParam
  >("openai", openaiMessageAdapterConfig);
  registerSenseAdapter<ChatCompletion>("openai", openaiSenseAdapterConfig);
  registerLLMAdapter("openai", openaiLLMAdapter);
}