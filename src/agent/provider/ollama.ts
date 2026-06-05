import ollama from "ollama";
import type {
  ChatResponse,
  ToolCall,
  Message,
} from "ollama";
import { registerMessageAdapter, type LLMResponse } from "@/core/message";
import { registerToolAdapter, type Tool, type ToolCallData, type ToolFunction } from "@/core/tool";
import type { ZodType } from "zod";
import { registerLLMAdapter } from "@/core/llm/adapter";
import { safeJsonParse } from "@/utils/json.js";
import type { LLMAdapter } from "@/core/middleware/types";
import { buildBaseToolFunction } from "@/core/tool/compiler/utils.js";

// ========== Adapter 定义（参数分离）==========

// Message Adapter 配置
const ollamaMessageAdapterConfig = {
  role: (raw: ChatResponse) =>
    (raw.message?.role as "assistant") ?? ("assistant" as const),
  content: (raw: ChatResponse) => raw.message?.content ?? "",
  thinking: (raw: ChatResponse) => raw.message?.thinking ?? undefined,
  extractStreamDelta: (chunk: ChatResponse) => chunk.message?.content ?? "",
  extractStreamThinking: (chunk: ChatResponse) =>
    chunk.message?.thinking ?? undefined,
  buildMessages: (history: LLMResponse[]) =>
    history.map((m) => ({
      role: m.role,
      content: m.content,
    })) as Message[],
};

// Tool Adapter 配置
const ollamaToolAdapterConfig = {
  buildTools(tools: Tool<ZodType>[]): ToolFunction[] {
    return tools.map((t) => ({
      type: "function",
      function: buildBaseToolFunction(t),
    }));
  },

  buildToolCallMessage(content: string, toolCalls: ToolCallData[]): Message {
    // 将统一的 ToolCallData 转换为 Ollama 格式
    const ollamaToolCalls = toolCalls.map((tc) => ({
      function: {
        name: tc.name ?? "",
        arguments: safeJsonParse(tc.arguments || "{}", {}),
      },
    }));
    return {
      role: "assistant",
      content,
      tool_calls: ollamaToolCalls,
    } as Message;
  },

  buildToolResponseMessage(_toolCallId: string, result: string): Message {
    return {
      role: "tool",
      content: result,
    } as Message;
  },

  toolCalls(response: ChatResponse): ToolCallData[] {
    const toolCalls = (response.message?.tool_calls ?? []) as ToolCall[];
    return toolCalls.map((tc, index) => ({
      index,
      id: `tool-${index}`, // Ollama 无 id，用 index 生成
      name: tc.function?.name ?? undefined,
      arguments: JSON.stringify(tc.function?.arguments ?? {}),
    }));
  },

  /**
   * 从流式 chunk 提取 tool call 增量
   * Ollama 流式响应：每个 chunk 包含完整 tool_call（非增量）
   * 返回 ToolCallData（index 定位）
   */
  extractToolCallDeltas(chunk: unknown): ToolCallData[] {
    const streamChunk = chunk as ChatResponse;
    const toolCalls = (streamChunk.message?.tool_calls ?? []) as ToolCall[];
    return toolCalls.map((tc, index) => ({
      index,
      id: `tool-${index}`,
      name: tc.function?.name ?? undefined,
      arguments: JSON.stringify(tc.function?.arguments ?? {}),
    }));
  },
};

// LLM Adapter 定义
const ollamaLLMAdapter: LLMAdapter = {
  async chat(
    messages: unknown[],
    tools: ToolFunction[],
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const msgArray = messages as Message[];
    const model = options?.model as string;
    if (!model) {
      throw new Error("Ollama provider requires model in options");
    }
    return ollama.chat({
      model,
      messages: msgArray,
      ...(tools.length > 0 && { tools }),
    });
  },
  async chatStream(
    messages: unknown[],
    tools: ToolFunction[],
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as Message[];
    const model = options?.model as string;
    if (!model) {
      throw new Error("Ollama provider requires model in options");
    }
    const stream = await ollama.chat({
      model,
      messages: msgArray,
      stream: true,
      ...(tools.length > 0 && { tools }),
    });
    return stream as AsyncIterable<unknown>;
  },
};

// ========== 注册函数 ==========
export function registerOllamaAdapter(): void {
  registerMessageAdapter<ChatResponse, ChatResponse, Message>(
    "ollama",
    ollamaMessageAdapterConfig,
  );
  registerToolAdapter<Message, ChatResponse>("ollama", ollamaToolAdapterConfig);
  registerLLMAdapter("ollama", ollamaLLMAdapter);
}
