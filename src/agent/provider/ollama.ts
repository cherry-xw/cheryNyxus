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
import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from "@/core/llm/adapter";
import { buildBaseSenseFunction } from "@/core/sense/compiler/utils.js";
import { logger } from "@/utils/logger/index.js";

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

  senseCalls(response: ChatResponse): SenseCallData[] {
    const senseCalls = (response.message?.tool_calls ?? []) as ToolCall[];
    // P1-2：Ollama 响应无 tool_call.id。非流式路径每次 chat() 都重新调 LLM 拿新 response，
    // id 随新响应新生（非同 call 重放漂移），故 randomUUID 占位可接受。流式不可靠见 extractSenseCallDeltas。
    return senseCalls.map((sc, index) => ({
      index,
      id: randomUUID(),
      name: sc.function?.name ?? undefined,
      arguments: JSON.stringify(sc.function?.arguments ?? {}),
    }));
  },

  /**
   * 从流式 chunk 提取 sense call 增量。
   * ⚠️ P1-2 标记：Ollama 流式响应不稳定返回 tool_calls（多数场景流式不产生 tool_call），且无 tool_call.id。
   *    randomUUID 仅占位，同 call 多 chunk 由 checkpointState.mergeSenseDeltas 取首 delta id 合并。
   *    建议需要感官调用时走非流式（senseCalls）路径以获得稳定结果。
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
    options?: LLMOptions,
  ): Promise<unknown> {
    const msgArray = messages as Message[];
    const model = options?.model;
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
    options?: LLMOptions,
  ): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as Message[];
    const model = options?.model;
    if (!model) {
      throw new Error("Ollama provider requires model in options");
    }
    // P1-2：Ollama 流式不稳定返回 tool_calls，感官调用可能不触发；建议非流式 chat() 路径。
    if (senses.length > 0) {
      logger.warn("[Ollama] 流式模式下 tool_call 不可靠，感官调用可能不触发；建议非流式");
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
