import {
  readRawConfig,
  restoreRedactedSecrets,
  saveRawConfig,
  validateConfigCandidate,
  validateLoadable,
  type ConfigRaw,
} from '@/utils/config.js'
import { logger, LogLevel } from '@/utils/logger/index.js'
import { requestRestartWhenIdle, type RestartStatus } from '@/service/restartCoordinator.js'
import { leaveMaintenanceMode } from '@/service/maintenanceMode.js'
import { detectRoleRenames, migrateRoleRename } from './roleRename.js'
import { createConfigRevision, markConfigRevisionHandled } from './revision.js'
import {
  applyRetiredRoles,
  archivePresetRoots,
  detectRemovedPresetIds,
  detectRetiredRoleIdentities,
} from './roleLifecycle.js'
import { getConfigBaseRevision } from './operations.js'

export type ConfigCommitResult =
  | {
      ok: true
      candidateRevisionId: string
      baseRevision: string
      restart: RestartStatus
      warnings: string[]
    }
  | {
      ok: false
      kind: 'stale'
      currentRevision: string
      errors: string[]
      warnings: string[]
    }
  | {
      ok: false
      kind: 'validation'
      errors: string[]
      warnings: string[]
    }

/**
 * AI 增量变更与前端全量保存共用的唯一提交边界。
 * 候选先在内存中完成全量校验，只有通过后才备份并写盘；成功后统一登记候选修订、
 * 应用角色/预设生命周期迁移，并安排所有会话空闲后的受控重启。
 */
export function commitConfigCandidate(input: {
  candidate: ConfigRaw
  expectedBaseRevision?: string
}): ConfigCommitResult {
  const before = readRawConfig()
  const currentRevision = getConfigBaseRevision(before)
  if (input.expectedBaseRevision && input.expectedBaseRevision !== currentRevision) {
    return {
      ok: false,
      kind: 'stale',
      currentRevision,
      errors: [
        `配置已被其他操作修改：baseRevision ${input.expectedBaseRevision} 已过期，当前为 ${currentRevision}`,
      ],
      warnings: [],
    }
  }

  const candidate = restoreRedactedSecrets(input.candidate, before)
  const candidateValidation = validateConfigCandidate(candidate, before)
  if (!candidateValidation.ok) {
    createConfigRevision({
      raw: candidate,
      source: 'structured',
      status: 'rejected',
      validationError: [...candidateValidation.errors, ...candidateValidation.warnings].join('\n'),
    })
    return {
      ok: false,
      kind: 'validation',
      errors: candidateValidation.errors,
      warnings: candidateValidation.warnings,
    }
  }

  // dry-run 在写盘前完成。环境变量缺失只是运行期软告警，不阻断结构正确的候选。
  const loadable = validateLoadable(candidate)
  if (!loadable.ok) {
    createConfigRevision({
      raw: candidate,
      source: 'structured',
      status: 'rejected',
      validationError: loadable.errors.join('\n'),
    })
    return {
      ok: false,
      kind: 'validation',
      errors: loadable.errors,
      warnings: loadable.warnings,
    }
  }

  const saved = saveRawConfig(candidate)
  if (!saved.ok) {
    // saveRawConfig 复用同一验证器；这里主要防御写盘前磁盘被外部编辑的极小竞态。
    return {
      ok: false,
      kind: 'validation',
      errors: saved.errors,
      warnings: saved.warnings,
    }
  }

  // 重新读取持久化形态：saveRawConfig 会补齐稳定 ID，readRawConfig 还会归一化默认值。
  // 后续 revision 与返回的 baseRevision 必须基于这个形态，否则新 brain 省略 thinking 时令牌会立即过期。
  const persisted = readRawConfig()
  const revision = createConfigRevision({ raw: persisted, source: 'structured' })
  leaveMaintenanceMode()
  process.send?.({ type: 'maintenance-cleared' })

  const retired = detectRetiredRoleIdentities(
    before.roles as unknown as Record<string, Record<string, unknown>>,
    persisted.roles as unknown as Record<string, Record<string, unknown>>,
  )
  const lifecycle = applyRetiredRoles({
    roleIds: retired.ids,
    roleNames: retired.names,
    reason: `角色在配置修订 ${revision.revisionId} 中被删除或语义修改`,
  })
  const removedPresetIds = detectRemovedPresetIds(
    before.presets as unknown as Record<string, Record<string, unknown>>,
    persisted.presets as unknown as Record<string, Record<string, unknown>>,
  )
  const archivedRoots = archivePresetRoots(
    removedPresetIds,
    `预设在配置修订 ${revision.revisionId} 中被删除`,
  )

  markConfigRevisionHandled(revision)
  for (const { from, to } of detectRoleRenames(before.roles, persisted.roles)) {
    try {
      migrateRoleRename(from, to)
    } catch (cause) {
      logger.event('role.rename.failed', {
        from,
        to,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  if (loadable.warnings.length > 0) {
    logger.event('config.save.warnings', { warnings: loadable.warnings }, LogLevel.warn)
  }
  const restart = requestRestartWhenIdle()
  const nextBaseRevision = getConfigBaseRevision(persisted)
  logger.event('config.revision.candidate', {
    revisionId: revision.revisionId,
    baseRevision: nextBaseRevision,
    retiredRoleIds: retired.ids,
    retiredChatIds: lifecycle.retiredChatIds,
    abandonedChatIds: lifecycle.abandonedChatIds,
    archivedRoots,
    restart,
  })

  return {
    ok: true,
    candidateRevisionId: revision.revisionId,
    baseRevision: nextBaseRevision,
    restart,
    warnings: loadable.warnings,
  }
}
