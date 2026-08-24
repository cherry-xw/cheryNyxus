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
import { readRawConfig, saveRawConfig, validateWorkspacePath, validateLoadable, rollbackConfig } from '@/utils/config.js'
import { logger, LogLevel } from '@/utils/logger/index.js'
import { requestRestartWhenIdle } from '@/service/restartCoordinator.js'
import { detectRoleRenames, migrateRoleRename } from './roleRename.js'

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
  // 保存前快照（含 ensureRoleIds 补全的 id），用于保存后检测同 id 改名
  const before = readRawConfig()
  const result = saveRawConfig(data)
  if (!result.ok) {
    // errors（硬错误）+ warnings（软错误，如 workspace 路径无效）合并展示给 UI；
    // 仅 warnings 时也阻止写盘（提示用户修正）。
    const combined = [...result.errors, ...(result.warnings ?? [])]
    return createResponse(
      rid,
      false,
      undefined,
      createError(ErrorCode.INVALID_PARAMS, combined.join('\n')),
    )
  }
  // 角色改名迁移：存量 DB（metadata.type/spawnTypes + spawn_tasks.type）旧名 -> 新名，
  // 使改名对历史 chat 关联不可见（见 docs/db.md「角色改名迁移」）。失败不阻断保存（迁移幂等可重试）。
  for (const { from, to } of detectRoleRenames(before.roles, data.roles)) {
    try {
      migrateRoleRename(from, to)
    } catch (err) {
      logger.event('role.rename.failed', {
        from,
        to,
        error: (err as Error).message,
      })
    }
  }
  // logger 在统一边界递归脱敏 key/token/secret/env 等字段。
  logger.event('config.save', { config: data })
  // 重启前 dry-run 预检：模拟 loadConfig 校验（坏配置会致重启后 crash-loop 永不恢复）。
  // 仅结构硬错误（validateRawConfig）会阻塞：失败 → 自动回滚最近备份 + 返回失败信息（未重启，进程保持运行）。
  // 软告警（如 $ENV 缺失变量）不阻塞：照常写盘并重启，随成功响应带出提示，运行期实际调用时再报错。
  const loadable = validateLoadable(data)
  if (!loadable.ok) {
    const backup = rollbackConfig()
    logger.event(
      'config.restart.validation_failed',
      { errors: loadable.errors, warnings: loadable.warnings, rollback: backup.backup },
      LogLevel.warn,
    )
    return {
      needRestart: false,
      restart: 'manual',
      validationErrors: loadable.errors,
      validationWarnings: loadable.warnings,
      rollbackBackup: backup.backup,
    }
  }
  if (loadable.warnings.length > 0) {
    logger.event('config.save.warnings', { warnings: loadable.warnings }, LogLevel.warn)
  }
  return {
    needRestart: true,
    restart: requestRestartWhenIdle(),
    warnings: loadable.warnings.length > 0 ? loadable.warnings : undefined,
  }
}

export function registerConfigHandlers(router: RpcRouter): void {
  router.register(Method.CONFIG_GET, handleConfigGet)
  router.register(Method.CONFIG_WORKSPACE_VALIDATE, handleConfigWorkspaceValidate)
  router.register(Method.CONFIG_SAVE, handleConfigSave)
}

export { handleConfigWorkspaceValidate }
