import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { freemem, loadavg, totalmem, uptime } from 'node:os'
import { ProcessStartError } from './processController.js'
import { BackendControl } from './backendControl.js'
import type { BackendIntentStore } from './backendIntent.js'
import type { BackendStopSnapshot } from '@chery/protocol'

export type BackendRuntimeState = 'inactive' | 'starting' | 'running' | 'retrying' | 'failed'
export type BackendLogStream = 'stdout' | 'stderr'

export interface BackendLogEntry {
  timestamp: string
  stream: BackendLogStream
  line: string
}

export interface BackendListener {
  host: string
  port: number
  ready: boolean
}

export interface BackendProcessResources {
  pid: number | null
  uptimeSeconds: number
  cpuPercent: number | null
  memoryBytes: number | null
}

export interface BackendSystemResources {
  memoryUsedRatio: number
  load1: number | undefined
  uptimeSeconds: number
}

export interface BackendSnapshot {
  state: BackendRuntimeState
  /** Manager 是否持有该后端子进程（外部启动的后端为 false，管理器不重试）。 */
  running: boolean
  pid: number | null
  retryCount: number
  maxRetries: number
  nextRetryAt: string | null
  nextRetryInMs: number | null
  lastError: string | null
  stableSince: string | null
  uptimeSeconds: number
  listener: BackendListener
  resources: { system: BackendSystemResources; process: BackendProcessResources }
  versionCompatibility: { contractVersion: number; compatible: boolean }
  logs?: BackendLogEntry[]
  lifecycle: BackendStopSnapshot | null
}

type Timer = ReturnType<typeof setTimeout>
interface LogSink {
  write(chunk: string): unknown
}

export interface BackendSupervisorOptions {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  /** 默认 5s / 15s / 30s 三次重试，可通过构造参数覆盖以便单元测试。 */
  retryDelaysMs?: readonly number[]
  /** 连续稳定运行多久才清零失败计数，默认 5 分钟。 */
  stableMs?: number
  readinessPollMs?: number
  readinessTimeoutMs?: number
  logLimit?: number
  /** 解析后端监听地址；仅用于状态展示。 */
  resolveListener?: () => Promise<{ host: string; port: number } | undefined>
  /** 就绪探测；未提供时子进程成功启动即视为就绪。 */
  isReady?: (listener: { host: string; port: number } | undefined) => Promise<boolean>
  /** 启动前端口占用预检；命中时立即 failed 且抛错，不做无意义的重试。 */
  isPortOpen?: (listener: { host: string; port: number }) => Promise<boolean>
  now?: () => number
  stdout?: LogSink
  stderr?: LogSink
  intent?: BackendIntentStore
}

const DEFAULT_RETRY_DELAYS = [5_000, 15_000, 30_000] as const
const DEFAULT_STABLE_MS = 300_000
const DEFAULT_LOG_LIMIT = 200
const MAX_LOG_LINE = 4096

/**
 * 受管后端进程监管器：唯一的启动、有限重试与稳定清零执行层。
 * 状态流转：inactive → starting → running；异常退出 → retrying → starting；超过 3 次 → failed。
 * 停止由 BackendControl 经 IPC 协调；默认等待不持有操作锁，也不设强杀定时器。
 */
export class BackendSupervisor {
  readonly control: BackendControl
  private readonly command: string
  private readonly args: string[]
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly retryDelaysMs: readonly number[]
  private readonly stableMs: number
  private readonly readinessPollMs: number
  private readonly readinessTimeoutMs: number
  private readonly logLimit: number
  private readonly resolveListener?: BackendSupervisorOptions['resolveListener']
  private readonly isReady?: BackendSupervisorOptions['isReady']
  private readonly isPortOpen?: BackendSupervisorOptions['isPortOpen']
  private readonly now: () => number
  private readonly stdoutSink: LogSink
  private readonly stderrSink: LogSink

