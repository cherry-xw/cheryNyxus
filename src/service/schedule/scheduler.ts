import { Cron } from 'croner'
import config from '@/utils/config.js'
import { resolvePresetSelection } from '@/agent/runtimeResolver.js'
import { runMaintenanceChat } from './maintenanceChat.js'
import { logger } from '@/utils/logger/index.js'

/**
 * 预设定时触发器（cron scheduler，参考 Claude Code Auto Dream「CLI 空闲时定期」）。
 *
 * 遍历 config.presets，对有 schedule.enabled !== false 的预设注册 cron 任务，
 * 到点 spawn 该预设的 leader 执行 schedule.task（典型：「维护」预设定时派 curator 做 Dream）。
 *
 * 与文章 Dream 的差异：CheryNyxus 无 CLI 空闲探测，改用 cron 定时（用户显式配置周期）。
 * 无后台守护进程轮询，cron 由 croner 纯 JS 计时（无 native 依赖）。
 *
 * 重启容错：cron 任务仅在运行期持有，进程重启后 startScheduleService 重建。
 * 未 finished 的维护 chat 走 listAllChats 但无 parent_chat_id → rebuildWaitedChildren 跳过（孤儿可接受）。
 */

const cronJobs: Cron[] = []

/**
 * 启动定时触发器服务：为每个 schedule.enabled !== false 的预设注册 cron 任务。
 * service 启动期调用（rebuildWaitedChildren 之后）。
 */
export function startScheduleService(): void {
  stopScheduleService()
  const presets = config.presets ?? {}
  for (const [name, preset] of Object.entries(presets)) {
    const schedule = preset.schedule
    if (!schedule) continue
    if (schedule.enabled === false) {
      logger.event('schedule.skip-disabled', { preset: name })
      continue
    }
    try {
      const job = new Cron(schedule.cron, { protect: true }, () => {
        void triggerMaintenance(name)
      })
      cronJobs.push(job)
      logger.event('schedule.registered', {
        preset: name,
        cron: schedule.cron,
        leader: preset.leader,
      })
    } catch (err) {
      // cron 表达式非法 → fail loud 但不阻塞其他预设注册
      logger.event(
        'schedule.register-failed',
        { preset: name, cron: schedule.cron, message: (err as Error).message },
        3,
      )
    }
  }
}

/**
 * 停止所有 cron 任务（进程关闭 / 重启重注册时调用）。
 */
export function stopScheduleService(): void {
  for (const job of cronJobs) {
    job.stop()
  }
  cronJobs.length = 0
}

/**
 * 触发某预设的维护任务：解析预设 leader 编制 → 创建独立维护 chat → 后台运行 schedule.task。
 * 错误隔离：失败仅 logger.error，不影响其他预设 / 下一次 cron 触发。
 */
async function triggerMaintenance(presetName: string): Promise<void> {
  const preset = config.presets?.[presetName]
  const schedule = preset?.schedule
  if (!preset || !schedule) return
  const task = schedule.task
  try {
    const resolved = resolvePresetSelection(presetName)
    logger.event('schedule.trigger', {
      preset: presetName,
      cron: schedule.cron,
      leader: preset.leader,
      taskPreview: task.slice(0, 200),
    })
    await runMaintenanceChat({
      presetName,
      task,
      selection: resolved.selection,
      systemPromptFile: resolved.systemPromptFile,
      workspace: resolved.workspace,
      skillFilter: resolved.skillFilter,
      spawnTypes: resolved.spawnTypes,
    })
  } catch (err) {
    logger.event(
      'schedule.trigger-failed',
      {
        preset: presetName,
        message: (err as Error).message,
        stack: (err as Error).stack,
      },
      3,
    )
  }
}
