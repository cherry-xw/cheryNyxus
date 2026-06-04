import type { LLMResponse } from "../message/index";import type { MessageProviderAdapterConfig } from "../message/adapter";
import type { ToolAdapter } from "../tool/adapter";
import type { ToolManager, ToolFunction } from "../tool/index";
import type { GlobalConfig, AIServerConfig } from "@/utils/config";

/**
 * 工具调用累积器（流式工具调用增量累积 + 执行结果）
 */
export interface ToolCallAccumulator {
  /** 工具调用唯一标识：id 或 tool-${index} */
  tid: string;
  name: string;
  arguments: string;
  /** 是否已审批过 */
  approved: boolean;
  /** 触发时间戳（用于超时判断） */
  triggeredAt: number;
}

/**
 * Adapter 分组 - provider adapter 实例集合
 */
export interface AdaptersGroup {
  /** LLM Adapter，处理 chat/chatStream 调用 */
  llmAdapter: llmAdapter;
  /** Message Adapter，处理消息格式转换 */
  messageAdapter: MessageProviderAdapterConfig;
  /** Tool Adapter，处理工具调用格式转换 */
  toolAdapter: ToolAdapter<unknown, unknown>;
}

export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
  toolCallId: string;
  toolName: string;
}

/**
 * 会话分组 - 会话标识和上下文关联信息
 */
export interface SessionGroup {
  /** agent实例唯一标识 */
  sessionId: string;
  /** agent实例中多轮次会话唯一标记 */
  threadId: string;
  /** 工具调用去重检查（toolName → hash → 空字符串） */
  hashCheck: Map<string, string>;
  /** Tool间共享数据（namespace → identifier → data） */
  toolSharedData: Map<string, Map<string, unknown>>;
}

/**
 * 待注入用户消息条目
 */
export interface PendingInputEntry {
  input: string;
  time: number;
}

/**
 * 对话数据组 和 最新一次接口响应数据累积
 */
interface ProcessGroup {
  /** 历史消息记录，用于构建LLM请求上下文 */
  history: LLMResponse[];
  /** 响应内容累积（流式增量拼接） */
  contentAccumulated: string;
  /** 思考内容累积（流式增量拼接） */
  thinkingAccumulated: string;
  /** 流式响应块计数 */
  chunkCount: number;
  /** 工具调用累积器Map */
  toolCallAccumulated: Map<string, ToolCallAccumulator>;
  /** 待消费的用户消息队列（send() 存储，chain 执行前注入） */
  pendingInputs: PendingInputEntry[];
}

/**
 * 工具分组 - 工具管理器和工具调用状态
 */
interface ToolsGroup {
  /** 工具管理器，负责工具注册和执行 */
  toolManager: ToolManager;
}

/**
 * 中间件上下文 - 八分组嵌套结构
 */
export interface MiddlewareContext {
  /** 会话分组：会话标识和上下文关联 */
  session: SessionGroup;
  /** 请求分组：本次请求的输入和模式 */
  global: GlobalConfig;
  /** 配置分组：LLM客户端配置和选项 */
  config: AIServerConfig;
  /** Adapter 分组：provider adapter 实例集合 */
  adapters: AdaptersGroup;
  /** 处理分组：消息处理累积状态 */
  process: ProcessGroup;
  /** 工具分组：工具管理器和调用状态 */
  tools: ToolsGroup;
}

/**
 * 完成 chunk（最终结束标记）
 * 内置类型，标记中间件链执行结束
 */
export interface DoneChunk {
  type: "done";
}

/**
 * 中间件处理函数（Generator 支持）
 * 泛型参数 T 表示 yield 的 chunk 类型
 */
export type MiddlewareHandler<T = unknown> = (
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<T>,
) => AsyncGenerator<T>;

/**
 * 循环策略处理函数
 * 包装单次 chain 执行，由 agent 层提供循环逻辑
 */
export type LoopHandler<T = unknown> = (
  ctx: MiddlewareContext,
  runChain: () => AsyncGenerator<T, void, unknown>,
) => AsyncGenerator<T, void, unknown>;

/**
 * LLM Adapter 接口
 */
export interface llmAdapter {
  chat(messages: unknown[], tools: ToolFunction[], options?: Record<string, unknown>): Promise<unknown>;
  chatStream(messages: unknown[], tools: ToolFunction[], options?: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
}