import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ObservationEnvelope, SenseCheckpoint, SenseResult } from './senseCreator.js'

export type ReplayPolicy = 'observation' | 'side_effect'
export type RecoveryReason =
  | 'missing'
  | 'expired'
  | 'corrupt'
  | 'incomplete_checkpoint'
  | 'side_effect_not_replayable'
  | 'capacity_rejected'

export interface DurableSenseRecord {
  version: 1
  key: string
  operationId: string
  operationClass: string
  replayPolicy: ReplayPolicy
  checkpoint: SenseCheckpoint
  result: SenseResult
  observation?: ObservationEnvelope
  source?: string
  savedAt: number
  expiresAt: number
}

export interface DurableSenseStoreOptions {
  filePath: string
  ttlMs: number
  maxEntries: number
  maxBytes: number
  now?: () => number
}

export type SenseReplay =
  | { status: 'replayed'; result: SenseResult; source?: string }
  | { status: 'recovery_required'; reason: RecoveryReason }

function clone<T>(value: T): T {
  return structuredClone(value)
}

function validRecord(value: unknown): value is DurableSenseRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<DurableSenseRecord>
  return (
    record.version === 1 &&
    typeof record.key === 'string' &&
    typeof record.operationId === 'string' &&
    typeof record.operationClass === 'string' &&
    (record.replayPolicy === 'observation' || record.replayPolicy === 'side_effect') &&
    !!record.checkpoint &&
    typeof record.checkpoint === 'object' &&
    typeof record.result === 'object' &&
    record.result !== null &&
    typeof record.savedAt === 'number' &&
    typeof record.expiresAt === 'number'
  )
}

/**
 * Small durable boundary for Sense recovery. It is deliberately separate from
 * WebSearchRuntime's process-local cache: only completed records are persisted.
 */
export class DurableSenseStore {
  private readonly records = new Map<string, DurableSenseRecord>()
  private readonly now: () => number
  private corrupt = false

  constructor(private readonly options: DurableSenseStoreOptions) {
    if (!options.filePath) throw new Error('filePath is required')
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
      throw new Error('ttlMs must be positive')
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)
      throw new Error('maxEntries must be positive')
    if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1)
      throw new Error('maxBytes must be positive')
    this.now = options.now ?? Date.now
    this.load()
  }

  save(record: Omit<DurableSenseRecord, 'version' | 'savedAt' | 'expiresAt'>): boolean {
    if (record.replayPolicy === 'side_effect') return false
    if (!this.isComplete(record.checkpoint)) return false
    const now = this.now()
    const next: DurableSenseRecord = {
      ...clone(record),
      version: 1,
      savedAt: now,
      expiresAt: now + this.options.ttlMs,
    }
    if (this.bytes(next) > this.options.maxBytes) return false
    this.records.set(next.key, next)
    this.evict()
    this.flush()
    return this.records.has(next.key)
  }

  replay(key: string, replayPolicy: ReplayPolicy = 'observation'): SenseReplay {
    if (this.corrupt) return { status: 'recovery_required', reason: 'corrupt' }
    if (replayPolicy === 'side_effect')
      return { status: 'recovery_required', reason: 'side_effect_not_replayable' }
    const record = this.records.get(key)
    if (!record) return { status: 'recovery_required', reason: 'missing' }
    if (record.expiresAt <= this.now()) {
      this.records.delete(key)
      this.flush()
      return { status: 'recovery_required', reason: 'expired' }
    }
    if (record.replayPolicy === 'side_effect')
      return { status: 'recovery_required', reason: 'side_effect_not_replayable' }
    if (!this.isComplete(record.checkpoint))
      return { status: 'recovery_required', reason: 'incomplete_checkpoint' }
    return {
      status: 'replayed',
      result: clone(record.result),
      ...(record.source ? { source: record.source } : {}),
    }
  }

  get size(): number {
    return this.records.size
  }

  private load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.options.filePath, 'utf8'))
      if (!Array.isArray(parsed)) return
      for (const value of parsed) {
        if (validRecord(value)) this.records.set(value.key, value)
      }
      this.evict()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.corrupt = true
      // Missing or torn files fail closed; a new operation may still proceed.
      this.records.clear()
    }
  }

  private flush(): void {
    mkdirSync(dirname(this.options.filePath), { recursive: true })
    const temp = `${this.options.filePath}.tmp`
    writeFileSync(temp, JSON.stringify([...this.records.values()]), 'utf8')
    renameSync(temp, this.options.filePath)
  }

  private bytes(record: DurableSenseRecord): number {
    return Buffer.byteLength(JSON.stringify(record), 'utf8')
  }

  private evict(): void {
    for (const [key, record] of this.records) {
      if (record.expiresAt <= this.now()) this.records.delete(key)
    }
    while (
      this.records.size > this.options.maxEntries ||
      this.totalBytes() > this.options.maxBytes
    ) {
      const oldest = [...this.records.values()].sort((a, b) => a.savedAt - b.savedAt)[0]
      if (!oldest) break
      this.records.delete(oldest.key)
    }
  }

  private totalBytes(): number {
    return [...this.records.values()].reduce((total, record) => total + this.bytes(record), 0)
  }

  private isComplete(checkpoint: SenseCheckpoint): boolean {
    return (
      checkpoint.version === 1 &&
      checkpoint.detached === false &&
      !!checkpoint.operationId &&
      !!checkpoint.senseCallId &&
      ['completed', 'rejected'].includes(checkpoint.status) &&
      Number.isFinite(checkpoint.completedAt)
    )
  }
}
