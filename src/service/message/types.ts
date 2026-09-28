import type {
  Request,
  Response,
  Chunk,
  Notification,
  EventContext,
  NotificationType,
  ChunkData,
} from './types/events.js'
import type { NotificationData } from './types/notification.js'
import type { ResponseData } from './types/methods.js'
import { randomUUID } from 'crypto'
import type { SupervisionLevel } from '@/core/config.js'
import type { ErrorSource, ProtocolError } from '@chery/protocol'
import { ErrorCode as ProtocolErrorCode } from '@chery/protocol'
import { feedbackForRpcError } from '../errorCatalog.js'

export type * from './types/events.js'

// ========== Request Data ==========

/** 严格空对象：用于无参数请求与无 data 成功响应，避免裸 `{}` 吞并联合成员。 */
export type EmptyObjectData = Record<string, never>

export type BrainListRequestData = EmptyObjectData

export type SenseListRequestData = EmptyObjectData

export type SenseToolsRequestData = EmptyObjectData

/**
 * sense.tools.docs 请求：统一获取内置工具的完整说明文档。
 * 省略 tools（或传空数组）= 全量返回；提供 tools = 后端按 name 列表一次性返回对应说明。
 */
export interface SenseToolsDocsRequestData {
  /** 需要的工具 name 列表；省略或空 = 全量。未知 name 自动忽略，不报错。 */
  tools?: string[]
}

/** skills.list：列出用户配置目录中当前可用的 Skill 元数据。支持可选分页与搜索。 */
export interface SkillsListRequestData {
  /** 1-based 页码；省略或 1 = 第一页；未给 pageSize 时忽略（返回全量）。 */
  page?: number
  /** 每页条数；默认 50，最大 200；未给 page 时忽略（返回全量）。 */
  pageSize?: number
  /** 按名称/描述/触发词模糊搜索（大小写不敏感）。 */
  search?: string
  /**
   * 插件过滤：undefined 或省略 = 仅独立 skill；"*" = 全部；具体字符串 = 该插件下的 skill。
   * 与 SkillFilter 互补：SkillFilter 用于 per-role 白名单，此参数用于 UI 列表展示过滤。
   */
  plugin?: string
}

export type PromptsListRequestData = EmptyObjectData
export type RulesListRequestData = EmptyObjectData

export type * from './types/chat.js'

export type * from './types/settingsRequests.js'

// ========== Response Data ==========

export interface BrainListResponseData {
  brains: Array<{
    name: string
    provider: string
    protocol?: import('@chery/protocol').LlmProtocol
    model: string
    thinking?: import('@/core/llm/adapter.js').ThinkingLevel
    capabilities?: import('@/utils/config.js').BrainCapabilities
    /** 上下文长度上限（token），供前端 context bar 显示用量。缺省 undefined */
    contextLimit?: number
    /** 是否为「默认」预设 leader 角色的 brain（前端 AgentDialog 无 runtime 时预选默认 brain） */
    default?: boolean
    senseGroups?: string | string[]
  }>
  /** 当前已连接的 MCP server 名（供前端按 server 渲染开关） */
  mcpServers: string[]
}

export interface SenseListResponseData {
  senseGroups: Array<{
    name: string
    supervision?: SupervisionLevel
    senses: string[]
  }>
}

/**
 * sense.tools 响应：代码维护的全部内置工具元信息。
 * name=原名（作 sense_groups 条目 key，如 "execute_command"）；
 * label=中文名（UI 显示）；description=解释（tooltip）。
 * 自定义/外部/MCP 工具不在内，前端组合框允许自由输入。
 * accepts/produces/preprocess：工具能力声明（来自已注册 sense 实例的 capabilities），
 * 供发送门控判断「感官组是否有可处理某媒体类型的工具」。
 */
export interface SenseToolMeta {
  name: string
  label: string
  description: string
  /** glyph/emoji 字符串（pet bar 运行中工具图标用）。非内置工具前端 fallback ⚙。 */
  icon: string
  /** 接收的媒体类型（image/video/audio）或文件后缀（doc/docx/pdf…） */
  accepts?: string[]
  /** 产出的媒体类型（image/video/audio）或 text */
  produces?: string[]
  /** 是否前置执行（缺省 false = 普通后置工具） */
  preprocess?: boolean
}

export interface SenseToolsResponseData {
  tools: SenseToolMeta[]
}

