import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { withBackendLifecycle } from './backendFixture.js'
import {
  BackendSupervisor,
  redactSecrets,
  type BackendSnapshot,
  type BackendSupervisorOptions,
} from '../src/backendSupervisor.js'

const supervisors: BackendSupervisor[] = []
const roots: string[] = []
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const silent = { stdout: { write: () => true }, stderr: { write: () => true } }

function supervisor(code: string, extra: Partial<BackendSupervisorOptions> = {}): BackendSupervisor {
  const instance = new BackendSupervisor({
    command: process.execPath,
    args: ['-e', withBackendLifecycle(code)],
    resolveListener: async () => ({ host: '127.0.0.1', port: 1 }),
    isReady: async () => false,
    readinessPollMs: 10,
    readinessTimeoutMs: 2_000,
    ...silent,
    ...extra,
  })
  supervisors.push(instance)
  return instance
}

async function waitForSnapshot(
  supervisorInstance: BackendSupervisor,
  check: (snapshot: BackendSnapshot) => boolean,
  timeout = 5_000,
): Promise<BackendSnapshot> {
  const begin = Date.now()
  while (Date.now() - begin < timeout) {
    const snapshot = await supervisorInstance.snapshot()
    if (check(snapshot)) return snapshot
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待状态超时，最后快照：${JSON.stringify(await supervisorInstance.snapshot({ logs: false }))}`)
}

it('启动失败按注入的退避间隔自动重试 3 次后停在 failed', async () => {
  const begin = Date.now()
  const backend = supervisor('setTimeout(() => process.exit(7), 5)', {
    retryDelaysMs: [40, 80, 120],
  })
  await backend.start()
  const retrying = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'retrying')
  expect(retrying.retryCount).toBe(1)
  expect(retrying.maxRetries).toBe(3)
  expect(retrying.nextRetryAt).not.toBeNull()
  expect(retrying.nextRetryInMs).toBeGreaterThan(0)
  const failed = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'failed')
  expect(failed.retryCount).toBe(3)
  expect(failed.lastError).toContain('退出码 7')
  expect(failed.lastError).toContain('已用完 3 次自动重试')
  expect(failed.nextRetryAt).toBeNull()
  expect(failed.running).toBe(false)
  // 三次退避 40 + 80 + 120 ms 必须全部走完，不允许跳过等待。
  expect(Date.now() - begin).toBeGreaterThanOrEqual(240)
})

it('未满稳定时长再次崩溃时继续累加失败计数，满稳定时长后才清零', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-supervisor-'))
  roots.push(root)
  const marker = join(root, 'marker')
  const code = `const fs = require('node:fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(9) } setInterval(() => {}, 1000)`
  const backend = supervisor(code, {
    retryDelaysMs: [20, 20, 20],
    stableMs: 60_000,
    isReady: async () => true,
    readinessPollMs: 5,
  })
  await backend.start()
  const firstCrash = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'retrying')
  expect(firstCrash.retryCount).toBe(1)
  const running = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'running')
  expect(running.retryCount).toBe(1)
  expect(running.stableSince).not.toBeNull()
  // 未满 5 分钟稳定时长就崩溃：计数继续累加，绝不清零。
  process.kill(running.pid!, 'SIGKILL')
  const secondCrash = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'retrying')
  expect(secondCrash.retryCount).toBe(2)
})

it('连续稳定运行满稳定时长后清零失败计数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-supervisor-'))
  roots.push(root)
  const marker = join(root, 'marker')
  const code = `const fs = require('node:fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(2) } setInterval(() => {}, 1000)`
  const backend = supervisor(code, {
    retryDelaysMs: [20],
    stableMs: 120,
    isReady: async () => true,
    readinessPollMs: 5,
  })
  await backend.start()
  const retrying = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'retrying')
  expect(retrying.retryCount).toBe(1)
  const running = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'running')
  expect(running.retryCount).toBe(1)
  const cleared = await waitForSnapshot(backend, (snapshot) => snapshot.retryCount === 0)
  expect(cleared.state).toBe('running')
})

