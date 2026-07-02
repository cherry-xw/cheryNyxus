import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/chat/completions";
import { registerMessageAdapter, type LLMResponse } from "@/core/message/adapter";
import { registerSenseAdapter, type Sense, type SenseCallData, type SenseFunction } from "@/core/sense";
import type { ZodType } from "zod";
import type {
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from "@/core/llm/adapter";
import { buildBaseSenseFunction } from "@/core/sense/compiler/utils.js";
import { getRateLimiter } from "@/utils/rateLimiter.js";

/**
 * RPM 限流：在发起 LLM 请求前按 (url, key) 滑动窗口节流。
 * rpm 未配置 / 非正数 / 无 url 时跳过（不限流）。
 */
async function acquireRpm(options?: LLMOptions): Promise<void> {
  const rpm = options?.rpm;
  const url = options?.url;
  if (!rpm || rpm <= 0 || !url) return;
  await getRateLimiter(url, options.key, rpm).acquire();
}

// ========== Adapter 定义（参数分离）==========

// Message Adapter 配置
const openaiMessageAdapterConfig = {
  role: () => "assistant" as const,
  content: (raw: ChatCompletion) => raw.choices[0]?.message?.content ?? "",
  thinking: (raw: ChatCompletion) => {
    const msg = raw.choices[0]?.message;
    if (msg && "reasoning_content" in msg && msg.reasoning_content) {
      return msg.reasoning_content as string;
    }
    return undefined;
  },
  extractStreamDelta: (chunk: OpenAI.Chat.Completions.ChatCompletionChunk) =>
    chunk.choices[0]?.delta?.content ?? "",
  extractStreamThinking: (
    chunk: OpenAI.Chat.Completions.ChatCompletionChunk,
  ) => {
    const delta = chunk.choices[0]?.delta;
    if (delta && "reasoning_content" in delta && delta.reasoning_content) {
      return delta.reasoning_content as string;
    }
    return undefined;
  },
  buildMessages: (history: LLMResponse[]) =>
    history.filter((m) => !m.revoked).map((m) => {
      if (m.role === "sense") {
        // 如果被替换，使用 replace.content
        const content = m.replace?.state ? m.replace.content : m.content;
        return {
          role: "tool",
          content,
          tool_call_id: m.id,
        } as ChatCompletionMessageParam;
      }
      if (m.role === "assistant" && m.senseCalls && m.senseCalls.length > 0) {
        return {
          role: m.role,
          content: m.content || null,
          tool_calls: m.senseCalls.map((sc) => ({
            id: sc.id,
            type: "function",
            function: {
              name: sc.name,
              arguments: sc.arguments,
            },
          })),
        } as ChatCompletionMessageParam;
      }
      return {
        role: m.role,
        content: m.content,
      } as ChatCompletionMessageParam;
    }),
};

// Sense Adapter 配置
const openaiSenseAdapterConfig = {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[] {
    return senses.map((s) => ({
      type: "function",
      function: {
        ...buildBaseSenseFunction(s),
        strict: true,
      },
    }));
  },

  senseCalls(response: ChatCompletion): SenseCallData[] {
    const senseCalls = (response.choices?.[0]?.message?.tool_calls ??
      []) as ChatCompletionMessageFunctionToolCall[];
    return senseCalls.map((sc, index) => ({
      index,
      id: sc.id ?? `sense-${index}`,
      name: sc.function?.name ?? undefined,
      arguments: sc.function?.arguments ?? "",
    }));
  },

  /**
   * 从流式 chunk 提取 sense call 增量
   * OpenAI 流式响应结构：choices[0].delta.tool_calls[]
   * 返回 SenseCallData（index 定位，arguments 为增量片段）
   */
  extractSenseCallDeltas(chunk: unknown): SenseCallData[] {
    const streamChunk = chunk as OpenAI.Chat.Completions.ChatCompletionChunk;
    const deltas = streamChunk.choices?.[0]?.delta?.tool_calls ?? [];
    return deltas.map((delta) => ({
      index: delta.index ?? 0,
      id: delta.id ?? `sense-${delta.index ?? 0}`,
      name: delta.function?.name ?? undefined,
      arguments: delta.function?.arguments ?? "",
    }));
  },
};

// LLM Adapter 定义
const openaiLLMAdapter: LLMAdapter = {
  async chat(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<unknown> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const model = options?.model;
    const url = options?.url;
    const key = options?.key;
    const thinking = options?.thinking === true;
    if (!model || !url) {
      throw new Error("OpenAI provider requires model and url in options");
    }
    await acquireRpm(options);
    const client = new OpenAI({
      baseURL: url,
      apiKey: key ?? "",
    });
    return client.chat.completions.create({
      model,
      messages: msgArray,
      ...(thinking ? { thinking: { type: "enabled" } } : {}),
      ...(senses.length > 0 && { tools: senses }),
    });
  },
  async chatStream(
    messages: unknown[],
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const model = options?.model;
    const url = options?.url;
    const key = options?.key;
    const thinking = options?.thinking === true;
    if (!model || !url) {
      throw new Error("OpenAI provider requires model and url in options");
    }
    await acquireRpm(options);
    const client = new OpenAI({
      baseURL: url,
      apiKey: key ?? "",
    });
    const stream = await client.chat.completions.create({
      model,
      messages: msgArray,
      stream: true,
      ...(thinking ? { thinking: { type: "enabled" } } : {}),
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
  registerSenseAdapter<ChatCompletionMessageParam, ChatCompletion>(
    "openai",
    openaiSenseAdapterConfig,
  );
  registerLLMAdapter("openai", openaiLLMAdapter);
}
