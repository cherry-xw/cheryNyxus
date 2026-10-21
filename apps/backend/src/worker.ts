import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { startService } from './service/index.js'
import { getSoulDb, closeAllDbs } from './db/index.js'
import { migrateFileStorage } from './service/media/migration.js'
import { registerMcpFileResults } from './service/media/mcpResults.js'
import { getAssetStore } from './service/media/store.js'
import { recoverFileOperations } from './service/fileServices/operations.js'
import { reconcileMessageCounts } from './db/message.js'
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
import config, { readRawConfig } from '@/utils/config.js'
import { hashPassword, isHashed } from '@/utils/password.js'
import { randomBytes } from 'node:crypto'
import { getAgentRuntimeStats, hasRunningChats } from '@/service/chat/runtimeCache.js'
import { createWorkerLifecycle } from '@/service/workerLifecycle.js'
import { initializeCommands, closeCommandLogs } from '@/service/commands.js'
import { closeAllTerminals } from '@/service/terminal/manager.js'
import { launchDetachedResume } from '@/service/chat/send.js'
import { getChat, getRootChatId } from '@/db/chat.js'
import { reconcileOrphanedExecutionRuns } from '@/service/chat/runRecovery.js'
import { sweepOrphanQuestionBatchesAcrossRoots } from '@/db/question.js'
import {
  configureRestartCoordinator,
  requestRestartWhenIdle,
  cancelPendingRestart,
  subscribeRestartState,
} from '@/service/restartCoordinator.js'
import { getBashProcessActivity } from '@/agent/sense/processRegistry.js'
import { activeRootIds, treeBoundaryReason } from '@/service/config/treeBoundary.js'
import { getConfigApplyCoordinator } from '@/service/config/commit.js'
import { validateRestartCandidate } from '@/service/config/restartPreflight.js'
import { stopScheduleService } from '@/service/schedule/scheduler.js'
import fs from 'node:fs'
import { persistStartupPasswordHash } from './utils/configOwnership.js'
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
 * 3. 默认 `<repo>/dist/web/`（pnpm web:build 输出到此处）
 *
 * `server.serve_frontend=false` 时返回 `undefined` → 不挂文件 handler，仅 serve /api/*。
 * 探测到路径但磁盘不存在时仍返回路径（createHttpServer 内部日志警告并降级）。
 */
function resolveStaticDir(): string | undefined {
  if (config.server.serve_frontend === false) return undefined
  const fromConfig = config.server.static_dir_override
  if (fromConfig) return fromConfig
  if (process.env.WEB_DIST_DIR) return process.env.WEB_DIST_DIR
  const componentRoot = path.resolve(__dirname, '..')
  const repoRoot = path.basename(componentRoot) === 'backend'
    ? path.resolve(componentRoot, '../..')
    : componentRoot
  return path.resolve(repoRoot, 'dist/web')
}

