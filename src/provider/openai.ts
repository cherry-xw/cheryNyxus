import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/chat/completions";
import { registerMessageAdapter, type LLMResponse } from "@/message/index";
import { registerToolAdapter, type Tool, type ToolCallData } from "@/tool/index";
import type { ZodType } from "zod";
import type {
  ChatCompletionTool,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";
import { registerLLMAdapter } from "@/llm/adapter";
import type { llmAdapter } from "@/middleware/types";

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
  extractStreamDelta: (chunk: OpenAI.Chat.Completions.ChatCompletionChunk) => chunk.choices[0]?.delta?.content ?? "",
  extractStreamThinking: (chunk: OpenAI.Chat.Completions.ChatCompletionChunk) => {
    const delta = chunk.choices[0]?.delta;
    if (delta && "reasoning_content" in delta && delta.reasoning_content) {
      return delta.reasoning_content as string;
    }
    return undefined;
  },
  buildMessages: (history: LLMResponse[]) =>
    history.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: (m.raw as { toolCallId: string }).toolCallId,
          content: m.content,
        } as ChatCompletionMessageParam;
      }
      return {
        role: m.role,
        content: m.content,
      } as ChatCompletionMessageParam;
    }),
  wrapFinalResponse: (threadId: string, content: string, thinking?: string, raw?: ChatCompletion) => {
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
};

// Tool Adapter 配置
const openaiToolAdapterConfig = {
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

  buildToolCallMessage(
    content: string,
    toolCalls: ToolCallData[],
  ): ChatCompletionMessageParam {
    // 将统一的 ToolCallData 转换为 OpenAI 格式
    const openaiToolCalls = toolCalls.map(tc => ({
      id: tc.id ?? `call_${Date.now()}`,
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

  extractToolCalls(response: ChatCompletion): ToolCallData[] {
    const toolCalls = (response.choices?.[0]?.message?.tool_calls ?? []) as ChatCompletionMessageFunctionToolCall[];
    return toolCalls.map(tc => ({
      id: tc.id ?? undefined,
      name: tc.function?.name ?? undefined,
      index: -1,
      arguments: tc.function?.arguments ?? "",
    }));
  },

  extractToolCallDeltas(chunk: unknown): ToolCallData[] {
    const streamChunk = chunk as {
      choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>;
    };
    const deltas = streamChunk.choices?.[0]?.delta?.tool_calls ?? [];
    return deltas.map(delta => ({
      id: delta.id ?? undefined,
      name: delta.function?.name ?? undefined,
      index: delta.index ?? 0,
      arguments: delta.function?.arguments ?? "",
    }));
  },
};

// LLM Adapter 定义
const openaiLLMAdapter: llmAdapter = {
  name: "openai",
  async chat(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<unknown> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const toolArray = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
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
      ...(thinking ? { thinking: true } : {}),
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
  },
  async chatStream(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const toolArray = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
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
      ...(thinking ? { thinking: true } : {}),
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
    return stream as AsyncIterable<unknown>;
  },
};

// ========== 注册函数 ==========

let registered = false;

export function registerOpenAIAdapter(): void {
  if (registered) return;
  registered = true;

  registerMessageAdapter<ChatCompletion, OpenAI.Chat.Completions.ChatCompletionChunk, ChatCompletionMessageParam>(
    "openai",
    openaiMessageAdapterConfig
  );
  registerToolAdapter<ChatCompletionMessageParam, ChatCompletion>(
    "openai",
    openaiToolAdapterConfig
  );
  registerLLMAdapter(openaiLLMAdapter);
}
