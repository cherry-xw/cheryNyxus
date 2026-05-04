import { v4 as uuid } from "uuid";

/**
 * Role 类型
 */
export type Role = "system" | "user" | "assistant" | "tool" | "function";

/**
 * MessageProvider 类型（可扩展）
 */
export type MessageProviderType = string;

/**
 * 统一 LLM 响应结构
 */
export interface LLMResponse<T = unknown> {
  id: string;
  role: Role;
  content: string;
  thinking?: string;
  threadId: string;
  createdAt: number;
  updateAt: number;
  raw: T;
  provider: MessageProviderType;
}

/**
 * 流式响应 Chunk 结构
 */
export interface LLMStreamChunk<T = unknown> {
  streamId: string;
  thinkingDelta: string;
  thinkingAccumulated?: string;
  delta: string;
  accumulated?: string;
  isDone: boolean;
  raw: T;
}

/**
 * MessageProvider 适配器接口
 */
export type MessageProviderAdapterConfig<T = unknown, TStream = unknown, TMessage = unknown> = {
  role: (raw: T) => Role;
  content: (raw: T) => string;
  thinking?: (raw: T) => string | undefined;
  extractToolCalls?: (raw: T) => unknown[];
  extractStreamDelta: (chunk: TStream) => string;
  extractStreamThinking?: (chunk: TStream) => string | undefined;
  extractStreamToolCallDeltas?: (chunk: TStream) => unknown[];
  buildMessages: (history: LLMResponse[]) => TMessage[];
  wrapFinalResponse: (
    threadId: string,
    content: string,
    thinking?: string,
    raw?: T
  ) => LLMResponse<T | null>;
};

/**
 * MessageProvider 适配器注册表（静态）
 */
const messageProviderRegistry = new Map<string, MessageProviderAdapterConfig>();

/**
 * 注册 provider 适配器
 */
export function registerMessageAdapter<T, TStream = unknown, TMessage = unknown>(
  provider: string,
  adapter: MessageProviderAdapterConfig<T, TStream, TMessage>,
): void {
  messageProviderRegistry.set(provider, adapter as MessageProviderAdapterConfig);
}

/**
 * 获取 provider 适配器配置
 */
export function getMessageAdapter(provider: string): MessageProviderAdapterConfig | undefined {
  return messageProviderRegistry.get(provider);
}

/**
 * MessageAdapter 类
 * 管理消息历史、适配 provider 格式
 */
export class MessageAdapter<T = unknown, TStream = unknown, TMessage = unknown> {
  readonly sessionId: string;
  readonly provider: string;
  private readonly config: MessageProviderAdapterConfig<T, TStream, TMessage>;
  private readonly messageStore: LLMResponse<T>[] = [];

  constructor(sessionId: string, provider: string) {
    this.sessionId = sessionId;
    this.provider = provider;
    const cfg = messageProviderRegistry.get(provider) as MessageProviderAdapterConfig<T, TStream, TMessage> | undefined;
    if (!cfg) {
      throw new Error(`Provider "${provider}" adapter not registered`);
    }
    this.config = cfg;
  }

  // ========== 消息工厂方法 ==========

  /**
   * 创建用户消息
   */
  createUserMessage(threadId: string, content: string): LLMResponse<undefined> {
    const now = Date.now();
    return {
      id: uuid(),
      role: "user",
      content,
      threadId,
      createdAt: now,
      updateAt: now,
      raw: undefined,
      provider: "user",
    };
  }

  /**
   * 创建工具结果消息
   */
  createToolResultMessage(
    threadId: string,
    toolCallId: string,
    content: string,
  ): LLMResponse<{ toolCallId: string }> {
    const now = Date.now();
    return {
      id: uuid(),
      role: "tool",
      content,
      threadId,
      createdAt: now,
      updateAt: now,
      raw: { toolCallId },
      provider: "tool",
    };
  }

  /**
   * 累积历史消息
   */
  accumulate(message?: LLMResponse<T>): LLMResponse<T>[] {
    if (!message) {
      return this.messageStore;
    }
    const sameThreadIndex = this.messageStore.findIndex(
      (item) => item.threadId === message.threadId,
    );
    if (sameThreadIndex >= 0) {
      message.createdAt = this.messageStore[sameThreadIndex]!.createdAt;
      this.messageStore[sameThreadIndex] = message;
    } else {
      this.messageStore.push(message);
    }
    return this.messageStore;
  }

  /**
   * 获取底层适配器配置
   */
  getAdapter(): MessageProviderAdapterConfig<T, TStream, TMessage> {
    return this.config;
  }
}