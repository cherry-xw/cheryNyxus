import { randomUUID } from "crypto";

// ========== 消息基础类型 ==========

/**
 * 请求消息（C→S）
 */
export interface Request {
  id: string;
  kind: "request";
  method: string;
  params: RequestData;
}

/**
 * 响应消息（S→C，请求返回）
 */
export interface Response {
  id: string;
  kind: "response";
  requestId: string;
  success: boolean;
  data?: ResponseData;
  error?: RpcError;
}

/**
 * Chunk消息（S→C，流式增量）
 */
export interface Chunk {
  kind: "chunk";
  type: "stream" | "staged";
  requestId: string;
  seq?: number;
  data: ChunkData;
}

/**
 * Notification消息（S→C，服务端推送）
 */
export interface Notification {
  kind: "notification";
  type: NotificationType;
  requestId: string;
  data: NotificationData;
}

export type NotificationType =
  | "interrupt"    // 工具中断（待审批）
  | "complete"     // 工具执行结果
  | "consumed"     // 消息已消费
  | "done"         // 执行完成
  | "error";       // 错误

// ========== Request Data ==========

export type RequestData =
  | ExecuteRequestData
  | ApprovalRequestData
  | ThreadRequestData
  | ToolRequestData;

export interface ExecuteRequestData {
  sessionId: string;
  threadId?: string;
  prompt: string;
}

export interface ApprovalRequestData {
  sessionId: string;
  interruptId: string;
  action: "accept" | "reject";
  reason?: string;
}

export interface ThreadRequestData {
  sessionId?: string;
  threadId?: string;
}

export interface ToolRequestData {
  name?: string;
}

// ========== Response Data ==========

export type ResponseData =
  | ExecuteResponseData
  | ApprovalResponseData
  | ThreadResponseData
  | PendingResponseData;

export interface ExecuteResponseData {
  threadId: string;
}

export interface ApprovalResponseData {
  interruptId: string;
  action: string;
  result?: string;
}

export interface ThreadResponseData {
  threadId?: string;
  messages?: unknown[];
}

export interface PendingResponseData {
  messages: Array<{ content: string; time: number }>;
}

// ========== Chunk Data ==========

export type ChunkData = StreamChunkData | StagedChunkData;

export interface StreamChunkData {
  thinking?: string;
  content?: string;
  toolCall?: ToolCallDelta[];
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StagedChunkData {
  type: "thinking_end" | "content_end" | "tool_trigger";
  thinking?: string;
  content?: string;
}

// ========== Notification Data ==========

export type NotificationData =
  | InterruptNotificationData
  | CompleteNotificationData
  | ConsumedNotificationData
  | ErrorNotificationData
  | null;

export interface InterruptNotificationData {
  interruptId: string;
  toolName: string;
  arguments: string;
  supervisionLevel: string;
}

export interface CompleteNotificationData {
  interruptId: string;
  toolName: string;
  result: string;
}

export interface ConsumedNotificationData {
  count: number;
}

export interface ErrorNotificationData {
  message: string;
}

// ========== Error ==========

export interface RpcError {
  code: string;
  message: string;
}

// ========== 方法常量 ==========

export const Method = {
  // Agent 管理
  AGENT_CREATE: "agent.create",
  AGENT_DELETE: "agent.delete",
  AGENT_LIST: "agent.list",
  AGENT_SESSION: "agent.session",

  // Agent 执行
  AGENT_EXECUTE: "agent.execute",

  // Tool 审批
  APPROVAL_TOOL: "agent.approval_tool",

  // Thread 管理
  THREAD_CREATE: "thread.create",
  THREAD_GET: "thread.get",
  THREAD_HISTORY: "thread.history",
  THREAD_DELETE: "thread.delete",
  THREAD_LIST: "thread.list",
  THREAD_CLEAR: "thread.clear",

  // Tool 管理
  TOOL_COMPILE: "tool.compile",
  TOOL_LIST: "tool.list",

  // Interrupt
  INTERRUPT_LIST: "interrupt.list",
  INTERRUPT_RESUME: "interrupt.resume",
} as const;

// ========== 错误码常量 ==========

export const ErrorCode = {
  INVALID_PARAMS: "INVALID_PARAMS",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INTERNAL: "INTERNAL",
  TIMEOUT: "TIMEOUT",
} as const;

// ========== 工厂函数 ==========

export function createRequest(method: string, params: RequestData): Request {
  return {
    id: randomUUID(),
    kind: "request",
    method,
    params,
  };
}

export function createResponse(
  requestId: string,
  success: boolean,
  data?: ResponseData,
  error?: RpcError,
): Response {
  return {
    id: randomUUID(),
    kind: "response",
    requestId,
    success,
    data,
    error,
  };
}

export function createChunk(
  type: "stream" | "staged",
  requestId: string,
  data: ChunkData,
  seq?: number,
): Chunk {
  return {
    kind: "chunk",
    type,
    requestId,
    seq,
    data,
  };
}

export function createNotification(
  type: NotificationType,
  requestId: string,
  data: NotificationData,
): Notification {
  return {
    kind: "notification",
    type,
    requestId,
    data,
  };
}

export function createError(code: string, message: string): RpcError {
  return { code, message };
}

// ========== 类型守卫 ==========

export function isRequest(msg: unknown): msg is Request {
  return typeof msg === "object" && msg !== null && (msg as { kind?: string }).kind === "request";
}

export function isResponse(msg: unknown): msg is Response {
  return typeof msg === "object" && msg !== null && (msg as { kind?: string }).kind === "response";
}

export function isChunk(msg: unknown): msg is Chunk {
  return typeof msg === "object" && msg !== null && (msg as { kind?: string }).kind === "chunk";
}

export function isNotification(msg: unknown): msg is Notification {
  return typeof msg === "object" && msg !== null && (msg as { kind?: string }).kind === "notification";
}