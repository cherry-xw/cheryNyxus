import { setTimeout as delay } from 'node:timers/promises'
import {
  DEFAULT_RUNTIME_LIMITS,
  ManagedAppError,
  type BurstPhase,
  type ParentResourceSnapshot,
  type RuntimeLimits,
} from './types.ts'

export interface ContainerMemoryProbe {
  appKey: string
  state: 'starting' | 'running'
  currentMemoryBytes: number
}

export interface HostResourceAdapter {
  readParentMemoryCurrent(): Promise<number>
  readParentMemoryMax(): Promise<number>
  writeParentMemoryMax(bytes: number): Promise<void>
  readParentPidsCurrent(): Promise<number>
  readParentPidsMax(): Promise<number>
  readHostMemAvailable(): Promise<number>
  readHostDiskAvailable(): Promise<number>
  readContainerMemoryCurrent(appKey: string): Promise<number>
  updateContainerResources(
    appKey: string,
    opts: { memoryBytes: number; cpuCores: number },
  ): Promise<void>
  killContainerCommandProcesses(appKey: string): Promise<void>
  cleanContainerTmp(appKey: string): Promise<void>
  restartContainerCleanRuntime(appKey: string): Promise<void>
  persistBurstTicket(
    ticket: { appKey: string; deadlineMs: number } | null,
  ): Promise<void>
  loadPersistedBurstTicket(): Promise<{ appKey: string; deadlineMs: number } | null>
}

interface QueuedBurstWaiter {
  userId: string
  appKey: string
  resolve: (release: () => Promise<void>) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  cleanup?: () => void
}

/**
 * 动态内存准入账本与 4 GiB 瞬时扩容/回落状态机
 *
 * 严格遵循用户已确认的额度：
 * - 常态工作组总内存上限 2 GiB
 * - 单容器常态上限 200 MiB
 * - 瞬时工作组最高上限 4 GiB
 * - 正常额度不足只拒绝/排队，绝不主动关闭已运行的他人应用容器
 */
export class ResourceLedger {
  private readonly limits: RuntimeLimits
  private readonly adapter: HostResourceAdapter
  private readonly mode: 'dynamic' | 'conservative'
  private readonly containers = new Map<string, ContainerMemoryProbe>()
  private burstPhase: BurstPhase = 'normal'
  private activeBurstAppKey: string | null = null
  private burstQueue: QueuedBurstWaiter[] = []
  private admissionChain: Promise<unknown> = Promise.resolve()

  constructor(
    adapter: HostResourceAdapter,
    limits: Partial<RuntimeLimits> = {},
    mode: 'dynamic' | 'conservative' = 'dynamic',
  ) {
    this.adapter = adapter
    this.limits = { ...DEFAULT_RUNTIME_LIMITS, ...limits }
    this.mode = mode
  }

  getLimits(): RuntimeLimits {
    return { ...this.limits }
  }

  getBurstPhase(): BurstPhase {
    return this.burstPhase
  }

  registerContainerState(
    appKey: string,
    state: 'starting' | 'running' | 'stopped',
    currentMemoryBytes = 0,
  ): void {
    if (state === 'stopped') {
      this.containers.delete(appKey)
      return
    }
    this.containers.set(appKey, { appKey, state, currentMemoryBytes })
  }

  /**
   * 计算有效常态承诺内存 E_norm
   */
  computeEffectiveNormalCommittedBytes(parentMemoryCurrentBytes: number): number {
    let startingReserveSum = 0
    let runningCount = 0

    for (const c of this.containers.values()) {
      if (c.state === 'starting') {
        const reserve = Math.max(
          0,
          this.limits.appStartReserveBytes - c.currentMemoryBytes,
        )
        startingReserveSum += reserve
        runningCount += 1
      } else if (c.state === 'running') {
        runningCount += 1
      }
    }

    if (this.mode === 'conservative') {
      return (
        runningCount * this.limits.appMemoryNormalMaxBytes +
        this.limits.parentSafetyReserveBytes
      )
    }

    return (
      parentMemoryCurrentBytes +
      startingReserveSum +
      runningCount * this.limits.appMetaOverheadBytes +
      this.limits.parentSafetyReserveBytes
    )
  }

