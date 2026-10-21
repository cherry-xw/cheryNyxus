import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { recoverStartupConfig } from './utils/configStartupRecovery.js'
import { syncCheryTemplate } from '../../../scripts/lib/chery-template-sync.mjs'
import { initializeBackendEnvironment } from '../../../scripts/lib/backend-layout.mjs'
import { GuardianLifecycle } from './service/guardianLifecycle.js'
import { ControllerSocketClient } from './service/managedApp/socketRpc.js'

const layout = initializeBackendEnvironment(import.meta.url)

const WORKER_FLAG = '--worker'
const MAX_BACKOFF_MS = 10_000
/**
 * Manager 以子进程方式拉起后端时注入；此时崩溃恢复的唯一执行层是 Manager，
 * guardian 只报告非零退出码，禁止内部无限重启绕过 Manager 的 3 次重试上限。
 */
const MANAGED_BY_MANAGER = process.env.CHERY_MANAGED_BY_MANAGER === '1'
let healthPort = 8183
let worker: ChildProcess | undefined
let fatal = false
let intentionalRestart = false
let restartDelayMs = 500
let maintenanceReason: string | undefined
let instanceId = process.env.CHERY_BACKEND_INSTANCE_ID || randomUUID()
const managedController = new ControllerSocketClient()
const lifecycle = new GuardianLifecycle(instanceId, {
  cleanupManaged: async (entry) => {
    const task = { userId: entry.userId, appId: entry.appId, taskId: entry.taskId }
    await managedController.cancelAppCommand(task).catch(() => {})
    const result = await managedController.getTaskStatus(task)
    return result.taskId === entry.taskId && result.userId === entry.userId && result.appId === entry.appId &&
      result.status !== 'running' && result.finishedAt !== null
  },
  publish: (message) => {
    if (!process.connected) return
    try { process.send?.(message, () => {}) } catch { /* Parent control loss is not permission to resume. */ }
  },
  complete: (state) => {
    const exit = () => process.exit(0)
    if (process.connected) {
      try { process.send?.({ type: 'stop-state', state }, exit) } catch { exit() }
    } else exit()
  },
})

function configRoot(): string {
  return path.resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
}

function templateRoot(): string {
  return layout.templateDir
}

/** Template upgrades are best-effort: an existing workspace must remain bootable on sync failure. */
function syncWorkspaceTemplate(): void {
  try {
    const report = syncCheryTemplate({
      templateDir: templateRoot(),
      runtimeRoot: path.resolve(process.env.CHERY_DIR || process.cwd()),
    })
    for (const warning of report.warnings) console.warn(`[guardian] template sync: ${warning}`)
    console.log(
      `[guardian] template sync: created=${report.created} copied=${report.copied.length} updated=${report.updated.length} preserved=${report.preserved.length}`,
    )
  } catch (error) {
    console.warn(
      `[guardian] template sync failed; continuing with the existing workspace: ${(error as Error).message}`,
    )
  }
}

/** Guardian must remain bootable even when config.yaml is malformed. */
function readHealthPort(): number {
  const fromEnv = Number(process.env.WEB_PORT)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  try {
    const raw = yaml.load(fs.readFileSync(path.join(configRoot(), 'config.yaml'), 'utf8')) as {
      server?: { webPort?: unknown }
    }
    const fromFile = Number(raw?.server?.webPort)
    return Number.isFinite(fromFile) && fromFile > 0 ? fromFile : 8183
  } catch {
    return 8183
  }
}

function workerArgs(): string[] {
  return [fileURLToPath(import.meta.url), WORKER_FLAG]
}

