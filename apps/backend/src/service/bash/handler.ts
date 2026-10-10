import type { RpcRouter, HandlerContext } from '../message/router.js'
import type {
  BashKillRequestData,
  BashKillResponseData,
  BashListRequestData,
  BashListResponseData,
  BashProcessInfo,
} from '../message/types.js'
import { Method } from '../message/types.js'
import { killBashProcess, listBashProcesses } from '@/agent/sense/processRegistry.js'
import { logger } from '@/utils/logger/index.js'

/**
 * Bash 进程管理 RPC handler。
 *
 * 依赖关系：service 层调用 agent/sense/processRegistry（模块级单例），范式同 service
 * ApprovalManager 调 core approvalRegistry——注册表由 agent/core 层持有，service 层触发。
 *
 * - bash.list：列出某 chat 挂起的 bash 进程（前端据此展示 + 取 pid）
 * - bash.kill：显式杀死整个进程组（前端传 pid 主动终止）
 */

/** bash.kill：显式杀死某 chat 挂起的 bash 进程（进程组）。返回是否命中。 */
async function handleBashKill(
  _ctx: HandlerContext,
  data: BashKillRequestData,
): Promise<BashKillResponseData> {
  const killed = killBashProcess(data.chatId, data.pid)
  logger.event('bash.kill', { chatId: data.chatId, pid: data.pid, killed })
  return { chatId: data.chatId, pid: data.pid, killed }
}

/** bash.list：列出某 chat 挂起的 bash 进程。 */
async function handleBashList(
  _ctx: HandlerContext,
  data: BashListRequestData,
): Promise<BashListResponseData> {
  const processes: BashProcessInfo[] = listBashProcesses(data.chatId)
  logger.event('bash.list', { chatId: data.chatId, count: processes.length })
  return { chatId: data.chatId, processes }
}

export function registerBashHandlers(router: RpcRouter): void {
  router.register(Method.BASH_KILL, handleBashKill)
  router.register(Method.BASH_LIST, handleBashList)
}
