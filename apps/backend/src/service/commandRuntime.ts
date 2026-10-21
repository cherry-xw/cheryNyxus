import { randomUUID } from 'node:crypto'
import type {
  AgentCommandRecord,
  AgentCommandStatus,
  BackendStopBlocker,
  CommandLogChunk,
  CommandLogIssue,
} from '@chery/protocol'
import { AgentCommandRepository, isActiveCommandStatus } from '@/db/agentCommands.js'
import { SensitiveLogStream } from '@/utils/sensitiveLogStream.js'
import { CommandLogStore, CommandLogRecorder } from './commandLogs.js'

type Identity = Pick<AgentCommandRecord, 'chatId' | 'rootChatId' | 'runId' | 'toolCallId'>
type CommandInput = Identity & Pick<AgentCommandRecord, 'sourceKind' | 'command' | 'description' | 'workdir'>
type CommandEnd = { status: Exclude<AgentCommandStatus, 'running' | 'background' | 'cancel_requested'>; exitCode?: number | null; signal?: string | null }

export type CommandRuntimeEvent =
  | { type: 'agent.command.updated'; command: AgentCommandRecord }
  | { type: 'agent.command.log.chunk'; chatId: string; chunk: CommandLogChunk }

interface RuntimeOptions {
  backendInstanceId: string
  /** Snapshot of already-approved environment secrets. No log consumer receives unsanitized output. */
  environment: Record<string, string>
  minimumBareSecretLength: number
  storageError?(commandId: string, error: unknown): void
}

/** Owns live cancellation handles, not session authorization. Never expose it as an unguarded RPC. */
export class CommandRuntime {
  private readonly live = new Map<string, RunningCommand>()
  private readonly listeners = new Set<(event: CommandRuntimeEvent) => void>()
  readonly logs: CommandLogStore

  constructor(readonly repository: AgentCommandRepository, readonly options: RuntimeOptions) {
    this.logs = new CommandLogStore(repository)
  }

  start(input: CommandInput, cancel: () => void | Promise<void>): RunningCommand {
    const record: AgentCommandRecord = {
      ...input, commandId: randomUUID(), backendInstanceId: this.options.backendInstanceId,
      executionId: null, status: 'running', exitCode: null, signal: null,
      startedAt: Date.now(), endedAt: null, version: 1, logStatus: 'active', logIssues: [],
      logSequence: 0, totalRawBytes: 0, totalNewlines: 0, storedCompressedBytes: 0,
      logTailUnconfirmed: false, drainSummary: null,
    }
    // Command text and descriptions can themselves contain environment secrets.
    for (const key of ['command', 'description', 'workdir'] as const) {
      if (record[key] === null) continue
      const sanitizer = this.redactor()
      record[key] = Buffer.concat([sanitizer.write(Buffer.from(record[key]!)), sanitizer.end()]).toString('utf8')
    }
    let recorder: CommandLogRecorder | undefined
    try {
      this.repository.create(record)
      recorder = this.logs.recorder(record.commandId,
        (chunk) => this.emit({ type: 'agent.command.log.chunk', chatId: record.chatId, chunk }),
        (issue) => this.live.get(record.commandId)?.logIssue(issue),
        () => this.live.get(record.commandId)?.publish())
    } catch (error) {
      record.logStatus = 'write_error'
      record.logIssues = ['write_error']
      this.reportStorageError(record.commandId, error)
      recorder = new CommandLogRecorder(this.logs, record,
        (chunk) => this.emit({ type: 'agent.command.log.chunk', chatId: record.chatId, chunk }),
        (issue) => this.live.get(record.commandId)?.logIssue(issue))
    }
    const handle = new RunningCommand(this, record, cancel, recorder, this.redactor(), this.redactor())
    this.live.set(record.commandId, handle)
    this.emit({ type: 'agent.command.updated', command: handle.snapshot() })
    return handle
  }

  get(commandId: string): AgentCommandRecord | undefined {
    return this.live.get(commandId)?.snapshot() ?? this.repository.get(commandId)
  }

  async cancel(commandId: string): Promise<boolean> {
    const handle = this.live.get(commandId)
    if (!handle) return false
    await handle.requestCancel()
    return true
  }

  liveRecords(): AgentCommandRecord[] { return [...this.live.values()].map((handle) => handle.snapshot()) }

  blockers(): BackendStopBlocker[] {
    return [...this.live.values()].map((handle) => {
      const record = handle.snapshot()
      return { id: `command:${record.commandId}`, kind: 'command' as const, commandId: record.commandId,
        chatId: record.chatId, description: record.description || record.command }
    })
  }

  async cancelAll(): Promise<void> {
    // A failed remote cancellation must not prevent requests to the other owners.
    await Promise.allSettled([...this.live.values()].map((handle) => handle.requestCancel()))
  }

  async flush(): Promise<void> {
    // Closing the writer must not invent an exit result for a process still alive.
    await Promise.allSettled([...this.live.values()].map((handle) => handle.flush()))
  }

