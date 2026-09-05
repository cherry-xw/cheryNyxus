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
import { validateWorkspacePath } from '@/utils/config.js'
import { CONFIG_APPLY_VERSION, CONFIG_APPLY_CHANGED } from '@chery/protocol'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { createNotification } from '../message/types.js'
import { logger } from '@/utils/logger/index.js'
import {
  commitConfigCandidate,
  getSavedBaseRevision,
  getConfigApplyCoordinator,
  previewConfigCandidate,
  readConfigImage,
} from './commit.js'

/**
 * Config 设置 RPC handler。
 *
 * config.get：读 .chery/config.yaml 原文（除 server 段），供设置面板编辑。
 *   返回 supervision 字符串、key 仍为 $ENV 占位符、无路径补全的原始结构。
 * config.save：校验 + 写回 .chery/config.yaml（保留 server 段、无注释）。
 *   v2 区分磁盘保存与资源生效；未接入模块保持待生效，不自动重启。
 */

/** config.get：读原文（剥离 server 段） */
async function handleConfigGet(
  _ctx: HandlerContext,
  _data: ConfigGetRequestData,
): Promise<ConfigGetResponseData> {
  const image = readConfigImage()
  const raw = image.config
  logger.event('config.get', { brains: Object.keys(raw.llm?.brain ?? {}).length })
  return { ...raw, baseRevision: getSavedBaseRevision(image) }
}

/** config.workspace.validate：为设置页提供后端主机上的只读目录校验。 */
async function handleConfigWorkspaceValidate(
  _ctx: HandlerContext,
  data: ConfigWorkspaceValidateRequestData,
): Promise<ConfigWorkspaceValidateResponseData> {
  return validateWorkspacePath(data.workspace)
}

/** config.save：统一保存候选并返回逐项生效状态。 */
export async function handleConfigSave(
  ctx: HandlerContext,
  data: ConfigSaveRequestData,
): Promise<ConfigSaveResponseData | Response> {
  const rid = ctx.requestId ?? ''
  if (data.protocolVersion !== CONFIG_APPLY_VERSION)
    return createResponse(
      rid,
      false,
      undefined,
      createError(ErrorCode.INVALID_PARAMS, '配置保存协议已升级到 v2，请刷新或升级客户端后重试'),
    )
  const result = commitConfigCandidate(data)
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
    candidateRevisionId: result.candidateRevisionId,
    baseRevision: result.baseRevision,
  })
  const { ok: _ok, ...response } = result
  return response
}

export function registerConfigHandlers(router: RpcRouter): void {
  const engine = getConfigApplyCoordinator()
  if (!subscribed) {
    subscribed = true
    engine.subscribe((state) => {
      for (const ws of connectionManager.getAllOutputs()) {
        if (connectionManager.get(ws)?.profile) continue
        try {
          ws.send(transport.encode(createNotification(CONFIG_APPLY_CHANGED, undefined, state)))
        } catch {
          logger.event('config.apply.notification_failed', { savedRevision: state.savedRevision })
        }
      }
    })
  }
  router.register(Method.CONFIG_GET, handleConfigGet)
  router.register(Method.CONFIG_WORKSPACE_VALIDATE, handleConfigWorkspaceValidate)
  router.register(Method.CONFIG_SAVE, handleConfigSave)
  router.register(Method.CONFIG_APPLY_STATUS, async () => engine.getState())
  router.register(Method.CONFIG_PREVIEW, async (ctx, data) => {
    const preview = previewConfigCandidate(data)
    if ('ok' in preview)
      return createResponse(
        ctx.requestId ?? '',
        false,
        undefined,
        createError(ErrorCode.INVALID_PARAMS, preview.ok ? '预览失败' : preview.errors.join('\n')),
      )
    return preview
  })
}

let subscribed = false

export { handleConfigWorkspaceValidate }
