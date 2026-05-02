import ollama from "ollama";
import type {
  ChatResponse,
  ToolCall,
  Message,
  Tool as OllamaTool,
} from "ollama";
import { BaseLLMClient, type ClientConfigBase } from "../llm/index";
import { registerMessageAdapter, type LLMResponse } from "@/message/index";
import { registerToolAdapter, type Tool } from "@/tool/index";
import type { ZodType } from "zod";

/**
 * Ollama 配置扩展
 */
export interface OllamaConfig extends ClientConfigBase {}

// ========== Ollama message Adapter 注册 ==========

registerMessageAdapter<ChatResponse, ChatResponse>("ollama", {
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

// ========== Ollama tool Adapter 注册 ==========

registerToolAdapter("ollama", {
  buildTools(tools: Tool<ZodType>[]): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.definition.function.name,
        description: t.definition.function.description,
        parameters: t.definition.function.parameters,
      },
    })) as OllamaTool[];
  },

  buildToolCallMessage(content: string, toolCalls: unknown[]): unknown {
    return {
      role: "assistant",
      content,
      tool_calls: toolCalls as ToolCall[],
    } as Message;
  },

  buildToolResponseMessage(_toolCallId: string, result: string): unknown {
    return {
      role: "tool",
      content: result,
    } as Message;
  },

  parseToolCallArguments(raw: unknown): Record<string, unknown> {
    const tc = raw as ToolCall;
    return (tc.function?.arguments as Record<string, unknown>) ?? {};
  },

  getToolCallName(raw: unknown): string {
    const tc = raw as ToolCall;
    return tc.function?.name ?? "";
  },

  getToolCallId(_raw: unknown): string {
    return ""; // Ollama 不需要 tool_call_id
  },

  extractToolCalls(response: unknown): unknown[] {
    const chatResponse = response as { message?: { tool_calls?: unknown[] } };
    return (chatResponse.message?.tool_calls ?? []) as ToolCall[];
  },

  extractToolCallDeltas(chunk: unknown): unknown[] {
    const streamChunk = chunk as { message?: { tool_calls?: unknown[] } };
    return (streamChunk.message?.tool_calls ?? []) as ToolCall[];
  },

  getToolCallDeltaId(_delta: unknown): string {
    return ""; // Ollama 不需要 tool_call_id
  },

  getToolCallDeltaName(delta: unknown): string | undefined {
    const tc = delta as ToolCall;
    return tc.function?.name;
  },

  getToolCallDeltaArguments(delta: unknown): string | undefined {
    const tc = delta as ToolCall;
    // Ollama 的 arguments 是对象，需转为 JSON 字符串
    const args = tc.function?.arguments as Record<string, unknown> | undefined;
    return args ? JSON.stringify(args) : undefined;
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
    _options?: Record<string, unknown>,
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
    _options?: Record<string, unknown>,
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
  providerConfig: OllamaConfig,
): OllamaClient {
  return new OllamaClient(sessionId, providerConfig);
}
