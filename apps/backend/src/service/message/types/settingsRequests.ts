import type { EmptyObjectData } from '../types.js'
import type { ConfigRaw } from '@/utils/config.js'

// ---------- MCP 管理（连接层）----------

export type McpListRequestData = EmptyObjectData

export interface McpGetRequestData {
  name: string
}

export interface McpConnectRequestData {
  name: string
}

export interface McpDisconnectRequestData {
  name: string
}

/**
 * mcp.reload：name 给出→原子重载单个 server；name 省略→全量重载（重读 config）。
 */
export interface McpReloadRequestData {
  name?: string
}

/**
 * subagent.result RPC 已于 2026-07-09 废弃（wait=true 改后端注入唤醒，见 docs/shared/architecture/agent-orchestration.md §5.4）。
 * 原前端→后端结果回传通道移除：SubagentResultRequestData / SubagentResultResponseData / Method.SUBAGENT_RESULT / handler / schema 全删。
 */

// ---------- Config 设置（config.get / config.save）----------

/** config.get 请求：空参 */
export type ConfigGetRequestData = EmptyObjectData

/** config.save 入参：除 server 外全部字段（结构同 ConfigRaw，supervision 为字符串、key 为 $ENV 占位符） */
export type ConfigSaveRequestData = import('@chery/protocol').ConfigSaveRequest<ConfigRaw>

/** config.workspace.validate：只读校验后端主机上的预设工作区目录。空值表示未限定，为有效值。 */
export interface ConfigWorkspaceValidateRequestData {
  workspace?: string
}

/** config.workspace.browse.start 入参：严格空对象。 */
export type ConfigWorkspaceBrowseStartRequestData = EmptyObjectData

/** config.workspace.browse.list 入参：encPath 为 xorEncrypt(nonce, 绝对路径或空串)（空串=根选择层）。 */
export interface ConfigWorkspaceBrowseListRequestData {
  sessionId: string
  /** hex 一次性随机数，客户端每请求新生成；响应回显供校验一致 */
  nonce: string
  /** base64：xorEncrypt(nonce, 绝对路径或空串)；空串表示请求根选择层 */
  encPath: string
  /** 是否返回文件条目；缺省取配置 default_include_files（默认 false 仅目录，为硬上限） */
  includeFiles?: boolean
}

export interface WorkspaceFilesListRequestData {
  chatId: string
  path?: string
  offset?: number
}

export interface WorkspaceFileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size?: number
  modifiedAt?: number
  extension?: string
}

export interface WorkspaceFilesListResponseData {
  chatId: string
  workspace: string
  path: string
  entries: WorkspaceFileEntry[]
  nextOffset?: number
}

export interface WorkspaceFilesReadRequestData {
  chatId: string
  path: string
}

export interface WorkspaceFilesReadResponseData {
  chatId: string
  path: string
  kind: 'text' | 'image' | 'binary'
  mimeType?: string
  content?: string
  size: number
  truncated?: boolean
}
export interface WorkspaceGitStatusRequestData {
  chatId: string
}
export interface WorkspaceGitStatusResponseData {
  chatId: string
  branch: string
  branches: string[]
  dirty: boolean
  files: Array<{ path: string; status: 'added' | 'modified' }>
}
export interface WorkspaceGitCheckoutRequestData {
  chatId: string
  branch: string
}
export interface WorkspaceGitCheckoutResponseData {
  chatId: string
  branch: string
}

export type {
  TerminalTarget,
  TerminalCreateRequestData,
  TerminalCreateResponseData,
  TerminalInputRequestData,
  TerminalInputResponseData,
  TerminalResizeRequestData,
  TerminalResizeResponseData,
  TerminalCloseRequestData,
  TerminalCloseResponseData,
  TerminalEventNotificationData,
} from './terminal.js'

// ---------- Hooks 管理（hooks.get / hooks.save / hooks.events）----------

/** hooks.get 请求：空参 */
export type HooksGetRequestData = EmptyObjectData

/** hooks.save 入参：全局 hooks.json 完整内容（事件 → handler 列表）*/
export interface HooksSaveRequestData {
  handlers: Record<string, HooksHandlerDTO[]>
}

