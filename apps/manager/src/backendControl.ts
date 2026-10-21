import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  BACKEND_FORCE_GRACE_MS,
  BackendLifecycleEventSchema,
  BackendProcessEventSchema,
  BackendManagedTaskEventSchema,
  type BackendManagedTaskEvent,
  type BackendProcessEvent,
  type BackendLifecycleRequest,
  type BackendStopSnapshot,
} from '@chery/protocol'
import type { BackendIntent, BackendIntentStore } from './backendIntent.js'
import { cleanupManagedTask } from './managedTaskCleanup.js'

export class BackendControlConflict extends Error {
  readonly code = 'STOP_OPERATION_CONFLICT'
}

interface Options {
  child(): ChildProcess | undefined
  intent?: BackendIntentStore
  stopAdmission(): void
  resumeAdmission(): void
  now(): number
  cleanupManaged?(task: BackendManagedTaskEvent): Promise<boolean>
}

/** Manager-side intent and IPC. A control timeout never authorizes a process kill. */
export class BackendControl {
  private intent: BackendIntent = { schemaVersion: 1, revision: 0, desiredState: 'running', pluginEnabled: true, operationId: null }
  private state: BackendStopSnapshot | null = null
  private observedVersion = -1
  private transitions: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<() => void>()
  private forceTimer: ReturnType<typeof setTimeout> | undefined
  private queryTimer: ReturnType<typeof setInterval> | undefined
  private readonly processes = new Map<number, BackendProcessEvent>()
  private readonly managed = new Map<string, BackendManagedTaskEvent>()
  private readonly checkingManaged = new Set<string>()
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private childExited = false
  private cancellingOperation: string | undefined
  private lastReplyAt = 0

  constructor(private readonly options: Options) {}

  snapshot(): BackendStopSnapshot | null { return this.state ? structuredClone(this.state) : null }

  async readIntent(): Promise<BackendIntent> {
    if (this.options.intent) this.intent = await this.options.intent.read()
    return { ...this.intent }
  }

  async allowStart(): Promise<void> {
    const intent = await this.readIntent()
    if (!intent.pluginEnabled) throw new BackendControlConflict('请先启用 Backend 管理插件')
    if (this.state && !['running', 'stopped'].includes(this.state.phase)) throw new BackendControlConflict('关闭尚未完成，不能重新启动')
    await this.save({ desiredState: 'running', operationId: null })
  }

  beginChild(instanceId: string): void {
    this.clearTimers()
    this.observedVersion = -1
    this.processes.clear()
    this.managed.clear()
    this.checkingManaged.clear()
    this.childExited = false
    this.cancellingOperation = undefined
    this.lastReplyAt = this.options.now()
    this.state = {
      backendInstanceId: instanceId, operationId: null, version: 0, phase: 'running', desiredState: 'running',
      canCancel: false, connection: 'connected', requestedAt: null, forceDeadlineAt: null,
      blockers: [], parkedInputCount: 0, unknownExternalOperations: [], error: null,
    }
    this.queryTimer = setInterval(() => {
      if (this.options.now() - this.lastReplyAt > 6000) this.disconnected()
      this.query()
    }, 2000)
    this.queryTimer.unref()
  }

  stopping(): boolean { return this.intent.desiredState === 'stopped' }

  requestStop(): Promise<BackendStopSnapshot | null> {
    return this.transition(async () => {
      if (this.stopping() && this.state?.operationId) return this.snapshot()
      const operationId = randomUUID()
      // Persist first: an acknowledged stop must survive a Manager restart.
      await this.save({ desiredState: 'stopped', operationId })
      this.options.stopAdmission()
      if (!this.options.child()) {
        if (this.state) {
          this.patch({ operationId, desiredState: 'stopped', canCancel: false })
          this.exited(0, null)
        }
        return this.snapshot()
      }
      this.patch({ operationId, desiredState: 'stopped', phase: 'requesting', requestedAt: this.options.now(), canCancel: false })
      this.sendStop()
      return this.snapshot()
    })
  }

