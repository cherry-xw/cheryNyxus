import ollama from "ollama";
import { randomUUID } from "crypto";
import type {
  ChatResponse,
  ToolCall,
  Message,
} from "ollama";
import { registerMessageAdapter, type LLMResponse } from "@/core/message/adapter";
import { registerSenseAdapter, type Sense, type SenseCallData, type SenseFunction } from "@/core/sense";
import type { ZodType } from "zod";
import { registerLLMAdapter, type LLMAdapter } from "@/core/llm/adapter";
import { safeJsonParse } from "@/utils/json.js";
import type { ProviderCapabilities } from "@/core/provider/capabilities";
import { buildBaseSenseFunction } from "@/core/sense/compiler/utils.js";

// ========== Adapter 定义（参数分离）==========

export const ollamaCapabilities: ProviderCapabilities = {
  supportsStreaming: true,
  supportsToolCalls: true,
  supportsReasoning: true,
  supportsStrictSchema: false,
  generatesToolCallIds: false,
};

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
    history.filter((m) => !m.revoked).map((m) => {
      // 如果是 sense 消息且被替换，使用 replace.content
      const content = m.role === "sense" && m.replace?.state
        ? m.replace.content
        : m.content;
      // ollama tool 结果需 role:"tool"（与 openai 一致），原 role:"sense" API 不识别
      const role = m.role === "sense" ? "tool" : m.role;
      return {
        role,
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
      id: randomUUID(), // Ollama 无 tool_call id，生成跨周期唯一 id（避免 loop 多周期 sense-${index} 冲突）
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
      id: randomUUID(),
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
