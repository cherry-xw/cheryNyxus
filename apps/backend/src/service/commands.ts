import { getSoulDb } from '@/db/index.js'
import { AgentCommandRepository } from '@/db/agentCommands.js'
import { listEnvVarMap } from '@/utils/config.js'
import { MIN_BARE_VALUE_LENGTH } from '@/utils/envGuard.js'
import { CommandRuntime } from './commandRuntime.js'
import { logger } from '@/utils/logger/index.js'
import { randomUUID } from 'node:crypto'

let runtime: CommandRuntime | undefined
let cleanup: ReturnType<typeof setInterval> | undefined

export function initializeCommands(instanceId: string): CommandRuntime {
  if (runtime) return runtime
  const repository = new AgentCommandRepository(getSoulDb())
  runtime = new CommandRuntime(repository, { backendInstanceId: instanceId,
    environment: listEnvVarMap(), minimumBareSecretLength: MIN_BARE_VALUE_LENGTH,
    storageError: (commandId) => logger.warn(`命令 ${commandId} 的日志或详情写入失败，命令继续运行`),
  })
  try { repository.interruptPreviousInstances(instanceId, Date.now()) }
  catch { logger.warn('历史命令的中断状态无法保存；不自动重放这些命令') }
  const clean = () => {
    try { runtime?.logs.cleanup() } catch { logger.warn('命令日志清理失败；已有命令不会因此中断') }
  }
  clean()
  cleanup = setInterval(clean, 60_000)
  cleanup.unref()
  return runtime
}

export function getCommandRuntime(): CommandRuntime {
  return runtime ?? initializeCommands(process.env.CHERY_BACKEND_INSTANCE_ID || randomUUID())
}

export async function closeCommandLogs(): Promise<void> {
  clearInterval(cleanup)
  await runtime?.flush()
}
