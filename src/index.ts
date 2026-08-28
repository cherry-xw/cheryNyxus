import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const WORKER_FLAG = '--worker'
const MAX_BACKOFF_MS = 10_000
let healthPort = readHealthPort()
let worker: ChildProcess | undefined
let stopping = false
let intentionalRestart = false
let restartDelayMs = 500
let maintenanceReason: string | undefined

function configRoot(): string {
  return path.resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
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
  const child = spawn(process.execPath, workerArgs(), {
    env: {
      ...process.env,
      ...(maintenanceReason ? { CHERY_MAINTENANCE_REASON: maintenanceReason } : {}),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    // Windows: guardian 无控制台，worker 是控制台子进程，隐藏避免闪 cmd 窗
    windowsHide: true,
  })
  worker = child
  void waitForWorkerHealth(child)
  child.on('message', (message: unknown) => {
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
    // 端口占用属环境问题，重试无效：不进入重启循环（见 docs/service/README.md）。
    if (m.type === 'fatal') {
      stopping = true
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
    if (stopping) return
    if (intentionalRestart) {
      intentionalRestart = false
      restartDelayMs = 500
      startWorker()
      return
    }
    const delay = restartDelayMs
    restartDelayMs = Math.min(restartDelayMs * 2, MAX_BACKOFF_MS)
    console.error(
      `[guardian] worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}); retrying in ${delay}ms`,
    )
    setTimeout(startWorker, delay)
  })
}

function recoverConfigForMaintenance(reason: string): boolean {
  const root = configRoot()
  const configPath = path.join(root, 'config.yaml')
  const backupsDir = path.join(root, 'backups')
  if (!fs.existsSync(configPath) || !fs.existsSync(backupsDir)) return false
  const backups = fs
    .readdirSync(backupsDir)
    .filter((name) => /^config-.*\.yaml$/i.test(name))
    .sort((a, b) => b.localeCompare(a))
  const fallback = backups[0]
  if (!fallback) return false
  const rejectedPath = path.join(
    backupsDir,
    `rejected-startup-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.yaml`,
  )
  fs.copyFileSync(configPath, rejectedPath)
  fs.copyFileSync(path.join(backupsDir, fallback), configPath)
  maintenanceReason = `启动配置无效，已保全原文件并进入维护模式：${reason}`
  healthPort = readHealthPort()
  console.error(`[guardian] ${maintenanceReason}`)
  console.error(`[guardian] 原配置已保全到 ${rejectedPath}`)
  return true
}

function restartWorker(): void {
  const child = worker
  if (!child || intentionalRestart || stopping) return
  intentionalRestart = true
  child.kill('SIGTERM')
  setTimeout(() => {
    if (worker === child && child.exitCode === null) child.kill('SIGKILL')
  }, 5000).unref()
}

function shutdown(signal: string): void {
  if (stopping) return
  stopping = true
  console.log(`[guardian] received ${signal}, stopping worker`)
  const child = worker
  if (!child) process.exit(0)
  child.once('exit', () => process.exit(0))
  child.kill('SIGTERM')
  setTimeout(() => {
    if (worker === child && child.exitCode === null) child.kill('SIGKILL')
  }, 5000).unref()
}

/** worker 的 HTTP 服务可用后才重置崩溃退避，避免启动即崩时高频循环。 */
async function waitForWorkerHealth(child: ChildProcess): Promise<void> {
  while (!stopping && worker === child && child.exitCode === null) {
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
  if (process.argv[2] === WORKER_FLAG) {
    const { startWorker: runWorker } = await import('./worker.js')
    await runWorker(process.argv.slice(3))
    return
  }
  // 维护命令不进入常驻守护循环，保持原 node dist/index.js <command> 语义。
  if (process.argv.length > 2) {
    const { startWorker: runWorker } = await import('./worker.js')
    await runWorker(process.argv.slice(2))
    return
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  startWorker()
}

main().catch((err) => {
  process.send?.({ type: 'config-invalid', code: (err as Error).message })
  console.error('守护进程启动失败:', (err as Error).message)
  process.exit(1)
})