  async cancel(instanceId: string, operationId: string): Promise<BackendStopSnapshot> {
    const waiting = await this.transition(async () => {
      this.assertOperation(instanceId, operationId)
      if (!this.state?.canCancel || this.state.phase !== 'draining' || this.state.connection !== 'connected')
        throw new BackendControlConflict('实际关闭已开始或控制连接失联，不能取消')
      // Do not restore desiredState until the actual worker confirms cancellation.
      const acknowledged = this.waitFor((state) => state.operationId === operationId && state.phase === 'running')
      this.cancellingOperation = operationId
      this.send({ type: 'stop-cancel', backendInstanceId: instanceId, operationId })
      return { acknowledged }
    })
    return waiting.acknowledged
  }

  force(instanceId?: string, operationId?: string): Promise<BackendStopSnapshot | null> {
    return this.transition(async () => {
      if (instanceId && operationId) this.assertOperation(instanceId, operationId)
      const id = this.state?.operationId ?? operationId ?? randomUUID()
      await this.save({ desiredState: 'stopped', operationId: id })
      this.options.stopAdmission()
      const child = this.options.child()
      if (!child && (!this.state || this.state.phase === 'stopped')) return this.snapshot()
      const deadlineAt = this.state?.forceDeadlineAt ?? this.options.now() + BACKEND_FORCE_GRACE_MS
      this.patch({ operationId: id, phase: 'force_stopping', desiredState: 'stopped', canCancel: false,
        requestedAt: this.state?.requestedAt ?? this.options.now(), forceDeadlineAt: deadlineAt })
      this.armDeadline(child, deadlineAt)
      this.sendStop()
      if (!child) this.exited(0, null)
      this.cleanupManaged()
      if (!this.cleanupTimer) {
        this.cleanupTimer = setInterval(() => { this.cleanupManaged(); this.cleanupResiduals() }, 500)
        this.cleanupTimer.unref()
      }
      return this.snapshot()
    })
  }

  /** Only messages received from the currently owned child reach this method. */
  observe(message: unknown): void {
    const managed = BackendManagedTaskEventSchema.safeParse(message)
    if (managed.success) {
      if (managed.data.backendInstanceId !== this.state?.backendInstanceId) return
      if (managed.data.action === 'register') this.managed.set(managed.data.commandId, managed.data)
      else this.managed.delete(managed.data.commandId)
      return
    }
    const process = BackendProcessEventSchema.safeParse(message)
    if (process.success && this.state && process.data.backendInstanceId === this.state.backendInstanceId) {
      if (process.data.action === 'register') this.processes.set(process.data.pid, process.data)
      else {
        const registered = this.processes.get(process.data.pid)
        if (registered?.commandId !== process.data.commandId) return
        if (registered?.kind === 'command' && this.alive(registered.pid)) return
        this.processes.delete(process.data.pid)
      }
      return
    }
    const parsed = BackendLifecycleEventSchema.safeParse(message)
    if (!parsed.success || !this.state) return
    const received = parsed.data.state
    this.lastReplyAt = this.options.now()
    const changedInstance = received.backendInstanceId !== this.state.backendInstanceId
    if (!changedInstance && received.version <= this.observedVersion) return
    this.observedVersion = received.version
    if (changedInstance) {
      this.state.backendInstanceId = received.backendInstanceId
      // The worker was replaced inside guardian; do not mistake old cancellation for a new confirmation.
      this.cancellingOperation = undefined
    }
    if (this.stopping() && received.phase === 'running') {
      if (received.operationId !== this.state.operationId || received.operationId !== this.cancellingOperation) { this.sendStop(); return }
      // A matching operation in running is an explicit cancel acknowledgement.
      void this.transition(async () => {
        if (this.state?.phase === 'force_stopping' || !this.options.child()) return
        await this.save({ desiredState: 'running', operationId: received.operationId })
        this.state = { ...received, version: this.state!.version + 1, canCancel: false }
        this.cancellingOperation = undefined
        this.options.resumeAdmission()
        this.publish()
      }).catch((error: unknown) => {
        // Worker resumed but persistence failed: close admission again, without pretending cancellation succeeded.
        this.cancellingOperation = undefined
        this.patch({ operationId: randomUUID(), phase: 'requesting', canCancel: false, error: (error as Error).message })
        this.sendStop()
      })
      return
    }
    if (this.stopping() && received.operationId !== this.state.operationId) return
    // Only the ChildProcess exit event can report Backend stopped.
    if (received.phase === 'stopped') {
      this.patch({ unknownExternalOperations: received.unknownExternalOperations, error: received.error ?? this.state.error })
      return
    }
    if (this.state.phase === 'force_stopping' && received.phase !== 'force_stopping') return
    const forceDeadlineAt = this.state.forceDeadlineAt === null ? received.forceDeadlineAt
      : Math.min(this.state.forceDeadlineAt, received.forceDeadlineAt ?? this.state.forceDeadlineAt)
    this.state = { ...received, forceDeadlineAt, version: this.state.version + 1 }
    if (received.desiredState === 'stopped') {
      this.options.stopAdmission()
      void this.transition(() => this.save({ desiredState: 'stopped', operationId: received.operationId }))
        .catch((error: unknown) => this.patch({ error: `停止意图未能保存：${(error as Error).message}` }))
    }
    if (forceDeadlineAt !== null && this.options.child()) this.armDeadline(this.options.child()!, forceDeadlineAt)
    this.publish()
  }

