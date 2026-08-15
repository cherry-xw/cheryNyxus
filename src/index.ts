import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import config from './utils/config.js'

const WORKER_FLAG = '--worker'
const MAX_BACKOFF_MS = 10_000
const HEALTH_PORT = config.server.webPort
let worker: ChildProcess | undefined
let stopping = false
let intentionalRestart = false
let restartDelayMs = 500

function workerArgs(): string[] {
  return [fileURLToPath(import.meta.url), WORKER_FLAG]
}

function startWorker(): void {
  const child = spawn(process.execPath, workerArgs(), {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  worker = child
  void waitForWorkerHealth(child)
  child.on('message', (message: unknown) => {
    if ((message as { type?: string })?.type === 'restart-ready') restartWorker()
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
      const response = await fetch(`http://127.0.0.1:${HEALTH_PORT}/api/config`)
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
  console.error('守护进程启动失败:', (err as Error).message)
  process.exit(1)
})