  async waitForCompletion(): Promise<void> {
    while (this.live.size) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 100)
      timer.unref()
    })
  }

  subscribe(listener: (event: CommandRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: CommandRuntimeEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Viewer failures are not execution failures. */ }
    }
  }

  released(commandId: string): void { this.live.delete(commandId) }

  reportStorageError(commandId: string, error: unknown): void {
    try { this.options.storageError?.(commandId, error) } catch { /* Reporting must not stop the command. */ }
  }

  private redactor(): SensitiveLogStream {
    return new SensitiveLogStream(this.options.environment, this.options.minimumBareSecretLength)
  }
}

export class RunningCommand {
  private closed = false
  private cancelling: Promise<void> | undefined
  private finishing: Promise<void> | undefined
  private readonly logIssues = new Set<CommandLogIssue>()

  constructor(private readonly runtime: CommandRuntime, private record: AgentCommandRecord,
    private readonly cancel: () => void | Promise<void>, private readonly recorder: CommandLogRecorder | undefined,
    private readonly stdout: SensitiveLogStream, private readonly stderr: SensitiveLogStream) {}

  get commandId(): string { return this.record.commandId }

  snapshot(): AgentCommandRecord {
    let stored: AgentCommandRecord | undefined
    try { stored = this.runtime.repository.get(this.commandId) } catch { /* Keep a live view on storage failure. */ }
    const value = { ...this.record, ...(stored ? {
      logStatus: stored.logStatus, logSequence: stored.logSequence, totalRawBytes: stored.totalRawBytes,
      totalNewlines: stored.totalNewlines, storedCompressedBytes: stored.storedCompressedBytes,
      logTailUnconfirmed: stored.logTailUnconfirmed, drainSummary: stored.drainSummary,
      version: Math.max(this.record.version, stored.version),
    } : {}) }
    value.logIssues = [...new Set([...value.logIssues, ...(stored?.logIssues ?? []), ...this.logIssues])]
    if (value.logIssues.includes('write_error')) value.logStatus = 'write_error'
    else if (value.logIssues.length && value.logStatus === 'active') value.logStatus = 'partial_truncated'
    return structuredClone(value)
  }

  started(executionId: string): void {
    if (!this.closed) this.update({ executionId })
  }

  background(): void {
    if (!this.closed && this.record.status === 'running') this.update({ status: 'background' })
  }

  write(stream: 'stdout' | 'stderr', raw: Buffer): void {
    if (this.closed) return
    try { this.recorder?.write(stream, this[stream].write(raw)) }
    catch (error) { this.logIssue('write_error'); this.runtime.reportStorageError(this.commandId, error) }
  }

  logIssue(issue: CommandLogIssue): void {
    if (this.logIssues.has(issue)) return
    this.logIssues.add(issue)
    this.record.version = this.snapshot().version + 1
    this.runtime.emit({ type: 'agent.command.updated', command: this.snapshot() })
  }

  logTransportLost(): void {
    this.recorder?.markIncomplete('transport')
    this.logIssue('transport')
    this.update({ logTailUnconfirmed: true })
  }

  publish(): void { this.runtime.emit({ type: 'agent.command.updated', command: this.snapshot() }) }

  async flush(): Promise<void> { await this.recorder?.finish() }

  requestCancel(): Promise<void> {
    if (this.closed || !isActiveCommandStatus(this.record.status)) return Promise.resolve()
    if (this.cancelling) return this.cancelling
    // Starting with a microtask also coalesces synchronous reentrant cancel requests.
    this.cancelling = Promise.resolve().then(() => { if (!this.closed) return this.cancel() }).catch((error: unknown) => {
      this.cancelling = undefined
      throw error
    })
    this.update({ status: 'cancel_requested' })
    return this.cancelling
  }

  /** Only an executor's actual close/final-state observation may call this, never a cancel ACK. */
  finish(evidence: CommandEnd): Promise<void> {
    if (this.finishing) return this.finishing
    this.closed = true
    for (const stream of ['stdout', 'stderr'] as const) {
      try { this.recorder?.write(stream, this[stream].end()) }
      catch { this.logIssue('write_error') }
    }
    this.finishing = Promise.resolve(this.recorder?.finish()).catch((error: unknown) => {
      this.logIssue('write_error')
      this.runtime.reportStorageError(this.commandId, error)
    }).then(() => {
      this.update({ ...evidence, exitCode: evidence.exitCode ?? null, signal: evidence.signal ?? null, endedAt: Date.now() })
      this.runtime.released(this.commandId)
    })
    return this.finishing
  }

  private update(patch: Partial<AgentCommandRecord>): void {
    const previous = this.snapshot()
    this.record = { ...previous, ...patch, version: previous.version + 1 }
    try {
      this.record = this.runtime.repository.update(this.commandId, (previous) => ({ ...previous, ...this.record }))
    } catch (error) {
      this.logIssues.add('write_error')
      this.runtime.reportStorageError(this.commandId, error)
    }
    this.runtime.emit({ type: 'agent.command.updated', command: this.snapshot() })
  }
}
