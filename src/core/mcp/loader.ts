import type { ZodType } from 'zod'
import config, { reloadMcpServersConfig, type McpServerConfig } from '@/utils/config.js'
import { registerSenses, unregisterSenses } from '@/core/sense'
import type { Sense } from '@/core/sense'
import { logger } from '@/utils/logger/index.js'
import { connectMcpServer } from './client.js'
import { toolToSense, resourceToSense, promptToSense } from './convert.js'
import type { McpClientHandle, McpSenseContext, McpServerInfo } from './types.js'
import { McpServerError } from './types.js'

/** 已连接 server 的注册条目：句柄 + 该 server 注册的 sense 名清单 */
interface ConnectedEntry {
  handle: McpClientHandle
  senseNames: string[]
}

/**
 * 已连接 MCP server 状态机：name → {handle, senseNames}。
 * 替代原 handles 数组，支持按 name 精确管理（connect/disconnect/reload）。
 */
const connectedServers = new Map<string, ConnectedEntry>()

/** 最近一次 connect/reload 失败原因（name → message），供 list 的 failed 状态展示 */
const lastError = new Map<string, string>()

/**
 * 连接单个 MCP server，按其声明的能力（tools/resources/prompts）转成 Sense 列表。
 * 返回句柄 + senses + senseNames（供调用方注册与状态追踪）。不注册、不存状态——纯构建。
 */
async function buildSensesForServer(
  name: string,
  cfg: McpServerConfig,
): Promise<{ handle: McpClientHandle; senses: Sense<ZodType>[]; senseNames: string[] }> {
  const handle = await connectMcpServer(name, cfg)

  const ctx: McpSenseContext = {
    client: handle.client,
    serverName: name,
    defaultSupervision: cfg.supervision,
  }

  const senses: Sense<ZodType>[] = []
  const caps = handle.client.getServerCapabilities()

  // tools：每个 tool 一个 sense
  if (caps?.tools) {
    const { tools } = await handle.client.listTools()
    senses.push(...tools.map((t) => toolToSense(t, ctx)))
  }

  // resources：整个 server 合并为单个 read_resource sense
  if (caps?.resources) {
    let resources: Array<{ uri: string; name?: string; description?: string }> = []
    try {
      resources = (await handle.client.listResources()).resources
    } catch {
      // server 声明 resources 能力但 list 失败：保留空列表，sense 仍注册（按 uri 读）
    }
    senses.push(resourceToSense(resources, ctx))
  }

  // prompts：整个 server 合并为单个 get_prompt sense
  if (caps?.prompts) {
    let prompts: Array<{ name: string; description?: string }> = []
    try {
      prompts = (await handle.client.listPrompts()).prompts
    } catch {
      // 同上：声明能力但 list 失败，保留空列表
    }
    senses.push(promptToSense(prompts, ctx))
  }

  const senseNames = senses.map((s) => s.definition.function.name)
  return { handle, senses, senseNames }
}

/** 构造单个 server 的 McpServerInfo（config + 状态合并）。cfg 必须存在。 */
function buildServerInfo(name: string, cfg: McpServerConfig): McpServerInfo {
  const entry = connectedServers.get(name)
  if (entry) {
    return {
      name,
      status: 'connected',
      transport: cfg.transport,
      supervision: cfg.supervision,
      senseNames: entry.senseNames,
    }
  }
  const err = lastError.get(name)
  if (err) {
    return {
      name,
      status: 'failed',
      transport: cfg.transport,
      supervision: cfg.supervision,
      senseNames: [],
      error: err,
    }
  }
  return {
    name,
    status: 'disconnected',
    transport: cfg.transport,
    supervision: cfg.supervision,
    senseNames: [],
  }
}

/** mcp.list：列出所有 config 中声明的 server 及其运行期状态 */
export function listMcpServers(): McpServerInfo[] {
  const cfgs = config.mcp_servers ?? {}
  return Object.entries(cfgs).map(([name, cfg]) => buildServerInfo(name, cfg))
}

/** mcp.get：单个 server 详情。不在 config → NOT_FOUND */
export function getMcpServer(name: string): McpServerInfo {
  const cfg = config.mcp_servers?.[name]
  if (!cfg) {
    throw new McpServerError(`扩展工具 "${name}" 没配置`, 'NOT_FOUND')
  }
  return buildServerInfo(name, cfg)
}

/**
 * mcp.connect：按 config.mcp_servers[name] 连接。
 * 已连接→幂等 no-op；不在 config→NOT_FOUND；连接失败→记 lastError 并抛出（不阻断其他 server）。
 */
export async function connectMcpServerByName(name: string): Promise<McpServerInfo> {
  const cfg = config.mcp_servers?.[name]
  if (!cfg) {
    throw new McpServerError(`扩展工具 "${name}" 没配置`, 'NOT_FOUND')
  }
  if (connectedServers.has(name)) {
    return buildServerInfo(name, cfg) // 幂等
  }
  try {
    const { handle, senses, senseNames } = await buildSensesForServer(name, cfg)
    registerSenses(senses)
    connectedServers.set(name, { handle, senseNames })
    lastError.delete(name)
    logger.info(`✓ MCP server "${name}" 已连接，注册 ${senses.length} 个 sense`)
    return buildServerInfo(name, cfg)
  } catch (err) {
    const msg = (err as Error).message
    lastError.set(name, msg)
    logger.warn(`⚠ MCP server "${name}" 连接失败: ${msg}`)
    throw err
  }
}

/**
 * mcp.disconnect：断开单个 server。
 * config 无名→NOT_FOUND；未连接→幂等返回 disconnected；已连接→反注册其 sense + close。
 */