/**
 * sense.tools.docs 单项：内置工具的完整说明文档。
 * doc 按【作用】【能力】【边界】【注意】分节，换行分隔；前端 hover 悬浮按 pre-line 展示。
 * 文档在工具开发阶段统一定义于 BUILTIN_SENSE_TOOLS.doc，sense.tools.docs 只是统一出口，
 * 前端一次拉取缓存即可，无需每次展示都重新提取。
 */
export interface SenseToolDoc {
  name: string
  doc: string
}

export interface SenseToolsDocsResponseData {
  docs: SenseToolDoc[]
}

export type * from './types/skills.js'

export type * from './types/plugins.js'

// ========== 凭据池（通用） ==========

/** 凭据池条目（密令永不回前端）。 */
export interface CredentialListItemDTO {
  id: string
  label: string
  username: string
  createdAt: string
}

/** credentials.list：列出全部已存凭据（仅 id/label/username）。 */
export type CredentialsListRequestData = EmptyObjectData
export interface CredentialsListResponseData {
  credentials: CredentialListItemDTO[]
}

/** credentials.save：加密入池（密令后端 AES-256-GCM 加密，不入日志——schema 字段名 password 自动脱敏）。 */
export interface CredentialsSaveRequestData {
  label: string
  username: string
  password: string
}
export interface CredentialsSaveResponseData {
  credential: CredentialListItemDTO
}

/** credentials.delete：从池中删除。 */
export interface CredentialsDeleteRequestData {
  id: string
}
export interface CredentialsDeleteResponseData {
  ok: true
}

/**
 * prompts.list 响应：.chery/prompt/ 下全部 .md 的相对路径（相对 .chery/，含 prompt/ 前缀，排除全局 base system.md）。
 * 供设置面板 systemPrompt 级联选择器建目录树；叶 value = 全路径 = 存储值。
 */
export interface PromptsListResponseData {
  prompts: string[]
}

/**
 * rules.list 响应：.chery/rule/ 下全部 .yaml 文件名（**排除基准 base.yaml**），供设置面板预设 tab
 * 「规则文件」下拉填充。目录为空/不存在 → []。
 */
export interface RulesListResponseData {
  rules: string[]
}

export type * from './types/chatSnapshots.js'

export type * from './types/chatTimeline.js'

export type * from './types/chatResponses.js'

export type * from './types/settingsResponses.js'

export type * from './types/events.js'

export type * from './types/notification.js'

// ========== Error ==========

export interface RpcError extends ProtocolError {}

export { Method } from './types/methods.js'
export type * from './types/methods.js'

// Public error codes are defined once in @chery/protocol and re-exported here
// for existing service imports.
export const ErrorCode = ProtocolErrorCode

// ========== 工厂函数 ==========

export function createResponse<TData extends ResponseData = ResponseData>(
  requestId: string,
  success: boolean,
  data?: TData,
  error?: RpcError,
): Response<TData> {
  return {
    id: randomUUID(),
    kind: 'response',
    requestId,
    success,
    data,
    error,
  }
}

export function createChunk(
  type: 'stream' | 'staged' | 'route',
  requestId: string,
  data: ChunkData,
  context: EventContext = {},
): Chunk {
  return {
    kind: 'chunk',
    type,
    requestId,
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    data,
  }
}

export function createNotification(
  type: NotificationType,
  requestId: string | undefined,
  data: NotificationData,
  context: EventContext = {},
): Notification {
  return {
    kind: 'notification',
    type,
    ...(requestId ? { requestId } : {}),
    ...(context.chatId ? { chatId: context.chatId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    data,
  }
}

export function createError(
  code: string,
  message: string,
  options: {
    source?: ErrorSource
    retryable?: boolean
    tracingId?: string
    retryAfterMs?: number
  } = {},
): RpcError {
  const embeddedTrace = /^\[([0-9a-f]{8})\]\s/i.exec(message)?.[1]
  const retryableByCode =
    code === ErrorCode.TIMEOUT || code === ErrorCode.RATE_LIMITED || code === ErrorCode.CONFLICT
  const source = options.source ?? 'system'
  const retryable = options.retryable ?? retryableByCode
  const tracingId = options.tracingId ?? embeddedTrace ?? randomUUID().slice(0, 8)
  return {
    code,
    message,
    source,
    retryable,
    tracingId,
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
    feedback: feedbackForRpcError({ code, message, source, tracingId, retryable }),
  }
}

// ========== 类型守卫 ==========

export function isRequest(msg: unknown): msg is Request {
  return typeof msg === 'object' && msg !== null && (msg as { kind?: string }).kind === 'request'
}

export function isResponse(msg: unknown): msg is Response {
  return typeof msg === 'object' && msg !== null && (msg as { kind?: string }).kind === 'response'
}
