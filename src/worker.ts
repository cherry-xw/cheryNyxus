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
import { validateBrowseRoots } from './service/browse/sandbox.js'
import { closeMcpClients } from '@/core/mcp/index.js'
import { reloadSenses } from './agent/sense/index.js'
import { clearAllApprovals } from '@/core/sense'
import { clearAllWaitedChildren } from '@/agent/spawnBroker.js'
import { closeAllConnections } from '@/service/websocket/index.js'
import { initLogger, logger, LogLevel } from '@/utils/logger/index.js'
import config, { readRawConfig, validateLoadable, rollbackConfig } from '@/utils/config.js'
import { hashPassword, isHashed } from '@/utils/password.js'
import { hasRunningChats } from '@/service/chat/runtime.js'
import { reconcileOrphanedExecutionRuns } from '@/service/chat/runRecovery.js'
import { sweepOrphanQuestionBatchesAcrossRoots } from '@/db/question.js'
import {
  configureRestartCoordinator,
  requestRestartWhenIdle,
} from '@/service/restartCoordinator.js'
import fs from 'node:fs'
import yaml from 'js-yaml'
import { ensureCurrentConfigRevision } from '@/service/config/revision.js'
import { startConfigRevisionWatcher } from '@/service/config/watcher.js'
import { getActiveConfigRevision } from '@/db/epoch.js'
import {
  applyRetiredRoles,
  archivePresetRoots,
  detectRemovedPresetIds,
  detectRetiredRoleIdentities,
} from '@/service/config/roleLifecycle.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
    // 重启前 dry-run 兜底预检（config.save handler 已同步预检；此处防 save 后到空闲前配置被改）。
    // 仅结构硬错误阻塞：失败 → 自动回滚最近备份 + 事件日志，不通知守护进程（进程保持运行，前端已在 save 响应得知）。
    // 软告警（$ENV 缺失等）不阻塞，仅记录日志。
    validateBeforeRestart: () => {
      const raw = readRawConfig()
      const loadable = validateLoadable(raw)
      if (loadable.ok) {
        if (loadable.warnings.length > 0) {
          logger.event('config.restart.warnings', { warnings: loadable.warnings }, LogLevel.warn)
        }
        return { ok: true }
      }
      try {
        const backup = rollbackConfig()
        logger.event(
          'config.restart.validation_failed',
          { errors: loadable.errors, warnings: loadable.warnings, rollback: backup.backup },
          LogLevel.warn,
        )
      } catch (err) {
        logger.event(
          'config.restart.rollback_failed',
          { error: (err as Error).message },
          LogLevel.error,
        )
      }
      return { ok: false, error: loadable.errors.join('\n') }
    },
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

  getSoulDb()
  const previousRevision = getActiveConfigRevision()
  const currentRaw = readRawConfig()
  const activeRevision = ensureCurrentConfigRevision()
  if (previousRevision && previousRevision.revisionId !== activeRevision.revisionId) {
    const beforeRoles = (previousRevision.snapshot.roles ?? {}) as Record<
      string,
      Record<string, unknown>
    >
    const afterRoles = currentRaw.roles as unknown as Record<string, Record<string, unknown>>
    const retired = detectRetiredRoleIdentities(beforeRoles, afterRoles)
    applyRetiredRoles({
      roleIds: retired.ids,
      roleNames: retired.names,
      reason: `角色在已激活配置修订 ${activeRevision.revisionId} 中被删除或语义修改`,
    })
    const removedPresetIds = detectRemovedPresetIds(
      (previousRevision.snapshot.presets ?? {}) as Record<string, Record<string, unknown>>,
      currentRaw.presets as unknown as Record<string, Record<string, unknown>>,
    )
    archivePresetRoots(
      removedPresetIds,
      `预设在已激活配置修订 ${activeRevision.revisionId} 中被删除`,
    )
  }
  logger.event('config.revision.active', {
    revisionId: activeRevision.revisionId,
    fingerprint: activeRevision.fingerprint,
  })

  await bootstrapAgentRuntime()

  const recoveredRuns = reconcileOrphanedExecutionRuns()
  if (recoveredRuns.length > 0) {
    logger.event(
      'chat.runs.recovered',
      { count: recoveredRuns.length, chatIds: recoveredRuns.map((run) => run.chatId) },
      LogLevel.warn,
    )
  }

  // 启动期清扫僵尸提问批（batch pending 但零 pending item），防重启后 hasPendingQuestionBatches
  // 长期短路 canResume 造成"无卡片无按钮"硬死锁（见 docs/interaction.md 工作台树级暂停与续接）。
  const sweptQuestionBatches = sweepOrphanQuestionBatchesAcrossRoots()
  if (sweptQuestionBatches > 0) {
    logger.event('chat.questions.swept', { count: sweptQuestionBatches }, LogLevel.warn)
  }

  // 启动自检：文件夹浏览协议（config.workspace.browse.*）根白名单有效性（rule12 fail loud）
  const browseRootWarnings = validateBrowseRoots()
  for (const w of browseRootWarnings) logger.warn(w)
  const staticDir = resolveStaticDir()
  if (staticDir && !existsSync(staticDir)) {
    logger.warn(
      `server.serve_frontend=true 但静态目录不存在: ${staticDir}（先 pnpm web:build；仅 API 模式生效）`,
    )
  }
  const { wss, httpServer } = startService({
    port: config.server.port,
    webPort: config.server.webPort,
    staticDir,
    host: config.server.host,
    auth: config.server.auth,
  })
  // 启动汇报：打印监听的服务地址（rule12 fail loud——端口监听可见）。
  const bindHost = config.server.host === '0.0.0.0' ? '0.0.0.0 (所有接口)' : config.server.host
  logger.info(
    `服务已启动：WebSocket ws://${bindHost}:${config.server.port} · ` +
      `HTTP http://${bindHost}:${config.server.webPort}（登录/静态资源）`,
  )

  const configWatcher = startConfigRevisionWatcher()

  let shuttingDown = false
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`\n收到 ${signal}，正在关闭服务...`)
    closeAllConnections(wss)
    clearAllApprovals()
    clearAllWaitedChildren()
    configWatcher.close()
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
