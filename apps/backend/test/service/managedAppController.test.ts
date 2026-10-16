import os from 'node:os'
import path from 'node:path'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedAppController } from '../../src/service/managedApp/controller.ts'
import { isolatedTaskArgs } from '../../src/service/managedApp/taskIsolation.ts'
import {
  DEFAULT_RUNTIME_LIMITS,
  GiB,
  ManagedAppError,
  MiB,
  ResourceLedger,
  assertNoSymlinkChain,
  startControllerSocketServer,
  ControllerSocketClient,
  type HostResourceAdapter,
} from '../../src/service/managedApp/index.ts'

function createFakeAdapter(overrides: Partial<HostResourceAdapter> = {}) {
  let parentMemCurrent = 300 * MiB
  let parentMemMax = 2 * GiB
  let parentPidsCurrent = 20
  let hostMemAvailable = 6 * GiB
  let hostDiskAvailable = 100 * GiB
  const containerMem = new Map<string, number>()
  const containerLimits = new Map<string, { memoryBytes: number; cpuCores: number }>()
  let persistedTicket: { appKey: string; deadlineMs: number } | null = null
  const events: string[] = []

  const adapter: HostResourceAdapter = {
    readParentMemoryCurrent: async () => parentMemCurrent,
    readParentMemoryMax: async () => parentMemMax,
    writeParentMemoryMax: async bytes => {
      events.push(`parentMax:${bytes}`)
      parentMemMax = bytes
    },
    readParentPidsCurrent: async () => parentPidsCurrent,
    readParentPidsMax: async () => 512,
    readHostMemAvailable: async () => hostMemAvailable,
    readHostDiskAvailable: async () => hostDiskAvailable,
    readContainerMemoryCurrent: async appKey => containerMem.get(appKey) ?? 80 * MiB,
    updateContainerResources: async (appKey, opts) => {
      events.push(`containerUpdate:${appKey}:${opts.memoryBytes}`)
      containerLimits.set(appKey, opts)
    },
    killContainerCommandProcesses: async appKey => {
      events.push(`killProcs:${appKey}`)
    },
    cleanContainerTmp: async appKey => {
      events.push(`cleanTmp:${appKey}`)
    },
    restartContainerCleanRuntime: async appKey => {
      events.push(`restartClean:${appKey}`)
      containerMem.set(appKey, 60 * MiB)
    },
    persistBurstTicket: async ticket => {
      persistedTicket = ticket
      events.push(`persistTicket:${ticket ? ticket.appKey : 'null'}`)
    },
    loadPersistedBurstTicket: async () => persistedTicket,
    ...overrides,
  }

  return {
    adapter,
    events,
    setParentMemCurrent: (v: number) => {
      parentMemCurrent = v
    },
    setHostMemAvailable: (v: number) => {
      hostMemAvailable = v
    },
    setContainerMem: (appKey: string, v: number) => {
      containerMem.set(appKey, v)
    },
    getParentMemMax: () => parentMemMax,
    getContainerLimits: (appKey: string) => containerLimits.get(appKey),
  }
}

describe('managed task cancellation and isolation', () => {
  it('keeps privileged namespace init separate from arbitrary task code', () => {
    const args = isolatedTaskArgs(12345, '/workspace', 'env -i setsid sleep 90')
    expect(args).toContain('--no-fork')
    expect(args).toContain('--mount-proc')
    expect(args).toContain('--pdeathsig=SIGKILL')
    expect(args.at(-1)).toBe('env -i setsid sleep 90')
    expect(args.join(' ')).toContain('--bounding-set=-all')
    expect(() => isolatedTaskArgs(1, '/workspace', 'pwd')).toThrow()
  })
  it('accepts cancellation before exec and never starts the container', async () => {
    const controller = new ManagedAppController()
    const internal = controller as any
    vi.spyOn(internal, 'requireOwnedApp').mockReturnValue({ userId: '649207438', appId: 'demo', containerName: 'unused' })
    const start = vi.spyOn(internal, 'ensureContainerRunning')
    const params = { userId: '649207438', appId: 'demo', taskId: 'task_1234567890abcdef' }
    await controller.cancelAppCommand(params)
    const result = await controller.runAppCommand({ ...params, command: 'sleep 90' })
    expect(result.status).toBe('cancelled')
    expect(result.finishedAt).not.toBeNull()
    expect(start).not.toHaveBeenCalled()
  })
  it('rejects cancelling an already completed task', async () => {
    const controller = new ManagedAppController()
    const internal = controller as any
    vi.spyOn(internal, 'requireOwnedApp').mockReturnValue({ userId: '649207438', appId: 'demo' })
    const cancel = vi.fn()
    internal.tasks.set('task_1234567890abcdef', { result: { userId: '649207438', appId: 'demo', status: 'completed' }, cancel })
    await expect(controller.cancelAppCommand({ userId: '649207438', appId: 'demo', taskId: 'task_1234567890abcdef' })).rejects.toThrow('已结束')
    expect(cancel).not.toHaveBeenCalled()
  })
  it('accepts cancellation before publish and never starts or stops a container', async () => {
    const controller = new ManagedAppController()
    const internal = controller as any
    vi.spyOn(internal, 'requireOwnedApp').mockReturnValue({ userId: '649207438', appId: 'demo', containerName: 'unused' })
    const start = vi.spyOn(internal, 'ensureContainerRunning')
    const stop = vi.spyOn(controller, 'stopAppService')
    const params = { userId: '649207438', appId: 'demo', taskId: 'task_1234567890abcdef' }
    await controller.cancelAppCommand(params)
    await expect(controller.startAppService(params)).rejects.toThrow()
    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect((await controller.getTaskStatus(params)).status).toBe('cancelled')
  })
})

