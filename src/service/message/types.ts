import { randomUUID } from "crypto";
import { SupervisionLevel } from "@/core/config.js";

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
  | "interrupt"    // 感官审批请求
  | "complete"     // 感官执行结果
  | "consumed"     // 消息已消费
  | "loaded"       // 历史对话已载入
  | "done"         // 执行完成
  | "error";       // 错误

// ========== Request Data ==========

export type RequestData =
  | SoulCreateRequestData
  | SoulDeleteRequestData
  | SoulLoadRequestData
  | ChatListRequestData
  | ChatGetRequestData
  | ChatDeleteRequestData
  | ChatSendRequestData
  | SenseApprovalRequestData;

export interface SoulCreateRequestData {
  brain: string;
  soulId?: string;
}

export interface SoulDeleteRequestData {
  soulId: string;
}

export interface SoulLoadRequestData {
  soulId: string;
}

export interface ChatListRequestData {
  soulId: string;
}

export interface ChatGetRequestData {
  chatId: string;
}

export interface ChatDeleteRequestData {
  chatId: string;
}

export interface ChatSendRequestData {
  soulId: string;
  chatId?: string;
  prompt: string;
}

export interface SenseApprovalRequestData {
  soulId: string;
  approvalId: string;
  action: "accept" | "reject";
  reason?: string;
}

// ========== Response Data ==========

export type ResponseData =
  | SoulCreateResponseData
  | SoulDeleteResponseData
  | SoulListResponseData
  | SoulLoadResponseData
  | ChatListResponseData
  | ChatGetResponseData
  | ChatDeleteResponseData
  | ChatSendResponseData
  | SenseApprovalResponseData;

export interface SoulCreateResponseData {
  soulId: string;
  config: {
    provider: string;
    model: string;
    sense_group?: string | string[];
  };
  createdAt: number;
}

export interface SoulDeleteResponseData {
  soulId: string;
}

export interface SoulListResponseData {
  souls: Array<{
    soulId: string;
    config: {
      provider: string;
      model: string;
      sense_group?: string | string[];
    };
    createdAt: number;
  }>;
}

export interface SoulLoadResponseData {
  soulId: string;
  config: {
    provider: string;
    model: string;
    sense_group?: string | string[];
  };
  createdAt: number;
  chats: Array<{
    chatId: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
  }>;
  pendingApprovals: Array<{
    approvalId: string;
    chatId: string;
    createdAt: number;
    senseCalls: Array<{
      id: string;
      name: string;
      arguments: string;
      approved: boolean;
      triggeredAt: number;
    }>;
  }>;
}

export interface ChatListResponseData {
  chats: Array<{
    chatId: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
  }>;
}

export interface ChatGetResponseData {
  chatId: string;
}

export interface ChatDeleteResponseData {
  chatId: string;
}

export interface ChatSendResponseData {
  chatId: string;
}

export interface SenseApprovalResponseData {
  approvalId: string;
  action: string;
}

// ========== Chunk Data ==========

export type ChunkData = StreamChunkData | StagedChunkData;

export interface StreamChunkData {
  thinking?: string;
  content?: string;
  senseCall?: SenseCallDelta[];
}

export interface SenseCallDelta {
  index?: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StagedChunkData {
  type: "thinking_end" | "content_end" | "sense_end";
  thinking?: string;
  content?: string;
  senseName?: string;
  arguments?: string;
}

// ========== Notification Data ==========

export type NotificationData =
  | InterruptNotificationData
  | CompleteNotificationData
  | ConsumedNotificationData
  | ErrorNotificationData
  | null;

export interface InterruptNotificationData {
  approvalId: string;
  senseName: string;
  arguments: string;
  supervisionLevel: SupervisionLevel;
}

export interface CompleteNotificationData {
  approvalId: string;
  senseName: string;
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
  // Soul 管理
  SOUL_CREATE: "soul.create",
  SOUL_DELETE: "soul.delete",
  SOUL_LIST: "soul.list",
  SOUL_LOAD: "soul.load",

  // Chat 管理
  CHAT_LIST: "chat.list",
  CHAT_GET: "chat.get",
  CHAT_DELETE: "chat.delete",
  CHAT_SEND: "chat.send",

  // Sense 审批
  SENSE_APPROVAL: "sense.approval",

  // Approval 管理
  APPROVAL_LIST: "approval.list",
  APPROVAL_RESUME: "approval.resume",

  // Sense 管理
  SENSE_COMPILE: "sense.compile",
  SENSE_LIST: "sense.list",
} as const;

// ========== 错误码常量 ==========

export const ErrorCode = {
  INVALID_PARAMS: "INVALID_PARAMS",
  NOT_FOUND: "NOT_FOUND",
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  SOUL_HAS_CHATS: "SOUL_HAS_CHATS",
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
