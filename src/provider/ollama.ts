import ollama from "ollama";
import type {
  ChatResponse,
  ToolCall,
  Message,
  Tool as OllamaTool,
} from "ollama";
import { type ClientConfigBase } from "../llm/types";
import { registerMessageAdapter, type LLMResponse } from "@/message/index";
import { registerToolAdapter, type Tool } from "@/tool/index";
import type { ZodType } from "zod";
import { registerLLMAdapter } from "@/llm/adapter";
import type { llmAdapter } from "@/middleware/types";

/**
 * Ollama 配置扩展
 */
export interface OllamaConfig extends ClientConfigBase {}

// ========== Adapter 定义（参数分离）==========

// Message Adapter 配置
const ollamaMessageAdapterConfig = {
  role: (raw: ChatResponse) => (raw.message?.role as "assistant") ?? "assistant" as const,
  content: (raw: ChatResponse) => raw.message?.content ?? "",
  thinking: (raw: ChatResponse) => raw.message?.thinking ?? undefined,
  extractToolCalls: (raw: ChatResponse) => raw.message?.tool_calls ?? [],
  extractStreamDelta: (chunk: ChatResponse) => chunk.message?.content ?? "",
  extractStreamThinking: (chunk: ChatResponse) => chunk.message?.thinking ?? undefined,
  extractStreamToolCallDeltas: (chunk: ChatResponse) => chunk.message?.tool_calls ?? [],
  buildMessages: (history: LLMResponse[]) =>
    history.map((m) => ({
      role: m.role,
      content: m.content,
    })) as Message[],
  wrapFinalResponse: (threadId: string, content: string, thinking?: string, raw?: ChatResponse) => {
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
};

// Tool Adapter 配置
const ollamaToolAdapterConfig = {
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

  buildToolCallMessage(content: string, toolCalls: ToolCall[]): Message {
    return {
      role: "assistant",
      content,
      tool_calls: toolCalls,
    } as Message;
  },

  buildToolResponseMessage(_toolCallId: string, result: string): Message {
    return {
      role: "tool",
      content: result,
    } as Message;
  },

  getToolCallArguments(raw: ToolCall): string {
    return JSON.stringify((raw.function?.arguments as Record<string, unknown>) ?? {});
  },

  getToolCallName(raw: ToolCall): string {
    return raw.function?.name ?? "";
  },

  getToolCallId(_raw: ToolCall): string {
    return ""; // Ollama 不需要 tool_call_id
  },

  extractToolCalls(response: ChatResponse): ToolCall[] {
    return (response.message?.tool_calls ?? []) as ToolCall[];
  },

  extractToolCallDeltas(chunk: unknown): ToolCall[] {
    const streamChunk = chunk as { message?: { tool_calls?: unknown[] } };
    return (streamChunk.message?.tool_calls ?? []) as ToolCall[];
  },

  getToolCallDeltaId(_delta: ToolCall): string {
    return ""; // Ollama 不需要 tool_call_id
  },

  getToolCallDeltaName(delta: ToolCall): string | undefined {
    return delta.function?.name;
  },

  getToolCallDeltaArguments(delta: ToolCall): string | undefined {
    // Ollama 的 arguments 是对象，需转为 JSON 字符串
    const args = delta.function?.arguments as Record<string, unknown> | undefined;
    return args ? JSON.stringify(args) : undefined;
  },
};

// LLM Adapter 定义
const ollamaLLMAdapter: llmAdapter = {
  name: "ollama",
  async chat(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<unknown> {
    const msgArray = messages as Message[];
    const toolArray = tools as OllamaTool[];
    const model = options?.model as string;
    if (!model) {
      throw new Error("Ollama provider requires model in options");
    }
    return ollama.chat({
      model,
      messages: msgArray,
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
  },
  async chatStream(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as Message[];
    const toolArray = tools as OllamaTool[];
    const model = options?.model as string;
    if (!model) {
      throw new Error("Ollama provider requires model in options");
    }
    const stream = await ollama.chat({
      model,
      messages: msgArray,
      stream: true,
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
    return stream as AsyncIterable<unknown>;
  },
};

// ========== 注册函数 ==========

let registered = false;

export function registerOllamaAdapter(): void {
  if (registered) return;
  registered = true;

  registerMessageAdapter<ChatResponse, ChatResponse, Message>(
    "ollama",
    ollamaMessageAdapterConfig
  );
  registerToolAdapter<ToolCall, Message, ChatResponse>(
    "ollama",
    ollamaToolAdapterConfig
  );
  registerLLMAdapter(ollamaLLMAdapter);
}
