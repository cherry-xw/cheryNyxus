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
  | "accept"       // 感官执行成功
  | "rejected"     // 感官执行被拒绝
  | "consumed"     // 消息已消费
  | "loaded"       // 历史对话已载入
  | "done"         // 执行完成
  | "error";       // 错误

// ========== Request Data ==========

export type RequestData =
  | BrainListRequestData
  | SenseListRequestData
  | RuntimeSetRequestData
  | ChatCreateRequestData
  | ChatListRequestData
  | ChatGetRequestData
  | ChatDeleteRequestData
  | ChatSendRequestData
  | ChatResumeRequestData
  | SenseApprovalRequestData;

export interface BrainListRequestData {}

export interface SenseListRequestData {}

export interface ChatCreateRequestData {
  chatId?: string;
  brain: string;
  senseGroups: string[];
}

export interface ChatListRequestData {}

export interface ChatGetRequestData {
  chatId: string;
}

export interface ChatDeleteRequestData {
  chatId: string;
}

export interface ChatSendRequestData {
  chatId: string;
  prompt: string;
}

export interface RuntimeSetRequestData {
  chatId: string;
  brain: string;
  senseGroups: string[];
}

export interface ChatResumeRequestData {
  chatId: string;
}

export interface SenseApprovalRequestData {
  approvalId: string;
  action: "accept" | "reject";
  reason?: string;
}

// ========== Response Data ==========

export type ResponseData =
  | BrainListResponseData
  | SenseListResponseData
  | RuntimeSetResponseData
  | ChatCreateResponseData
  | ChatListResponseData
  | ChatGetResponseData
  | ChatDeleteResponseData
  | ChatSendResponseData
  | ChatResumeResponseData
  | SenseApprovalResponseData;

export interface BrainListResponseData {
  brains: Array<{
    name: string;
    provider: string;
    model: string;
    thinking?: boolean;
    senseGroups?: string | string[];
  }>;
}

export interface SenseListResponseData {
  senseGroups: Array<{
    name: string;
    supervision?: SupervisionLevel;
    senses: string[];
  }>;
}

export interface ChatCreateResponseData {
  chatId: string;
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
  /** 末条为 pending sense 时 true，前端据此发起 chat.resume 撤回重跑 */
  canResume?: boolean;
}

export interface ChatDeleteResponseData {
  chatId: string;
}

export interface ChatSendResponseData {
  chatId: string;
}

export interface RuntimeSetResponseData {
  chatId: string;
  brain: string;
  senseGroups: string[];
}

export interface ChatResumeResponseData {
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
  type: "thinking_end" | "content_end" | "sense_end" | "reverse";
  /** 消息角色，用于区分消息来源（chat.get历史返回时使用） */
  role?: "user" | "assistant" | "system" | "sense";
  thinking?: string;
  content?: string;
  senseName?: string;
  arguments?: string;
  /** sense 调用 id（= trigger.id = sense message.id），用于前端关联 sense_end 与 role:sense 的 result content_end */
  id?: string;
  /** reverse 类型：被撤回的消息 id 列表（chat.send 恢复撤回整个当前周期时携带） */
  messageIds?: string[];
  /** 感官去重：该消息已被后续相同 hash 调用替换（chat.get 历史返回时携带，content 仍为原内容） */
  replace?: { state: boolean; by: string; content: string };
  /** 被替换时的原内容（溯源/前端展示） */
  originalContent?: string;
}

// ========== Notification Data ==========

export type NotificationData =
  | InterruptNotificationData
  | AcceptNotificationData
  | RejectedNotificationData
  | ConsumedNotificationData
  | ErrorNotificationData
  | null;

export interface InterruptNotificationData {
  approvalId: string;
  senseName: string;
  arguments: string;
  supervisionLevel: SupervisionLevel;
  needsApproval: boolean;
}

export interface AcceptNotificationData {
  approvalId: string;
  senseName: string;
  result: string;
}

export interface RejectedNotificationData {
  approvalId: string;
  senseName: string;
  reason: string;
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
  // Brain / Sense 列表
  BRAIN_LIST: "brain.list",
  SENSE_LIST: "sense.list",

  // Runtime 设置（每轮可换，必须原子携带 brain + senseGroups）
  RUNTIME_SET: "runtime.set",

  // Chat 管理
  CHAT_CREATE: "chat.create",
  CHAT_LIST: "chat.list",
  CHAT_GET: "chat.get",
  CHAT_DELETE: "chat.delete",
  CHAT_SEND: "chat.send",
  CHAT_RESUME: "chat.resume",

  // Sense 审批
  SENSE_APPROVAL: "sense.approval",
} as const;

// ========== 错误码常量 ==========

export const ErrorCode = {
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
