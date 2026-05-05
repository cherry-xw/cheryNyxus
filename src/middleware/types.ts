import type { LLMResponse } from "@/message/index";
import type { MessageProviderAdapterConfig } from "@/message/adapter";
import type { ToolAdapter } from "@/tool/adapter";
import type { ToolManager } from "@/tool/index";
import type { GlobalConfig, ClientConfig } from "@/config";

/**
 * 工具调用累积器（流式工具调用增量累积 + 执行结果）
 */
export interface ToolCallAccumulator {
  id?: string;
  name: string;
  arguments: string;
  index: number;
  // 执行结果（tool 中间件写入）
  executionResult?: ToolExecutionResult;
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

/**
 * 回退状态枚举
 * - none: 正常执行，无需回退
 * - retryMessage: 回退到 message 入口重新执行
 */
export enum RetryState {
  none = 0,
  retryMessage = 1,
}

/**
 * 工具执行结果
 */
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
interface SessionGroup {
  /** agent实例唯一标识 */
  sessionId: string;
  /** agent实例中多轮次会话唯一标记 */
  threadId: string;
  /** 已加载的技能列表，防止重复加载 */
  loadedSkills: Set<string>;
}

/**
 * 处理分组 - 消息处理过程中的累积状态
 */
interface ProcessGroup {
  /** 历史消息记录，用于构建LLM请求上下文 */
  history: LLMResponse[];
  /** 响应内容累积（流式增量拼接） */
  accumulated: string;
  /** 思考内容累积（流式增量拼接） */
  thinkingAccumulated: string;
  /** 流式响应块计数 */
  chunkCount: number;
}

/**
 * 工具分组 - 工具管理器和工具调用状态
 */
interface ToolsGroup {
  /** 工具管理器，负责工具注册和执行 */
  toolManager: ToolManager;
  /** 工具调用累积器Map */
  toolCallAccumulated: Map<string, ToolCallAccumulator>;
}

/**
 * 响应分组 - LLM响应和最终结果
 */
interface ResponseGroup {
  /** LLM原始响应（非流式模式） */
  raw: unknown;
  /** 最终响应内容（处理完成后） */
  finalContent: string;
  /** 最终思考内容（处理完成后，可选） */
  finalThinking?: string;
}

/**
 * 状态分组 - 执行状态和中断信息
 */
interface StateGroup {
  /** 是否需要中断执行（两阶段确认） */
  needInterrupt: boolean;
  /** 中断信息（工具调用ID/名称/参数） */
  interruptInfo?: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  /** 回退状态，控制是否重新执行 */
  retryState: RetryState;
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
  /** 响应分组：LLM响应和最终结果 */
  response: ResponseGroup;
  /** 状态分组：执行状态和中断信息 */
  state: StateGroup;
}

/**
 * 中间件处理函数（Generator 支持）
 */
export type MiddlewareHandler = (
  ctx: MiddlewareContext,
  next: () => Promise<void> | AsyncGenerator<MiddlewareChunk>,
) => AsyncGenerator<MiddlewareChunk>;

/**
 * 中间件 chunk 类型
 */
export type MiddlewareChunk = StreamChunk | InterruptChunk | StagedChunk | DoneChunk;

/**
 * 统一响应 Chunk 结构（流式和非流式）
 */
export interface MessageStreamChunk<T = unknown> {
  /** 当前增量思考 */
  thinkingDelta: string;
  /** 累积思考（可选） */
  thinkingAccumulated?: string;
  /** 当前增量响应 */
  delta: string;
  /** 累积/完整响应（可选） */
  accumulated?: string;
  /** 状态标识 */
  status: "success" | "pending" | "error";
  /** 待确认工具信息（仅 pending 状态） */
  pendingTool?: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  /** 原始响应 */
  raw: T;
}

/**
 * 流式 chunk
 */
export interface StreamChunk {
  type: "stream";
  streamId: string;
  /** 思考增量 */
  thinkingDelta: string;
  /** 响应增量 */
  delta: string;
  thinkingAccumulated: string;
  accumulated: string;
  raw: unknown;
}

/**
 * 中断 chunk（工具两阶段确认）
 */
export interface InterruptChunk {
  type: "interrupt";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
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