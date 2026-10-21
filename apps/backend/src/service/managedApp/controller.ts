import { scheduleNotifications, type AppNotification } from './notifications.ts'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { lifecycleStopReason, weeklyCleanupBoundary } from './lifecycle.ts'
import { spawnIsolatedTask } from './taskIsolation.ts'
import { promisify } from 'node:util'
import { initializeApplicationNetworkLimits, limitApplicationNetwork } from './networkLimits.ts'
import { randomUUID } from 'node:crypto'
import {
  access,
  lstat,
  cp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import {
  DEFAULT_RUNTIME_LIMITS,
  ManagedAppError,
  appIdSchema,
  qqRealUserIdSchema,
  relativeCwdSchema,
  type AppRuntimeStatus,
  type CommandTaskResult,
  type ControllerCommandOutput,
  type ControllerRpcRequest,
  type ManagedAppRecord,
  type ParentResourceSnapshot,
  type RuntimeLimits,
  type StopReason,
} from './types.ts'
import { ResourceLedger, type HostResourceAdapter } from './resourceLedger.ts'
import { XfsQuotaManager, assertNoSymlinkChain } from './quotaManager.ts'
import { ControllerStateStore } from './stateStore.ts'

import { z } from 'zod'

const execFileAsync = promisify(execFile)

export interface AppControllerOptions {
  stateFilePath?: string
  xfsMountPoint?: string
  hostUserFilesRoot?: string
  parentCgroupDir?: string
  systemdSliceName?: string
  dockerNetworkName?: string
  runtimeImage?: string
  templateSkeletonHostPath?: string
  limits?: Partial<RuntimeLimits>
}

interface RunningTaskHandle {
  result: CommandTaskResult
  cancel: () => Promise<void>
}

export class ManagedAppController {
  private readonly opts: Required<Omit<AppControllerOptions, 'limits'>>
  private readonly limits: RuntimeLimits
  private readonly store: ControllerStateStore
  private readonly quota: XfsQuotaManager
  private readonly ledger: ResourceLedger
  private readonly tasks = new Map<string, RunningTaskHandle>()
  private readonly deletingApps = new Set<string>()
  private readonly earlyCancellations = new Map<string, number>()
  private readonly taskCleanups = new Map<string, { appKey: string; kill: () => Promise<void> }>()
  private readonly containerStarts = new Map<string, Promise<ManagedAppRecord>>()
  private readonly appLocks = new Map<string, Promise<unknown>>()

  constructor(options: AppControllerOptions = {}) {
    this.limits = { ...DEFAULT_RUNTIME_LIMITS, ...options.limits }
    this.opts = {
      stateFilePath:
        options.stateFilePath ?? '/var/lib/cherynyxus-apps/controller-state.json',
      xfsMountPoint: options.xfsMountPoint ?? '/var/lib/cherynyxus-apps/mnt',
      hostUserFilesRoot:
        options.hostUserFilesRoot ?? '/home/chery/docker/cherynyxus/user-files',
      parentCgroupDir:
        options.parentCgroupDir ??
        '/sys/fs/cgroup/cherynyxus.slice/cherynyxus-apps.slice',
      systemdSliceName: options.systemdSliceName ?? 'cherynyxus-apps.slice',
      dockerNetworkName: options.dockerNetworkName ?? 'cherynyxus_apps_net',
      runtimeImage:
        options.runtimeImage ??
        process.env.CHERY_APP_RUNTIME_IMAGE ??
        'cherynyxus-app-runtime:latest',
      templateSkeletonHostPath:
        options.templateSkeletonHostPath ??
        '/var/lib/cherynyxus-apps/template-skeleton',
    }

    this.store = new ControllerStateStore(this.opts.stateFilePath)
    this.quota = new XfsQuotaManager({
      xfsMountPoint: this.opts.xfsMountPoint,
      hostUserFilesRoot: this.opts.hostUserFilesRoot,
      diskQuotaBytes: this.limits.projectDiskQuotaBytes,
      inodeQuota: this.limits.projectInodeQuota,
    })

    const adapter: HostResourceAdapter = {
      readParentMemoryCurrent: () =>
        this.readCgroupNumber(path.join(this.opts.parentCgroupDir, 'memory.current')),
      readParentMemoryMax: () =>
        this.readCgroupNumber(
          path.join(this.opts.parentCgroupDir, 'memory.max'),
          this.limits.parentMemoryNormalMaxBytes,
        ),
      writeParentMemoryMax: async (bytes: number) => {
        await writeFile(
          path.join(this.opts.parentCgroupDir, 'memory.max'),
          String(bytes),
          'utf8',
        )
      },
      readParentPidsCurrent: () =>
        this.readCgroupNumber(path.join(this.opts.parentCgroupDir, 'pids.current')),
      readParentPidsMax: () =>
        this.readCgroupNumber(
          path.join(this.opts.parentCgroupDir, 'pids.max'),
          this.limits.parentPidsMax,
        ),
      readHostMemAvailable: () => this.readProcMemAvailable(),
      readHostDiskAvailable: () => this.readDiskAvailableBytes(),
      readContainerMemoryCurrent: appKey =>
        this.readContainerMemoryCurrentByKey(appKey),
      updateContainerResources: (appKey, res) =>
        this.updateDockerContainerLimits(appKey, res),
      killContainerCommandProcesses: appKey =>
        this.killTransientProcessesInContainer(appKey),
      cleanContainerTmp: appKey => this.cleanTmpInContainer(appKey),
      restartContainerCleanRuntime: appKey =>
        this.restartContainerClean(appKey),
      persistBurstTicket: ticket => this.store.setBurstTicket(ticket),
      loadPersistedBurstTicket: async () =>
        this.store.getState().activeBurstTicket,
    }

    this.ledger = new ResourceLedger(adapter, this.limits, 'dynamic')
  }

  async init(): Promise<void> {
    await this.store.load()
    await this.verifyParentSliceReady()
    await this.quota.verifyQuotaFilesystemReady()
    await initializeApplicationNetworkLimits()
    await this.reconcileAll()
  }

  getLedger(): ResourceLedger {
    return this.ledger
  }

  async dispatchRpc(req: ControllerRpcRequest, onOutput?: ControllerCommandOutput): Promise<unknown> {
    switch (req.method) {
      case 'claimAppNotifications': return this.claimAppNotifications(req.params.selfId)
      case 'reportAppNotification': return this.reportAppNotification(req.params)
      case 'ensureAppWorkspace':
        return this.ensureAppWorkspace(req.params)
      case 'runAppCommand':
        return this.trackExecution(registered => this.runAppCommand(req.params, onOutput, registered))
      case 'getTaskStatus':
        return this.getTaskStatus(req.params)
      case 'cancelAppCommand':
        return this.cancelAppCommand(req.params)
      case 'startAppService':
        return this.trackExecution(registered => this.startAppService(req.params, onOutput, registered))
      case 'stopAppService':
        return this.stopAppService(req.params)
      case 'deleteApp': return this.deleteApp(req.params)
      case 'destroyAppContainer':
        return this.destroyAppContainer(req.params)
      case 'renewAppLease':
        return this.renewAppLease(req.params)
      case 'inspectAppStatus':
        return this.inspectAppStatus(req.params)
      case 'createAppBackup':
        return this.createAppBackup(req.params)
      case 'touchAppActivity':
        return this.touchAppActivity(req.params)
      case 'reconcileAll':
        return this.reconcileAll()
      case 'getParentResourceSnapshot':
        return this.ledger.getSnapshot()
    }
  }

  static buildAppUrl(userId: string, appId: string): string {
    return `https://mini.xcherry.top/qq/${encodeURIComponent(userId)}/apps/${encodeURIComponent(appId)}/`
  }

  private async trackExecution<T>(run: (registered: () => void) => Promise<T>): Promise<T> {
    let registered = false
    try { return await run(() => { registered = true }) }
    catch (error) {
      if (registered) throw error
      const failure = error instanceof ManagedAppError ? error : new ManagedAppError('INVALID_INPUT', '命令参数无效，未启动执行')
      throw new ManagedAppError(failure.code, failure.message, { ...failure.details, executionNotStarted: true })
    }
  }

  static buildContainerName(userId: string, appId: string): string {
    return `chery-app-${userId}-${appId}`
  }

  async ensureAppWorkspace(params: {
    userId: string
    appId: string
    title: string
    description?: string
    visibility?: 'private' | 'public_read'
    creatorChannel?: ManagedAppRecord['creatorChannel']
  }) {
    const userId = qqRealUserIdSchema.parse(params.userId)
    const appId = appIdSchema.parse(params.appId)
    const appKey = `${userId}:${appId}`

    return this.withAppLock(appKey, async () => {
      let record = this.store.getApp(userId, appId)
      const now = Date.now()

      if (!record) {
        const projectId = await this.store.allocateProjectId()
        const paths = await this.quota.ensureProjectDirectoriesAndQuota(
          userId,
          appId,
          projectId,
        )
        await this.seedTemplateIfEmpty(paths.projectDir, {
          userId,
          appId,
          title: params.title,
          description: params.description ?? '',
        })

        record = {
          userId,
          appId,
          projectId,
          title: params.title,
          description: params.description ?? '',
          visibility: params.visibility ?? 'private',
          templateVersion: '1.0.0',
          state: 'stopped',
          stopReason: 'initial',
          containerName: ManagedAppController.buildContainerName(userId, appId),
          containerId: null,
          containerIp: null,
          createdAt: now,
          updatedAt: now,
          lastActiveAt: now,
          startedAt: null,
          stoppedAt: null,
          leaseExpiresAt:
            now + this.limits.defaultLeaseDays * 24 * 60 * 60 * 1000,
          leaseVersion: 1,
          weeklyCleanupExempt: false,
          adminActivated: false,
          activationTokenHash: null,
          activationExpiresAt: null,
          creatorChannel: params.creatorChannel ?? null,
        }
        await this.store.upsertApp(record)
      } else {
        await this.quota.ensureProjectDirectoriesAndQuota(
          userId,
          appId,
          record.projectId,
        )
        record.title = params.title || record.title
        if (params.description !== undefined) {
          record.description = params.description
        }
        if (params.visibility !== undefined) {
          record.visibility = params.visibility
        }
        record.updatedAt = now
        await this.store.upsertApp(record)
      }

      return {
        appId: record.appId,
        userId: record.userId,
        state: record.state,
        appUrl: ManagedAppController.buildAppUrl(userId, appId),
        workspaceRoot: '/workspace',
        dataRoot: '/data',
        templateVersion: record.templateVersion,
        leaseExpiresAt: record.leaseExpiresAt,
        projectId: record.projectId,
      }
    })
  }

  /**
   * 确保工作容器处于运行态（用于执行命令或承载 Web 服务）
   */
  private async ensureContainerRunning(
    record: ManagedAppRecord,
  ): Promise<ManagedAppRecord> {
    const appKey = `${record.userId}:${record.appId}`
    const pending = this.containerStarts.get(appKey)
    if (pending) return pending
    const start = this.ensureContainerRunningLocked(record)
    this.containerStarts.set(appKey, start)
    try { return await start } finally { this.containerStarts.delete(appKey) }
  }

  private async ensureContainerRunningLocked(record: ManagedAppRecord): Promise<ManagedAppRecord> {
    if (record.state === 'stopping') throw new ManagedAppError('INVALID_INPUT', '应用正在停止，请稍后重试')
    const appKey = `${record.userId}:${record.appId}`
    const paths = await this.quota.ensureProjectDirectoriesAndQuota(
      record.userId,
      record.appId,
      record.projectId,
    )

    const inspected = await this.inspectDockerContainer(record.containerName)
    if (inspected && inspected.running) {
      await limitApplicationNetwork(record.containerName)
      record.containerId = inspected.id
      record.containerIp = inspected.ip
      record.state = 'running'
      this.ledger.registerContainerState(
        appKey,
        'running',
        await this.readContainerMemoryCurrentByKey(appKey),
      )
      await this.store.upsertApp(record)
      return record
    }

    // 需要启动容器：先通过动态内存账本准入（绝不关闭他人容器）
    await this.ledger.admitNormalStart(appKey)
    record.state = 'starting'
    await this.store.upsertApp(record)

    try {
      if (inspected && !inspected.running) {
        await execFileAsync('docker', ['rm', '-f', record.containerName]).catch(
          () => {},
        )
      }

      const appBase = `/qq/${record.userId}/apps/${record.appId}/`
      const args = [
        'run',
        '-d',
        '--name',
        record.containerName,
        '--label',
        'chery.managed.app=true',
        '--label',
        `chery.user.id=${record.userId}`,
        '--label',
        `chery.app.id=${record.appId}`,
        '--cgroup-parent',
        this.opts.systemdSliceName,
        '--network',
        this.opts.dockerNetworkName,
        '--user',
        '1000:1000',
        '--read-only',
        '--security-opt',
        'no-new-privileges:true',
        '--cap-drop',
        'ALL',
        '--memory',
        String(this.limits.appMemoryNormalMaxBytes),
        '--memory-swap',
        String(this.limits.appMemoryNormalMaxBytes),
        '--cpus',
        String(this.limits.appCpuNormalCores),
        '--pids-limit',
        String(this.limits.appPidsMax),
        '--ulimit',
        `nofile=${this.limits.appNofileLimit}:${this.limits.appNofileLimit}`,
        '--log-driver',
        'json-file',
        '--log-opt',
        'max-size=5m',
        '--log-opt',
        'max-file=2',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,nodev,size=64m,nr_inodes=4096,uid=1000,gid=1000,mode=1777',
        '--tmpfs',
        '/run:rw,noexec,nosuid,nodev,size=16m,nr_inodes=1024,uid=1000,gid=1000,mode=0755',
        '--mount',
        `type=bind,src=${paths.projectDir},dst=/workspace,bind-propagation=rprivate`,
        '--mount',
        `type=bind,src=${paths.dataDir},dst=/data,bind-propagation=rprivate`,
        '-w',
        '/workspace',
        '-e',
        'HOME=/tmp',
        '-e',
        'PORT=3000',
        '-e',
        `APP_ID=${record.appId}`,
        '-e',
        `APP_OWNER_ID=${record.userId}`,
        '-e',
        `APP_BASE=${appBase}`,
        '-e',
        'NODE_ENV=production',
        '-e',
        'NODE_PATH=/opt/chery-app-template/node_modules',
        this.opts.runtimeImage,
        'sh',
        '-c',
        'trap "exit 0" TERM INT; while true; do sleep 3600 & wait $!; done',
      ]

      await execFileAsync('docker', args)
      const after = await this.inspectDockerContainer(record.containerName)
      if (!after || !after.running) {
        throw new ManagedAppError(
          'CONTROLLER_UNAVAILABLE',
          '工作容器启动后立即退出',
        )
      }

      const now = Date.now()
      record.serviceReady = false
      record.containerId = after.id
      if (!after.ip) throw new ManagedAppError('CONTROLLER_UNAVAILABLE', '应用未取得隔离网络地址')
      await limitApplicationNetwork(record.containerName)
      record.containerIp = after.ip
      record.state = 'running'
      record.startedAt = now
      record.updatedAt = now
      record.lastActiveAt = now
      this.ledger.registerContainerState(
        appKey,
        'running',
        await this.readContainerMemoryCurrentByKey(appKey),
      )
      await this.store.upsertApp(record)
      return record
    } catch (err) {
      await execFileAsync('docker', ['rm', '-f', record.containerName], { timeout: 10000 }).catch(() => {})
      this.ledger.registerContainerState(appKey, 'stopped')
      record.state = 'stopped'
      await this.store.upsertApp(record)
      throw err
    }
  }

  /**
   * 在工作容器中执行命令（支持超时强杀进程树、输出 256KiB 截断、build 瞬时 4GiB 队列）
   */
  async runAppCommand(params: {
    userId: string
    appId: string
    command: string
    taskId?: string
    cwd?: string
    profile?: 'standard' | 'build'
    timeoutSec?: number
  }, onOutput?: ControllerCommandOutput, onRegistered?: () => void): Promise<CommandTaskResult> {
    const userId = qqRealUserIdSchema.parse(params.userId)
    const appId = appIdSchema.parse(params.appId)
    const cwdRel = relativeCwdSchema.parse(params.cwd ?? '.')
    const profile = params.profile ?? 'standard'
    const maxAllowedTimeout =
      profile === 'build'
        ? this.limits.maxBuildExecTimeoutSec
        : this.limits.maxStandardExecTimeoutSec
    const timeoutSec = Math.min(
      params.timeoutSec ?? this.limits.defaultExecTimeoutSec,
      maxAllowedTimeout,
    )

    const record = this.requireOwnedApp(userId, appId)
    const appKey = `${userId}:${appId}`
    if (this.deletingApps.has(appKey)) throw new ManagedAppError('APP_ACCESS_DENIED', '应用正在删除')
    const taskId = z.string().regex(/^task_[a-f0-9]{16}$/).parse(params.taskId ?? `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`)
    if (this.tasks.has(taskId)) throw new ManagedAppError('INVALID_INPUT', '任务标识已存在')
    const startedAt = Date.now()

    let releaseBurst: (() => Promise<void>) | null = null
    const workdir =
      cwdRel === '.' ? '/workspace' : path.posix.join('/workspace', cwdRel)
    let cleanup: (() => Promise<void>) | undefined

    const taskResult: CommandTaskResult = {
      taskId,
      appId,
      userId,
      profile,
      status: 'running',
      exitCode: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      startedAt,
      finishedAt: null,
    }

    const cancellationKey = `${userId}:${appId}:${taskId}`
    const abort = new AbortController()
    let cancelled = (this.earlyCancellations.get(cancellationKey) ?? 0) > Date.now()
    this.earlyCancellations.delete(cancellationKey)
    let timedOut = false



    // Register before asynchronous startup/admission so abort cannot race task registration.
    this.tasks.set(taskId, { result: taskResult, cancel: async () => { cancelled = true; abort.abort(); await cleanup?.() } })
    onRegistered?.()
    try {
      if (cancelled) abort.abort()
      abort.signal.throwIfAborted()
      await this.ensureContainerRunning(record)
      if (profile === 'build' && !cancelled) {
        releaseBurst = await this.ledger.acquireBurstTicket(userId, appKey, timeoutSec, abort.signal)
      }
      if (cancelled) {
        taskResult.status = 'cancelled'
        taskResult.finishedAt = Date.now()
        taskResult.durationMs = taskResult.finishedAt - startedAt
        return { ...taskResult }
      }
      const inspected = await execFileAsync('docker', ['inspect', record.containerName, '--format', '{{.State.Pid}}'])
      if (cancelled) abort.signal.throwIfAborted()
      return await new Promise<CommandTaskResult>((resolve, reject) => {
        const child = spawnIsolatedTask(Number(inspected.stdout.trim()), workdir, params.command)
        let closed!: () => void
        const completion = new Promise<void>(resolve => { closed = resolve })
        cleanup = async () => { child.kill('SIGKILL'); await completion }
        this.taskCleanups.set(taskId, { appKey, kill: cleanup })

        let stdoutChunks: Buffer[] = []
        let stderrChunks: Buffer[] = []
        let totalBytes = 0

        const appendChunk = (target: Buffer[], chunk: Buffer) => {
          const remaining = this.limits.maxCommandOutputBytes - totalBytes
          if (remaining <= 0) {
            taskResult.truncated = true
            return
          }
          if (chunk.byteLength > remaining) {
            target.push(chunk.subarray(0, remaining))
            totalBytes += remaining
            taskResult.truncated = true
          } else {
            target.push(chunk)
            totalBytes += chunk.byteLength
          }
        }

        child.once('error', error => { clearTimeout(timeoutTimer); closed(); reject(error) })
        for (const stream of ['stdout', 'stderr'] as const) child[stream].on('data', (chunk: Buffer) => {
          try { onOutput?.(stream, chunk) } catch { /* Log transport failure must not stop the isolated command. */ }
          appendChunk(stream === 'stdout' ? stdoutChunks : stderrChunks, chunk)
        })

        const timeoutTimer = setTimeout(async () => {
          timedOut = true
          await cleanup?.()
        }, timeoutSec * 1000)

        this.tasks.set(taskId, {
          result: taskResult,
          cancel: async () => {
            cancelled = true
            abort.abort()
            clearTimeout(timeoutTimer)
            await cleanup?.()
          },
        })

        child.on('close', async code => {
          clearTimeout(timeoutTimer)
          closed()

          const finishedAt = Date.now()
          taskResult.finishedAt = finishedAt
          taskResult.durationMs = finishedAt - startedAt
          taskResult.exitCode = code
          taskResult.stdout = Buffer.concat(stdoutChunks).toString('utf8')
          taskResult.stderr = Buffer.concat(stderrChunks).toString('utf8')

          if (cancelled) {
            taskResult.status = 'cancelled'
          } else if (timedOut) {
            taskResult.status = 'timed_out'
          } else if (code === 137) {
            taskResult.status = 'oom_killed'
          } else if (code === 0) {
            taskResult.status = 'completed'
          } else {
            taskResult.status = 'failed'
          }

          resolve({ ...taskResult })
        })
      })
    } catch (error) {
      taskResult.status = cancelled ? 'cancelled' : 'failed'
      taskResult.finishedAt = Date.now()
      taskResult.durationMs = taskResult.finishedAt - startedAt
      if (cancelled) return { ...taskResult }
      throw error
    } finally {
      await cleanup?.()
      this.taskCleanups.delete(taskId)
      if (releaseBurst) {
        await releaseBurst()
      }
    }
  }

  async getTaskStatus(params: {
    userId: string
    appId: string
    taskId: string
  }): Promise<CommandTaskResult> {
    this.requireOwnedApp(params.userId, params.appId)
    const handle = this.tasks.get(params.taskId)
    if (!handle || handle.result.userId !== params.userId || handle.result.appId !== params.appId) {
      throw new ManagedAppError('APP_NOT_FOUND', `未找到任务: ${params.taskId}`)
    }
    return { ...handle.result }
  }

  async cancelAppCommand(params: {
    userId: string
    appId: string
    taskId: string
  }): Promise<{ taskId: string; status: 'cancelled' }> {
    this.requireOwnedApp(params.userId, params.appId)
    const handle = this.tasks.get(params.taskId)
    if (!handle) {
      z.string().regex(/^task_[a-f0-9]{16}$/).parse(params.taskId)
      const now = Date.now()
      for (const [key, expires] of this.earlyCancellations) if (expires <= now) this.earlyCancellations.delete(key)
      if (this.earlyCancellations.size >= 1024) throw new ManagedAppError('RESOURCE_BUDGET_EXCEEDED', '取消记录已满')
      this.earlyCancellations.set(`${params.userId}:${params.appId}:${params.taskId}`, now + 360_000)
    } else {
      if (handle.result.userId !== params.userId || handle.result.appId !== params.appId) {
        throw new ManagedAppError('APP_NOT_FOUND', `未找到任务: ${params.taskId}`)
      }
      if (handle.result.status !== 'running') {
        throw new ManagedAppError('INVALID_INPUT', '任务已结束，不能再次取消')
      }
      await handle.cancel()
    }
    return { taskId: params.taskId, status: 'cancelled' }
  }

  async startAppService(params: {
    userId: string
    appId: string
    buildFirst?: boolean
    taskId?: string
  }, onOutput?: ControllerCommandOutput, onRegistered?: () => void) {
    const record = this.requireOwnedApp(params.userId, params.appId)
    const appKey = `${record.userId}:${record.appId}`

    const taskId = z.string().regex(/^task_[a-f0-9]{16}$/).parse(params.taskId ?? `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`)
    if (this.tasks.has(taskId)) throw new ManagedAppError('INVALID_INPUT', '任务标识已存在')
    let serviceStarting = false
    const key = `${record.userId}:${record.appId}:${taskId}`
    const abort = new AbortController()
    if ((this.earlyCancellations.get(key) ?? 0) > Date.now()) abort.abort()
    this.earlyCancellations.delete(key)
    const buildTaskId = `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const result: CommandTaskResult = { taskId, userId: record.userId, appId: record.appId, profile: 'build', status: 'running', exitCode: null, durationMs: 0, stdout: '', stderr: '', truncated: false, startedAt: Date.now(), finishedAt: null }
    this.tasks.set(taskId, { result, cancel: async () => {
      abort.abort()
      const build = this.tasks.get(buildTaskId)
      if (!build || build.result.status === 'running') {
        await this.cancelAppCommand({ userId: record.userId, appId: record.appId, taskId: buildTaskId })
      }
    } })
    onRegistered?.()
    const check = () => abort.signal.throwIfAborted()
    return this.withAppLock(appKey, async () => {
      try {
      check()
      await this.ensureContainerRunning(record)
      record.serviceReady = false
      record.state = 'starting'
      await this.store.upsertApp(record)
      check()

      if (params.buildFirst !== false) {
        const pkgPath = path.join(
          this.quota.resolveAppPaths(record.userId, record.appId).projectDir,
          'package.json',
        )
        const hasBuildScript = await readFile(pkgPath, 'utf8')
          .then(raw => Boolean(JSON.parse(raw)?.scripts?.build))
          .catch(() => false)

        if (hasBuildScript) {
          const buildRes = await this.runAppCommand({
            userId: record.userId,
            appId: record.appId,
            command: 'npm run build',
            taskId: buildTaskId,
            profile: 'build',
            timeoutSec: 180,
          }, onOutput)
          if (buildRes.status !== 'completed') {
            throw new ManagedAppError(
              'COMMAND_EXEC_FAILED',
              `应用构建失败 (${buildRes.status}, exit=${buildRes.exitCode})`,
              { stdout: buildRes.stdout, stderr: buildRes.stderr },
            )
          }
        }
      }

      check()
      // 停掉旧的应用 Web 服务进程并后台启动新进程
      await execFileAsync('docker', [
        'exec',
        record.containerName,
        'sh',
        '-c',
        `for p in /proc/[0-9]*/environ; do
          pid=\${p#/proc/}; pid=\${pid%/environ};
          if [ "$pid" != "1" ] && tr '\\0' '\\n' < "$p" 2>/dev/null | grep -q '^CHERY_APP_SERVER=1$'; then
            kill -9 "$pid" 2>/dev/null || true;
          fi;
        done`,
      ]).catch(() => {})

      check()
      serviceStarting = true
      const launch = await execFileAsync('docker', [
        'exec',
        '-d',
        '-w',
        '/workspace',
        '-e',
        'CHERY_APP_SERVER=1',
        record.containerName,
        'sh',
        '-c',
        'mkdir -p /data/logs && exec node server/index.mjs >>/data/logs/server.log 2>&1',
      ])
      // The detached application's ongoing logs stay with that app, not this temporary publish step.
      try {
        if (launch.stdout) onOutput?.('stdout', Buffer.from(launch.stdout))
        if (launch.stderr) onOutput?.('stderr', Buffer.from(launch.stderr))
      } catch { /* Publishing does not depend on a log viewer. */ }

      const refreshed = await this.inspectDockerContainer(record.containerName)
      record.containerIp = refreshed?.ip ?? record.containerIp

      const healthPayload = await this.waitForHealthcheck(record)
      if (!healthPayload) {
        const logs = await execFileAsync('docker', [
          'exec',
          record.containerName,
          'sh',
          '-c',
          'tail -n 50 /data/logs/server.log 2>/dev/null || true',
        ]).catch(() => ({ stdout: '' }))
        throw new ManagedAppError(
          'HEALTHCHECK_FAILED',
          '服务启动后未在 15 秒内通过 0.0.0.0:3000/__app_health 健康检查',
          { logs: logs.stdout },
        )
      }

      check()
      const now = Date.now()
      record.state = 'running'
      record.startedAt = now
      record.lastActiveAt = now
      record.updatedAt = now
      record.adminActivated = Boolean(healthPayload.activated)
      await this.store.upsertApp(record)
      check()
      record.serviceReady = true
      await this.store.upsertApp(record)
      check()
      result.status = 'completed'
      result.finishedAt = Date.now()
      result.durationMs = result.finishedAt - result.startedAt

      const appUrl = ManagedAppController.buildAppUrl(
        record.userId,
        record.appId,
      )
      const activationUrl =
        !healthPayload.activated && healthPayload.activationToken
          ? `${appUrl}?activate_token=${encodeURIComponent(healthPayload.activationToken)}`
          : undefined

      return {
        appId: record.appId,
        userId: record.userId,
        state: 'running' as const,
        appUrl,
        ...(activationUrl ? { activationUrl } : {}),
        containerIp: record.containerIp,
        health: 'ok' as const,
        leaseExpiresAt: record.leaseExpiresAt,
        idleTimeoutHours: this.limits.defaultIdleTimeoutHours,
      }
      } catch (error) {
      if (serviceStarting) {
        await this.stopAppServiceLocked(record, 'manual_stop')
      } else if (record.state === 'starting') {
        record.state = 'running'
        record.serviceReady = false
        await this.store.upsertApp(record)
      }
      result.status = abort.signal.aborted ? 'cancelled' : 'failed'
      result.finishedAt = Date.now()
      result.durationMs = result.finishedAt - result.startedAt
      throw error
      }
    })
  }

  async stopAppService(params: {
    userId: string
    appId: string
    reason?: StopReason
  }) {
    const record = this.requireOwnedApp(params.userId, params.appId)
    const appKey = `${record.userId}:${record.appId}`

    for (const task of this.tasks.values()) if (task.result.userId === record.userId && task.result.appId === record.appId && task.result.status === 'running') await task.cancel()
    return this.withAppLock(appKey, async () => {
      for (const task of this.tasks.values()) if (task.result.userId === record.userId && task.result.appId === record.appId && task.result.status === 'running') await task.cancel()
      return this.stopAppServiceLocked(record, params.reason ?? 'manual_stop')
    })
  }

  private async stopAppServiceLocked(record: ManagedAppRecord, reason: StopReason) {
      const appKey = `${record.userId}:${record.appId}`
      record.serviceReady = false
      record.state = 'stopping'
      await this.containerStarts.get(appKey)?.catch(() => {})
      record.state = 'stopping'
      record.serviceReady = false
      await this.store.upsertApp(record)

      await execFileAsync('docker', [
        'stop',
        '-t',
        '10',
        record.containerName,
      ], { timeout: 15000 }).catch(() => {})
      await execFileAsync('docker', ['rm', '-f', record.containerName], { timeout: 10000 }).catch(async error => {
        if (await this.inspectDockerContainer(record.containerName)) throw error
      })

      const now = Date.now()
      record.state = 'stopped'
      record.stopReason = reason
      record.containerId = null
      record.containerIp = null
      record.stoppedAt = now
      record.updatedAt = now
      this.ledger.registerContainerState(appKey, 'stopped')
      await this.store.upsertApp(record)

      return {
        appId: record.appId,
        userId: record.userId,
        state: 'stopped' as const,
        stopReason: record.stopReason,
        dataPreserved: true,
      }
  }

  async deleteApp(params: { userId: string; appId: string }) {
    this.requireOwnedApp(params.userId, params.appId)
    const key = `${params.userId}:${params.appId}`
    // Do not race an executing or queued command; the caller can cancel first.
    if (this.deletingApps.has(key)) throw new ManagedAppError('APP_ACCESS_DENIED', '应用正在删除')
    this.deletingApps.add(key)
    try { return await this.withAppLock(key, async () => {
      const record = this.requireOwnedApp(params.userId, params.appId)
      if ([...this.tasks.values()].some(t => t.result.userId === record.userId && t.result.appId === record.appId && t.result.status === 'running'))
        throw new ManagedAppError('COMMAND_EXEC_FAILED', '应用仍有活动任务，请先取消并等待结束，再删除')
      await this.stopAppServiceLocked(record, 'manual_stop')
      await this.quota.deleteProject(record.userId, record.appId, record.projectId)
      await this.store.deleteApp(record.userId, record.appId)
      for (const [id, task] of this.tasks) if (task.result.userId === record.userId && task.result.appId === record.appId) this.tasks.delete(id)
      return { appId: record.appId, deleted: true as const }
    }) } finally { this.deletingApps.delete(key) }
  }

  async destroyAppContainer(params: { userId: string; appId: string }) {
    return this.stopAppService({
      userId: params.userId,
      appId: params.appId,
      reason: 'manual_stop',
    })
  }

  async renewAppLease(params: {
    userId: string
    appId: string
    days?: number
  }) {
    const record = this.requireOwnedApp(params.userId, params.appId)
    return this.withAppLock(`${record.userId}:${record.appId}`, async () => {
    const days = Math.min(Math.max(params.days ?? this.limits.defaultLeaseDays, 1), 7)
    const now = Date.now()
    const base = Math.max(now, record.leaseExpiresAt)
    record.leaseExpiresAt = base + days * 24 * 60 * 60 * 1000
    record.leaseVersion += 1
    scheduleNotifications(record, this.store.getState().notifications, now)
    record.updatedAt = now
    await this.store.upsertApp(record)

    return {
      appId: record.appId,
      userId: record.userId,
      state: record.state,
      leaseExpiresAt: record.leaseExpiresAt,
      leaseVersion: record.leaseVersion,
      weeklyCleanupExempt: record.weeklyCleanupExempt,
    }
    })
  }

  async touchAppActivity(params: { userId: string; appId: string }) {
    const record = this.requireOwnedApp(params.userId, params.appId)
    const now = Date.now()
    if (now - record.lastActiveAt >= 60_000) {
      record.lastActiveAt = now
      record.updatedAt = now
      await this.store.upsertApp(record)
    }
    return { ok: true, lastActiveAt: record.lastActiveAt }
  }

  async inspectAppStatus(params: {
    userId: string
    appId?: string
  }): Promise<AppRuntimeStatus[]> {
    qqRealUserIdSchema.parse(params.userId)
    const records = params.appId
      ? [this.requireOwnedApp(params.userId, params.appId)]
      : this.store.listUserApps(params.userId)

    const out: AppRuntimeStatus[] = []
    for (const rec of records) {
      const appKey = `${rec.userId}:${rec.appId}`
      const [memCur, quotaInfo, inspected] = await Promise.all([
        rec.state === 'running'
          ? this.readContainerMemoryCurrentByKey(appKey)
          : Promise.resolve(0),
        this.quota.inspectProjectQuota(rec.projectId),
        this.inspectDockerContainer(rec.containerName),
      ])

      if (!inspected?.running && rec.state === 'running') {
        rec.state = inspected?.oomKilled ? 'crashed_oom' : 'stopped'
        rec.stopReason = inspected?.oomKilled
          ? 'oom_killed'
          : rec.stopReason
        rec.containerIp = null
        this.ledger.registerContainerState(appKey, 'stopped')
        await this.store.upsertApp(rec)
      }

      out.push({
        userId: rec.userId,
        appId: rec.appId,
        title: rec.title,
        description: rec.description,
        state: rec.state,
        stopReason: rec.stopReason,
        appUrl: ManagedAppController.buildAppUrl(rec.userId, rec.appId),
        serviceReady: rec.serviceReady === true,
        containerIp: rec.containerIp,
        memoryCurrentBytes: memCur,
        memoryLimitBytes: this.limits.appMemoryNormalMaxBytes,
        diskUsedBytes: quotaInfo.diskUsedBytes,
        diskLimitBytes: quotaInfo.diskLimitBytes,
        inodesUsed: quotaInfo.inodesUsed,
        inodesLimit: quotaInfo.inodesLimit,
        createdAt: rec.createdAt,
        lastActiveAt: rec.lastActiveAt,
        startedAt: rec.startedAt,
        leaseExpiresAt: rec.leaseExpiresAt,
        leaseVersion: rec.leaseVersion,
        weeklyCleanupExempt: rec.weeklyCleanupExempt,
      })
    }
    return out
  }

  async createAppBackup(params: {
    userId: string
    appId: string
    note?: string
  }) {
    const record = this.requireOwnedApp(params.userId, params.appId)
    const appKey = `${record.userId}:${record.appId}`

    return this.withAppLock(appKey, async () => {
      const paths = this.quota.resolveAppPaths(record.userId, record.appId)
      await assertNoSymlinkChain(this.opts.hostUserFilesRoot, paths.backupsDir)

      const backupId = `bak_${Date.now()}`
      const targetArchive = path.join(paths.backupsDir, `${backupId}.tar.gz`)
      const snapshot = `.backup-${backupId}`
      const command = await this.runAppCommand({ userId: record.userId, appId: record.appId, command: `node /opt/chery-app-template/backup.mjs ${backupId} && tar -czf /data/.${backupId}.tar.gz -C /data/.backup-${backupId} project data`, timeoutSec: 180 })
      try {
        if (command.status !== 'completed') throw new ManagedAppError('COMMAND_EXEC_FAILED', 'SQLite 一致性快照未完成')
        const archive = path.join(paths.dataDir, `.${backupId}.tar.gz`)
        if (!(await lstat(archive)).isFile()) throw new ManagedAppError('INVALID_INPUT', '备份产物不是普通文件')
        await rename(archive, targetArchive)
      } finally {
        await rm(path.join(paths.dataDir, snapshot), { recursive: true, force: true })
        await rm(path.join(paths.dataDir, `.${backupId}.tar.gz`), { force: true })
      }

      // 最多保留最近 3 份备份
      const files = (await readdir(paths.backupsDir))
        .filter(f => f.endsWith('.tar.gz'))
        .sort()
      while (files.length > 3) {
        const oldest = files.shift()!
        await rm(path.join(paths.backupsDir, oldest), { force: true })
      }

      const st = await stat(targetArchive)
      return {
        backupId,
        appId: record.appId,
        createdAt: Date.now(),
        sizeBytes: st.size,
      }
    })
  }

  /**
   * 对账与自愈：只操作带有 `chery.managed.app=true` 标签的受管容器，绝不触碰宿主机常驻服务
   */
  async reconcileAll(): Promise<{
    reconciledApps: number
    snapshot: ParentResourceSnapshot
  }> {
    await this.ledger.reconcileOnStartup()

    const { stdout } = await execFileAsync('docker', [
      'ps',
      '-a',
      '--filter',
      'label=chery.managed.app=true',
      '--format',
      '{{.Names}}',
    ]).catch(() => ({ stdout: '' }))

    const existingNames = new Set(
      stdout
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean),
    )

    const allApps = this.store.listAllApps()
    for (const rec of allApps) {
      const appKey = `${rec.userId}:${rec.appId}`
      const inspected = await this.inspectDockerContainer(rec.containerName)
      if (inspected?.running) {
        if (!inspected.ip) throw new ManagedAppError('CONTROLLER_UNAVAILABLE', '应用网络地址缺失')
        await limitApplicationNetwork(rec.containerName)
        rec.serviceReady = rec.serviceReady === true && Boolean(await this.waitForHealthcheck(rec))
        rec.state = 'running'
        rec.containerId = inspected.id
        rec.containerIp = inspected.ip
        const mem = await this.readContainerMemoryCurrentByKey(appKey)
        this.ledger.registerContainerState(appKey, 'running', mem)
      } else {
        if (rec.state === 'running' || rec.state === 'starting') {
          rec.state = inspected?.oomKilled ? 'crashed_oom' : 'stopped'
          rec.stopReason = inspected?.oomKilled
            ? 'oom_killed'
            : 'reconcile_recovered'
        }
        rec.containerIp = null
        this.ledger.registerContainerState(appKey, 'stopped')
      }
      existingNames.delete(rec.containerName)
      await this.store.upsertApp(rec)
    }

    // 清理无登记记录但带有 chery.managed.app=true 标签的孤儿工作容器
    for (const orphanName of existingNames) {
      if (orphanName.startsWith('chery-app-')) {
        await execFileAsync('docker', ['rm', '-f', orphanName]).catch(() => {})
      }
    }

    return {
      reconciledApps: allApps.length,
      snapshot: await this.ledger.getSnapshot(),
    }
  }

  async sweepLifecycle(now = Date.now()): Promise<{ stopped: number }> {
    let stopped = 0
    const failures: unknown[] = []
    const pressure = await this.ledger.getSnapshot()
    if (pressure.hostMemAvailableBytes < 1024 ** 3 || pressure.hostDiskAvailableBytes < this.limits.hostMinDiskAvailableBytes) {
      for (const task of this.tasks.values()) if (task.result.profile === 'build' && task.result.status === 'running') await task.cancel()
    }
    for (const [id, task] of this.tasks) if (task.result.finishedAt !== null && task.result.finishedAt < now - 86400000) this.tasks.delete(id)
    for (const app of this.store.listAllApps()) {
      // Cancel before waiting for the publish lock; a long build must not delay expiry.
      const pendingTasks = [...this.tasks.values()].filter(task => task.result.userId === app.userId && task.result.appId === app.appId && task.result.status === 'running')
      const pendingSince = pendingTasks.length ? Math.min(...pendingTasks.map(task => task.result.startedAt)) : undefined
      if (lifecycleStopReason({ ...app, state: app.state === 'starting' ? 'running' : app.state }, now, this.limits.defaultIdleTimeoutHours, pendingSince)) for (const task of pendingTasks) await task.cancel()
      await this.withAppLock(`${app.userId}:${app.appId}`, async () => {
        const runningTasks = [...this.tasks.values()].filter(task => task.result.userId === app.userId && task.result.appId === app.appId && task.result.status === 'running')
        const busySince = runningTasks.length ? Math.min(...runningTasks.map(task => task.result.startedAt)) : undefined
        const reason = lifecycleStopReason(app, now, this.limits.defaultIdleTimeoutHours, busySince)
        if (!reason) return
        for (const task of runningTasks) await task.cancel()
        await this.stopAppServiceLocked(app, reason)
        stopped += 1
      }).catch(error => { failures.push(error) })
    }
    for (const app of this.store.listAllApps()) scheduleNotifications(app, this.store.getState().notifications, now)
    if (this.store.getState().lastWeeklyCleanupSlot !== String(weeklyCleanupBoundary(now))) await this.store.setLastWeeklyCleanupSlot(String(weeklyCleanupBoundary(now)))
    else await this.store.save()
    if (failures.length) throw new AggregateError(failures, '部分应用停止失败')
    return { stopped }
  }

  async claimAppNotifications(selfId: string): Promise<AppNotification[]> {
    qqRealUserIdSchema.parse(selfId)
    const now = Date.now()
    const records = this.store.getState().notifications
    const claimed: AppNotification[] = []
    for (const item of Object.values(records)) {
      if (item.creatorChannel.selfId !== selfId) continue
      // A lost acknowledgement is uncertain, never a reason to resend.
      if (item.status === 'inflight' && item.retryAt <= now) item.status = 'delivery_uncertain'
      const app = this.store.getApp(item.userId, item.appId)
      if (!app || app.leaseVersion !== item.leaseVersion) { if (item.status === 'pending') item.status = 'superseded'; continue }
      if (item.stage !== 'STOPPED' && (app.state !== 'running' || app.leaseExpiresAt <= now)) { if (item.status === 'pending') item.status = 'superseded'; continue }
      if (item.status !== 'pending' || item.retryAt > now || claimed.length >= 20) continue
      item.status = 'inflight'; item.attempts += 1; item.retryAt = now + 300000
      claimed.push(structuredClone(item))
    }
    await this.store.save()
    return claimed
  }

  async reportAppNotification(params: { selfId: string; notificationId: string; status: 'sent' | 'failed' | 'unknown' }) {
    const item = this.store.getState().notifications[params.notificationId]
    if (!item || item.creatorChannel.selfId !== params.selfId) throw new ManagedAppError('APP_ACCESS_DENIED', '通知不属于当前连接')
    if (item.status !== 'inflight') return { recorded: false }
    item.status = params.status === 'unknown' ? 'delivery_uncertain' : params.status === 'failed' && item.attempts < 3 ? 'pending' : params.status
    item.retryAt = Date.now() + 60000 * item.attempts
    await this.store.save()
    return { recorded: true }
  }

  private requireOwnedApp(userId: string, appId: string): ManagedAppRecord {
    qqRealUserIdSchema.parse(userId)
    appIdSchema.parse(appId)
    const rec = this.store.getApp(userId, appId)
    if (!rec) {
      throw new ManagedAppError(
        'APP_NOT_FOUND',
        `未找到属于当前用户的应用: ${appId}`,
      )
    }
    if (rec.userId !== userId) {
      throw new ManagedAppError(
        'APP_ACCESS_DENIED',
        `无权访问其他用户的应用: ${appId}`,
      )
    }
    return rec
  }

  private async verifyParentSliceReady(): Promise<void> {
    await access(path.join(this.opts.parentCgroupDir, 'memory.max')).catch(
      () => {
        throw new ManagedAppError(
          'CONTROLLER_UNAVAILABLE',
          `父级 cgroup slice 未就绪: ${this.opts.parentCgroupDir}`,
        )
      },
    )
  }

  private async seedTemplateIfEmpty(
    projectDir: string,
    _meta: { userId: string; appId: string; title: string; description: string },
  ): Promise<void> {
    const entries = await readdir(projectDir).catch(() => [])
    if (entries.length > 0) return

    const hasSkeleton = await access(this.opts.templateSkeletonHostPath)
      .then(() => true)
      .catch(() => false)

    if (hasSkeleton) {
      await cp(this.opts.templateSkeletonHostPath, projectDir, {
        recursive: true,
      })
      await execFileAsync('chown', ['-R', '1000:1000', projectDir])
      return
    }

    throw new ManagedAppError('CONTROLLER_UNAVAILABLE', '固定模板未部署，拒绝创建不完整应用')
  }

  private async waitForHealthcheck(record: ManagedAppRecord): Promise<{
    ok: boolean
    activated?: boolean
    activationToken?: string | null
  } | null> {
    const deadline = Date.now() + 15000
    for (let i = 0; i < 30 && Date.now() < deadline; i++) {
      const payload = await execFileAsync('docker', [
        'exec',
        record.containerName,
        'sh',
        '-c',
        'wget -T 1 -q -O - http://127.0.0.1:3000/__app_health 2>/dev/null || curl --max-time 1 -sf http://127.0.0.1:3000/__app_health 2>/dev/null',
      ], { timeout: 2500, maxBuffer: 65536 })
        .then(r => {
          const parsed = JSON.parse(r.stdout.trim())
          return parsed?.ok === true ? parsed : null
        })
        .catch(() => null)

      if (payload) return payload
      await delay(500)
    }
    return null
  }

  private async inspectDockerContainer(containerName: string): Promise<{
    id: string
    running: boolean
    oomKilled: boolean
    ip: string | null
  } | null> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        containerName,
        '--format',
        '{{.Id}}|{{.State.Running}}|{{.State.OOMKilled}}|{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      ])
      const [id, runningStr, oomStr, ip] = stdout.trim().split('|')
      if (!id) return null
      return {
        id,
        running: runningStr === 'true',
        oomKilled: oomStr === 'true',
        ip: ip || null,
      }
    } catch {
      return null
    }
  }

  private async readContainerMemoryCurrentByKey(appKey: string): Promise<number> {
    const [userId, appId] = appKey.split(':')
    if (!userId || !appId) return 0
    const rec = this.store.getApp(userId, appId)
    if (!rec) return 0
    const inspected = await this.inspectDockerContainer(rec.containerName)
    if (!inspected || !inspected.running) return 0

    const cgroupFile = path.join(
      this.opts.parentCgroupDir,
      `docker-${inspected.id}.scope`,
      'memory.current',
    )
    return this.readCgroupNumber(cgroupFile, 0)
  }

  private async updateDockerContainerLimits(
    appKey: string,
    res: { memoryBytes: number; cpuCores: number },
  ): Promise<void> {
    const [userId, appId] = appKey.split(':')
    if (!userId || !appId) return
    const rec = this.store.getApp(userId, appId)
    if (!rec) return
    await execFileAsync('docker', [
      'update',
      '--memory',
      String(res.memoryBytes),
      '--memory-swap',
      String(res.memoryBytes),
      '--cpus',
      String(res.cpuCores),
      rec.containerName,
    ])
  }

  private async killTransientProcessesInContainer(appKey: string): Promise<void> {
    const [userId, appId] = appKey.split(':')
    if (!userId || !appId) return
    const rec = this.store.getApp(userId, appId)
    if (!rec) return
    await Promise.all([...this.taskCleanups.values()].filter(task => task.appKey === appKey).map(task => task.kill()))
  }

  private async cleanTmpInContainer(appKey: string): Promise<void> {
    const [userId, appId] = appKey.split(':')
    if (!userId || !appId) return
    const rec = this.store.getApp(userId, appId)
    if (!rec) return
    await execFileAsync('docker', [
      'exec',
      rec.containerName,
      'sh',
      '-c',
      'rm -rf /tmp/* /tmp/.[!.]* 2>/dev/null || true',
    ]).catch(() => {})
  }

  private async restartContainerClean(appKey: string): Promise<void> {
    const [userId, appId] = appKey.split(':')
    if (!userId || !appId) return
    const rec = this.store.getApp(userId, appId)
    if (!rec) return
    const wasReady = rec.serviceReady === true
    rec.serviceReady = false
    await execFileAsync('docker', ['restart', '-t', '5', rec.containerName], { timeout: 15000 })
    if (wasReady) {
      await execFileAsync('docker', ['exec', '-d', '-w', '/workspace', '-e', 'CHERY_APP_SERVER=1', rec.containerName, 'sh', '-c', 'exec node server/index.mjs >>/data/logs/server.log 2>&1'], { timeout: 10000 })
      rec.serviceReady = Boolean(await this.waitForHealthcheck(rec))
    }
    await this.store.upsertApp(rec)
  }

  private async readCgroupNumber(
    filePath: string,
    fallbackIfMax = 0,
  ): Promise<number> {
    try {
      const raw = (await readFile(filePath, 'utf8')).trim()
      if (raw === 'max') return fallbackIfMax
      const num = Number(raw)
      if (!Number.isFinite(num)) throw new Error('Invalid cgroup counter')
      return num
    } catch (error) {
      throw new ManagedAppError('HOST_PRESSURE_GUARD', '无法读取受管资源计数，停止接受新任务', { filePath, cause: error instanceof Error ? error.message : String(error) })
    }
  }

  private async readProcMemAvailable(): Promise<number> {
    const raw = await readFile('/proc/meminfo', 'utf8')
    const match = raw.match(/^MemAvailable:\s+(\d+)\s+kB/m)
    return match ? Number(match[1]) * 1024 : 0
  }

  private async readDiskAvailableBytes(): Promise<number> {
    const info = await statfs(this.opts.hostUserFilesRoot)
    return info.bavail * info.bsize
  }

  private async withAppLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.appLocks.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.appLocks.set(key, next)
    try {
      return await next
    } finally {
      if (this.appLocks.get(key) === next) {
        this.appLocks.delete(key)
      }
    }
  }
}