function startWorker(): void {
  if (fatal || lifecycle.isStopping()) return
  const child = spawn(process.execPath, workerArgs(), {
    env: {
      ...process.env,
      ...(maintenanceReason ? { CHERY_MAINTENANCE_REASON: maintenanceReason } : {}),
      CHERY_BACKEND_INSTANCE_ID: instanceId,
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Windows: guardian 无控制台，worker 是控制台子进程，隐藏避免闪 cmd 窗
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  worker = child
  lifecycle.attach(child, instanceId)
  void waitForWorkerHealth(child)
  child.on('message', (message: unknown) => {
    if (lifecycle.receiveWorker(child, message)) return
    const m = message as { type?: string; code?: string; port?: number } | null
    if (!m) return
    if (m.type === 'restart-ready') {
      restartWorker()
      return
    }
    if (m.type === 'maintenance-cleared') {
      maintenanceReason = undefined
      return
    }
    if (m.type === 'config-invalid') {
      if (recoverConfigForMaintenance(m.code ?? '配置无法加载')) {
        intentionalRestart = true
      }
      return
    }
    // worker 报告不可重试的启动失败（如端口被占用）→ 停止守护循环并提示。
    // 端口占用属环境问题，重试无效：不进入重启循环（见 docs/backend/service/README.md）。
    if (m.type === 'fatal') {
      if (lifecycle.isStopping()) return
      fatal = true
      if (m.code === 'EADDRINUSE') {
        console.error(`[guardian] 后端启动失败：端口 ${m.port} 已被其他进程占用。`)
        console.error('[guardian] 请释放该端口后重新启动（guardian 不再自动重试）。')
      } else {
        console.error(`[guardian] 后端启动失败（${m.code ?? 'unknown'}），不再自动重试。`)
      }
      process.exit(1)
    }
  })
  child.once('exit', (code, signal) => {
    if (worker === child) worker = undefined
    if (lifecycle.exited(child, code, signal) || fatal) return
    if (intentionalRestart) {
      intentionalRestart = false
      restartDelayMs = 500
      instanceId = randomUUID()
      startWorker()
      return
    }
    if (MANAGED_BY_MANAGER) {
      // 非预期崩溃：把恢复交给 Manager，单层重试才能保证 3 次上限不被绕过。
      console.error(
        `[guardian] worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}); handing recovery to Manager`,
      )
      process.exit(code === null || code === 0 ? 1 : code)
    }
    const delay = restartDelayMs
    restartDelayMs = Math.min(restartDelayMs * 2, MAX_BACKOFF_MS)
    console.error(
      `[guardian] worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}); retrying in ${delay}ms`,
    )
    setTimeout(() => { instanceId = randomUUID(); startWorker() }, delay)
  })
  child.once('disconnect', () => lifecycle.disconnected(child))
}

function recoverConfigForMaintenance(reason: string): boolean {
  const root = configRoot()
  const configPath = path.join(root, 'config.yaml')
  if (!fs.existsSync(configPath)) return false
  try {
    const result = recoverStartupConfig(configPath)
    maintenanceReason = `启动配置无效，已保全原文件${result.restored ? '并仅恢复业务分区' : '，拒绝整文件恢复'}：${reason}`
    healthPort = readHealthPort()
    console.error(`[guardian] ${maintenanceReason}`)
    console.error(`[guardian] 原配置已保全到 ${result.rejectedPath}`)
    return result.restored
  } catch (error) {
    console.error(`[guardian] 配置恢复事务失败，未覆盖文件：${(error as Error).message}`)
    return false
  }
}

function restartWorker(): void {
  const child = worker
  if (!child || intentionalRestart || fatal || lifecycle.isStopping()) return
  intentionalRestart = true
  // Node on Windows cannot deliver SIGTERM gracefully; use the existing IPC channel.
  child.send({ type: 'restart-close' }, (error) => {
    if (error) { intentionalRestart = false; lifecycle.disconnected(child) }
  })
}

function shutdown(signal: string): void {
  console.log(`[guardian] received ${signal}, stopping worker`)
  intentionalRestart = false
  lifecycle.externalStop(randomUUID())
}

/** worker 的 HTTP 服务可用后才重置崩溃退避，避免启动即崩时高频循环。 */
async function waitForWorkerHealth(child: ChildProcess): Promise<void> {
  while (!fatal && !lifecycle.isStopping() && worker === child && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${healthPort}/api/config`)
      if (response.ok) {
        restartDelayMs = 500
        console.log('[guardian] worker is healthy')
        return
      }
    } catch {
      // worker 尚未 bind HTTP port，继续轮询。
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 250)
      timer.unref()
    })
  }
}

async function main(): Promise<void> {
  // Ingress maintenance must remain usable without loading business/core config.
  if (process.argv[2] === 'ingress') {
    const { runIngressCommand } = await import('./service/ingress/commands.js')
    runIngressCommand(process.argv.slice(3))
    return
  }
  if (process.argv[2] === WORKER_FLAG) {
    const { startWorker: runWorker } = await import('./worker.js')
    await runWorker(process.argv.slice(3))
    return
  }
  syncWorkspaceTemplate()
  healthPort = readHealthPort()
  // 维护命令不进入常驻守护循环，保持原 node dist/index.js <command> 语义。
  if (process.argv.length > 2) {
    const { startWorker: runWorker } = await import('./worker.js')
    await runWorker(process.argv.slice(2))
    return
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('message', (message: unknown) => {
    if (lifecycle.receive(message)) { if (lifecycle.isStopping()) intentionalRestart = false; return }
    if ((message as { type?: string } | null)?.type === 'restart-schedule' && !lifecycle.isStopping() && worker?.connected)
      worker.send({ type: 'restart-schedule' }, () => {})
  })
  startWorker()
}

main().catch((err) => {
  process.send?.({ type: 'config-invalid', code: (err as Error).message })
  console.error('守护进程启动失败:', (err as Error).message)
  process.exit(1)
})