  private child: ChildProcess | undefined
  private state: BackendRuntimeState = 'inactive'
  private retryCount = 0
  private lastError: string | undefined
  private nextRetryAt: number | undefined
  private stableSince: number | undefined
  private startedAt: number | undefined
  private listener: { host: string; port: number } | undefined
  private pendingFailure: string | undefined
  private stopRequested = false
  private closing = false
  private retryTimer: Timer | undefined
  private stableTimer: Timer | undefined
  private readinessTimer: Timer | undefined
  private readinessDeadline: Timer | undefined
  private cpuSample: { at: number; ticks: number } | undefined
  private readonly logs: BackendLogEntry[] = []
  private readonly residuals: Record<BackendLogStream, string> = { stdout: '', stderr: '' }
  private operations: Promise<unknown> = Promise.resolve()

  constructor(options: BackendSupervisorOptions) {
    this.command = options.command
    this.args = options.args
    this.env = options.env
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS
    if (this.retryDelaysMs.length === 0) throw new Error('retryDelaysMs 不能为空')
    this.stableMs = options.stableMs ?? DEFAULT_STABLE_MS
    this.readinessPollMs = options.readinessPollMs ?? 250
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 120_000
    this.logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT
    this.resolveListener = options.resolveListener
    this.isReady = options.isReady
    this.isPortOpen = options.isPortOpen
    this.now = options.now ?? Date.now
    this.stdoutSink = options.stdout ?? process.stdout
    this.stderrSink = options.stderr ?? process.stderr
    this.control = new BackendControl({ child: () => this.child, intent: options.intent, now: this.now,
      stopAdmission: () => {
        this.stopRequested = true
        this.clearRetry()
        this.clearStable()
        this.clearReadiness()
        this.nextRetryAt = undefined
        if (!this.child) this.state = 'inactive'
      },
      resumeAdmission: () => {
        this.stopRequested = false
        if (this.child) this.watchReadiness(this.child)
      },
    })
  }

  get maxRetries(): number {
    return this.retryDelaysMs.length
  }

  /** 管理器是否持有后端子进程（外部启动的后端无法由管理器重启）。 */
  isManaged(): boolean {
    return this.child !== undefined
  }

  /** 供 ProcessController.adopt 的动态桥接：存活与 PID 随内部重启自动跟随。 */
  bridge(): import('./processController.js').AdoptedProcessBridge {
    return {
      isAlive: () => this.child !== undefined,
      pid: () => this.child?.pid,
      stop: async () => { await this.stop(); await this.control.waitForExit() },
    }
  }

  /** 当前状态名，供同步判断使用；完整快照见 snapshot()。 */
  currentState(): BackendRuntimeState {
    return this.state
  }

  /** 手动启动：重置失败计数并立即开启新一轮启动，已在运行或启动中则幂等返回。 */
  start(): Promise<BackendSnapshot> {
    return this.exclusive(async () => {
      if (this.closing) throw new Error('管理器正在关闭')
      await this.control.allowStart()
      if (this.child) return this.snapshot()
      // 端口已被其他进程占用（外部后端等）：不可重试的启动失败，直接 failed，不烧重试次数。
      // 仅在显式 start 入口预检，避免 restart/内部重试因端口未及时释放被误判。
      const resolved = await this.resolveListener?.().catch(() => undefined)
      if (resolved) this.listener = resolved
      if (this.isPortOpen && this.listener) {
        const occupied = await this.isPortOpen(this.listener).catch(() => false)
        if (occupied) {
          this.lastError = `监听端口已占用（${this.listener.host}:${this.listener.port}）`
          this.state = 'failed'
          this.nextRetryAt = undefined
          throw new ProcessStartError('backend', `端口已占用：${this.listener.host}:${this.listener.port}`)
        }
      }
      this.clearRetry()
      this.retryCount = 0
      this.nextRetryAt = undefined
      this.lastError = undefined
      this.stableSince = undefined
      this.stopRequested = false
      await this.attemptStart()
      return this.snapshot()
    })
  }