it('重试等待期取消自动重试立即定格为 failed 且不再启动', async () => {
  const backend = supervisor('setTimeout(() => process.exit(5), 5)', { retryDelaysMs: [5_000] })
  await backend.start()
  const retrying = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'retrying')
  expect(retrying.nextRetryAt).not.toBeNull()
  expect(backend.cancelRetry()).toBe(true)
  const cancelled = await backend.snapshot()
  expect(cancelled.state).toBe('failed')
  expect(cancelled.nextRetryAt).toBeNull()
  expect(cancelled.lastError).toContain('已手动取消自动重试')
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect((await backend.snapshot()).state).toBe('failed')
  expect(backend.cancelRetry()).toBe(false)
})

it('手动启动重置失败计数并立即开启新一轮启动', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backend-supervisor-'))
  roots.push(root)
  const marker = join(root, 'marker')
  const code = `const fs = require('node:fs'); if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(4) } setInterval(() => {}, 1000)`
  const backend = supervisor(code, {
    retryDelaysMs: [5_000],
    isReady: async () => true,
    readinessPollMs: 5,
  })
  await backend.start()
  const retrying = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'retrying')
  expect(retrying.retryCount).toBe(1)
  const restarted = await backend.start()
  expect(restarted.retryCount).toBe(0)
  const running = await waitForSnapshot(backend, (snapshot) => snapshot.state === 'running')
  expect(running.retryCount).toBe(0)
  expect(running.pid).not.toBeNull()
})

it('采集日志环形缓冲、脱敏敏感字段并转发到父进程输出', async () => {
  const written: string[] = []
  const backend = supervisor(
    `for (let i = 0; i < 40; i++) console.log('line ' + i); console.error('token=topsecret'); setInterval(() => {}, 1000)`,
    {
      logLimit: 10,
      isReady: async () => true,
      readinessPollMs: 5,
      stdout: { write: (chunk: string) => written.push(chunk) },
      stderr: { write: (chunk: string) => written.push(chunk) },
    },
  )
  await backend.start()
  const snapshot = await waitForSnapshot(
    backend,
    (current) => current.state === 'running' && (current.logs?.length ?? 0) >= 10,
  )
  expect(snapshot.logs).toHaveLength(10)
  const lines = snapshot.logs!.map((entry) => entry.line)
  expect(lines.join('\n')).not.toContain('topsecret')
  expect(lines.some((line) => line.includes('token=***'))).toBe(true)
  expect(lines).toContain('line 39')
  for (const entry of snapshot.logs!) {
    expect(['stdout', 'stderr']).toContain(entry.stream)
    expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false)
  }
  expect(written.length).toBeGreaterThan(0)
  expect(written.join('')).not.toContain('topsecret')
})

it('提供进程与系统资源快照，进程退出后不抛错', async () => {
  const backend = supervisor('setInterval(() => {}, 1000)', {
    isReady: async () => true,
    readinessPollMs: 5,
  })
  await backend.start()
  const snapshot = await waitForSnapshot(backend, (current) => current.state === 'running')
  expect(snapshot.resources.process.pid).toBe(snapshot.pid)
  expect(snapshot.resources.process.uptimeSeconds).toBeGreaterThanOrEqual(0)
  expect(snapshot.resources.system.memoryUsedRatio).toBeGreaterThan(0)
  expect(snapshot.resources.system.memoryUsedRatio).toBeLessThanOrEqual(1)
  expect(snapshot.resources.system.uptimeSeconds).toBeGreaterThan(0)
  expect(snapshot.listener).toMatchObject({ host: '127.0.0.1', port: 1, ready: true })
  expect(snapshot.versionCompatibility).toEqual({ contractVersion: 1, compatible: true })
  await backend.stop()
  const stopped = await waitForSnapshot(backend, current => current.lifecycle?.phase === 'stopped')
  expect(stopped.state).toBe('inactive')
  expect(stopped.pid).toBeNull()
  expect(stopped.resources.process.uptimeSeconds).toBe(0)
})

it('脱敏规则覆盖等号/冒号写法和 Bearer 凭据', () => {
  expect(redactSecrets('apiKey=abcdef123')).toBe('apiKey=***')
  expect(redactSecrets('password: "quoted-value"')).toBe('password: ***')
  expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: ***')
})
