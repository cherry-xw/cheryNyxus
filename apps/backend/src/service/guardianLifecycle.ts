import { spawn, type ChildProcess, type Serializable } from 'node:child_process'
import {
  BACKEND_FORCE_GRACE_MS,
  BackendLifecycleRequestSchema,
  BackendLifecycleEventSchema,
  BackendProcessEventSchema,
  BackendManagedTaskEventSchema,
  type BackendStopSnapshot,
  type BackendProcessEvent,
  type BackendManagedTaskEvent,
} from '@chery/protocol'

interface Options {
  publish(message: unknown): void
  complete(state: BackendStopSnapshot): void
  now?: () => number
  cleanupManaged?(entry: BackendManagedTaskEvent): Promise<boolean>
}

/** Parent enforcement stays responsive even when the business worker's JS thread is blocked. */
export class GuardianLifecycle {
  private worker: ChildProcess | undefined
  private state: BackendStopSnapshot
  private readonly now: () => number
  private workerVersion = -1
  private deadline: ReturnType<typeof setTimeout> | undefined
  private cleanupPoll: ReturnType<typeof setInterval> | undefined
  private readonly processes = new Map<number, BackendProcessEvent>()
  private readonly managed = new Map<string, BackendManagedTaskEvent>()
  private readonly checkingManaged = new Set<string>()
  private workerExited = false
  private completed = false

  constructor(instanceId: string, private readonly options: Options) {
    this.now = options.now ?? Date.now
    this.state = this.initial(instanceId)
  }

  snapshot(): BackendStopSnapshot { return structuredClone(this.state) }
  isStopping(): boolean { return this.state.desiredState === 'stopped' }

  attach(child: ChildProcess, instanceId: string): void {
    if (this.isStopping()) throw new Error('关闭期间不能重新启动 worker')
    this.worker = child
    this.workerExited = false
    this.workerVersion = -1
    this.state = { ...this.initial(instanceId), version: this.state.version + 1 }
    this.publish()
    if (child.pid) this.processEvent({ type: 'backend-process', backendInstanceId: instanceId,
      kind: 'worker', action: 'register', pid: child.pid })
  }

  receive(message: unknown): boolean {
    const parsed = BackendLifecycleRequestSchema.safeParse(message)
    if (!parsed.success) return false
    const request = parsed.data
    if (request.backendInstanceId !== this.state.backendInstanceId) { this.publish(); return true }
    if (request.type === 'stop-query') { this.publish(); this.forward(request); return true }
    if (request.type === 'stop-drain') {
      if (this.isStopping()) { this.publish(); return true }
      // Cancel retries for the same operation must not replay a completed stop.
      if (request.operationId === this.state.operationId) { this.publish(); return true }
      this.patch({ phase: 'requesting', desiredState: 'stopped', operationId: request.operationId,
        requestedAt: this.now(), canCancel: false, error: null })
      if (!this.worker) {
        this.workerExited = true
        this.patch({ phase: 'closing', canCancel: false })
        for (const entry of this.processes.values()) this.signal(entry.pid, false)
        this.cleanup()
        if (!this.completed) {
          this.cleanupPoll = setInterval(() => this.cleanup(), 100)
          this.cleanupPoll.unref()
        }
      }
      else this.forward(request)
      return true
    }
    if (request.type === 'stop-cancel') {
      if (request.operationId === this.state.operationId && this.state.canCancel && this.state.phase === 'draining') this.forward(request)
      else this.publish()
      return true
    }
    if (request.operationId !== this.state.operationId && this.isStopping()) { this.publish(); return true }
    this.force(request.operationId, request.deadlineAt)
    return true
  }

  receiveWorker(child: ChildProcess, message: unknown): boolean {
    if (child !== this.worker) return false
    const managed = BackendManagedTaskEventSchema.safeParse(message)
    if (managed.success) {
      const entry = managed.data
      if (entry.backendInstanceId !== this.state.backendInstanceId) return true
      if (entry.action === 'register') this.managed.set(entry.commandId, entry)
      else this.managed.delete(entry.commandId)
      this.options.publish(entry)
      return true
    }
    const process = BackendProcessEventSchema.safeParse(message)
    if (process.success) {
      if (process.data.backendInstanceId === this.state.backendInstanceId && process.data.kind === 'command') this.processEvent(process.data)
      return true
    }
    const parsed = BackendLifecycleEventSchema.safeParse(message)
    if (!parsed.success) return false
    const received = parsed.data.state
    if (received.backendInstanceId !== this.state.backendInstanceId || received.version <= this.workerVersion) return true
    this.workerVersion = received.version
    if (received.phase === 'stopped') return true
    if (this.state.phase === 'force_stopping' && received.phase !== 'force_stopping') return true
    if (this.isStopping() && received.operationId !== this.state.operationId) return true
    const forceDeadlineAt = this.state.forceDeadlineAt === null ? received.forceDeadlineAt
      : Math.min(this.state.forceDeadlineAt, received.forceDeadlineAt ?? this.state.forceDeadlineAt)
    this.patch({ ...received, forceDeadlineAt, version: this.state.version + 1 })
    if (received.phase === 'force_stopping') this.armDeadline()
    return true
  }

  disconnected(child?: ChildProcess): void {
    if (child && child !== this.worker) return
    this.patch({ connection: 'lost', canCancel: false })
    // Losing a pipe is neither a stop request nor permission to kill or restart.
  }

  externalStop(operationId: string): void {
    this.force(this.state.operationId ?? operationId, this.now() + BACKEND_FORCE_GRACE_MS)
  }