  /** 配置重启也等待当前工作；停止意图优先，不再另走直接杀进程路径。 */
  async restart(): Promise<BackendSnapshot> {
    if (this.control.stopping()) throw new Error('Backend 正在关闭，不能重新启动')
    const child = this.child
    if (!child) return this.start()
    if (!child.connected) throw new Error('Backend 控制连接已失联，无法确认重启')
    await new Promise<void>((resolve, reject) => child.send({ type: 'restart-schedule' }, (error) => error ? reject(error) : resolve()))
    return this.snapshot()
  }

  /** 发起等待关闭并立即返回。仅在实际 child exit 后，快照才显示 stopped。 */
  async stop(): Promise<BackendSnapshot> {
    await this.control.requestStop()
    return this.snapshot()
  }

  /** 重试等待期取消自动重试：清定时器并定格为 failed，不触碰运行中进程。 */
  cancelRetry(): boolean {
    if (this.state !== 'retrying') return false
    this.clearRetry()
    this.nextRetryAt = undefined
    this.state = 'failed'
    this.lastError = `${this.lastError ?? '后端异常退出'}（已手动取消自动重试）`
    return true
  }

  /** 管理器关闭：停止自动重试并结束子进程。 */
  async shutdown(): Promise<void> {
    this.closing = true
    await this.control.force()
    await this.control.waitForExit()
  }

  async snapshot(options: { logs?: boolean } = {}): Promise<BackendSnapshot> {
    const nowMs = this.now()
    const child = this.child
    const pid = child?.pid ?? null
    const startedAt = this.startedAt
    // Read lifecycle fields together before resource I/O can interleave with exit/restart.
    const snapshot = {
      state: this.state,
      running: this.child !== undefined,
      pid,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
      nextRetryAt: this.nextRetryAt === undefined ? null : new Date(this.nextRetryAt).toISOString(),
      nextRetryInMs:
        this.nextRetryAt === undefined ? null : Math.max(0, Math.round(this.nextRetryAt - nowMs)),
      lastError: this.lastError ?? null,
      stableSince: this.stableSince === undefined ? null : new Date(this.stableSince).toISOString(),
      uptimeSeconds:
        this.startedAt === undefined || pid === null ? 0 : Math.max(0, (nowMs - this.startedAt) / 1000),
      listener: {
        host: this.listener?.host ?? '',
        port: this.listener?.port ?? 0,
        ready: this.state === 'running',
      },
      versionCompatibility: { contractVersion: 1, compatible: true },
      lifecycle: this.control.snapshot(),
      ...(options.logs === false ? {} : { logs: this.logs.map((entry) => ({ ...entry })) }),
    }
    const system = {
      memoryUsedRatio: totalmem() > 0 ? (totalmem() - freemem()) / totalmem() : 0,
      load1: loadavg()[0] || undefined,
      uptimeSeconds: uptime(),
    }
    const processResources = await readProcessResources(pid, startedAt, nowMs, this.cpuSample)
    if (this.child === child && processResources.sample) this.cpuSample = processResources.sample
    return { ...snapshot, resources: { system, process: processResources.value } }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operations.then(operation, operation)
    this.operations = current.catch(() => {})
    return current
  }