/** 业务 worker 入口；可由守护进程 IPC 拉起，也可为维护子命令直接运行。 */
export async function startWorker(args: string[] = process.argv.slice(2)): Promise<void> {
  initLogger(config.global.logger)
  logger.recordConfigBaseline(readRawConfig())

  configureRestartCoordinator({
    isIdle: () => !hasRunningChats(),
    blockers: () => [
      ...getBashProcessActivity().map(({ chatId, pid, description }) => ({
        kind: 'process',
        chatId,
        pid,
        description,
      })),
      ...(restartEngine
        ? activeRootIds().flatMap((chatId) => {
            const description = treeBoundaryReason(chatId, true)
            return description ? [{ kind: 'tree', chatId, description }] : []
          })
        : []),
      ...(restartEngine?.isApplying() ? [{ kind: 'config', description: '等待配置应用完成' }] : []),
    ],
    onRestartReady: process.send
      ? () => {
          if (!process.connected) throw new Error('Guardian disconnected')
          return new Promise<void>((resolve, reject) => {
            process.send?.({ type: 'restart-ready' }, (error: Error | null) =>
              error ? reject(error) : resolve(),
            )
          })
        }
      : undefined,
    // Preserve later disk edits. Failed preflight must never restore an unrelated backup.
    validateBeforeRestart: () => validateRestartCandidate(restartEngine?.getState().savedRevision),
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
    const original = config.server.auth.password
    const hashed = hashPassword(original)
    ensurePasswordHashedOnDisk(original, hashed)
    config.server.auth.password = hashed
    logger.info('检测到 server.auth.password 为明文，已改写为 scrypt 哈希，正在自动重启...')
    // 启动期无 chat 在跑 → isIdle()=true → 立即通知守护进程替换 worker。
    if (requestRestartWhenIdle() !== 'manual') return
  }

  getSoulDb()
  const commands = initializeCommands(statusInstanceId)
  let closeResources: (() => Promise<void>) | undefined
  let resourcesReady: () => void = () => {}
  const readyToClose = new Promise<void>((resolve) => { resourcesReady = resolve })
  const lifecycle = createWorkerLifecycle({
    db: getSoulDb(), backendInstanceId: statusInstanceId,
    configApplying: () => restartEngine?.isApplying() ?? false,
    commandBlockers: () => commands.blockers(),
    forceCommands: () => commands.cancelAll(),
    close: async () => { await readyToClose; await closeResources?.() },
    wakeQueued: async (chatId) => {
      const metadata = JSON.parse(getChat(getRootChatId(chatId))?.metadata ?? '{}') as { fileOwnerId?: string }
      await launchDetachedResume({ connectionId: `backend-cancel-stop:${chatId}`, authenticatedUserId: metadata.fileOwnerId, log: logger }, chatId, `cancel-stop:${randomBytes(12).toString('hex')}`)
    },
    publish: (state) => {
      if (!process.connected) return
      try { process.send?.({ type: 'stop-state', state }, () => {}) } catch { /* Parent must retain its saved stop intent. */ }
    },
    error: (error) => logger.warn(`停止控制失败：${(error as Error).message}`),
  })
  lifecycle.recover()
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
  // 长期短路 canResume 造成"无卡片无按钮"硬死锁（见 docs/shared/protocol/interactions.md 工作台树级暂停与续接）。
  const sweptQuestionBatches = sweepOrphanQuestionBatchesAcrossRoots()
  if (sweptQuestionBatches > 0) {
    logger.event('chat.questions.swept', { count: sweptQuestionBatches }, LogLevel.warn)
  }
  restartEngine = getConfigApplyCoordinator()
  subscribeRestartState((state) => restartEngine?.setRestartState(state))
  restartEngine.configureRestart((required) => {
    if (required) requestRestartWhenIdle()
    else cancelPendingRestart()
  })

  // 启动自检：文件夹浏览协议（config.workspace.browse.*）根白名单有效性（rule12 fail loud）
  const browseRootWarnings = validateBrowseRoots()
  for (const w of browseRootWarnings) logger.warn(w)
  const staticDir = resolveStaticDir()
  if (staticDir && !existsSync(staticDir)) {
    logger.warn(
      `server.serve_frontend=true 但静态目录不存在: ${staticDir}（先 pnpm web:build；仅 API 模式生效）`,
    )
  }
  await migrateFileStorage()
  registerMcpFileResults()
  recoverFileOperations()
  const cleanupFiles = () => {
    try { getAssetStore().cleanup(Date.now(), config.files?.unreferencedAssetRetentionHours ?? 24, config.files?.unreferencedUploadRetentionHours ?? 24) }
    catch (error) { logger.warn(`文件清理失败：${(error as Error).message}`) }
  }
  cleanupFiles()
  const fileCleanupTimer = setInterval(cleanupFiles, 60 * 60 * 1000)
  fileCleanupTimer.unref()
  const service = startService({
    businessPreset: config.server.businessPreset,
    port: config.server.port,
    webPort: config.server.webPort,
    staticDir,
    host: config.server.host,
    auth: config.server.auth,
    channelAuth: process.env.CHERY_CHANNEL_AUTH
      ? JSON.parse(process.env.CHERY_CHANNEL_AUTH)
      : undefined,
    ingress: {
      runtimeOptions: process.env.CHERY_PLUGIN_RUNTIME_OPTIONS
        ? JSON.parse(process.env.CHERY_PLUGIN_RUNTIME_OPTIONS)
        : undefined,
    },
    remote: config.server.remote?.enabled
      ? {
          httpPort: config.server.remote.httpPort,
          websocketPort: config.server.remote.websocketPort,
        }
      : undefined,
  })
  const { wss, httpServer, remoteWss, remoteHttpServer } = service
  let serviceAddresses: unknown
  void service.ready.then((addresses) => {
    serviceAddresses = addresses
    logger.info(
      `远程专用入口已启动：HTTP 127.0.0.1:${addresses.remote?.httpPort ?? 0} · WS 127.0.0.1:${addresses.remote?.websocketPort ?? 0}`,
    )
    writeBackendStatus(addresses)
  })
  const statusTimer = setInterval(() => {
    if (serviceAddresses) writeBackendStatus(serviceAddresses)
  }, 2_000)
  statusTimer.unref()
  // 启动汇报：打印监听的服务地址（rule12 fail loud——端口监听可见）。
  const bindHost = config.server.host === '0.0.0.0' ? '0.0.0.0 (所有接口)' : config.server.host
  logger.info(
    `服务已启动：WebSocket ws://${bindHost}:${config.server.port} · ` +
      `HTTP http://${bindHost}:${config.server.webPort}（登录/静态资源）`,
  )

  const configWatcher = startConfigRevisionWatcher()

  let closing: Promise<void> | undefined
  closeResources = () => closing ??= (async () => {
    logger.info('正在关闭服务；正常关闭不设隐藏强制退出时限')
    service.stopSchedule()
    configWatcher.close()
    clearInterval(statusTimer)
    clearInterval(fileCleanupTimer)
    stopScheduleService()
    await service.stopIngress()
    closeAllTerminals()
    await commands.cancelAll()
    if (lifecycle.coordinator.snapshot().phase !== 'force_stopping') await commands.waitForCompletion()
    await closeCommandLogs()
    clearAllApprovals()
    clearAllWaitedChildren()
    closeAllConnections(wss)
    if (remoteWss) closeAllConnections(remoteWss)
    await Promise.all([
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
      ...(remoteWss ? [new Promise<void>((resolve) => remoteWss.close(() => resolve()))] : []),
      ...(remoteHttpServer ? [new Promise<void>((resolve) => remoteHttpServer.close(() => resolve()))] : []),
      closeMcpClients(),
    ])
    lifecycle.syncUnknown()
    closeAllDbs()
    lifecycle.dispose()
    process.exit(0)
  })()
  resourcesReady()
  process.on('message', (message: unknown) => {
    const type = (message as { type?: string } | null)?.type
    if (type === 'restart-schedule' && lifecycle.coordinator.canConsumeInput()) requestRestartWhenIdle()
    if (type === 'restart-close' && lifecycle.coordinator.canConsumeInput())
      void closeResources?.().catch((error) => logger.warn(`配置重启收尾失败：${(error as Error).message}`))
  })
}

let restartEngine: ReturnType<typeof getConfigApplyCoordinator> | undefined

/** 将已哈希的 server.auth.password 写回盘上 config.yaml（保留字符串原文，含 $ 无需引号由 yaml 处理）。 */
function ensurePasswordHashedOnDisk(original: string, hashed: string): void {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  persistStartupPasswordHash(configPath, original, hashed)
}

const statusInstanceId = process.env.CHERY_BACKEND_INSTANCE_ID || randomBytes(24).toString('base64url')
function writeBackendStatus(addresses: unknown): void {
  const file = process.env.CHERY_BACKEND_STATUS_FILE
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      `${JSON.stringify({ protocolVersion: 1, instanceId: statusInstanceId, status: 'running', addresses, agents: getAgentRuntimeStats(), updatedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    )
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  } catch (error) {
    logger.warn(`无法写入后端监听状态：${(error as Error).message}`)
  }
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