export async function disconnectMcpServer(name: string): Promise<McpServerInfo> {
  const cfg = config.mcp_servers?.[name]
  if (!cfg) {
    throw new McpServerError(`扩展工具 "${name}" 没配置`, 'NOT_FOUND')
  }
  const entry = connectedServers.get(name)
  if (!entry) {
    return buildServerInfo(name, cfg) // 幂等：已断开
  }
  unregisterSenses(entry.senseNames)
  await entry.handle.close().catch(() => {})
  connectedServers.delete(name)
  logger.info(`✓ MCP server "${name}" 已断开`)
  return buildServerInfo(name, cfg)
}

/**
 * 原子重载单个 server（mcp.reload {name}）：
 * 先建新连接（失败则旧态保留）→ 同步 register 新 + unregister 旧差集 → close 旧 client。
 * 注册表在任意时刻对同名 sense 都有效（无缺失窗口）。不在 config → NOT_FOUND。
 */
export async function reloadOneServer(name: string): Promise<McpServerInfo> {
  const cfg = config.mcp_servers?.[name]
  if (!cfg) {
    throw new McpServerError(`扩展工具 "${name}" 没配置`, 'NOT_FOUND')
  }
  const oldEntry = connectedServers.get(name)

  // 1. 建新连接（async 边界）。失败 → 旧连接与旧 sense 原封不动（原子保留）
  let built: { handle: McpClientHandle; senses: Sense<ZodType>[]; senseNames: string[] }
  try {
    built = await buildSensesForServer(name, cfg)
  } catch (err) {
    const msg = (err as Error).message
    lastError.set(name, msg)
    logger.warn(`⚠ MCP server "${name}" 重载失败（保留旧态）: ${msg}`)
    throw err
  }

  // 2. 同步交换（同 tick，无 await）：register 新（同名覆盖）→ unregister 旧差集
  registerSenses(built.senses)
  if (oldEntry) {
    const dropped = oldEntry.senseNames.filter((n) => !built.senseNames.includes(n))
    if (dropped.length > 0) {
      unregisterSenses(dropped)
    }
  }

  // 3. close 旧 client（注册表已指向新，旧 sense 已被覆盖/移除）
  if (oldEntry) {
    await oldEntry.handle.close().catch(() => {})
  }

  connectedServers.set(name, { handle: built.handle, senseNames: built.senseNames })
  lastError.delete(name)
  logger.info(`✓ MCP server "${name}" 已原子重载，注册 ${built.senses.length} 个 sense`)
  return buildServerInfo(name, cfg)
}

/** mcp.reload 返回结构（servers + 汇总计数） */
export interface McpReloadResult {
  servers: McpServerInfo[]
  connected: number
  failed: number
  totalSenses: number
}

/**
 * mcp.reload（全量）：重读 config → 断开已移除的 server → 对每个仍存在的 server 原子重载（逐个容忍）。
 * 返回 summary。
 */
export async function reloadMcpServers(): Promise<McpReloadResult> {
  reloadMcpServersConfig()

  const newNames = new Set(Object.keys(config.mcp_servers ?? {}))

  // 断开已从 config 移除的 server
  const removed = [...connectedServers.keys()].filter((n) => !newNames.has(n))
  await Promise.all(removed.map((n) => disconnectMcpServer(n).catch(() => {})))

  // 原子重载每个仍存在的 server（未连的会被 reloadOneServer 建连）
  let connected = 0
  let failed = 0
  let totalSenses = 0
  for (const name of newNames) {
    try {
      const info = await reloadOneServer(name)
      connected++
      totalSenses += info.senseNames.length
    } catch {
      failed++
    }
  }

  logger.info(`MCP 重载完成：${connected} 成功 / ${failed} 失败，共注册 ${totalSenses} 个 sense`)
  return { servers: listMcpServers(), connected, failed, totalSenses }
}

/**
 * 取已连 server 注册的 sense 名清单。供 runtimeResolver 把 enabled MCP server 的
 * tools 合并进 chat schema。未连→NOT_FOUND（fail loud：chat 启用了未连的 server）。
 */
export function getConnectedServerSenseNames(name: string): string[] {
  const entry = connectedServers.get(name)
  if (!entry) {
    const cfg = config.mcp_servers?.[name]
    if (!cfg) {
      throw new McpServerError(`扩展工具 "${name}" 没配置`, 'NOT_FOUND')
    }
    throw new McpServerError(`扩展工具 "${name}" 没连上`, 'NOT_FOUND')
  }
  return entry.senseNames
}

/** 已连 server 名清单（brain.list 供前端渲染开关） */
export function listConnectedServerNames(): string[] {
  return [...connectedServers.keys()]
}

/**
 * 启动期加载所有 MCP server（bootstrap 调用）。
 * 收敛为遍历 connectMcpServerByName；单个失败 warn 跳过，不阻断启动；无配置时直接返回。
 */
export async function loadMcpSenses(): Promise<void> {
  const cfgs = config.mcp_servers
  if (!cfgs || Object.keys(cfgs).length === 0) return

  let ok = 0
  let failed = 0
  let totalSenses = 0

  for (const name of Object.keys(cfgs)) {
    try {
      const info = await connectMcpServerByName(name)
      ok++
      totalSenses += info.senseNames.length
    } catch {
      failed++
    }
  }

  logger.info(`MCP 加载完成：${ok} 成功 / ${failed} 失败，共注册 ${totalSenses} 个 sense`)
}

/** 进程关闭时关闭所有 MCP client（index.ts SIGINT/SIGTERM 钩子） */
export async function closeMcpClients(): Promise<void> {
  await Promise.all(
    [...connectedServers.keys()].map((name) => disconnectMcpServer(name).catch(() => {})),
  )
}