  disconnected(): void { this.patch({ connection: 'lost', canCancel: false }) }

  exited(code: number | null, signal: NodeJS.Signals | null): void {
    clearInterval(this.queryTimer)
    this.childExited = true
    if (this.state && (this.stopping() || this.state.desiredState === 'stopped')) {
      const unknown = new Map(this.state.unknownExternalOperations.map(entry => [entry.id, entry]))
      for (const blocker of this.state.blockers) if (blocker.kind === 'external') unknown.set(blocker.id,
        { id: blocker.id, description: `${blocker.description}；Backend 已退出，外部结果未确认` })
      this.patch({ phase: 'closing', connection: 'lost', canCancel: false, blockers: [],
        unknownExternalOperations: [...unknown.values()],
        error: this.state.error ?? (code === 0 ? null : `Backend 已退出（退出码 ${code ?? '未知'}，信号 ${signal ?? '无'}）`) })
      for (const entry of this.processes.values()) if (entry.kind === 'command') this.signal(entry.pid, false)
      this.cleanupResiduals()
      if (this.state.phase !== 'stopped') {
        clearInterval(this.cleanupTimer)
        this.cleanupTimer = setInterval(() => this.cleanupResiduals(), 500)
        this.cleanupTimer.unref()
      }
    }
  }

  async setPluginEnabled(enabled: boolean): Promise<BackendIntent> {
    return this.transition(async () => {
      if (!enabled && (this.options.child() || this.state && this.state.phase !== 'stopped')) throw new BackendControlConflict('必须确认 Backend 已停止后才能停用插件')
      return this.save({ pluginEnabled: enabled })
    })
  }

  waitForExit(): Promise<void> {
    if (this.state && this.stopping() && this.state.phase !== 'stopped') return new Promise(resolve => {
      const finish = () => {
        if (this.state?.phase !== 'stopped' && this.stopping()) return
        this.listeners.delete(finish)
        resolve()
      }
      this.listeners.add(finish)
      finish()
    })
    const child = this.options.child()
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
    return new Promise((resolve) => child.once('exit', () => resolve()))
  }

  private query(): void {
    if (this.state) this.send({ type: 'stop-query', backendInstanceId: this.state.backendInstanceId })
  }

  private sendStop(): void {
    if (!this.state?.operationId) return
    this.send(this.state.forceDeadlineAt !== null
      ? { type: 'stop-force', backendInstanceId: this.state.backendInstanceId, operationId: this.state.operationId, deadlineAt: this.state.forceDeadlineAt }
      : { type: 'stop-drain', backendInstanceId: this.state.backendInstanceId, operationId: this.state.operationId })
  }

  private send(message: BackendLifecycleRequest): void {
    const child = this.options.child()
    if (!child?.connected) { this.disconnected(); return }
    try { child.send(message, (error) => { if (error && child === this.options.child()) this.disconnected() }) }
    catch { this.disconnected() }
  }

  private assertOperation(instanceId: string, operationId: string): void {
    if (!this.state || this.state.backendInstanceId !== instanceId || this.state.operationId !== operationId)
      throw new BackendControlConflict('关闭操作已变化，请重新读取状态')
  }

