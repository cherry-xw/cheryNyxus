import { randomUUID } from "crypto";
import { SupervisionLevel } from "@/core/config.js";
import type { McpServerInfo } from "@/core/mcp/types.js";
import type { RuntimeSelection } from "@/agent/runtimeResolver.js";
import type { ConfigRaw } from "@/utils/config.js";

// ========== 消息基础类型 ==========

/**
 * 请求消息（C→S）
 */
export interface Request {
  id: string;
  kind: "request";
  method: Method;
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
  | "replaced"     // 感官去重命中：历史 sense 结果被新读取替换
  | "subagent_created"   // 子 agent 派发（spawn_subagent sense 执行时推送给主 chat 所属连接）
  | "subagent_destroyed"; // 子 agent 销毁（destroy_subagent sense 执行时推送给主 chat 所属连接，CP6）

// ========== Request Data ==========

export type RequestData =
  | BrainListRequestData
  | SenseListRequestData
  | SenseToolsRequestData
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
  | McpReloadRequestData
  | SubagentResultRequestData
  | ConfigGetRequestData
  | ConfigSaveRequestData;

export interface BrainListRequestData {}

export interface SenseListRequestData {}

export interface SenseToolsRequestData {}

export interface ChatCreateRequestData {
  chatId?: string;
  brain: string;
  senseGroups: string[];
  /** 启用的 MCP server 名（绕过 sense_groups，其全部 tools 合并进 schema）。缺省 []。 */
  mcpServers?: string[];
  /** 子 agent 关联主 chat 的 chatId；主 chat 不携带（DB 存 NULL）。主从 Agent 桌宠系统 CP1。 */
  parentChatId?: string;
}

export interface ChatListRequestData {
  /**
   * true：每项增返 preview（首条 user 消息截断）+ turnCount（user 消息数），供会话列表渲染。
   * 省略/false：lean，不查 messages，供初始化重建 pet 树（免 N+1）。CP8。
   */
  includePreview?: boolean;
}

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

/**
 * subagent.result：spawn wait=true 的结果回传通道（前端→后端）。
 * 前端跑完子 agent → 调本方法 → 后端据 chatId 唤醒主 agent 挂起的 spawn Promise。
 */
export interface SubagentResultRequestData {
  /** 子 chat id（spawn_subagent sense 在 subagent_created notification 中推送的 chatId） */
  chatId: string;
  /** 子 agent 最终 content（主 agent 唤醒后作 spawn sense 的 result） */
  content: string;
}

// ---------- Config 设置（config.get / config.save）----------

/** config.get 请求：空参 */
export interface ConfigGetRequestData {}

/** config.save 入参：除 server 外全部字段（结构同 ConfigRaw，supervision 为字符串、key 为 $ENV 占位符） */
export type ConfigSaveRequestData = ConfigRaw;

// ========== Response Data ==========

export type ResponseData =
  | BrainListResponseData
  | SenseListResponseData
  | SenseToolsResponseData
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
  | McpReloadResponseData
  | SubagentResultResponseData
  | ConfigGetResponseData
  | ConfigSaveResponseData;

export interface BrainListResponseData {
  brains: Array<{
    name: string;
    provider: string;
    model: string;
    thinking?: boolean;
    /** 上下文长度上限（token），供前端 context bar 显示用量。缺省 undefined */
    contextLimit?: number;
    /** 是否为 config.default.brain（前端 AgentDialog 无 runtime 时预选默认 brain） */
    default?: boolean;
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

/**
 * sense.tools 响应：代码维护的全部内置工具元信息。
 * name=原名（作 sense_groups 条目 key，如 "execute_command"）；
 * label=中文名（UI 显示）；description=解释（tooltip）。
 * 自定义/外部/MCP 工具不在内，前端组合框允许自由输入。
 */
export interface SenseToolMeta {
  name: string;
  label: string;
  description: string;
}

export interface SenseToolsResponseData {
  tools: SenseToolMeta[];
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
    /**
     * 子 agent 关联主 chat 的 chatId；主 chat 为 null。
     * 前端据此溯源重建 pet 树（主 chat → 主 pet，子 chat 挂主 pet 附近）。CP1。
     */
    parentChatId: string | null;
    /**
     * 首条 user 消息截断（≤40 字符），供会话列表辨识。"指令"跳过规则待定（默认取首条 user 消息）。
     * 仅 includePreview=true 时返。CP8。
     */
    preview?: string;
    /**
     * user 角色消息数 = 会话轮次。仅 includePreview=true 时返。CP8。
     */
    turnCount?: number;
    /**
     * 子 agent 是否已完成（metadata.finished 解析）。前端据 finished===true 重建子 pet 为 ghost（灵魂态）。
     * 主 chat 恒 undefined。无论 includePreview 与否都返（initFromChats 重建 pet 树需）。
     */
    finished?: boolean;
  }>;
}

export interface ChatGetResponseData {
  chatId: string;
  /** 末条为 pending sense 时 true，前端据此发起 chat.resume 撤回重跑 */
  canResume?: boolean;
  /**
   * 当前 chat 上下文 token 用量比例（0-1，相对 brain.contextLimit）。
   * 历史载入时返，前端据此更新 pet.contextUsage（ContextBar 渲染）。CP7。
   */
  contextUsage?: number;
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

/**
 * subagent.result 响应（spawn wait=true 回传）。
 * matched=false 表示 chatId 无挂起的 spawn（误调或 wait=false 场景）。
 */
export interface SubagentResultResponseData {
  chatId: string;
  matched: boolean;
}

/**
 * config.get 响应：.chery/config.yaml 原文（除 server 段）。
 * supervision 为字符串、key 仍为 $ENV 占位符、无路径补全（供设置面板编辑）。
 */
export type ConfigGetResponseData = ConfigRaw;

/**
 * config.save 响应：校验通过已写盘，需重启后端生效。
 * 校验失败走 error（INVALID_PARAMS + errors 列表），不返此 data。
 */
export interface ConfigSaveResponseData {
  needRestart: true;
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
  /** content_end 携带：user=发送时配置（messages.runtime），assistant=前一条 user runtime（后端关联）。供前端 hover 历史消息显该消息用的 brain/工具 */
  runtime?: RuntimeSelection;
  /** 消息创建时间戳（ms），用于合并多 chat 历史时按时间排序 */
  createdAt?: number;
}

// ========== Notification Data ==========

export type NotificationData =
  | InterruptNotificationData
  | AcceptNotificationData
  | RejectedNotificationData
  | ConsumedNotificationData
  | ErrorNotificationData
  | ReplacedNotificationData
  | SubagentCreatedNotificationData
  | SubagentDestroyedNotificationData
  | DoneNotificationData
  | null;

export interface InterruptNotificationData {
  approvalId: string;
  senseName: string;
  arguments: string;
  supervisionLevel: SupervisionLevel;
  needsApproval: boolean;
  /** 审批等待时长（ms，= global.approval_timeout）。前端据此与 createdAt 算倒计时。仅 needsApproval=true 时有意义。 */
  waitTime: number;
  /** 审批发起时间戳（ms，Date.now()）。前端倒计时 = waitTime - (now - createdAt)。 */
  createdAt: number;
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

/**
 * chat.send/resume loop 结束（done notification data）。CP7。
 * contextUsage = 当前 chat 总 token / brain.contextLimit（0-1），前端据实时更新 pet.contextUsage。
 */
export interface DoneNotificationData {
  contextUsage: number;
  /**
   * 子 agent done 标记（仅子 chat 即 parent_chat_id 非空时携带=true）。
   * 前端据 finished===true 把子 pet 转 ghost（灵魂态）。主 chat 不带。done 时后端写 metadata.finished 持久化。
   */
  finished?: boolean;
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

/**
 * 子 agent 派发（spawn_subagent sense 执行时推送）。
 * 前端据 type+prompt 创建子 pet 并驱动子 chat（前端驱动架构，见 docs/agent-pet.md §2/§5.1）。
 * requestId 为主 chat id（spawn_subagent sense 无法取主 agent 当前 WS requestId，前端按 chatId 路由）。
 */
export interface SubagentCreatedNotificationData {
  /** 子 chat id（前端据此驱动子 chat.send） */
  chatId: string;
  /** 主 chat id（前端溯源 pet 树） */
  parentChatId: string;
  /** 子 agent 类型（config.subagents 键名） */
  type: string;
  /** 交付子 agent 的任务 prompt */
  prompt: string;
  /** 子 agent 用的 brain 名 */
  brain: string;
  /** 子 agent 启用的感官组 */
  senseGroups: string[];
  /** 是否等待结果（true: 前端跑完须调 subagent.result 回传；false: 立即派发不等待） */
  wait: boolean;
}

/**
 * 子 agent 销毁（destroy_subagent sense 执行时推送，CP6）。
 * 前端据 chatId 移除对应子 pet 并关闭子 chat UI。
 * requestId 为主 chat id（与 subagent_created 同路由规则）。
 */
export interface SubagentDestroyedNotificationData {
  /** 被销毁的子 chat id */
  chatId: string;
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
  // 列出代码维护的全部内置工具（name/label/description），供设置面板感官分组下拉
  SENSE_TOOLS: "sense.tools",

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

  // 子 agent 结果回传（spawn wait=true 时前端跑完子 agent → 调本方法唤醒主 agent）
  SUBAGENT_RESULT: "subagent.result",

  // Config 设置（读写 .chery/config.yaml，除 server 段，重启生效）
  CONFIG_GET: "config.get",
  CONFIG_SAVE: "config.save",
} as const;

/**
 * Method 类型别名：所有合法 method 字符串的联合。
 * Request.method 用此类型（非裸 string），router.register 据 Method 约束注册键。
 */
export type Method = (typeof Method)[keyof typeof Method];

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
