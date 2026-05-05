/**
 * Role 类型
 */
type Role = "system" | "user" | "assistant" | "tool" | "function";

/**
 * MessageProvider 类型（可扩展）
 */
type MessageProviderType = string;

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
  extractStreamDelta: (chunk: TStream) => string;
  extractStreamThinking?: (chunk: TStream) => string | undefined;
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
  private readonly config: MessageProviderAdapterConfig<T, TStream, TMessage>;

  constructor(_sessionId: string, provider: string) {
    const cfg = messageProviderRegistry.get(provider) as MessageProviderAdapterConfig<T, TStream, TMessage> | undefined;
    if (!cfg) {
      throw new Error(`Provider "${provider}" adapter not registered`);
    }
    this.config = cfg;
  }

  /**
   * 获取底层适配器配置
   */
  getAdapter(): MessageProviderAdapterConfig<T, TStream, TMessage> {
    return this.config;
  }
}