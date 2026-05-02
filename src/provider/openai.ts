import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/chat/completions";
import { BaseLLMClient, type ClientConfigBase } from "../llm/index";
import { registerMessageAdapter, type LLMResponse } from "@/message/index";
import { registerToolAdapter, type Tool } from "@/tool/index";
import type { ZodType } from "zod";
import type {
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

/**
 * OpenAI/LongCat 配置扩展
 */
export interface OpenAIConfig extends ClientConfigBase {}

// ========== OpenAI message Adapter 注册 ==========

registerMessageAdapter<
  ChatCompletion,
  OpenAI.Chat.Completions.ChatCompletionChunk
>("openai", {
  role: () => "assistant",
  content: (raw) => raw.choices[0]?.message?.content ?? "",
  thinking: (raw) => {
    const msg = raw.choices[0]?.message;
    if (msg && "reasoning_content" in msg && msg.reasoning_content) {
      return msg.reasoning_content as string;
    }
    return undefined;
  },
  extractToolCalls: (raw) => raw.choices[0]?.message?.tool_calls ?? [],
  extractStreamDelta: (chunk) => chunk.choices[0]?.delta?.content ?? "",
  extractStreamThinking: (chunk) => {
    const delta = chunk.choices[0]?.delta;
    if (delta && "reasoning_content" in delta && delta.reasoning_content) {
      return delta.reasoning_content as string;
    }
    return undefined;
  },
  extractStreamToolCallDeltas: (chunk) =>
    chunk.choices[0]?.delta?.tool_calls ?? [],
  wrapFinalResponse: (threadId, content, thinking, raw) => {
    const response: LLMResponse<ChatCompletion | null> = {
      id: raw?.id ?? `openai-${Date.now()}`,
      role: "assistant",
      content,
      threadId,
      createdAt: Date.now(),
      updateAt: Date.now(),
      raw: raw ?? null,
      provider: "openai",
    };
    if (thinking) response.thinking = thinking;
    return response;
  },
});

// ========== OpenAI tool Adapter 注册 ==========

registerToolAdapter("openai", {
  buildTools(tools: Tool<ZodType>[]): unknown[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.definition.function.name,
        description: t.definition.function.description,
        parameters: t.definition.function.parameters,
        strict: t.definition.function.strict,
      },
    })) as ChatCompletionTool[];
  },

  buildToolCallMessage(content: string, toolCalls: unknown[]): unknown {
    return {
      role: "assistant",
      content,
      tool_calls: toolCalls as ChatCompletionMessageToolCall[],
    } as ChatCompletionMessageParam;
  },

  buildToolResponseMessage(toolCallId: string, result: string): unknown {
    return {
      role: "tool",
      tool_call_id: toolCallId,
      content: result,
    } as ChatCompletionMessageParam;
  },

  parseToolCallArguments(raw: unknown): Record<string, unknown> {
    const tc = raw as { function?: { arguments?: string } };
    const argsJson = tc.function?.arguments ?? "{}";
    return JSON.parse(argsJson) as Record<string, unknown>;
  },

  getToolCallName(raw: unknown): string {
    const tc = raw as { function?: { name?: string } };
    return tc.function?.name ?? "";
  },

  getToolCallId(raw: unknown): string {
    const tc = raw as { id?: string };
    return tc.id ?? "";
  },

  extractToolCalls(response: unknown): unknown[] {
    const completion = response as {
      choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
    };
    return (completion.choices?.[0]?.message?.tool_calls ?? []) as unknown[];
  },

  extractToolCallDeltas(chunk: unknown): unknown[] {
    const streamChunk = chunk as {
      choices?: Array<{ delta?: { tool_calls?: unknown[] } }>;
    };
    return (streamChunk.choices?.[0]?.delta?.tool_calls ?? []) as unknown[];
  },

  getToolCallDeltaId(delta: unknown): string {
    const tc = delta as { id?: string };
    return tc.id ?? "";
  },

  getToolCallDeltaName(delta: unknown): string | undefined {
    const tc = delta as { function?: { name?: string } };
    return tc.function?.name;
  },

  getToolCallDeltaArguments(delta: unknown): string | undefined {
    const tc = delta as { function?: { arguments?: string } };
    return tc.function?.arguments;
  },
});

/**
 * OpenAI Client 实现
 */
class OpenAIClient extends BaseLLMClient<OpenAIConfig> {
  private client: OpenAI;

  constructor(sessionId: string, providerConfig: OpenAIConfig) {
    super(sessionId, providerConfig);
    this.client = new OpenAI({
      baseURL: providerConfig.url,
      apiKey: providerConfig.key ?? "",
    });
  }

  // ========== 特定实现 ==========

  protected _buildMessages(history: LLMResponse[]): unknown[] {
    return history.map((m) => ({
      role: m.role,
      content: m.content,
    })) as ChatCompletionMessageParam[];
  }

  protected async chat(
    messages: unknown[],
    tools: unknown[],
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const toolArray = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
    const thinking = options?.thinking === true;
    return this.client.chat.completions.create({
      model: this.config.model,
      messages: msgArray,
      ...(thinking ? { thinking: true } : {}),
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
  }

  protected async chatStream(
    messages: unknown[],
    tools: unknown[],
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const toolArray = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
    const thinking = options?.thinking === true;
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages: msgArray,
      stream: true,
      ...(thinking ? { thinking: true } : {}),
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
    return stream as AsyncIterable<unknown>;
  }
}

/**
 * 工厂函数：创建 OpenAI Client
 */
export default function createOpenAIClient(
  sessionId: string,
  providerConfig: OpenAIConfig,
): OpenAIClient {
  return new OpenAIClient(sessionId, providerConfig);
}
