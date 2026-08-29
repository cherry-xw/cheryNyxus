import type { RpcRouter, HandlerContext } from '../message/router.js'
import {
  Method,
  ErrorCode,
  createResponse,
  createError,
  type Response,
  type ConfigGetRequestData,
  type ConfigGetResponseData,
  type ConfigWorkspaceValidateRequestData,
  type ConfigWorkspaceValidateResponseData,
  type ConfigSaveRequestData,
  type ConfigSaveResponseData,
} from '../message/types.js'
import { readRawConfig, validateWorkspacePath } from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'
import { commitConfigCandidate } from './commit.js'

/**
 * Config 设置 RPC handler。
 *
 * config.get：读 .chery/config.yaml 原文（除 server 段），供设置面板编辑。
 *   返回 supervision 字符串、key 仍为 $ENV 占位符、无路径补全的原始结构。
 * config.save：校验 + 写回 .chery/config.yaml（保留 server 段、无注释）。
 *   worker 通过 IPC 请求守护进程在所有 chat 空闲时替换自己；直启 worker 则明确要求手动重启。
 */

/** config.get：读原文（剥离 server 段） */
async function handleConfigGet(
  _ctx: HandlerContext,
  _data: ConfigGetRequestData,
): Promise<ConfigGetResponseData> {
  const raw = readRawConfig()
  logger.event('config.get', { brains: Object.keys(raw.llm?.brain ?? {}).length })
  return raw
}

/** config.workspace.validate：为设置页提供后端主机上的只读目录校验。 */
async function handleConfigWorkspaceValidate(
  _ctx: HandlerContext,
  data: ConfigWorkspaceValidateRequestData,
): Promise<ConfigWorkspaceValidateResponseData> {
  return validateWorkspacePath(data.workspace)
}

/** config.save：校验 + 写回；成功后迁移角色改名引用 + 安排空闲重启。 */
export async function handleConfigSave(
  ctx: HandlerContext,
  data: ConfigSaveRequestData,
): Promise<ConfigSaveResponseData | Response> {
  const rid = ctx.requestId ?? ''
  const result = commitConfigCandidate({ candidate: data })
  if (!result.ok) {
    const combined = [...result.errors, ...result.warnings]
    return createResponse(
      rid,
      false,
      undefined,
      createError(ErrorCode.INVALID_PARAMS, combined.join('\n')),
    )
  }
  // logger 在统一边界递归脱敏 key/token/secret/env 等字段。
  logger.event('config.save', {
    config: data,
    candidateRevisionId: result.candidateRevisionId,
    baseRevision: result.baseRevision,
  })
  return {
    needRestart: true,
    restart: result.restart,
    warnings: result.warnings.length > 0 ? result.warnings : undefined,
  }
}

export function registerConfigHandlers(router: RpcRouter): void {
  router.register(Method.CONFIG_GET, handleConfigGet)
  router.register(Method.CONFIG_WORKSPACE_VALIDATE, handleConfigWorkspaceValidate)
  router.register(Method.CONFIG_SAVE, handleConfigSave)
}

export { handleConfigWorkspaceValidate }
