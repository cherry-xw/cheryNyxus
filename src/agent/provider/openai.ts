import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/chat/completions";
import { registerMessageAdapter, type LLMResponse } from "@/core/message";
import { registerToolAdapter, type Tool, type ToolCallData } from "@/core/tool";
import type { ZodType } from "zod";
import type {
  ChatCompletionTool,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions";
import { registerLLMAdapter } from "@/core/llm/adapter";
import type { llmAdapter } from "@/core/middleware/types";

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
  extractStreamDelta: (chunk: OpenAI.Chat.Completions.ChatCompletionChunk) =>
    chunk.choices[0]?.delta?.content ?? "",
  extractStreamThinking: (
    chunk: OpenAI.Chat.Completions.ChatCompletionChunk,
  ) => {
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
          role: m.role,
          content: m.content,
          tool_call_id: (m.raw as { toolCallId: string }).toolCallId,
        } as ChatCompletionMessageParam;
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: m.role,
          content: m.content || null,
          ...(m.thinking && { reasoning_content: m.thinking }),
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.tid,
            type: "function",
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        } as ChatCompletionMessageParam;
      }
      if (m.role === "assistant" && m.thinking) {
        return {
          role: m.role,
          content: m.content,
          reasoning_content: m.thinking,
        } as ChatCompletionMessageParam;
      }
      return {
        role: m.role,
        content: m.content,
      } as ChatCompletionMessageParam;
    }),
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
    const openaiToolCalls = toolCalls.map((tc) => ({
      id: tc.tid,
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
    const toolCalls = (response.choices?.[0]?.message?.tool_calls ??
      []) as ChatCompletionMessageFunctionToolCall[];
    return toolCalls.map((tc, index) => ({
      tid: tc.id ?? `tool-${index}`,
      name: tc.function?.name ?? undefined,
      arguments: tc.function?.arguments ?? "",
    }));
  },

  assembleToolCallChunks(chunks: unknown[]): unknown {
    // 按 index 累积 tool call 数据
    const toolCallsMap = new Map<
      number,
      { id?: string; name?: string; arguments: string }
    >();

    for (const chunk of chunks) {
      const streamChunk = chunk as {
        choices?: Array<{
          delta?: {
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      const deltas = streamChunk.choices?.[0]?.delta?.tool_calls ?? [];
      for (const delta of deltas) {
        const index = delta.index ?? 0;
        const existing = toolCallsMap.get(index);
        if (existing) {
          // 累积 arguments
          if (delta.function?.arguments) {
            existing.arguments += delta.function.arguments;
          }
          // id 和 name 只在首个 chunk 出现
          if (delta.id && !existing.id) {
            existing.id = delta.id;
          }
          if (delta.function?.name && !existing.name) {
            existing.name = delta.function.name;
          }
        } else {
          // 初始化
          toolCallsMap.set(index, {
            id: delta.id,
            name: delta.function?.name,
            arguments: delta.function?.arguments ?? "",
          });
        }
      }
    }

    // 模拟 ChatCompletion 结构
    const toolCalls = Array.from(toolCallsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([index, tc]) => ({
        id: tc.id ?? `tool-${index}`,
        type: "function",
        function: {
          name: tc.name ?? "",
          arguments: tc.arguments,
        },
      }));

    return {
      choices: [
        {
          message: {
            tool_calls: toolCalls,
          },
        },
      ],
    } as ChatCompletion;
  },
};

// LLM Adapter 定义
const openaiLLMAdapter: llmAdapter = {
  async chat(
    messages: unknown[],
    tools: unknown[],
    options?: Record<string, unknown>,
  ): Promise<unknown> {
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
      ...(thinking ? { thinking: { type: "enabled" } } : {}),
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
  },
  async chatStream(
    messages: unknown[],
    tools: unknown[],
    options?: Record<string, unknown>,
  ): Promise<AsyncIterable<unknown>> {
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
      ...(thinking ? { thinking: { type: "enabled" } } : {}),
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

  registerMessageAdapter<
    ChatCompletion,
    OpenAI.Chat.Completions.ChatCompletionChunk,
    ChatCompletionMessageParam
  >("openai", openaiMessageAdapterConfig);
  registerToolAdapter<ChatCompletionMessageParam, ChatCompletion>(
    "openai",
    openaiToolAdapterConfig,
  );
  registerLLMAdapter("openai", openaiLLMAdapter);
}
