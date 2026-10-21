import {
  BACKEND_FORCE_GRACE_MS,
  type BackendStopBlocker,
  type BackendStopSnapshot,
} from '@chery/protocol'

interface StopCoordinatorOptions {
  backendInstanceId: string
  /** These two callbacks must be synchronous: input adoption shares the same JS turn. */
  parkInputs(operationId: string): number
  restoreInputs(operationId: string): void
  blockers(): BackendStopBlocker[]
  close(state: BackendStopSnapshot): void | Promise<void>
  force(state: BackendStopSnapshot): void | Promise<void>
  now?: () => number
}

export class BackendStopConflict extends Error {
  readonly code = 'STOP_OPERATION_CONFLICT'
}

/** Worker-side admission and reversible wait. The parent process owns the hard deadline. */
export class BackendStopCoordinator {
  private state: BackendStopSnapshot
  private readonly listeners = new Set<(state: BackendStopSnapshot) => void>()
  private readonly retiredOperations = new Set<string>()
  private poll: ReturnType<typeof setInterval> | undefined
  private readonly now: () => number

  constructor(private readonly options: StopCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.state = {
      backendInstanceId: options.backendInstanceId,
      operationId: null,
      version: 0,
      phase: 'running',
      desiredState: 'running',
      canCancel: false,
      connection: 'connected',
      requestedAt: null,
      forceDeadlineAt: null,
      blockers: [],
      parkedInputCount: 0,
      unknownExternalOperations: [],
      error: null,
    }
  }

  snapshot(): BackendStopSnapshot {
    return structuredClone(this.state)
  }

  subscribe(listener: (state: BackendStopSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Existing-work capability must be established by the caller, never a browser boolean. */
  assertAdmission(existingWork = false): void {
    if (this.state.phase === 'running') return
    if (existingWork && ['requesting', 'draining'].includes(this.state.phase)) return
    throw Object.assign(new Error('服务正在关闭，不能开始新任务'), { code: 'BACKEND_STOPPING' })
  }

  canConsumeInput(): boolean {
    return this.state.phase === 'running'
  }

  request(operationId: string): BackendStopSnapshot {
    if (this.state.phase !== 'running') {
      this.assertOperation(operationId)
      return this.snapshot()
    }
    // A retried request for an already-cancelled operation cannot start it again.
    if (this.state.operationId === operationId) return this.snapshot()
    if (this.retiredOperations.has(operationId)) throw new BackendStopConflict('该关闭操作已经结束')
    if (this.state.operationId) this.retiredOperations.add(this.state.operationId)
    // Close admission before any callback can inspect or mutate a queued input.
    this.update({ operationId, phase: 'requesting', desiredState: 'stopped', requestedAt: this.now(), error: null })
    if (this.snapshot().phase !== 'requesting') return this.snapshot()
    try {
      const parkedInputCount = this.options.parkInputs(operationId)
      if (this.snapshot().phase !== 'requesting') return this.snapshot()
      this.update({ phase: 'draining', canCancel: this.state.connection === 'connected', parkedInputCount })
      if (this.snapshot().phase !== 'draining') return this.snapshot()
      this.poll = setInterval(() => this.refresh(), 250)
      this.poll.unref()
      this.refresh()
    } catch (error) {
      // A partial park is not a reason to reopen admission or to kill the worker.
      if (this.snapshot().phase !== 'requesting') return this.snapshot()
      this.update({ phase: 'draining', canCancel: this.state.connection === 'connected', error: this.errorText(error) })
    }
    return this.snapshot()
  }

  cancel(operationId: string): BackendStopSnapshot {
    this.assertOperation(operationId)
    if (!this.state.canCancel || this.state.phase !== 'draining' || this.state.connection === 'lost') {
      throw new BackendStopConflict('已开始实际关闭，不能取消')
    }
    try {
      this.options.restoreInputs(operationId)
    } catch (error) {
      this.update({ error: this.errorText(error) })
      throw error
    }
    if (this.snapshot().phase !== 'draining') throw new BackendStopConflict('已开始实际关闭，不能取消')
    this.clearPoll()
    this.update({
      phase: 'running', desiredState: 'running', canCancel: false,
      blockers: [], parkedInputCount: 0, error: null,
    })
    return this.snapshot()
  }

  force(operationId: string, deadlineAt = this.now() + BACKEND_FORCE_GRACE_MS): BackendStopSnapshot {
    if (this.state.phase === 'stopped') return this.snapshot()
    if (this.state.phase !== 'running') this.assertOperation(operationId)
    if (this.state.phase === 'force_stopping') {
      // Retries and later signals must never extend the already-authorized deadline.
      if (deadlineAt < this.state.forceDeadlineAt!) this.update({ forceDeadlineAt: deadlineAt })
      return this.snapshot()
    }
    this.clearPoll()
    this.update({
      operationId, phase: 'force_stopping', desiredState: 'stopped', canCancel: false,
      requestedAt: this.state.requestedAt ?? this.now(),
      forceDeadlineAt: Math.min(deadlineAt, this.now() + BACKEND_FORCE_GRACE_MS), error: null,
    })
    try { this.options.parkInputs(operationId) } catch (error) { this.update({ error: this.errorText(error) }) }
    this.invoke(() => this.options.force(this.snapshot()))
    return this.snapshot()
  }

  refresh(): void {
    if (this.state.phase !== 'draining' || this.state.error || this.state.connection === 'lost') return
    try {
      const blockers = this.options.blockers()
      if (JSON.stringify(blockers) !== JSON.stringify(this.state.blockers)) this.update({ blockers })
      // A listener may have cancelled or forced while processing the preceding update.
      const current = this.snapshot()
      if (current.phase !== 'draining' || blockers.length || current.error || current.connection === 'lost') return
      this.clearPoll()
      this.update({ phase: 'closing', canCancel: false })
      this.invoke(() => this.options.close(this.snapshot()))
    } catch (error) {
      this.update({ error: this.errorText(error) })
    }
  }

  setConnection(connected: boolean): void {
    this.update({ connection: connected ? 'connected' : 'lost', canCancel: connected && this.state.phase === 'draining' })
    if (connected) this.refresh()
  }

  recordUnknown(id: string, description: string): void {
    if (this.state.unknownExternalOperations.some((entry) => entry.id === id)) return
    this.update({ unknownExternalOperations: [...this.state.unknownExternalOperations, { id, description }] })
  }

  replaceUnknown(operations: BackendStopSnapshot['unknownExternalOperations']): void {
    if (JSON.stringify(operations) !== JSON.stringify(this.state.unknownExternalOperations))
      this.update({ unknownExternalOperations: operations })
  }

  dispose(): void {
    this.clearPoll()
    this.listeners.clear()
  }

  private assertOperation(operationId: string): void {
    if (operationId !== this.state.operationId) throw new BackendStopConflict('关闭操作已变化，请重新读取状态')
  }

  private update(patch: Partial<BackendStopSnapshot>): void {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 }
    for (const listener of this.listeners) {
      try { listener(this.snapshot()) } catch { /* A failed status sink cannot reopen admission. */ }
    }
  }

  private invoke(action: () => void | Promise<void>): void {
    try {
      const result = action()
      void Promise.resolve(result).catch((error: unknown) => this.update({ error: this.errorText(error) }))
    } catch (error) {
      this.update({ error: this.errorText(error) })
    }
  }

  private errorText(error: unknown): string {
    return (error instanceof Error ? error.message : '关闭处理失败').slice(0, 2000)
  }

  private clearPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = undefined
  }
}
