import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startService } from './service/index.js'
import { getSoulDb, closeAllDbs } from './db/index.js'
import { reconcileMessageCounts } from './db/chat.js'
import { compileSenses } from './core/sense/compiler/index.js'
import {
  runSenseTestsAndCollect,
  reportSenseCompileResult,
} from './agent/sense/compileToolsReporter.js'
import { bootstrapAgentRuntime } from './agent/bootstrap.js'
import { closeMcpClients } from '@/core/mcp/index.js'
import { reloadSenses } from './agent/sense/index.js'
import { clearAllApprovals } from '@/core/sense'
import { clearAllWaitedChildren } from '@/agent/spawnBroker.js'
import { closeAllConnections } from '@/service/websocket/index.js'
import { initLogger, logger, LogLevel } from '@/utils/logger/index.js'
import config, { readRawConfig } from '@/utils/config.js'
import { hasRunningChats } from '@/service/chat/runtime.js'
import { configureRestartCoordinator } from '@/service/restartCoordinator.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_PORT = Number(process.env.WEB_PORT ?? 8183)
const STATIC_DIR = process.env.WEB_DIST_DIR ?? path.resolve(__dirname, '..', 'web', 'dist')

/** 业务 worker 入口；可由守护进程 IPC 拉起，也可为维护子命令直接运行。 */
export async function startWorker(args: string[] = process.argv.slice(2)): Promise<void> {
  initLogger(config.global.logger)
  logger.recordConfigBaseline(readRawConfig())

  configureRestartCoordinator({
    isIdle: () => !hasRunningChats(),
    onRestartReady: process.send ? () => process.send?.({ type: 'restart-ready' }) : undefined,
  })

  const subcommand = args[0]
  if (subcommand === 'compile-senses') {
    await compileSensesCommand()
    return
  }
  if (subcommand === 'reconcile-db') {
    const result = reconcileMessageCounts()
    logger.info(`reconcile-db: checked ${result.checked} chats, fixed ${result.fixed} drift(s)`)
    closeAllDbs()
    return
  }

  await bootstrapAgentRuntime()
  const { wss, httpServer } = startService({
    port: config.server.port,
    webPort: WEB_PORT,
    staticDir: STATIC_DIR,
    host: config.server.host,
    auth: config.server.auth,
  })

  getSoulDb()
  const reconcileResult = reconcileMessageCounts()
  if (reconcileResult.fixed > 0) {
    logger.event(
      'db.reconcile',
      { checked: reconcileResult.checked, fixed: reconcileResult.fixed },
      LogLevel.warn,
    )
  }

  let shuttingDown = false
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`\n收到 ${signal}，正在关闭服务...`)
    closeAllConnections(wss)
    clearAllApprovals()
    clearAllWaitedChildren()
    try {
      await Promise.race([
        Promise.all([
          new Promise<void>((resolve) => wss.close(() => resolve())),
          new Promise<void>((resolve) => httpServer.close(() => resolve())),
          closeMcpClients(),
        ]),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('关闭超时')), 5000)),
      ])
    } catch {
      logger.warn('关闭超时，强制退出')
    }
    closeAllDbs()
    process.exit(0)
  }

  process.once('SIGINT', () => {
    void gracefulShutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void gracefulShutdown('SIGTERM')
  })
}

async function compileSensesCommand(): Promise<void> {
  const summary = await compileSenses()
  if (summary.succeeded.length === 0 && summary.failed.length === 0) {
    logger.info('未找到外部感官源文件')
    await reloadSenses()
    return
  }
  const testResults = await runSenseTestsAndCollect(summary.succeeded)
  reportSenseCompileResult(summary, testResults)
  await reloadSenses()
  if (
    summary.failed.length > 0 ||
    [...testResults.values()].some((r) => !r.detail.passed && r.detail.error)
  ) {
    process.exitCode = 1
  }
}