  private async attemptStart(): Promise<void> {
    if (this.closing || this.control.stopping()) throw new Error('Backend 已要求保持停止')
    const resolved = await this.resolveListener?.().catch(() => undefined)
    if (resolved) this.listener = resolved
    if (this.closing || this.control.stopping()) throw new Error('Backend 已要求保持停止')
    const instanceId = randomUUID()
    const child = spawn(this.command, this.args, {
      env: { ...process.env, ...this.env, CHERY_MANAGED_BY_MANAGER: '1', CHERY_BACKEND_INSTANCE_ID: instanceId },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      // 独立进程组：终止时整组（含 backend 自行派生的 worker/子进程）一并退出，
      // 不给业务子进程留下孤儿（旧 controller 依赖同一机制清理进程组）。
      detached: process.platform !== 'win32',
    })
    this.child = child
    this.control.beginChild(instanceId)
    this.state = 'starting'
    this.startedAt = this.now()
    this.stableSince = undefined
    this.pendingFailure = undefined
    this.residuals.stdout = ''
    this.residuals.stderr = ''
    if (child.stdout) this.capture(child, child.stdout, 'stdout')
    if (child.stderr) this.capture(child, child.stderr, 'stderr')
    child.once('error', (error) => this.handleSpawnError(child, error))
    child.once('exit', (code, signal) => this.handleExit(child, code, signal))
    child.on('message', (message: unknown) => { if (this.child === child) this.control.observe(message) })
    child.once('disconnect', () => { if (this.child === child) this.control.disconnected() })
    await new Promise<void>((resolve, reject) => {
      let settled = false
      child.once('spawn', () => {
        if (settled) return
        settled = true
        resolve()
      })
      child.once('error', (error) => {
        if (settled) return
        settled = true
        reject(new ProcessStartError('backend', error.message))
      })
    })
    this.watchReadiness(child)
  }

  private capture(child: ChildProcess, stream: NodeJS.ReadableStream, kind: BackendLogStream): void {
    stream.setEncoding?.('utf8')
    stream.on('data', (chunk: string) => {
      if (this.child !== child) return
      let residual = this.residuals[kind] + chunk
      if (residual.length > MAX_LOG_LINE * 8) residual = residual.slice(-MAX_LOG_LINE * 8)
      const lines = residual.split(/\r?\n/)
      this.residuals[kind] = lines.pop() ?? ''
      for (const line of lines) this.appendLog(kind, line)
    })
    stream.on('error', () => {})
  }

  private appendLog(kind: BackendLogStream, raw: string): void {
    const line = redactSecrets(raw).slice(0, MAX_LOG_LINE)
    this.logs.push({ timestamp: new Date(this.now()).toISOString(), stream: kind, line })
    while (this.logs.length > this.logLimit) this.logs.shift()
    const sink = kind === 'stdout' ? this.stdoutSink : this.stderrSink
    try {
      sink.write(`${line}\n`)
    } catch {
      // 日志转发失败不能影响受管进程。
    }
  }

  private watchReadiness(child: ChildProcess): void {
    if (!this.isReady) {
      this.markRunning()
      return
    }
    const deadline = setTimeout(() => {
      if (this.child !== child || this.state !== 'starting') return
      this.pendingFailure = `后端在 ${this.readinessTimeoutMs}ms 内未就绪`
      this.appendLog('stderr', `[manager] ${this.pendingFailure}`)
      void this.control.force()
    }, this.readinessTimeoutMs)
    deadline.unref()
    this.readinessDeadline = deadline
    const poll = async (): Promise<void> => {
      if (this.child !== child || this.state !== 'starting') return
      let ready = false
      try {
        ready = await this.isReady!(this.listener)
      } catch {
        ready = false
      }
      if (this.child !== child || this.state !== 'starting') return
      if (ready) {
        this.markRunning()
        return
      }
      const next = setTimeout(() => void poll(), this.readinessPollMs)
      next.unref()
      this.readinessTimer = next
    }
    void poll()
  }

  private markRunning(): void {
    this.clearReadiness()
    this.clearStable()
    this.state = 'running'
    this.stableSince = this.now()
    const timer = setTimeout(() => {
      // 只有连续稳定运行满 stableMs 才清零失败计数；未满就崩溃的计数继续累加。
      this.retryCount = 0
    }, this.stableMs)
    timer.unref()
    this.stableTimer = timer
  }

  private handleSpawnError(child: ChildProcess, error: Error): void {
    if (this.child !== child) return
    if (child.pid !== undefined) return
    this.child = undefined
    this.startedAt = undefined
    this.clearReadiness()
    this.clearStable()
    if (this.closing) {
      this.state = 'inactive'
      return
    }
    this.lastError = error.message
    this.scheduleRetry()
  }

