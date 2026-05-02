import ollama from "ollama";
import type { ChatResponse, Message, Tool as OllamaTool } from "ollama";
import type { LLMResponse } from "@/message/index";
import type { ClientConfigBase } from "./types";
import { BaseLLMClient } from "./base";
import { registerAdapter } from "@/message/index";

/**
 * Ollama 配置扩展
 */
export interface OllamaConfig extends ClientConfigBase {}

// ========== Ollama Adapter 注册 ==========

registerAdapter<ChatResponse, ChatResponse>("ollama", {
  role: (raw) => (raw.message?.role as "assistant") ?? "assistant",
  content: (raw) => raw.message?.content ?? "",
  thinking: (raw) => raw.message?.thinking ?? undefined,
  extractToolCalls: (raw) => raw.message?.tool_calls ?? [],
  extractStreamDelta: (chunk) => chunk.message?.content ?? "",
  extractStreamThinking: (chunk) => chunk.message?.thinking ?? undefined,
  extractStreamToolCallDeltas: (chunk) => chunk.message?.tool_calls ?? [],
  wrapFinalResponse: (threadId, content, thinking, raw) => {
    const response: LLMResponse<ChatResponse | null> = {
      id: `ollama-${Date.now()}`,
      role: "assistant",
      content,
      threadId,
      createdAt: Date.now(),
      updateAt: Date.now(),
      raw: raw ?? null,
      provider: "ollama",
    };
    if (thinking) response.thinking = thinking;
    return response;
  },
});

/**
 * Ollama Client 实现
 */
class OllamaClient extends BaseLLMClient<OllamaConfig> {
  constructor(sessionId: string, providerConfig: OllamaConfig) {
    super(sessionId, providerConfig);
  }

  // ========== 特定实现 ==========

  protected _buildMessages(history: LLMResponse[]): unknown[] {
    return history.map((m) => ({
      role: m.role,
      content: m.content,
    })) as Message[];
  }

  protected async chat(
    messages: unknown[],
    tools: unknown[],
    _options?: Record<string, unknown>
  ): Promise<unknown> {
    const msgArray = messages as Message[];
    const toolArray = tools as OllamaTool[];
    return ollama.chat({
      model: this.config.model,
      messages: msgArray,
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
  }

  protected async chatStream(
    messages: unknown[],
    tools: unknown[],
    _options?: Record<string, unknown>
  ): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as Message[];
    const toolArray = tools as OllamaTool[];
    const stream = await ollama.chat({
      model: this.config.model,
      messages: msgArray,
      stream: true,
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
    return stream as AsyncIterable<unknown>;
  }
}

/**
 * 工厂函数：创建 Ollama Client
 */
export default function createOllamaClient(
  sessionId: string,
  providerConfig: OllamaConfig
): OllamaClient {
  return new OllamaClient(sessionId, providerConfig);
}