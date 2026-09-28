import type { McpServerInfo } from '@/core/mcp/types.js'
import type { ConfigRaw } from '@/utils/config.js'
import type {
  ModelCatalogFacts,
  ModelCatalogRecommendation,
  ModelCatalogUnknownPolicy,
} from '@/utils/modelCatalog.js'
import type { HooksHandlerDTO, EmptyObjectData } from '../types.js'

export interface McpListResponseData {
  servers: McpServerInfo[]
}

export interface McpGetResponseData {
  server: McpServerInfo
}

export interface McpConnectResponseData {
  server: McpServerInfo
}

export interface McpDisconnectResponseData {
  server: McpServerInfo
}

/**
 * mcp.reload 返回：全量 server 列表 + 本次操作汇总。
 * - 全量重载：connected/failed/totalSenses 覆盖所有 server。
 * - connected 统计当前可用连接，failed 包含候选生效失败；旧连接可用且新配置失败时两者可同时计数。
 * - 单 server 重载也返回全量连接汇总；实际生效结果以 apply 和各 server.applyStatus 为准。
 */
export interface McpReloadResponseData {
  apply?: import('@chery/protocol').ConfigApplyState
  servers: McpServerInfo[]
  connected: number
  failed: number
  totalSenses: number
}

/**
 * config.get 响应：.chery/config.yaml 原文（除 server 段）。
 * supervision 为字符串、key 仍为 $ENV 占位符、无路径补全（供设置面板编辑）。
 */
export type ConfigGetResponseData = ConfigRaw & { baseRevision: string }

/**
 * config.save v2：保存修订、运行修订与逐项生效状态。
 * 校验失败走 error（INVALID_PARAMS + errors 列表），不返此 data。
 * 写盘前失败走 RPC error；写盘后应用失败通过 failed 明确表达。
 */
export type ConfigSaveResponseData = import('@chery/protocol').ConfigSaveResult

/** config.workspace.validate 响应：无副作用的后端目录校验结果。 */
export interface ConfigWorkspaceValidateResponseData {
  valid: boolean
  error?: string
}

/** config.workspace.browse.start 响应：开启浏览会话；roots 为管理员白名单明文。 */
export interface ConfigWorkspaceBrowseStartResponseData {
  sessionId: string
  /** 会话存活毫秒数（到期自动清理） */
  ttlMs: number
  /** process.platform 原样透传（前端面包屑平台适配） */
  platform: string
  /** 显示分隔符：win32 为 '\\'，其余 '/' */
  sep: '/' | '\\'
  /** 允许浏览的根白名单（明文 = 管理员配置，非用户数据） */
  roots: Array<{ path: string; name: string }>
  /** 空串 = 多根选择器；单根 = 直接列其子目录 */
  initialPath: string
  /** 生效的 includeFiles 值 */
  includeFiles: boolean
  /** 无有效根时结构化返回（不抛 RpcError） */
  error?: string
}

/** config.workspace.browse.list 响应：encData 为 xorEncrypt(nonce, JSON.stringify(payload))。 */
export interface ConfigWorkspaceBrowseListResponseData {
  /** 回显请求 nonce，前端校验一致后解密 encData */
  nonce: string
  /** base64：xorEncrypt(nonce, JSON.stringify(BrowseListPayload)) */
  encData: string
}

/** hooks.get 响应：全局 hooks + 各 brain 级 hooks（只读展示）+ handler 执行器平台状态 */
export interface HooksShellInfo {
  /** 服务进程平台（process.platform，如 win32/linux/darwin） */
  platform: string
  /** 是否解析到可用 POSIX shell（handler 执行器，见 docs/backend/agent/hooks.md 跨平台执行） */
  available: boolean
  /** available=true 时解析到的 shell（PATH 名或绝对路径，如 Git Bash bash.exe） */
  executable?: string
  /** available=false 时的安装指引 */
  hint?: string
}

export interface HooksGetResponseData {
  handlers: Record<string, HooksHandlerDTO[]>
  brainHooks: Record<string, Record<string, HooksHandlerDTO[]>>
  shellInfo: HooksShellInfo
}

/** hooks.save 响应：写入成功 */
export interface HooksSaveResponseData {
  ok: true
}

/**
 * utils.models 响应：归一化模型列表。
 * 请求失败时 models 为空数组，error 携带错误信息（非 RpcError，前端可展示）。
 */
export interface UtilsModelsResponseData {
  models: Array<{
    /** 模型 ID（API 原始值） */
    id: string
    /** 显示名（缺省取 id） */
    name?: string
    /** 所有者/组织（部分 API 提供） */
    ownedBy?: string
  }>
  /** 非空时表示请求失败，前端据此展示错误提示 */
  error?: string
}

/** utils.testConnection 响应：判别联合避免 ok 与 error 组合出无效状态。 */
export type UtilsTestConnectionResponseData =
  { ok: true; error?: never } | { ok: false; error: string }

/** env.list 响应：.env 文件中的变量名列表 */
export interface EnvListResponseData {
  vars: string[]
  apply?: import('@chery/protocol').ConfigApplyState
}

/**
 * utils.modelRecommendation 响应。未知模型的 thinkingLevels 为空，不伪造可用档位。
 */
export interface UtilsModelRecommendationResponseData {
  matched: boolean
  id?: string
  confidence: 'exact' | 'pattern' | 'unknown'
  facts?: ModelCatalogFacts
  recommend?: ModelCatalogRecommendation
  thinkingLevels: import('@/core/llm/adapter.js').ThinkingLevel[]
  unknown: ModelCatalogUnknownPolicy
}

/** utils.openFile 响应：空（成功即打开，失败返 RpcError） */
export type UtilsOpenFileResponseData = EmptyObjectData

/** utils.openConfigDir 响应：空（成功即打开，失败返 RpcError） */
export type UtilsOpenConfigDirResponseData = EmptyObjectData

/**
 * utils.editors 响应：系统可用的文本编辑器列表。
 * editors：编辑器信息数组（name=显示名，command=启动命令，available=是否可用）。
 */
export interface UtilsEditorsResponseData {
  editors: Array<{
    /** 显示名称（如 "Visual Studio Code"） */
    name: string
    /** 启动命令（如 "code"、"notepad"、"gedit"） */
    command: string
    /** 是否在系统 PATH 中可用 */
    available: boolean
  }>
}
