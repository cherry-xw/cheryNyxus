import { Cron } from 'croner'
import config, { type PresetSchedule } from '@/utils/config.js'
import { resolvePresetSelection } from '@/agent/runtimeResolver.js'
import { runMaintenanceChat } from './maintenanceChat.js'
import { logger } from '@/utils/logger/index.js'
import { isRestartDraining, trackRestartActivity } from '@/service/restartCoordinator.js'

const cronJobs = new Map<string, Cron>()
const runningPresets = new Set<string>()

type ExecutionSnapshot = ReturnType<typeof resolvePresetSelection>

async function triggerMaintenance(
  presetName: string,
  schedule: PresetSchedule,
  resolved: ExecutionSnapshot,
): Promise<void> {
  if (isRestartDraining()) return
  if (runningPresets.has(presetName)) {
    logger.event('schedule.skip-running', { preset: presetName })
    return
  }
  runningPresets.add(presetName)
  const release = trackRestartActivity({
    kind: 'schedule',
    description: `等待维护任务 ${presetName} 完成`,
  })
  try {
    logger.event('schedule.trigger', {
      preset: presetName,
      cron: schedule.cron,
      leader: resolved.leaderName,
      taskPreview: schedule.task.slice(0, 200),
    })
    await runMaintenanceChat({
      presetName,
      task: schedule.task,
      selection: resolved.selection,
      systemPromptFile: resolved.systemPromptFile,
      workspace: resolved.workspace,
      skillFilter: resolved.skillFilter,
      spawnTypes: resolved.spawnTypes,
    })
  } catch (err) {
    logger.event(
      'schedule.trigger-failed',
      { preset: presetName, message: (err as Error).message, stack: (err as Error).stack },
      3,
    )
  } finally {
    runningPresets.delete(presetName)
    release()
  }
}

/** Validate and construct a paused job; apply performs the single active-map swap. */
export function preparePresetSchedule(
  presetName: string,
  schedule: PresetSchedule | undefined,
): { apply(): void; dispose(): void } {
  const enabled = schedule && schedule.enabled !== false
  const resolved = enabled ? resolvePresetSelection(presetName) : undefined
  const candidate =
    enabled && resolved
      ? new Cron(schedule.cron, { protect: true, paused: true }, () =>
          triggerMaintenance(presetName, schedule, resolved),
        )
      : undefined
  let adopted = false
  return {
    apply(): void {
      cronJobs.get(presetName)?.stop()
      if (candidate) {
        cronJobs.set(presetName, candidate)
        candidate.resume()
        logger.event('schedule.registered', {
          preset: presetName,
          cron: schedule!.cron,
          leader: resolved!.leaderName,
        })
      } else {
        cronJobs.delete(presetName)
        logger.event('schedule.skip-disabled', { preset: presetName })
      }
      adopted = true
    },
    dispose(): void {
      if (!adopted) candidate?.stop()
    },
  }
}

export function startScheduleService(): void {
  stopScheduleService()
  for (const [name, preset] of Object.entries(config.presets ?? {})) {
    if (!preset.schedule) continue
    try {
      preparePresetSchedule(name, preset.schedule).apply()
    } catch (err) {
      logger.event(
        'schedule.register-failed',
        { preset: name, cron: preset.schedule.cron, message: (err as Error).message },
        3,
      )
    }
  }
}

export function stopScheduleService(): void {
  for (const job of cronJobs.values()) job.stop()
  cronJobs.clear()
}
