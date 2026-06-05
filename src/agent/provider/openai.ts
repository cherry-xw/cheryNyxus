import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/chat/completions";
import { registerMessageAdapter, type LLMResponse } from "@/core/message";
import { registerToolAdapter, type Tool, type ToolCallData, type ToolFunction } from "@/core/tool";
import type { ZodType } from "zod";
import type {
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";
import { registerLLMAdapter } from "@/core/llm/adapter";
import type { LLMAdapter } from "@/core/middleware/types";
import { buildBaseToolFunction } from "@/core/tool/compiler/utils.js";

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
  thinkingFieldName: "reasoning_content",
  buildMessages: (history: LLMResponse[]) =>
    history.map((m) => {
      if (m.role === "tool") {
        return {
          role: m.role,
          content: m.content,
          tool_call_id: m.id,
        } as ChatCompletionMessageParam;
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: m.role,
          content: m.content || null,
          ...(m.thinking && { reasoning_content: m.thinking }),
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: tc.arguments,
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

// Tool Adapter 配置
const openaiToolAdapterConfig = {
  buildTools(tools: Tool<ZodType>[]): ToolFunction[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        ...buildBaseToolFunction(t),
        strict: t.definition.function.strict,
      },
    }));
  },

  buildToolCallMessage(
    content: string,
    toolCalls: ToolCallData[],
  ): ChatCompletionMessageParam {
    // 将统一的 ToolCallData 转换为 OpenAI 格式
    const openaiToolCalls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name ?? "",
        arguments: tc.arguments,
      },
    }));
    return {
      role: "assistant",
      content,
      tool_calls: openaiToolCalls,
    } as ChatCompletionMessageParam;
  },

  buildToolResponseMessage(
    toolCallId: string,
    result: string,
  ): ChatCompletionMessageParam {
    return {
      role: "tool",
      tool_call_id: toolCallId,
      content: result,
    } as ChatCompletionMessageParam;
  },

  toolCalls(response: ChatCompletion): ToolCallData[] {
    const toolCalls = (response.choices?.[0]?.message?.tool_calls ??
      []) as ChatCompletionMessageFunctionToolCall[];
    return toolCalls.map((tc, index) => ({
      index,
      id: tc.id ?? `tool-${index}`,
      name: tc.function?.name ?? undefined,
      arguments: tc.function?.arguments ?? "",
    }));
  },

  /**
   * 从流式 chunk 提取 tool call 增量
   * OpenAI 流式响应结构：choices[0].delta.tool_calls[]
   * 返回 ToolCallData（index 定位，arguments 为增量片段）
   */
  extractToolCallDeltas(chunk: unknown): ToolCallData[] {
    const streamChunk = chunk as OpenAI.Chat.Completions.ChatCompletionChunk;
    const deltas = streamChunk.choices?.[0]?.delta?.tool_calls ?? [];
    return deltas.map((delta) => ({
      index: delta.index ?? 0,
      id: delta.id ?? `tool-${delta.index ?? 0}`,
      name: delta.function?.name ?? undefined,
      arguments: delta.function?.arguments ?? "",
    }));
  },
};

// LLM Adapter 定义
const openaiLLMAdapter: LLMAdapter = {
  async chat(
    messages: unknown[],
    tools: ToolFunction[],
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
      ...(tools.length > 0 && { tools }),
    });
  },
  async chatStream(
    messages: unknown[],
    tools: ToolFunction[],
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
      ...(tools.length > 0 && { tools }),
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
  registerToolAdapter<ChatCompletionMessageParam, ChatCompletion>(
    "openai",
    openaiToolAdapterConfig,
  );
  registerLLMAdapter("openai", openaiLLMAdapter);
}
