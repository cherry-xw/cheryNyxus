import ollama from "ollama";
import type {
  ChatResponse,
  ToolCall,
  Message,
} from "ollama";
import { registerMessageAdapter, type LLMResponse } from "@/core/message";
import { registerSenseAdapter, type Sense, type SenseCallData, type SenseFunction } from "@/core/sense";
import type { ZodType } from "zod";
import { registerLLMAdapter } from "@/core/llm/adapter";
import { safeJsonParse } from "@/utils/json.js";
import type { LLMAdapter } from "@/core/middleware/types";
import { buildBaseSenseFunction } from "@/core/sense/compiler/utils.js";

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
    history.map((m) => {
      // 如果是 sense 消息且被替换，使用 replace.content
      const content = m.role === "sense" && m.replace?.state
        ? m.replace.content
        : m.content;
      return {
        role: m.role,
        content,
      };
    }) as Message[],
};

// Sense Adapter 配置
const ollamaSenseAdapterConfig = {
  buildSenses(senses: Sense<ZodType>[]): SenseFunction[] {
    return senses.map((s) => ({
      type: "function",
      function: buildBaseSenseFunction(s),
    }));
  },

  buildSenseCallMessage(content: string, senseCalls: SenseCallData[]): Message {
    // 将统一的 SenseCallData 转换为 Ollama 格式
    const ollamaSenseCalls = senseCalls.map((sc) => ({
      function: {
        name: sc.name ?? "",
        arguments: safeJsonParse(sc.arguments || "{}", {}),
      },
    }));
    return {
      role: "assistant",
      content,
      tool_calls: ollamaSenseCalls,
    } as Message;
  },

  buildSenseResponseMessage(_senseCallId: string, result: string): Message {
    return {
      role: "sense",
      content: result,
    } as Message;
  },

  senseCalls(response: ChatResponse): SenseCallData[] {
    const senseCalls = (response.message?.tool_calls ?? []) as ToolCall[];
    return senseCalls.map((sc, index) => ({
      index,
      id: `sense-${index}`, // Ollama 无 id，用 index 生成
      name: sc.function?.name ?? undefined,
      arguments: JSON.stringify(sc.function?.arguments ?? {}),
    }));
  },

  /**
   * 从流式 chunk 提取 sense call 增量
   * Ollama 流式响应：每个 chunk 包含完整 tool_call（非增量）
   * 返回 SenseCallData（index 定位）
   */
  extractSenseCallDeltas(chunk: unknown): SenseCallData[] {
    const streamChunk = chunk as ChatResponse;
    const senseCalls = (streamChunk.message?.tool_calls ?? []) as ToolCall[];
    return senseCalls.map((sc, index) => ({
      index,
      id: `sense-${index}`,
      name: sc.function?.name ?? undefined,
      arguments: JSON.stringify(sc.function?.arguments ?? {}),
    }));
  },
};

// LLM Adapter 定义
const ollamaLLMAdapter: LLMAdapter = {
  async chat(
    messages: unknown[],
    senses: SenseFunction[],
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
      ...(senses.length > 0 && { tools: senses }),
    });
  },
  async chatStream(
    messages: unknown[],
    senses: SenseFunction[],
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
      ...(senses.length > 0 && { tools: senses }),
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
  registerSenseAdapter<Message, ChatResponse>("ollama", ollamaSenseAdapterConfig);
  registerLLMAdapter("ollama", ollamaLLMAdapter);
}