import fs from 'node:fs'
import path from 'node:path'
import config, { readRawConfig, validateLoadable } from '@/utils/config.js'
import { logger, LogLevel } from '@/utils/logger/index.js'
import {
  consumeHandledConfigRevision,
  createConfigRevision,
} from './revision.js'
import { requestRestartWhenIdle } from '@/service/restartCoordinator.js'
import {
  enterMaintenanceMode,
  getMaintenanceState,
  leaveMaintenanceMode,
} from '@/service/maintenanceMode.js'
import { abortAllChatRuntimes } from '@/service/chat/runtime.js'
import {
  applyRetiredRoles,
  archivePresetRoots,
  detectRemovedPresetIds,
  detectRetiredRoleIdentities,
} from './roleLifecycle.js'

const WATCHED_DIRS = ['prompt', 'skills', 'senses', 'plugins', 'rule', 'command', 'hooks']
const WATCHED_ROOT_FILES = new Set(['config.yaml', 'model-catalog.yaml'])

export interface ConfigWatcherHandle {
  close(): void
  validateNow(): void
}

/**
 * Monitor semantic runtime resources. Disk writes never mutate a live builder:
 * they become a candidate revision after a quiet period, then the guardian
 * swaps workers at an idle boundary. Invalid candidates enter fail-closed
 * maintenance mode and stop every Agent runtime.
 */
export function startConfigRevisionWatcher(): ConfigWatcherHandle {
  const cheryRoot = path.resolve(config.global.prompts_dir, '..')
  const watchers: fs.FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let acceptedRaw = readRawConfig()
  let acceptedConfigText = fs.readFileSync(path.join(cheryRoot, 'config.yaml'), 'utf8')
  let acceptedRevision = createConfigRevision({ raw: acceptedRaw, source: 'startup' })
  let suppressRecoveredWrite = false

  const restoreAcceptedConfig = (message: string): string | undefined => {
    const configPath = path.join(cheryRoot, 'config.yaml')
    const backupsDir = path.join(cheryRoot, 'backups')
    const rejectedPath = path.join(
      backupsDir,
      `rejected-manual-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.yaml`,
    )
    const candidatePath = `${configPath}.recovery-${process.pid}`
    try {
      fs.mkdirSync(backupsDir, { recursive: true })
      fs.renameSync(configPath, rejectedPath)
      fs.writeFileSync(candidatePath, acceptedConfigText, 'utf8')
      fs.renameSync(candidatePath, configPath)
      suppressRecoveredWrite = true
      logger.event(
        'config.manual.recovered',
        { rejectedPath, reason: message },
        LogLevel.warn,
      )
      return rejectedPath
    } catch (error) {
      if (fs.existsSync(candidatePath)) fs.rmSync(candidatePath, { force: true })
      if (!fs.existsSync(configPath) && fs.existsSync(rejectedPath)) {
        fs.copyFileSync(rejectedPath, configPath)
      }
      logger.event(
        'config.manual.recovery_failed',
        { error: (error as Error).message, reason: message },
        LogLevel.error,
      )
      return undefined
    }
  }

  const schedule = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(validateCandidate, 500)
  }

  const validateCandidate = (): void => {
    timer = undefined
    if (closed) return
    if (suppressRecoveredWrite) {
      suppressRecoveredWrite = false
      logger.event('config.manual.recovery_held', {
        revisionId: acceptedRevision.revisionId,
      })
      return
    }
    let raw: ReturnType<typeof readRawConfig>
    try {
      raw = readRawConfig()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const rejectedPath = restoreAcceptedConfig(message)
      enterMaintenanceMode('手工配置文件无法解析', [
        message,
        ...(rejectedPath
          ? [`无效文件已保全到 ${rejectedPath}；已恢复最后一次可解析版本，等待用户确认保存。`]
          : []),
      ])
      abortAllChatRuntimes()
      logger.event(
        'config.manual.invalid',
        { errors: [message], rejectedPath },
        LogLevel.error,
      )
      return
    }
    const validation = validateLoadable(raw)
    if (!validation.ok) {
      const revision = createConfigRevision({
        raw,
        source: 'manual',
        status: 'rejected',
        validationError: validation.errors.join('\n'),
      })
      enterMaintenanceMode('手工配置候选版本验证失败', validation.errors)
      abortAllChatRuntimes()
      logger.event(
        'config.manual.invalid',
        { revisionId: revision.revisionId, errors: validation.errors },
        LogLevel.error,
      )
      return
    }

    const candidate = createConfigRevision({ raw, source: 'manual' })
    const candidateText = fs.readFileSync(path.join(cheryRoot, 'config.yaml'), 'utf8')
    const alreadyHandled = consumeHandledConfigRevision(candidate.fingerprint)
    const unchanged = candidate.fingerprint === acceptedRevision.fingerprint
    if (alreadyHandled || unchanged) {
      acceptedRaw = raw
      acceptedConfigText = candidateText
      acceptedRevision = candidate
      const recovering = getMaintenanceState().active
      if (recovering) {
        leaveMaintenanceMode()
        process.send?.({ type: 'maintenance-cleared' })
        requestRestartWhenIdle()
      }
      logger.event('config.watcher.candidate.acknowledged', {
        revisionId: candidate.revisionId,
        alreadyHandled,
        unchanged,
        recoveredFromMaintenance: recovering,
      })
      return
    }
    const retired = detectRetiredRoleIdentities(
      acceptedRaw.roles as unknown as Record<string, Record<string, unknown>>,
      raw.roles as unknown as Record<string, Record<string, unknown>>,
    )
    applyRetiredRoles({
      roleIds: retired.ids,
      roleNames: retired.names,
      reason: `角色在手工配置修订 ${candidate.revisionId} 中被删除或语义修改`,
    })
    const removedPresetIds = detectRemovedPresetIds(
      acceptedRaw.presets as unknown as Record<string, Record<string, unknown>>,
      raw.presets as unknown as Record<string, Record<string, unknown>>,
    )
    archivePresetRoots(
      removedPresetIds,
      `预设在手工配置修订 ${candidate.revisionId} 中被删除`,
    )
    acceptedRaw = raw
    acceptedConfigText = candidateText
    acceptedRevision = candidate
    const recovering = getMaintenanceState().active
    leaveMaintenanceMode()
    if (recovering) process.send?.({ type: 'maintenance-cleared' })
    const restart = requestRestartWhenIdle()
    logger.event('config.manual.candidate', {
      revisionId: candidate.revisionId,
      restart,
      recoveredFromMaintenance: recovering,
      warnings: validation.warnings,
    })
  }

  const watch = (target: string, recursive = false): void => {
    if (!fs.existsSync(target)) return
    const watcher = fs.watch(target, { recursive }, (_event, filename) => {
      if (!filename) return schedule()
      const normalized = filename.toString().replaceAll('\\', '/')
      if (target === cheryRoot && !WATCHED_ROOT_FILES.has(normalized)) return
      schedule()
    })
    watcher.on('error', (error) => {
      logger.event(
        'config.watcher.error',
        { target, error: error.message },
        LogLevel.warn,
      )
    })
    watchers.push(watcher)
  }

  watch(cheryRoot)
  for (const name of WATCHED_DIRS) watch(path.join(cheryRoot, name), true)

  return {
    close(): void {
      closed = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
    validateNow: schedule,
  }
}
