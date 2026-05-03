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
export function getMessageProviderAdapterConfig(provider: string): MessageProviderAdapterConfig | undefined {
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

  // ========== 适配器方法 ==========

  /**
   * 构建特定 provider 的消息数组
   */
  buildMessages(history: LLMResponse[]): TMessage[] {
    return this.config.buildMessages(history) as TMessage[];
  }

  /**
   * 从响应提取 role
   */
  role(raw: T): Role {
    return this.config.role(raw);
  }

  /**
   * 从响应提取 content
   */
  content(raw: T): string {
    return this.config.content(raw);
  }

  /**
   * 从响应提取 thinking
   */
  thinking(raw: T): string | undefined {
    return this.config.thinking?.(raw);
  }

  /**
   * 从响应提取 toolCalls
   */
  extractToolCalls(raw: T): unknown[] {
    return this.config.extractToolCalls?.(raw) ?? [];
  }

  /**
   * 从流式 chunk 提取 delta
   */
  extractStreamDelta(chunk: TStream): string {
    return this.config.extractStreamDelta(chunk);
  }

  /**
   * 从流式 chunk 提取 thinking delta
   */
  extractStreamThinking(chunk: TStream): string | undefined {
    return this.config.extractStreamThinking?.(chunk);
  }

  /**
   * 从流式 chunk 提取 toolCall deltas
   */
  extractStreamToolCallDeltas(chunk: TStream): unknown[] {
    return this.config.extractStreamToolCallDeltas?.(chunk) ?? [];
  }

  /**
   * 包装最终响应
   */
  wrapFinalResponse(
    threadId: string,
    content: string,
    thinking?: string,
    raw?: T,
  ): LLMResponse<T | null> {
    return this.config.wrapFinalResponse(threadId, content, thinking, raw);
  }
}