  private handleExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.control.exited(code, signal)
    this.child = undefined
    this.startedAt = undefined
    this.cpuSample = undefined
    this.clearReadiness()
    this.clearStable()
    for (const kind of ['stdout', 'stderr'] as const) {
      const residual = this.residuals[kind]
      this.residuals[kind] = ''
      if (residual) this.appendLog(kind, residual)
    }
    if (this.closing || this.stopRequested) {
      this.state = 'inactive'
      this.retryCount = 0
      this.stableSince = undefined
      this.nextRetryAt = undefined
      return
    }
    const reason =
      this.pendingFailure ??
      `后端非预期退出（退出码 ${code === null ? '未知' : code}，信号 ${signal ?? '无'}）`
    this.pendingFailure = undefined
    this.lastError = reason
    this.stableSince = undefined
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.closing || this.stopRequested || this.control.stopping()) { this.state = 'inactive'; return }
    if (this.retryCount >= this.maxRetries) {
      this.state = 'failed'
      this.nextRetryAt = undefined
      this.lastError = `${this.lastError ?? '后端异常退出'}（已用完 ${this.maxRetries} 次自动重试）`
      return
    }
    this.retryCount += 1
    const delay = this.retryDelaysMs[this.retryCount - 1]!
    this.state = 'retrying'
    this.nextRetryAt = this.now() + delay
    const timer = setTimeout(() => {
      this.retryTimer = undefined
      this.nextRetryAt = undefined
      if (!this.closing && !this.stopRequested && !this.control.stopping()) void this.attemptStart().catch(() => {})
    }, delay)
    timer.unref()
    this.retryTimer = timer
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private clearStable(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = undefined
  }

  private clearReadiness(): void {
    if (this.readinessTimer) clearTimeout(this.readinessTimer)
    if (this.readinessDeadline) clearTimeout(this.readinessDeadline)
    this.readinessTimer = undefined
    this.readinessDeadline = undefined
  }
}

/** 日志脱敏：token / 密码 / 密钥与 Bearer 凭据一律替换为 ***。 */
export function redactSecrets(line: string): string {
  return line
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
    .replace(/(\bauthorization\b\s*[:=]\s*).*/gi, '$1***')
    .replace(
      /(\b(?:token|secret|password|passwd|api[_-]?key|access[_-]?key)\b\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
      '$1***',
    )
}

const CLOCK_TICKS_PER_SECOND = 100

async function readProcessResources(
  pid: number | null,
  startedAt: number | undefined,
  nowMs: number,
  previous: { at: number; ticks: number } | undefined,
): Promise<{
  value: BackendProcessResources
  sample: { at: number; ticks: number } | undefined
}> {
  const value: BackendProcessResources = {
    pid,
    uptimeSeconds: pid === null || startedAt === undefined ? 0 : Math.max(0, (nowMs - startedAt) / 1000),
    cpuPercent: null,
    memoryBytes: null,
  }
  if (pid === null) return { value, sample: previous }
  let sample: { at: number; ticks: number } | undefined = previous
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const ticks = Number(tail[11]) + Number(tail[12])
    if (Number.isFinite(ticks)) {
      if (previous && nowMs > previous.at) {
        const cpuSeconds = Math.max(0, ticks - previous.ticks) / CLOCK_TICKS_PER_SECOND
        const wallSeconds = (nowMs - previous.at) / 1000
        value.cpuPercent = Math.round((cpuSeconds / wallSeconds) * 10000) / 100
      }
      sample = { at: nowMs, ticks }
    }
  } catch {
    // 进程已退出或非 Linux：保留空值，不影响状态读取。
  }
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
    if (match) value.memoryBytes = Number(match[1]) * 1024
  } catch {
    // 同上。
  }
  return { value, sample }
}