  async getSnapshot(): Promise<ParentResourceSnapshot> {
    const [
      parentMemoryCurrentBytes,
      parentMemoryMaxBytes,
      parentPidsCurrent,
      parentPidsMax,
      hostMemAvailableBytes,
      hostDiskAvailableBytes,
    ] = await Promise.all([
      this.adapter.readParentMemoryCurrent(),
      this.adapter.readParentMemoryMax(),
      this.adapter.readParentPidsCurrent(),
      this.adapter.readParentPidsMax(),
      this.adapter.readHostMemAvailable(),
      this.adapter.readHostDiskAvailable(),
    ])

    let runningContainerCount = 0
    let startingContainerCount = 0
    for (const c of this.containers.values()) {
      if (c.state === 'running') runningContainerCount++
      if (c.state === 'starting') startingContainerCount++
    }

    return {
      burstPhase: this.burstPhase,
      activeBurstAppKey: this.activeBurstAppKey,
      parentMemoryCurrentBytes,
      parentMemoryMaxBytes,
      parentPidsCurrent,
      parentPidsMax,
      hostMemAvailableBytes,
      hostDiskAvailableBytes,
      runningContainerCount,
      startingContainerCount,
      effectiveNormalCommittedBytes:
        this.computeEffectiveNormalCommittedBytes(parentMemoryCurrentBytes),
    }
  }

  /**
   * 原子准入检查：新启动一个普通应用容器
   * 若预算不足直接抛出 RESOURCE_BUDGET_EXCEEDED，绝不停止他人容器
   */
  async admitNormalStart(appKey: string): Promise<void> {
    return this.withAdmissionLock(async () => {
      const existing = this.containers.get(appKey)
      if (existing?.state === 'running') {
        return
      }

      const snap = await this.getSnapshot()

      if (snap.hostMemAvailableBytes < this.limits.hostMinMemAvailableNormalBytes) {
        throw new ManagedAppError(
          'HOST_PRESSURE_GUARD',
          `宿主机当前可用内存低于安全保护线（需至少 ${(this.limits.hostMinMemAvailableNormalBytes / (1024 ** 3)).toFixed(1)} GiB），暂停启动新应用容器以保障主服务稳定`,
          {
            hostMemAvailableBytes: snap.hostMemAvailableBytes,
            requiredBytes: this.limits.hostMinMemAvailableNormalBytes,
          },
        )
      }

      if (snap.hostDiskAvailableBytes < this.limits.hostMinDiskAvailableBytes) {
        throw new ManagedAppError(
          'HOST_PRESSURE_GUARD',
          '宿主机磁盘可用空间低于安全保护线（5 GiB），暂停启动新应用容器',
          {
            hostDiskAvailableBytes: snap.hostDiskAvailableBytes,
            requiredBytes: this.limits.hostMinDiskAvailableBytes,
          },
        )
      }

      const projectedMemory =
        snap.effectiveNormalCommittedBytes + this.limits.appStartReserveBytes
      if (projectedMemory > this.limits.parentMemoryNormalMaxBytes) {
        throw new ManagedAppError(
          'RESOURCE_BUDGET_EXCEEDED',
          '当前可用运行内存额度已满（常态总上限 2 GiB），无法再启动新的应用容器；现有运行中的服务不受影响',
          {
            effectiveNormalCommittedBytes: snap.effectiveNormalCommittedBytes,
            requestedStartReserveBytes: this.limits.appStartReserveBytes,
            parentMemoryNormalMaxBytes: this.limits.parentMemoryNormalMaxBytes,
          },
        )
      }

      if (snap.parentPidsCurrent + 32 > this.limits.parentPidsMax) {
        throw new ManagedAppError(
          'RESOURCE_BUDGET_EXCEEDED',
          `工作容器组总进程/线程数接近上限（${snap.parentPidsCurrent}/${this.limits.parentPidsMax}），暂时无法启动新应用容器`,
          {
            parentPidsCurrent: snap.parentPidsCurrent,
            parentPidsMax: this.limits.parentPidsMax,
          },
        )
      }

      this.containers.set(appKey, {
        appKey,
        state: 'starting',
        currentMemoryBytes: 0,
      })
    })
  }

