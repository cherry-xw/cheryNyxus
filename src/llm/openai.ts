import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletion } from "openai/resources/chat/completions";
import type { LLMResponse } from "@/message/index";
import type { ClientConfigBase } from "./types";
import { BaseLLMClient } from "./base";
import { registerAdapter } from "@/message/index";

/**
 * OpenAI/LongCat 配置扩展
 */
export interface OpenAIConfig extends ClientConfigBase {}

// ========== OpenAI Adapter 注册 ==========

registerAdapter<ChatCompletion, OpenAI.Chat.Completions.ChatCompletionChunk>("openai", {
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
  extractStreamToolCallDeltas: (chunk) => chunk.choices[0]?.delta?.tool_calls ?? [],
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
    options?: Record<string, unknown>
  ): Promise<unknown> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const toolArray = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
    const thinking = options?.thinking === true;
    return this.client.chat.completions.create({
      model: this.config.model,
      messages: msgArray,
      ...thinking ? { thinking: true } : {},
      ...(toolArray.length > 0 && { tools: toolArray }),
    });
  }

  protected async chatStream(
    messages: unknown[],
    tools: unknown[],
    options?: Record<string, unknown>
  ): Promise<AsyncIterable<unknown>> {
    const msgArray = messages as ChatCompletionMessageParam[];
    const toolArray = tools as OpenAI.Chat.Completions.ChatCompletionTool[];
    const thinking = options?.thinking === true;
    const stream = await this.client.chat.completions.create({
      model: this.config.model,
      messages: msgArray,
      stream: true,
      ...thinking ? { thinking: true } : {},
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
  providerConfig: OpenAIConfig
): OpenAIClient {
  return new OpenAIClient(sessionId, providerConfig);
}