/** hooks.events 请求：空参 */
export type HooksEventsRequestData = EmptyObjectData

/** hooks handler 传输对象（对齐 HookHandlerConfig）*/
export interface HooksHandlerDTO {
  matcher?: string
  if?: string
  command: string
  timeout?: number
}

/** hooks.events 响应：静态事件元数据 */
export interface HooksEventsResponseData {
  events: Array<{
    name: string
    label?: string
    description: string
    /** 该事件 handler 能做的能力（前端 chip 展示）*/
    capabilities: string[]
    /** matcher 比对的 payload 字段名（提示用户 matcher 匹配什么）*/
    matcherField?: string
  }>
}

// ---------- Utils 工具（独立信息查询，不依赖 chat/brain 运行时）----------

/**
 * utils.models：基于用户提供的 provider/url/key 拉取可用模型列表。
 * provider 必填（区分调用方式），url 必填，key 可选（ollama 通常无需）。
 */
export interface UtilsModelsRequestData {
  provider: string
  protocol?: import('@chery/protocol').LlmProtocol
  url: string
  key?: string
  /** true=URL 已含完整端点，后端不补全、原样访问（与正式 chat 同规则） */
  fullUrl?: boolean
}

/**
 * utils.testConnection：用未保存的 brain 连接字段执行真实最小 Provider 请求。
 * key 可选：Ollama 通常无需密钥。
 */
export interface UtilsTestConnectionRequestData {
  provider: string
  protocol?: import('@chery/protocol').LlmProtocol
  url: string
  key?: string
  model: string
  /** true=URL 已含完整端点，后端不补全、原样访问（与正式 chat 同规则） */
  fullUrl?: boolean
}

/**
 * utils.modelRecommendation：查询单个模型的目录匹配、推荐、事实与 thinking 档位。
 */
export interface UtilsModelRecommendationRequestData {
  model: string
  provider?: string
  protocol?: import('@chery/protocol').LlmProtocol
}

// ---------- Env 环境变量 ----------

/** env.list 请求：空参 */
export type EnvListRequestData = EmptyObjectData

// ---------- Utils 打开文件 ----------

/**
 * utils.openFile：打开指定文件（用配置的文本编辑器或系统默认）。
 * path：相对 .chery 目录的文件路径（如 config.yaml、.env、prompts/leader.md）。
 */
export interface UtilsOpenFileRequestData {
  path: string
}

/**
 * utils.editors：获取系统可用的文本编辑器列表。
 * 返回主流编辑器（VSCode、记事本、TextEdit、gedit 等），供前端下拉选择。
 */
export type UtilsEditorsRequestData = EmptyObjectData

/** utils.openConfigDir：固定打开后端主机的 CHERY_DIR/.chery，不接受客户端路径。 */
export type UtilsOpenConfigDirRequestData = EmptyObjectData

// ---------- 内置命令系统（命令管理 Tab 后端）----------

/** 单条 .chery/command/<name>.md 元信息 */
export interface CommandInfo {
  /** 命令名（= 文件名 basename，无 .md 后缀） */
  name: string
  /** 文件 frontmatter.description；缺失时为 "" */
  description: string
  /** frontmatter 与正文之间的纯指令正文（trim 后） */
  content: string
}

/** command.list 响应：所有内置命令文件元信息 */
export interface CommandListResponseData {
  commands: CommandInfo[]
}

/**
 * chat 上下文暴露的 command 系统配置（前端 PetToolbar / 设置面板用）。compact 无开关。
 * - warn → 前端视觉提示阈值（contextUsage ≥ warn 时提示）；不参与后端触发。
 * - auto → 自动触发阈值（thresholdReached 命中即压缩）。
 * - min_context_limit → 只有 brain.contextLimit ≥ 此值才启用 compact（「不可用」门槛）。
 */
export interface ThresholdData {
  unit: 'tokens' | 'percent'
  value: number
}

export interface CommandConfigData {
  warn: ThresholdData
  auto: ThresholdData
  minContextLimit: number
}
