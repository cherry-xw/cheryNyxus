import { randomUUID } from "crypto";
import { SupervisionLevel } from "@/core/config.js";
import type { McpServerInfo } from "@/core/mcp/types.js";

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
  | "error"        // 错误
  | "replaced";    // 感官去重命中：历史 sense 结果被新读取替换

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
  | SenseApprovalRequestData
  | ChatAbortRequestData
  | BashKillRequestData
  | BashListRequestData
  | McpListRequestData
  | McpGetRequestData
  | McpConnectRequestData
  | McpDisconnectRequestData
  | McpReloadRequestData;

export interface BrainListRequestData {}

export interface SenseListRequestData {}

export interface ChatCreateRequestData {
  chatId?: string;
  brain: string;
  senseGroups: string[];
  /** 启用的 MCP server 名（绕过 sense_groups，其全部 tools 合并进 schema）。缺省 []。 */
  mcpServers?: string[];
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
  /** 启用的 MCP server 名。缺省 []（关闭所有 MCP）。 */
  mcpServers?: string[];
}

export interface ChatResumeRequestData {
  chatId: string;
}

export interface SenseApprovalRequestData {
  approvalId: string;
  action: "accept" | "reject";
  reason?: string;
}

export interface ChatAbortRequestData {
  chatId: string;
}

export interface BashKillRequestData {
  chatId: string;
  pid: number;
}

export interface BashListRequestData {
  chatId: string;
}

// ---------- MCP 管理（连接层）----------

export interface McpListRequestData {}

export interface McpGetRequestData {
  name: string;
}

export interface McpConnectRequestData {
  name: string;
}

export interface McpDisconnectRequestData {
  name: string;
}

/**
 * mcp.reload：name 给出→原子重载单个 server；name 省略→全量重载（重读 config）。
 */
export interface McpReloadRequestData {
  name?: string;
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
  | SenseApprovalResponseData
  | ChatAbortResponseData
  | BashKillResponseData
  | BashListResponseData
  | McpListResponseData
  | McpGetResponseData
  | McpConnectResponseData
  | McpDisconnectResponseData
  | McpReloadResponseData;

export interface BrainListResponseData {
  brains: Array<{
    name: string;
    provider: string;
    model: string;
    thinking?: boolean;
    senseGroups?: string | string[];
  }>;
  /** 当前已连接的 MCP server 名（供前端按 server 渲染开关） */
  mcpServers: string[];
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
  /** 回显已生效的 runtime selection（含 MCP 开关） */
  brain: string;
  senseGroups: string[];
  mcpServers: string[];
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
  mcpServers: string[];
}

export interface ChatResumeResponseData {
  chatId: string;
}

export interface SenseApprovalResponseData {
  approvalId: string;
  action: string;
}

export interface ChatAbortResponseData {
  chatId: string;
}

/**
 * 挂起 bash 进程信息（bash.list 返回）。
 * 结构对齐 agent/sense/processRegistry.ts BashProcessEntry（service 层不反向依赖 agent，独立定义）。
 */
export interface BashProcessInfo {
  pid: number;
  command: string;
  description: string;
  startedAt: number;
  /** 是否已被显式 kill（区分自然结束）。 */
  killed: boolean;
}

export interface BashKillResponseData {
  chatId: string;
  pid: number;
  /** 是否命中注册表并发送了 kill 信号（false = 该 pid 已不在挂起表中）。 */
  killed: boolean;
}

export interface BashListResponseData {
  chatId: string;
  processes: BashProcessInfo[];
}

export interface McpListResponseData {
  servers: McpServerInfo[];
}

export interface McpGetResponseData {
  server: McpServerInfo;
}

export interface McpConnectResponseData {
  server: McpServerInfo;
}

export interface McpDisconnectResponseData {
  server: McpServerInfo;
}

/**
 * mcp.reload 返回：全量 server 列表 + 本次操作汇总。
 * - 全量重载：connected/failed/totalSenses 覆盖所有 server。
 * - 单 server 重载：connected∈{0,1}、failed∈{0,1}、totalSenses 为该 server 注册数；servers 为重载后全量列表。
 */
export interface McpReloadResponseData {
  servers: McpServerInfo[];
  connected: number;
  failed: number;
  totalSenses: number;
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
  | ReplacedNotificationData
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

/**
 * 感官去重命中（read_file hash 相同 = 文件未变动）：
 * 历史 sense 结果被新读取替换。web 据此实时更新对应历史 sense block。
 */
export interface ReplacedNotificationData {
  /** 被替换的历史 sense message id（= sense call id） */
  id: string;
  /** 替换后的说明文字（主显，剔除冗长重复内容） */
  content: string;
  /** 原长内容（折叠溯源） */
  originalContent: string;
  /** 触发替换的新 sense id */
  by: string;
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
  // Chat 中止（切换 chat：清内存 + 退出挂起 generator，不动 DB，pending 保留供下次重新审核）
  CHAT_ABORT: "chat.abort",

  // Bash 进程管理（挂起子进程的查询 / 显式杀死）
  BASH_LIST: "bash.list",
  BASH_KILL: "bash.kill",

  // MCP 管理（连接层热重载：list/get/connect/disconnect/reload）
  MCP_LIST: "mcp.list",
  MCP_GET: "mcp.get",
  MCP_CONNECT: "mcp.connect",
  MCP_DISCONNECT: "mcp.disconnect",
  MCP_RELOAD: "mcp.reload",
} as const;

// ========== 错误码常量 ==========

export const ErrorCode = {
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INTERNAL: "INTERNAL",
  TIMEOUT: "TIMEOUT",
  // MCP 管理：资源不存在 / 参数非法（handler 显式返回，非抛错走 INTERNAL）
  NOT_FOUND: "NOT_FOUND",
  INVALID_PARAMS: "INVALID_PARAMS",
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
