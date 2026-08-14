import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
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
import { hashPassword, isHashed } from '@/utils/password.js'
import { hasRunningChats } from '@/service/chat/runtime.js'
import {
  configureRestartCoordinator,
  requestRestartWhenIdle,
} from '@/service/restartCoordinator.js'
import fs from 'node:fs'
import yaml from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_PORT = Number(process.env.WEB_PORT ?? 8183)
/**
 * 解析前端静态目录，优先级：
 * 1. `server.static_dir_override`（绝对路径，用户在 config.yaml 显式指定）
 * 2. `WEB_DIST_DIR` 环境变量（脚本/容器场景）
 * 3. 默认 `<repo>/dist/web/`（当前构建布局，pnpm web:build 与 pnpm build 输出到此处）
 * 4. 兼容 fallback `<repo>/web/dist/`（旧 vite.config 的 outDir，新工程无需）
 *
 * `server.serve_frontend=false` 时返回 `undefined` → 不挂文件 handler，仅 serve /api/*。
 * 探测到路径但磁盘不存在时仍返回路径（createHttpServer 内部日志警告并降级）。
 */
function resolveStaticDir(): string | undefined {
  if (config.server.serve_frontend === false) return undefined
  const fromConfig = config.server.static_dir_override
  if (fromConfig) return fromConfig
  if (process.env.WEB_DIST_DIR) return process.env.WEB_DIST_DIR
  const newLayout = path.resolve(__dirname, '..', 'dist', 'web')
  if (existsSync(newLayout)) return newLayout
  const legacyLayout = path.resolve(__dirname, '..', 'web', 'dist')
  return existsSync(legacyLayout) ? legacyLayout : newLayout
}

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

  // 启动自检：server.auth.password 为明文 → 改写为 scrypt 哈希并自动重启（rule12 fail loud）。
  // 用户可直接在 config 写明文密码；本钩子保证运行时只用哈希，且不落明文。
  if (config.server.auth?.password && !isHashed(config.server.auth.password)) {
    const hashed = hashPassword(config.server.auth.password)
    config.server.auth.password = hashed
    ensurePasswordHashedOnDisk(hashed)
    logger.info('检测到 server.auth.password 为明文，已改写为 scrypt 哈希，正在自动重启...')
    // 启动期无 chat 在跑 → isIdle()=true → 立即通知守护进程替换 worker。
    requestRestartWhenIdle()
    return
  }

  await bootstrapAgentRuntime()
  const staticDir = resolveStaticDir()
  if (staticDir && !existsSync(staticDir)) {
    logger.warn(
      `server.serve_frontend=true 但静态目录不存在: ${staticDir}（先 pnpm web:build；仅 API 模式生效）`,
    )
  }
  const { wss, httpServer } = startService({
    port: config.server.port,
    webPort: WEB_PORT,
    staticDir,
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

/** 将已哈希的 server.auth.password 写回盘上 config.yaml（保留字符串原文，含 $ 无需引号由 yaml 处理）。 */
function ensurePasswordHashedOnDisk(hashed: string): void {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  const disk = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
  const server = (disk.server ??= {}) as Record<string, unknown>
  const auth = (server.auth ??= {}) as Record<string, unknown>
  auth.password = hashed
  fs.writeFileSync(configPath, yaml.dump(disk, { lineWidth: -1 }))
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