describe('WP1 ResourceLedger & 2GiB/200MiB/4GiB State Machine', () => {
  it('fails closed if lowering the parent resource limit fails', async () => {
    const ctx = createFakeAdapter()
    const ledger = new ResourceLedger(ctx.adapter)
    const release = await ledger.acquireBurstTicket('649207438', '649207438:app-one')
    ctx.adapter.writeParentMemoryMax = async () => { throw new Error('cgroup unavailable') }
    await expect(release()).rejects.toThrow('cgroup unavailable')
    expect(ledger.getBurstPhase()).toBe('burst_cleaning')
    expect(await ctx.adapter.loadPersistedBurstTicket()).not.toBeNull()
  })
  it('rejects build and startup on host pressure without stopping running apps', async () => {
    const ctx = createFakeAdapter()
    const ledger = new ResourceLedger(ctx.adapter)
    ledger.registerContainerState('649207438:app-one', 'running', 80 * MiB)
    ctx.setHostMemAvailable(1)
    await expect(ledger.admitNormalStart('649207438:app-two')).rejects.toMatchObject({ code: 'HOST_PRESSURE_GUARD' })
    await expect(ledger.acquireBurstTicket('649207438', '649207438:app-two')).rejects.toMatchObject({ code: 'HOST_PRESSURE_GUARD' })
    expect(ctx.events).toHaveLength(0)
  })
  it('shares one pending container startup between simultaneous commands', async () => {
    const controller = new ManagedAppController() as any
    let resolve!: (value: any) => void
    const startup = new Promise(resolveStart => { resolve = resolveStart })
    const start = vi.spyOn(controller, 'ensureContainerRunningLocked').mockReturnValue(startup)
    const record = { userId: '649207438', appId: 'demo' }
    const one = controller.ensureContainerRunning(record)
    const two = controller.ensureContainerRunning(record)
    resolve(record)
    expect(await one).toBe(record)
    expect(await two).toBe(record)
    expect(start).toHaveBeenCalledTimes(1)
  })
  it('admits normal container start within 2 GiB budget and rejects without stopping others when budget is full', async () => {
    const ctx = createFakeAdapter()
    const ledger = new ResourceLedger(ctx.adapter)

    await ledger.admitNormalStart('649207438:app-one')
    ledger.registerContainerState('649207438:app-one', 'running', 120 * MiB)

    // 模拟当前父级内存已达 1.7 GiB，加上 256 MiB 安全余量 + 24 MiB 元开销 + 128 MiB 新启动预留 > 2 GiB
    ctx.setParentMemCurrent(1700 * MiB)

    await expect(ledger.admitNormalStart('649207438:app-two')).rejects.toMatchObject({
      code: 'RESOURCE_BUDGET_EXCEEDED',
    })

    // 已运行的 app-one 不受影响
    const snap = await ledger.getSnapshot()
    expect(snap.runningContainerCount).toBe(1)
  })

  it('steps up to burst limit (<= 4 GiB) and smoothly steps back down to 200 MiB / 2 GiB when memory cools down', async () => {
    const ctx = createFakeAdapter()
    ctx.setContainerMem('649207438:app-one', 110 * MiB)
    const ledger = new ResourceLedger(ctx.adapter)
    ledger.registerContainerState('649207438:app-one', 'running', 110 * MiB)

    const release = await ledger.acquireBurstTicket('649207438', '649207438:app-one', 120)
    expect(ledger.getBurstPhase()).toBe('burst_running')
    expect(ctx.getParentMemMax()).toBeGreaterThan(2 * GiB)
    expect(ctx.getParentMemMax()).toBeLessThanOrEqual(4 * GiB)
    expect(ctx.getContainerLimits('649207438:app-one')?.memoryBytes).toBe(
      DEFAULT_RUNTIME_LIMITS.appMemoryBurstMaxBytes,
    )

    await release()
    expect(ledger.getBurstPhase()).toBe('normal')
    expect(ctx.getParentMemMax()).toBe(2 * GiB)
    expect(ctx.getContainerLimits('649207438:app-one')?.memoryBytes).toBe(200 * MiB)
    expect(ctx.events).not.toContain('restartClean:649207438:app-one')
  })

  it('restarts container to clean runtime before lowering limit when post-build memory stays above 170 MiB', async () => {
    const ctx = createFakeAdapter()
    // 模拟构建后常驻进程膨胀到 550 MiB 不释放
    ctx.setContainerMem('649207438:app-sticky', 550 * MiB)
    const ledger = new ResourceLedger(ctx.adapter, {
      burstCooldownTargetBytes: 170 * MiB,
    })

    const release = await ledger.acquireBurstTicket(
      '649207438',
      '649207438:app-sticky',
      60,
    )
    await release()

    expect(ctx.events).toContain('restartClean:649207438:app-sticky')
    expect(ctx.getContainerLimits('649207438:app-sticky')?.memoryBytes).toBe(200 * MiB)
    expect(ctx.getParentMemMax()).toBe(2 * GiB)
  }, 15_000)

  it('removes cancelled burst waiters without granting resources', async () => {
    const ctx = createFakeAdapter()
    const ledger = new ResourceLedger(ctx.adapter)
    const release = await ledger.acquireBurstTicket('649207438', '649207438:active', 60)
    const abort = new AbortController()
    const waiting = ledger.acquireBurstTicket('123456789', '123456789:queued', 60, abort.signal)
    const rejected = expect(waiting).rejects.toThrow('取消')
    abort.abort()
    await rejected
    await release()
    expect(ctx.events.some(event => event.startsWith('containerUpdate:123456789:queued'))).toBe(false)
  })
  it('never grants two tickets to requests arriving before the first admission completes', async () => {
    const ctx = createFakeAdapter()
    const ledger = new ResourceLedger(ctx.adapter)
    const results = await Promise.allSettled([
      ledger.acquireBurstTicket('649207438', '649207438:race-one', 60),
      ledger.acquireBurstTicket('123456789', '123456789:race-two', 60),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(ctx.events.filter(event => event.startsWith('containerUpdate:'))).toHaveLength(1)
    for (const result of results) if (result.status === 'fulfilled') await result.value()
  })
  it('serializes concurrent burst build requests and hands over ticket in FIFO order', async () => {
    const ctx = createFakeAdapter()
    const ledger = new ResourceLedger(ctx.adapter)

    const release1 = await ledger.acquireBurstTicket('649207438', '649207438:a1', 60)
    let secondAcquired = false
    const p2 = ledger
      .acquireBurstTicket('649207438', '649207438:a2', 60)
      .then(rel => {
        secondAcquired = true
        return rel
      })

    expect(secondAcquired).toBe(false)
    await release1()
    const release2 = await p2
    expect(secondAcquired).toBe(true)
    await release2()
    expect(ledger.getBurstPhase()).toBe('normal')
  })
})

describe('WP1 Symlink Escape Guard & Restricted Socket RPC', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true })
    }
  })

  it('rejects symlink segments inside project directory chain', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'chery-wp1-test-'))
    tempDirs.push(tmp)

    const normalDir = path.join(tmp, '649207438', 'apps', 'demo')
    await mkdir(normalDir, { recursive: true })
    await assertNoSymlinkChain(tmp, normalDir)

    const evilLink = path.join(normalDir, 'project')
    await symlink('/etc', evilLink)

    await expect(assertNoSymlinkChain(tmp, evilLink)).rejects.toMatchObject({
      code: 'APP_ACCESS_DENIED',
    })
  })

  it('rejects forged OpenID or invalid appId over Unix Socket RPC schema validation', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'chery-wp1-sock-'))
    tempDirs.push(tmp)
    const sockPath = path.join(tmp, 'controller.sock')

    const fakeController = {
      dispatchRpc: async () => ({ ok: true }),
    } as any

    const srv = await startControllerSocketServer(fakeController, sockPath)
    const client = new ControllerSocketClient(sockPath)

    try {
      // OpenID 74B88543... 不是真实个人 QQ 号，必须被拒绝
      await expect(
        client.ensureAppWorkspace({
          userId: '74B88543EE2CC173418104185151205E',
          appId: 'valid-app',
          title: 'Test',
        }),
      ).rejects.toBeInstanceOf(ManagedAppError)

      // 保留词 share 作为 appId 必须被拒绝
      await expect(
        client.ensureAppWorkspace({
          userId: '649207438',
          appId: 'share',
          title: 'Test',
        }),
      ).rejects.toBeInstanceOf(ManagedAppError)
    } finally {
      await srv.close()
    }
  })
})
