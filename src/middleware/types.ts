import type { LLMResponse } from "@/message/index";
import type { MessageProviderAdapterConfig } from "@/message/adapter";
import type { ToolAdapter } from "@/tool/adapter";
import type { ToolManager } from "@/tool/index";
import type { ClientConfigBase } from "@/llm/types";

/**
 * 工具调用累积器（流式工具调用增量累积 + 执行结果）
 */
export interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
  // 执行结果（tool 中间件写入）
  executionResult?: ToolExecutionResult;
  // 待累积的消息（tool 中间件写入）
  resultMessage?: unknown;
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
  toolAdapter: ToolAdapter<unknown, unknown, unknown>;
}

/**
 * Tool 监管等级枚举
 * - auto: 自动执行，无需确认
 * - confirm: 需用户确认后执行
 * - manual: 禁止自动执行，仅手动触发
 */
export enum SupervisionLevel {
  auto = 0,
  confirm = 1,
  manual = 2,
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
export interface SessionGroup {
  /** 会话唯一标识，用于消息累积和状态管理 */
  sessionId: string;
  /** 线程唯一标识，用于同一线程内消息更新而非追加 */
  threadId: string;
}

/**
 * 请求分组 - 本次请求的输入和模式配置
 */
export interface RequestGroup {
  /** 用户输入内容 */
  input: string;
  /** 是否启用流式响应模式 */
  isStream: boolean;
}

/**
 * 处理分组 - 消息处理过程中的累积状态
 */
export interface ProcessGroup {
  /** 历史消息记录，用于构建LLM请求上下文 */
  history: LLMResponse[];
  /** 当前处理的消息列表 */
  messages: unknown[];
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
export interface ToolsGroup {
  /** 工具管理器，负责工具注册和执行 */
  toolManager: ToolManager;
  /** 工具调用累积器Map（流式增量累积 + 执行结果） */
  toolCallAccumulated: Map<string, ToolCallAccumulator>;
  /** 待处理的工具调用列表（非流式模式） */
  pendingToolCalls?: unknown[];
  /** 工具监管等级，决定自动执行策略 */
  supervisionLevel: SupervisionLevel;
}

/**
 * 响应分组 - LLM响应和最终结果
 */
export interface ResponseGroup {
  /** LLM原始响应（非流式模式） */
  raw: unknown;
  /** 最终响应内容（处理完成后） */
  finalContent: string;
  /** 最终思考内容（处理完成后，可选） */
  finalThinking?: string;
  /** 最终响应对象（包含role/content/thinking/toolCalls） */
  finalResponse?: LLMResponse;
}

/**
 * 状态分组 - 执行状态和中断信息
 */
export interface StateGroup {
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
  request: RequestGroup;
  /** 配置分组：LLM客户端配置和选项 */
  config: ClientConfigBase;
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
export type MiddlewareChunk = StreamChunk | InterruptChunk | DoneChunk;

/**
 * 流式 chunk
 */
export interface StreamChunk {
  type: "stream";
  streamId: string;
  thinkingDelta: string;
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
  threadId: string;
}

/**
 * 完成 chunk
 */
export interface DoneChunk {
  type: "done";
  content: string;
  thinking?: string;
  threadId: string;
  raw: unknown;
}

/**
 * LLM Stream Chunk（流式响应）
 */
export type LLMStreamChunk<T = unknown> = {
  streamId: string;
  thinkingDelta: string;
  thinkingAccumulated: string;
  delta: string;
  accumulated: string;
  isDone: boolean;
  raw: T;
};

/**
 * LLM Adapter 接口
 */
export interface llmAdapter {
  name: string;
  chat(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<unknown>;
  chatStream(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
}