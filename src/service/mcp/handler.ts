import type { RpcRouter, HandlerContext } from '../message/router.js'
import {
  Method,
  ErrorCode,
  createResponse,
  createError,
  type Response,
  type McpListRequestData,
  type McpListResponseData,
  type McpGetRequestData,
  type McpGetResponseData,
  type McpConnectRequestData,
  type McpConnectResponseData,
  type McpDisconnectRequestData,
  type McpDisconnectResponseData,
  type McpReloadRequestData,
  type McpReloadResponseData,
} from '../message/types.js'
import {
  listMcpServers,
  getMcpServer,
  connectMcpServerByName,
  disconnectMcpServer,
  reloadOneServer,
  reloadMcpServers,
  McpServerError,
} from '@/core/mcp'
import { logger } from '@/utils/logger/index.js'

/**
 * MCP 管理 RPC handler（连接层）。
 *
 * 范式对齐 bash/handler.ts：service 层调用 core/mcp/loader（模块级状态机），注册表由 core 持有。
 *
 * 错误码约定（router.ts:91 isResponse 短路，非抛错走 INTERNAL）：
 * - 缺 name → 显式 INVALID_PARAMS Response
 * - McpServerError（NOT_FOUND 等）→ 显式对应 code Response
 * - 其他异常 → rethrow → router toRpcError → INTERNAL
 *
 * 幂等：connect 已连、disconnect 未连均 no-op 成功。
 */

/** 缺 name 的统一错误 Response */
function missingName(rid: string, _method: string): Response {
  return createResponse(
    rid,
    false,
    undefined,
    createError(ErrorCode.INVALID_PARAMS, '请指定扩展工具名称'),
  )
}

/** McpServerError → 显式错误 Response；其他 → rethrow */
function wrapMcpError(rid: string, err: unknown): Response {
  if (err instanceof McpServerError) {
    return createResponse(rid, false, undefined, createError(err.code, err.message))
  }
  throw err
}

/** mcp.list：列出所有 config 中声明的 server 及其运行期状态 */
async function handleMcpList(
  _ctx: HandlerContext,
  _data: McpListRequestData,
): Promise<McpListResponseData> {
  const servers = listMcpServers()
  logger.event('mcp.list', { count: servers.length })
  return { servers }
}

/** mcp.get：单个 server 详情 */
async function handleMcpGet(
  ctx: HandlerContext,
  data: McpGetRequestData,
): Promise<McpGetResponseData | Response> {
  const rid = ctx.requestId ?? ''
  if (!data.name) return missingName(rid, 'mcp.get')
  try {
    const server = getMcpServer(data.name)
    logger.event('mcp.get', { name: data.name, status: server.status })
    return { server }
  } catch (err) {
    return wrapMcpError(rid, err)
  }
}

/** mcp.connect：连接单个 server（已连幂等） */
async function handleMcpConnect(
  ctx: HandlerContext,
  data: McpConnectRequestData,
): Promise<McpConnectResponseData | Response> {
  const rid = ctx.requestId ?? ''
  if (!data.name) return missingName(rid, 'mcp.connect')
  try {
    const server = await connectMcpServerByName(data.name)
    logger.event('mcp.connect', { name: data.name, status: server.status })
    return { server }
  } catch (err) {
    return wrapMcpError(rid, err)
  }
}

/** mcp.disconnect：断开单个 server（未连幂等） */
async function handleMcpDisconnect(
  ctx: HandlerContext,
  data: McpDisconnectRequestData,
): Promise<McpDisconnectResponseData | Response> {
  const rid = ctx.requestId ?? ''
  if (!data.name) return missingName(rid, 'mcp.disconnect')
  try {
    const server = await disconnectMcpServer(data.name)
    logger.event('mcp.disconnect', { name: data.name, status: server.status })
    return { server }
  } catch (err) {
    return wrapMcpError(rid, err)
  }
}

/** mcp.reload：name 给出→原子重载单 server；name 省略→全量重载（重读 config） */
async function handleMcpReload(
  ctx: HandlerContext,
  data: McpReloadRequestData,
): Promise<McpReloadResponseData | Response> {
  const rid = ctx.requestId ?? ''
  try {
    if (data.name) {
      const server = await reloadOneServer(data.name)
      logger.event('mcp.reload', { name: data.name, senseCount: server.senseNames.length })
      return {
        servers: listMcpServers(),
        connected: 1,
        failed: 0,
        totalSenses: server.senseNames.length,
      }
    }
    const result = await reloadMcpServers()
    logger.event('mcp.reload', {
      full: true,
      connected: result.connected,
      failed: result.failed,
      totalSenses: result.totalSenses,
    })
    return result
  } catch (err) {
    return wrapMcpError(rid, err)
  }
}

export function registerMcpHandlers(router: RpcRouter): void {
  router.register(Method.MCP_LIST, handleMcpList)
  router.register(Method.MCP_GET, handleMcpGet)
  router.register(Method.MCP_CONNECT, handleMcpConnect)
  router.register(Method.MCP_DISCONNECT, handleMcpDisconnect)
  router.register(Method.MCP_RELOAD, handleMcpReload)
}
