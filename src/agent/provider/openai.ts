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
import { registerLLMAdapter, type LLMAdapter } from "@/core/llm/adapter";
import type { ProviderCapabilities } from "@/core/provider/capabilities";
import { buildBaseSenseFunction } from "@/core/sense/compiler/utils.js";

// ========== Adapter 定义（参数分离）==========

export const openaiCapabilities: ProviderCapabilities = {
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsReasoning: true,
  supportsStrictSchema: true,
  generatesToolCallIds: true,
};

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
          ...(m.thinking && { reasoning_content: m.thinking }),
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
      if (m.role === "assistant" && m.thinking) {
        return {
          role: m.role,
          content: m.content,
          reasoning_content: m.thinking,
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
        strict: s.definition.function.strict,
      },
    }));
  },

  buildSenseCallMessage(
    content: string,
    senseCall: SenseCallData[],
  ): ChatCompletionMessageParam {
    // 将统一的 SenseCallData 转换为 OpenAI 格式
    const openaiSenseCalls = senseCall.map((sc) => ({
      id: sc.id,
      type: "function",
      function: {
        name: sc.name ?? "",
        arguments: sc.arguments,
      },
    }));
    return {
      role: "assistant",
      content,
      tool_calls: openaiSenseCalls,
    } as ChatCompletionMessageParam;
  },

  buildSenseResponseMessage(
    senseCallId: string,
    result: string,
  ): ChatCompletionMessageParam {
    return {
      role: "tool",
      tool_call_id: senseCallId,
      content: result,
    } as ChatCompletionMessageParam;
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
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const model = options?.model as string;
    const url = options?.url as string;
    const key = options?.key as string | undefined;
    const thinking = options?.thinking === true;
    if (!model || !url) {
      throw new Error("OpenAI provider requires model and url in options");
    }
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
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const model = options?.model as string;
    const url = options?.url as string;
    const key = options?.key as string | undefined;
    const thinking = options?.thinking === true;
    if (!model || !url) {
      throw new Error("OpenAI provider requires model and url in options");
    }
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