  /**
   * 申请瞬时 4 GiB 构建票据（全局并发 1，有界排队）
   * 返回 release 函数；release 内部严格执行 6 步回落状态机
   */
  async acquireBurstTicket(
    userId: string,
    appKey: string,
    timeoutSec = this.limits.maxBuildExecTimeoutSec,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    signal?.throwIfAborted()
    if (this.burstPhase !== 'normal') {
      if (this.burstQueue.length >= this.limits.maxBurstQueueLength) {
        throw new ManagedAppError(
          'BURST_QUEUE_FULL',
          `当前构建队列已满（上限 ${this.limits.maxBurstQueueLength}），请稍后重试`,
        )
      }
      const userQueued = this.burstQueue.filter(w => w.userId === userId).length
      if (userQueued >= this.limits.maxBurstQueuePerUser) {
        throw new ManagedAppError(
          'BURST_QUEUE_FULL',
          `您已有 ${userQueued} 个构建任务正在排队，请等待完成后再提交`,
        )
      }

      return new Promise<() => Promise<void>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.burstQueue = this.burstQueue.filter(w => w !== waiter)
          waiter.cleanup?.()
          reject(
            new ManagedAppError(
              'BURST_QUEUE_TIMEOUT',
              '等待瞬时构建内存额度超时，请稍后重试',
            ),
          )
        }, this.limits.burstQueueWaitTimeoutMs)

