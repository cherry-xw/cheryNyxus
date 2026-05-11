import type { LLMResponse } from "../message/index";
import type { MessageProviderAdapterConfig } from "../message/adapter";
import type { ToolAdapter } from "../tool/adapter";
import type { ToolManager } from "../tool/index";
import type { GlobalConfig, ClientConfig } from "@/config";

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
 * HistoryProxy - 劫持 Array.push，维护 assistant 索引指针
 * 兼容 LLMResponse[] 数组类型，可直接传递给 messageAdapter.buildMessages
 */
export type HistoryProxy = LLMResponse[] & {
  /** 最后一条 assistant 索引（内部维护） */
  _lastAStagedIndex: number;
  /** getter：直接索引访问最后 assistant */
  readonly lastAssistant: LLMResponse | undefined;
};

/**
 * 会话分组 - 会话标识和上下文关联信息
 */
interface SessionGroup {
  /** agent实例唯一标识 */
  sessionId: string;
  /** agent实例中多轮次会话唯一标记 */
  threadId: string;
  /** 工具调用去重检查（toolName → hash → 空字符串） */
  hashCheck: Map<string, string>;
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
  /** 历史消息记录，用于构建LLM请求上下文（使用 HistoryProxy） */
  history: HistoryProxy;
  /** 响应内容累积（流式增量拼接） */
  contentAccumulated: string;
  /** 思考内容累积（流式增量拼接） */
  thinkingAccumulated: string;
  /** 流式响应块计数 */
  chunkCount: number;
  /** 工具调用累积器Map */
  toolCallAccumulated: Map<string, ToolCallAccumulator>;
  /** 待注入的用户消息队列（send() 存储，chain 执行前注入） */
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
  config: ClientConfig;
  /** Adapter 分组：provider adapter 实例集合 */
  adapters: AdaptersGroup;
  /** 处理分组：消息处理累积状态 */
  process: ProcessGroup;
  /** 工具分组：工具管理器和调用状态 */
  tools: ToolsGroup;
}

/**
 * 中间件处理函数（Generator 支持）
 */
export type MiddlewareHandler = (
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
) => AsyncGenerator<MiddlewareChunk>;

/**
 * 中间件 chunk 类型
 */
export type MiddlewareChunk = StreamChunk | InterruptChunk | StagedChunk | DoneChunk;

/**
 * 流式 chunk
 */
export interface StreamChunk {
  type: "stream";
  /** 思考增量 */
  thinkingDelta: string;
  /** 响应增量 */
  contentDelta: string;
  thinkingAccumulated: string;
  contentAccumulated: string;
  raw: unknown;
}

/**
 * 中断 chunk（工具两阶段确认）
 * acknowledge 由 tool 中间件注入闭包绑定
 */
export interface InterruptChunk {
  type: "interrupt";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** 确认执行（接受/拒绝指令） */
  acknowledge: (action: "accept" | "reject", reason?: string) => Promise<void>;
}

/**
 * 阶段性结果 chunk（中间状态，非最终完成）
 */
export interface StagedChunk {
  type: "staged";
  content: string;
  thinking?: string;
  raw: unknown;
}

/**
 * 完成 chunk（最终结束标记）
 */
interface DoneChunk {
  type: "done";
}

/**
 * LLM Adapter 接口
 */
export interface llmAdapter {
  name: string;
  chat(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<unknown>;
  chatStream(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
}