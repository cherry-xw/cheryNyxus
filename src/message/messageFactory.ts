import { v4 as uuid } from "uuid";
import { providerRegistry } from "./adapter.ts";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

/**
 * Provider 类型（可扩展）
 */
export type ProviderType = string;

/**
 * 统一 LLM 响应结构
 */
export interface LLMResponse<T = unknown> {
  /** 请求唯一标识（SDK原生id或生成） */
  id: string;
  role: Role;
  /** 统一提取的文本内容 */
  content: string;
  /** 思考过程内容（reasoning_content） */
  thinking?: string;
  threadId: string;
  createdAt: number;
  updateAt: number;
  /** 原始响应数据 */
  raw: T;
  /** 提供商标识 */
  provider: ProviderType;
}

/**
 * 流式响应 Chunk 结构
 */
export interface LLMStreamChunk<T = unknown> {
  /** 流标识（整个流保持一致） */
  streamId: string;
  thinkingDelta: string;
  thinkingAccumulated?: string;
  /** 当前 chunk 的增量内容 */
  delta: string;
  /** 累积内容（可选，便于调用方显示） */
  accumulated?: string;
  /** 是否为最后一个 chunk */
  isDone: boolean;
  /** 原始 chunk 数据 */
  raw: T;
}

/**
 * 流式响应包装器选项
 */
export interface StreamWrapperOptions<T = unknown> {
  provider: string;
  threadId: string;
  /** 从原生响应提取 delta 内容 */
  extractDelta: (raw: T) => string;
  /** 判断流是否结束 */
  isDone: (raw: T) => boolean;
}

/**
 * 工厂函数：将原生响应包装为统一结构
 */
export function wrapResponse<T>(
  provider: string,
  threadId: string,
  rawResponse: T,
): LLMResponse<T> | undefined {
  const adapter = providerRegistry.get(provider);
  if (!adapter) {
    console.warn(`[messageFactory] 未注册的 provider: ${provider}`);
    return {
      id: uuid(),
      role: "assistant",
      content: "",
      threadId,
      createdAt: Date.now(),
      updateAt: Date.now(),
      raw: rawResponse,
      provider,
    };
  }

  const content = adapter.content(rawResponse);
  const role = adapter.role(rawResponse);
  const thinking = adapter.thinking?.(rawResponse);
  const now = Date.now();
  const response: LLMResponse<T> = {
    id: uuid(),
    content,
    role,
    threadId,
    createdAt: now,
    updateAt: now,
    raw: rawResponse,
    provider,
  };
  if (thinking !== undefined) {
    response.thinking = thinking;
  }
  return response;
}

const messageStore: Map<string, LLMResponse<any>[]> = new Map();

/**
 * 创建用户消息
 */
export function createUserMessage(
  threadId: string,
  content: string,
): LLMResponse<undefined> {
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
 * 累积历史消息（用户消息和 LLM 响应统一处理）
 */
export function accumulateMessages<T = any>(
  sessionId: string,
  message?: LLMResponse<T>,
): LLMResponse<T>[] {
  let session = messageStore.get(sessionId);
  if (!session) {
    session = [];
    messageStore.set(sessionId, session);
  }
  if (!message) {
    return session;
  }
  const sameThreadIndex = session.findIndex(
    (item) => item.threadId === message.threadId,
  );
  if (sameThreadIndex >= 0) {
    message.createdAt = session[sameThreadIndex]!.createdAt;
    session[sameThreadIndex] = message;
  } else {
    session.push(message);
  }
  return session;
}