        const waiter: QueuedBurstWaiter = {
          userId,
          appKey,
          resolve,
          reject,
          timer,
        }
        const abort = () => {
          this.burstQueue = this.burstQueue.filter(w => w !== waiter)
          clearTimeout(timer)
          waiter.cleanup?.()
          reject(new Error('构建排队已取消'))
        }
        waiter.signal = signal
        waiter.cleanup = () => signal?.removeEventListener('abort', abort)
        signal?.addEventListener('abort', abort, { once: true })
        this.burstQueue.push(waiter)
      })
    }

    return this.grantBurstNow(appKey, timeoutSec, signal)
  }

  private async grantBurstNow(
    appKey: string,
    timeoutSec: number,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>> {
    return this.withAdmissionLock(async () => {
      signal?.throwIfAborted()
      if (this.burstPhase !== 'normal') {
        throw new ManagedAppError('RESOURCE_BUDGET_EXCEEDED', '构建额度已被另一任务占用，请稍后重试')
      }
      const snap = await this.getSnapshot()
      if (snap.hostMemAvailableBytes < this.limits.hostMinMemAvailableBurstBytes) {
        throw new ManagedAppError(
          'HOST_PRESSURE_GUARD',
          '宿主机当前可用内存不足以开启瞬时构建扩容，已拒绝本次重型构建以保护常驻服务',
          {
            hostMemAvailableBytes: snap.hostMemAvailableBytes,
            requiredBytes: this.limits.hostMinMemAvailableBurstBytes,
          },
        )
      }

      if (snap.hostDiskAvailableBytes < this.limits.hostMinDiskAvailableBytes) throw new ManagedAppError('HOST_PRESSURE_GUARD', '磁盘可用空间不足，拒绝构建')

      const burstDelta =
        this.limits.appMemoryBurstMaxBytes - this.limits.appMemoryNormalMaxBytes
      const targetParentMax = Math.min(
        this.limits.parentMemoryPeakMaxBytes,
        Math.max(
          this.limits.parentMemoryNormalMaxBytes + burstDelta,
          snap.effectiveNormalCommittedBytes + burstDelta,
        ),
      )

      if (
        snap.effectiveNormalCommittedBytes + burstDelta >
        this.limits.parentMemoryPeakMaxBytes
      ) {
        throw new ManagedAppError(
          'RESOURCE_BUDGET_EXCEEDED',
          '当前总内存加上瞬时构建增量将超过 4 GiB 最高上限，请稍后重试',
        )
      }

      signal?.throwIfAborted()
      const deadlineMs = Date.now() + timeoutSec * 1000
      this.burstPhase = 'burst_granted'
      this.activeBurstAppKey = appKey
      try {
        await this.adapter.persistBurstTicket({ appKey, deadlineMs })
        await this.adapter.writeParentMemoryMax(targetParentMax)
        await this.adapter.updateContainerResources(appKey, {
          memoryBytes: this.limits.appMemoryBurstMaxBytes,
          cpuCores: this.limits.appCpuBurstCores,
        })
        this.burstPhase = 'burst_running'
      } catch (err) {
        await this.releaseBurstAndStepDown(appKey)
        throw err
      }

      let released = false
      return async () => {
        if (released) return
        released = true
        await this.releaseBurstAndStepDown(appKey)
      }
    })
  }

  /**
   * 6 步瞬时内存回落状态机：
   * 1. 强杀残留构建进程组
   * 2. 清理 /tmp 构建缓存
   * 3. 轮询容器 memory.current (每 250ms, 最多 5s)
   * 4. 若 <= 170 MiB，先降容器到 200 MiB，再降父级 slice 到 2 GiB
   * 5. 若仍 > 170 MiB，重启容器为干净运行态后再降回 200 MiB / 2 GiB
   */
  private async releaseBurstAndStepDown(appKey: string): Promise<void> {
    this.burstPhase = 'burst_cleaning'
    try {
      await this.adapter.killContainerCommandProcesses(appKey).catch(() => {})
      await this.adapter.cleanContainerTmp(appKey).catch(() => {})

      let cooledDown = false
      const maxAttempts = 20
      for (let i = 0; i < maxAttempts; i++) {
        const current = await this.adapter
          .readContainerMemoryCurrent(appKey)
          .catch(() => Number.POSITIVE_INFINITY)
        if (current <= this.limits.burstCooldownTargetBytes) {
          cooledDown = true
          break
        }
        await delay(250)
      }

      if (!cooledDown) {
        await this.adapter.restartContainerCleanRuntime(appKey)
        const after = await this.adapter.readContainerMemoryCurrent(appKey)
        if (after > this.limits.burstCooldownTargetBytes) throw new ManagedAppError('HOST_PRESSURE_GUARD', '构建容器重启后内存仍未回落，保持构建准入关闭')
      }

      await this.adapter
        .updateContainerResources(appKey, {
          memoryBytes: this.limits.appMemoryNormalMaxBytes,
          cpuCores: this.limits.appCpuNormalCores,
        })
      await this.adapter.writeParentMemoryMax(this.limits.parentMemoryNormalMaxBytes)
      await this.adapter.persistBurstTicket(null)
      this.burstPhase = 'normal'
      this.activeBurstAppKey = null
      this.pumpBurstQueue()
    } catch (error) {
      this.burstPhase = 'burst_cleaning'
      while (this.burstQueue.length) { const next = this.burstQueue.shift()!; clearTimeout(next.timer); next.cleanup?.(); next.reject(new ManagedAppError('HOST_PRESSURE_GUARD', '构建额度回收失败，暂停新的构建')) }
      throw error
    }
  }

  private pumpBurstQueue(): void {
    const next = this.burstQueue.shift()
    if (!next) return
    clearTimeout(next.timer)
    next.cleanup?.()
    this.grantBurstNow(next.appKey, this.limits.maxBuildExecTimeoutSec, next.signal)
      .then(release => next.resolve(release))
      .catch(err => {
        next.reject(err instanceof Error ? err : new Error(String(err)))
        this.pumpBurstQueue()
      })
  }

  /**
   * 控制器启动/崩溃恢复对账：回收任何遗留的瞬时构建额度并将父级 slice 恢复到 2 GiB
   */
  async reconcileOnStartup(): Promise<void> {
    const persisted = await this.adapter.loadPersistedBurstTicket()
    if (persisted) {
      await this.releaseBurstAndStepDown(persisted.appKey)
    } else {
      await this.adapter.writeParentMemoryMax(
        this.limits.parentMemoryNormalMaxBytes,
      )
    }
  }

  private async withAdmissionLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.admissionChain
    let releaseLock!: () => void
    this.admissionChain = new Promise<void>(r => {
      releaseLock = r
    })
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      releaseLock()
    }
  }
}
