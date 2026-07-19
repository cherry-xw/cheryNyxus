import type { SupervisionLevel } from '@/core/config'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

/**
 * MCP（Model Context Protocol）模块：把 MCP server 的 tools/resources/prompts
 * 映射为 Sense 注册进全局 senseRegistry，复用框架的监管等级 / 审批 / loop / sense_groups 机制。
 *
 * 与 core/sense/compiler（编译本地 .ts 外部感官）并列——compiler 注入本地源码产物，
 * 本模块注入远程/子进程 server 的能力。两者都最终调用 registerSenses。
 */

/** MCP sense 命名前缀，防跨 server 工具同名冲突，形如 mcp__<server>__<tool> */
export const MCP_PREFIX = 'mcp__'

/** MCP server 内只读资源 sense、模板 sense 的固定后缀 */
export const RESOURCE_SENSE_SUFFIX = 'read_resource'
export const PROMPT_SENSE_SUFFIX = 'get_prompt'

/**
 * 已连接的 MCP server 句柄。
 * 进程级长连接，由 loader 维护集合，关闭时统一 close。
 */
export interface McpClientHandle {
  /** 配置中的 server 名（命名空间） */
  name: string
  /** MCP client 实例 */
  client: Client
  /** 关闭连接（stdio 杀子进程 / http 关 session） */
  close: () => Promise<void>
}

/**
 * MCP sense 转换所需的运行时上下文。
 * convert.ts 各转换器据此把 server 能力包成 Sense。
 */
export interface McpSenseContext {
  client: Client
  serverName: string
  /** server 级默认监管等级（来自 config.mcp_servers.<name>.supervision）；undefined 时走 global */
  defaultSupervision: SupervisionLevel | undefined
}

/**
 * MCP server 运行期状态信息（mcp.list / mcp.get / mcp.reload 等返回）。
 * - connected：已握手成功且 senses 已注册
 * - disconnected：在 config 中声明，但未连接（从未 connect 或被 disconnect）
 * - failed：最近一次 connect/reload 失败（见 error 字段）
 */
export interface McpServerInfo {
  name: string
  status: 'connected' | 'disconnected' | 'failed'
  transport: 'stdio' | 'streamable-http'
  supervision?: SupervisionLevel
  /** 该 server 注册的 sense 名列表（仅 connected 时非空）。 */
  senseNames: string[]
  /** status === "failed" 时的失败原因。 */
  error?: string
}

/**
 * MCP 管理操作抛出的领域错误。handler 据此映射为 RPC 错误码。
 * 定义在 core 层（不依赖 service），避免 core→service 反向依赖。
 */
export class McpServerError extends Error {
  code: 'NOT_FOUND' | 'INVALID_PARAMS'
  constructor(message: string, code: 'NOT_FOUND' | 'INVALID_PARAMS') {
    super(message)
    this.name = 'McpServerError'
    this.code = code
  }
}
