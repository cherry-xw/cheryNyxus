/**
 * Role 类型
 */
type Role = "system" | "user" | "assistant" | "sense" | "function";

/**
 * Sense Call 数据结构
 */
export interface SenseCallInfo {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 消息替换信息
 */
export interface ReplaceInfo {
  /** 是否被替换 */
  state: boolean;
  /** 替换者的 tool call id */
  by: string;
  /** 替换后的内容 */
  content: string;
}

/**
 * 统一 LLM 响应结构
 */
export interface LLMResponse {
  id: string;
  role: Role;
  content: string;
  thinking?: string;
  senseCalls?: SenseCallInfo[];
  createdAt: number;
  updateAt: number;
  /** 感官执行结果的 hash（仅 sense 消息有） */
  hash?: string;
  /** 替换信息（sense消息被后续相同hash调用替换时） */
  replace?: ReplaceInfo;
  /** 原内容（被替换时保留，用于溯源/前端显示） */
  originalContent?: string;
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
