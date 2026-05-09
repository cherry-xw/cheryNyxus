import ollama from "ollama";
import type {
  ChatResponse,
  ToolCall,
  Message,
  Tool as OllamaTool,
} from "ollama";
import { registerMessageAdapter, type LLMResponse } from "@/message/index";
import { registerToolAdapter, type Tool, type ToolCallData } from "@/tool/index";
import type { ZodType } from "zod";
import { registerLLMAdapter } from "@/llm/adapter";
import type { llmAdapter } from "@/middleware/types";

// ========== Adapter 定义（参数分离）==========

// Message Adapter 配置
const ollamaMessageAdapterConfig = {
  role: (raw: ChatResponse) => (raw.message?.role as "assistant") ?? "assistant" as const,
  content: (raw: ChatResponse) => raw.message?.content ?? "",
  thinking: (raw: ChatResponse) => raw.message?.thinking ?? undefined,
  extractStreamDelta: (chunk: ChatResponse) => chunk.message?.content ?? "",
  extractStreamThinking: (chunk: ChatResponse) => chunk.message?.thinking ?? undefined,
  buildMessages: (history: LLMResponse[]) =>
    history.map((m) => ({
      role: m.role,
      content: m.content,
    })) as Message[],
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

  buildToolCallMessage(content: string, toolCalls: ToolCallData[]): Message {
    // 将统一的 ToolCallData 转换为 Ollama 格式
    const ollamaToolCalls = toolCalls.map(tc => ({
      function: {
        name: tc.name ?? "",
        arguments: JSON.parse(tc.arguments || "{}"),
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

  extractToolCalls(response: ChatResponse): ToolCallData[] {
    const toolCalls = (response.message?.tool_calls ?? []) as ToolCall[];
    return toolCalls.map(tc => ({
      tid: "", // Ollama 无 id
      name: tc.function?.name ?? undefined,
      arguments: JSON.stringify(tc.function?.arguments ?? {}),
    }));
  },

  assembleToolCallChunks(chunks: unknown[]): unknown {
    // Ollama 每个 chunk 可能包含完整 tool_call，直接累积
    const allToolCalls: ToolCall[] = [];

    for (const chunk of chunks) {
      const streamChunk = chunk as { message?: { tool_calls?: ToolCall[] } };
      const toolCalls = streamChunk.message?.tool_calls ?? [];
      for (const tc of toolCalls) {
        allToolCalls.push(tc);
      }
    }

    // 模拟 ChatResponse 结构
    return {
      message: {
        tool_calls: allToolCalls,
      },
    } as ChatResponse;
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
  registerToolAdapter<Message, ChatResponse>(
    "ollama",
    ollamaToolAdapterConfig
  );
  registerLLMAdapter(ollamaLLMAdapter);
}