  exited(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): boolean {
    if (child !== this.worker) return false
    this.worker = undefined
    this.workerExited = true
    if (child.pid) this.processEvent({ type: 'backend-process', backendInstanceId: this.state.backendInstanceId,
      kind: 'worker', action: 'release', pid: child.pid })
    if (!this.isStopping()) return false
    const unknown = new Map(this.state.unknownExternalOperations.map(entry => [entry.id, entry]))
    for (const blocker of this.state.blockers) if (blocker.kind === 'external') unknown.set(blocker.id,
      { id: blocker.id, description: `${blocker.description}；worker 已退出，外部结果未确认` })
    this.patch({ unknownExternalOperations: [...unknown.values()] })
    if (this.state.phase === 'draining' || this.state.phase === 'requesting') {
      this.patch({ phase: 'closing', canCancel: false,
        error: `等待关闭期间 worker 已退出（退出码 ${code ?? '未知'}，信号 ${signal ?? '无'}）` })
    }
    for (const process of this.processes.values()) this.signal(process.pid, false)
    this.cleanup()
    if (!this.completed) {
      this.cleanupPoll = setInterval(() => this.cleanup(), 100)
      this.cleanupPoll.unref()
    }
    return true
  }

  private force(operationId: string, deadlineAt: number): void {
    if (this.completed) return
    const end = Math.min(this.state.forceDeadlineAt ?? Infinity, deadlineAt, this.now() + BACKEND_FORCE_GRACE_MS)
    this.patch({ operationId, desiredState: 'stopped', phase: 'force_stopping', canCancel: false,
      requestedAt: this.state.requestedAt ?? this.now(), forceDeadlineAt: end })
    this.armDeadline()
    this.forward({ type: 'stop-force', backendInstanceId: this.state.backendInstanceId, operationId, deadlineAt: end })
    for (const process of this.processes.values()) if (process.kind === 'command') this.signal(process.pid, false)
    this.cleanupManaged()
    if (!this.worker) { this.workerExited = true; this.cleanup() }
  }

  private armDeadline(): void {
    clearTimeout(this.deadline)
    if (this.state.forceDeadlineAt === null) return
    this.deadline = setTimeout(() => {
      for (const process of this.processes.values()) this.signal(process.pid, true)
      // Completion still waits for the owned worker's actual exit event.
      if (this.workerExited) this.cleanup(true)
    }, Math.max(0, this.state.forceDeadlineAt - this.now()))
    this.deadline.unref()
  }

  private cleanup(deadline = this.state.forceDeadlineAt !== null && this.now() >= this.state.forceDeadlineAt): void {
    this.cleanupManaged()
    for (const [pid, process] of this.processes) {
      if (!this.alive(pid)) this.processEvent({ ...process, action: 'release' })
      else if (deadline) this.signal(pid, true)
    }
    if (!this.workerExited || ((this.processes.size || this.managed.size) && !deadline)) return
    if (this.processes.size) {
      this.patch({ unknownExternalOperations: [
        ...this.state.unknownExternalOperations,
        ...[...this.processes.values()].map((entry) => ({ id: entry.commandId ?? `process:${entry.pid}`,
          description: `本地进程组 ${entry.pid} 的全部后代退出尚未确认` })),
      ] })
    }
    if (this.managed.size) this.patch({ unknownExternalOperations: [
      ...this.state.unknownExternalOperations,
      ...[...this.managed.values()].map((entry) => ({ id: entry.commandId, description: `受管命令 ${entry.taskId} 的停止结果未确认` })),
    ] })
    this.finish()
  }

  private cleanupManaged(): void {
    for (const [id, entry] of this.managed) {
      if (this.checkingManaged.has(id) || !this.options.cleanupManaged) continue
      this.checkingManaged.add(id)
      void this.options.cleanupManaged(entry).then((ended) => {
        if (!ended || this.managed.get(id) !== entry) return
        this.managed.delete(id)
        this.options.publish({ ...entry, action: 'release' })
      }).catch(() => { /* Unknown is retained until deadline, separately from local exit. */ })
        .finally(() => this.checkingManaged.delete(id))
    }
  }

  private processEvent(event: BackendProcessEvent): void {
    if (event.action === 'register') this.processes.set(event.pid, event)
    else {
      const registered = this.processes.get(event.pid)
      if (registered && registered.commandId !== event.commandId) return
      // A shell closing is not proof that its process group has disappeared.
      if (registered?.kind === 'command' && this.alive(event.pid)) return
      this.processes.delete(event.pid)
    }
    this.options.publish(event)
  }

  private alive(pid: number): boolean {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }

  private signal(pid: number, force: boolean): void {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => this.patch({ error: `无法清理进程树 ${pid}` }))
    } else {
      try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.patch({ error: `无法清理进程组 ${pid}` }) }
    }
  }

  private forward(message: unknown): void {
    const child = this.worker
    if (!child?.connected) { if (child) this.disconnected(child); return }
    try { child.send(message as Serializable, (error) => { if (error) this.disconnected(child) }) }
    catch { this.disconnected(child) }
  }

  private finish(): void {
    if (this.completed) return
    this.completed = true
    clearTimeout(this.deadline)
    clearInterval(this.cleanupPoll)
    this.patch({ phase: 'stopped', canCancel: false, connection: 'lost', blockers: [] })
    this.options.complete(this.snapshot())
  }

  private patch(patch: Partial<BackendStopSnapshot>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 }
    this.publish()
  }

  private publish(): void { this.options.publish({ type: 'stop-state', state: this.snapshot() }) }

  private initial(backendInstanceId: string): BackendStopSnapshot {
    return { backendInstanceId, operationId: null, version: 0, phase: 'running', desiredState: 'running',
      canCancel: false, connection: 'connected', requestedAt: null, forceDeadlineAt: null,
      blockers: [], parkedInputCount: 0, unknownExternalOperations: [], error: null }
  }
}
