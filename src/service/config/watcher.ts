import fs from 'node:fs'
import {
  consumeHandledConfigImage,
  getConfigApplyCoordinator,
  readConfigImage,
  submitDiskConfigImage,
} from './commit.js'
import path from 'node:path'
import config, { readRawConfig, validateLoadable } from '@/utils/config.js'
import { logger, LogLevel } from '@/utils/logger/index.js'
import { createConfigRevision } from './revision.js'
import { imageRevision } from './impact.js'
import {
  enterMaintenanceMode,
  getMaintenanceState,
  leaveMaintenanceMode,
} from '@/service/maintenanceMode.js'
import { abortAllChatRuntimes } from '@/service/chat/runtime.js'

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
  getConfigApplyCoordinator()
  const cheryRoot = path.resolve(config.global.prompts_dir, '..')
  const watchers = new Map<string, fs.FSWatcher>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const acceptedRaw = readRawConfig()
  let acceptedConfigText = fs.readFileSync(path.join(cheryRoot, 'config.yaml'), 'utf8')
  let acceptedImageRevision = imageRevision(readConfigImage())
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
      logger.event('config.manual.recovered', { rejectedPath, reason: message }, LogLevel.warn)
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
      const currentText = fs.readFileSync(path.join(cheryRoot, 'config.yaml'), 'utf8')
      if (currentText === acceptedConfigText) {
        logger.event('config.manual.recovery_held', {
          revisionId: acceptedRevision.revisionId,
        })
        return
      }
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
      logger.event('config.manual.invalid', { errors: [message], rejectedPath }, LogLevel.error)
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

    let image: ReturnType<typeof readConfigImage>
    try {
      image = readConfigImage()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const revision = createConfigRevision({
        raw,
        source: 'manual',
        status: 'rejected',
        validationError: message,
      })
      enterMaintenanceMode('手工资源候选版本无法解析', [message])
      abortAllChatRuntimes()
      logger.event(
        'config.manual.invalid',
        { revisionId: revision.revisionId, errors: [message] },
        LogLevel.error,
      )
      return
    }
    const candidate = createConfigRevision({ raw: image.config, source: 'manual' })
    const candidateText = fs.readFileSync(path.join(cheryRoot, 'config.yaml'), 'utf8')
    const nextImageRevision = imageRevision(image)
    const alreadyHandled = consumeHandledConfigImage(image)
    const unchanged = nextImageRevision === acceptedImageRevision
    if (alreadyHandled || unchanged) {
      acceptedConfigText = candidateText
      acceptedImageRevision = nextImageRevision
      acceptedRevision = candidate
      const recovering = getMaintenanceState().active
      if (recovering) {
        leaveMaintenanceMode()
        process.send?.({ type: 'maintenance-cleared' })
      }
      logger.event('config.watcher.candidate.acknowledged', {
        revisionId: candidate.revisionId,
        alreadyHandled,
        unchanged,
        recoveredFromMaintenance: recovering,
      })
      return
    }
    const state = submitDiskConfigImage('manual')
    acceptedConfigText = candidateText
    acceptedImageRevision = nextImageRevision
    acceptedRevision = candidate
    const recovering = getMaintenanceState().active
    leaveMaintenanceMode()
    if (recovering) process.send?.({ type: 'maintenance-cleared' })
    logger.event('config.manual.candidate', {
      revisionId: candidate.revisionId,
      status: state.status,
      restart: state.restart,
      recoveredFromMaintenance: recovering,
      warnings: validation.warnings,
    })
  }

  const watch = (target: string, recursive = false): void => {
    if (!fs.existsSync(target) || watchers.has(target)) return
    const watcher = fs.watch(target, { recursive }, (_event, filename) => {
      if (!filename) return schedule()
      const normalized = filename.toString().replaceAll('\\', '/')
      if (target === cheryRoot) {
        const rootName = normalized.split('/')[0]!
        if (WATCHED_DIRS.includes(rootName)) watch(path.join(cheryRoot, rootName), true)
        if (!WATCHED_ROOT_FILES.has(normalized) && !WATCHED_DIRS.includes(rootName)) return
      }
      schedule()
    })
    watcher.on('error', (error) => {
      logger.event('config.watcher.error', { target, error: error.message }, LogLevel.warn)
    })
    watchers.set(target, watcher)
  }

  watch(cheryRoot)
  for (const name of WATCHED_DIRS) watch(path.join(cheryRoot, name), true)

  return {
    close(): void {
      closed = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers.values()) watcher.close()
    },
    validateNow: schedule,
  }
}
