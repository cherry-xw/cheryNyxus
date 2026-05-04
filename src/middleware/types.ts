import type { LLMResponse } from "@/message/index";
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
 * 中间件上下文
 */
export interface MiddlewareContext {
  sessionId: string;
  threadId: string;
  input: string;
  config: ClientConfigBase;
  isStream: boolean;
  history: LLMResponse[];
  messages: unknown[];
  toolManager: ToolManager;
  toolCallAccumulated: Map<string, ToolCallAccumulator>;
  supervisionLevel: SupervisionLevel;
  needInterrupt: boolean;
  interruptInfo?: {
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  };
  accumulated: string;
  thinkingAccumulated: string;
  chunkCount: number;
  response: unknown;
  streamIterator?: AsyncIterable<unknown>;
  options?: Record<string, unknown>;
  finalContent: string;
  finalThinking?: string;
  finalResponse?: LLMResponse;
  // 回退相关字段
  retryState: RetryState;
  // toolExecutionResult 已嵌入 toolCallAccumulated 中，通过 toolCallId 查询
  pendingToolCalls?: unknown[];
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
 * Provider Adapter 接口
 */
export interface llmAdapter {
  name: string;
  chat(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<unknown>;
  chatStream(messages: unknown[], tools: unknown[], options?: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
}