  private waitFor(accept: (state: BackendStopSnapshot) => boolean): Promise<BackendStopSnapshot> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        if (!this.state || !accept(this.state)) return
        clearTimeout(timer)
        this.listeners.delete(finish)
        resolve(this.snapshot()!)
      }
      const timer = setTimeout(() => {
        this.listeners.delete(finish)
        reject(new BackendControlConflict('取消关闭未获确认；停止意图保持不变，请重新查询状态'))
      }, 5000)
      timer.unref()
      this.listeners.add(finish)
      finish()
    })
  }

  private armDeadline(child: ChildProcess | undefined, deadlineAt: number): void {
    if (this.forceTimer) clearTimeout(this.forceTimer)
    this.forceTimer = setTimeout(() => {
      this.cleanupManaged()
      for (const entry of this.processes.values()) this.signal(entry.pid, true)
      if (!child || child !== this.options.child() || child.exitCode !== null || child.signalCode !== null) {
        if (this.childExited) this.cleanupResiduals()
        return
      }
      // This is a fallback if guardian itself is blocked. SIGKILL is not an exit acknowledgement.
      if (process.platform === 'win32') {
        void import('node:child_process').then(({ spawn }) => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => this.patch({ error: '无法执行 Backend 进程清理' }))
        })
      } else {
        for (const entry of this.processes.values()) {
          try { process.kill(-entry.pid, 'SIGKILL') } catch { /* Guardian also keeps the same parent-layer registrations. */ }
        }
        try { if (child.pid) process.kill(-child.pid, 'SIGKILL') }
        catch { try { child.kill('SIGKILL') } catch { this.patch({ error: '无法执行 Backend 进程清理' }) } }
      }
    }, Math.max(0, deadlineAt - this.options.now()))
    this.forceTimer.unref()
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

  private cleanupManaged(): void {
    for (const [id, entry] of this.managed) {
      if (this.checkingManaged.has(id)) continue
      this.checkingManaged.add(id)
      void (this.options.cleanupManaged ?? cleanupManagedTask)(entry).then(ended => {
        if (ended && this.managed.get(id) === entry) this.managed.delete(id)
      }).catch(() => { /* Query failure and cancel ACK never establish termination. */ })
        .finally(() => this.checkingManaged.delete(id))
    }
  }

  private cleanupResiduals(): void {
    if (!this.childExited || !this.state) return
    const deadline = this.state.forceDeadlineAt !== null && this.options.now() >= this.state.forceDeadlineAt
    for (const [pid] of this.processes) {
      if (!this.alive(pid)) this.processes.delete(pid)
      else if (deadline) this.signal(pid, true)
    }
    this.cleanupManaged()
    // Guardian exiting alone cannot certify that its worker has exited.
    if ([...this.processes.values()].some(entry => entry.kind === 'worker')) return
    if ((this.processes.size || this.managed.size) && !deadline) return
    const unknown = new Map(this.state.unknownExternalOperations.map(item => [item.id, item]))
    for (const entry of this.processes.values()) unknown.set(entry.commandId ?? `process:${entry.pid}`,
      { id: entry.commandId ?? `process:${entry.pid}`, description: `进程组 ${entry.pid} 的全部后代退出未确认` })
    for (const entry of this.managed.values()) unknown.set(entry.commandId,
      { id: entry.commandId, description: `受管命令 ${entry.taskId} 的停止结果未确认` })
    clearInterval(this.cleanupTimer)
    clearTimeout(this.forceTimer)
    this.patch({ phase: 'stopped', connection: 'lost', canCancel: false, blockers: [], unknownExternalOperations: [...unknown.values()] })
  }

  private patch(patch: Partial<BackendStopSnapshot>): void {
    if (this.state) this.state = { ...this.state, ...patch, version: this.state.version + 1 }
    this.publish()
  }

  private publish(): void { for (const listener of this.listeners) listener() }

  private async save(patch: Partial<Pick<BackendIntent, 'desiredState' | 'pluginEnabled' | 'operationId'>>): Promise<BackendIntent> {
    this.intent = this.options.intent ? await this.options.intent.save(patch) : { ...this.intent, ...patch, revision: this.intent.revision + 1 }
    return { ...this.intent }
  }

  private transition<T>(action: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(action, action)
    this.transitions = result.catch(() => {})
    return result
  }

  private clearTimers(): void {
    clearTimeout(this.forceTimer)
    clearInterval(this.queryTimer)
    clearInterval(this.cleanupTimer)
    this.forceTimer = undefined
    this.queryTimer = undefined
  }
}
