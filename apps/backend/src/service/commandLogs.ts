import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import {
  CommandLogChunkSchema,
  type AgentCommandRecord,
  type CommandLogChunk,
  type CommandLogGap,
  type CommandLogIssue,
  type CommandLogPage,
} from '@chery/protocol'
import { AgentCommandRepository, type CommandLogBlockRow } from '@/db/agentCommands.js'
import { StreamingDrain } from '@/utils/drain/index.js'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
export const COMMAND_LOG_BLOCK_BYTES = 64 * 1024
const COMMAND_PENDING_BYTES = 256 * 1024
const TOTAL_PENDING_BYTES = 4 * 1024 * 1024

export const COMMAND_LOG_POLICY = {
  commandBytes: 10 * 1024 * 1024,
  openingRatio: 0.2,
  totalBytes: 200 * 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
} as const

type Policy = { commandBytes: number; openingRatio: number; totalBytes: number; retentionMs: number }
type Progress = Pick<AgentCommandRecord, 'logSequence' | 'totalRawBytes' | 'totalNewlines'>
type Edge = { sequence: number; byte_end: number; line_end: number }

/** Compressed payload quotas, not a promise about SQLite file size or WAL allocation. */
export class CommandLogStore {
  readonly policy: Policy
  private pendingBytes = 0
  private readonly writers = new Set<string>()

  constructor(readonly repository: AgentCommandRepository, policy: Partial<Policy> = {}) {
    this.policy = { ...COMMAND_LOG_POLICY, ...policy }
    if (!Number.isSafeInteger(this.policy.commandBytes) || this.policy.commandBytes <= 0 ||
      !Number.isSafeInteger(this.policy.totalBytes) || this.policy.totalBytes <= 0 ||
      !Number.isSafeInteger(this.policy.retentionMs) || this.policy.retentionMs < 0 ||
      this.policy.openingRatio <= 0 || this.policy.openingRatio >= 1) throw new Error('日志配额无效')
  }

  reserve(bytes: number): boolean {
    if (this.pendingBytes + bytes > TOTAL_PENDING_BYTES) return false
    this.pendingBytes += bytes
    return true
  }

  release(bytes: number): void { this.pendingBytes -= bytes }

  recorder(commandId: string, onLive?: (chunk: CommandLogChunk) => void, onIssue?: (issue: CommandLogIssue) => void,
    onProgress?: () => void): CommandLogRecorder {
    const record = this.repository.get(commandId)
    if (!record || record.endedAt !== null || record.logStatus !== 'active' || this.writers.has(commandId))
      throw new Error('命令不存在、日志已关闭或已有写者')
    this.writers.add(commandId)
    return new CommandLogRecorder(this, record, onLive, onIssue, () => this.writers.delete(commandId), onProgress)
  }

  saveProgress(commandId: string, progress: Progress, issues: readonly CommandLogIssue[]): AgentCommandRecord {
    return this.repository.update(commandId, (previous) => {
      const logIssues = [...new Set([...previous.logIssues, ...issues])]
      return { ...previous,
        logSequence: Math.max(previous.logSequence, progress.logSequence),
        totalRawBytes: Math.max(previous.totalRawBytes, progress.totalRawBytes),
        totalNewlines: Math.max(previous.totalNewlines, progress.totalNewlines),
        logIssues,
        logStatus: previous.logStatus === 'expired' || previous.logStatus === 'evicted_by_quota'
          ? previous.logStatus : logIssues.includes('write_error') ? 'write_error'
            : logIssues.length ? 'partial_truncated' : previous.logStatus,
      }
    })
  }

  /** Called only after compression: no SQLite transaction spans an async operation. */
  saveBlock(chunk: CommandLogChunk, compressed: Buffer, issues: readonly CommandLogIssue[]): CommandLogIssue | null {
    return this.repository.db.transaction(() => {
      const db = this.repository.db
      const record = this.repository.get(chunk.commandId)
      if (!record || record.endedAt !== null) return 'write_error'
      // Rotate the command's own middle before checking the global quota. Otherwise
      // a full global pool would prevent an active command from retaining its latest tail.
      const openingBudget = Math.floor(this.policy.commandBytes * this.policy.openingRatio)
      const tailBudget = this.policy.commandBytes - openingBudget
      const openingSize = (db.prepare(`SELECT COALESCE(SUM(compressed_bytes), 0) AS size
        FROM agent_command_log_blocks WHERE command_id = ? AND opening = 1`).get(chunk.commandId) as { size: number }).size
      const sealed = (db.prepare('SELECT opening_sealed FROM agent_commands WHERE command_id = ?')
        .get(chunk.commandId) as { opening_sealed: number }).opening_sealed
      const opening = !sealed && openingSize + compressed.length <= openingBudget
      if (!opening) {
        if (!sealed) db.prepare('UPDATE agent_commands SET opening_sealed = 1 WHERE command_id = ?').run(chunk.commandId)
        let tailSize = (db.prepare(`SELECT COALESCE(SUM(compressed_bytes), 0) AS size
          FROM agent_command_log_blocks WHERE command_id = ? AND opening = 0`).get(chunk.commandId) as { size: number }).size
        while (tailSize + compressed.length > tailBudget && tailSize > 0) {
          const oldest = db.prepare(`SELECT sequence, compressed_bytes FROM agent_command_log_blocks
            WHERE command_id = ? AND opening = 0 ORDER BY sequence LIMIT 1`).get(chunk.commandId) as { sequence: number; compressed_bytes: number }
          db.prepare('DELETE FROM agent_command_log_blocks WHERE command_id = ? AND sequence = ?').run(chunk.commandId, oldest.sequence)
          tailSize -= oldest.compressed_bytes
          issues = [...issues, 'command_quota']
        }
        this.repository.update(chunk.commandId, (previous) => ({ ...previous, storedCompressedBytes: openingSize + tailSize }))
        if (compressed.length > tailBudget) {
          this.saveProgress(chunk.commandId, { logSequence: chunk.sequence, totalRawBytes: chunk.byteEnd, totalNewlines: chunk.lineEnd }, [...issues, 'command_quota'])
          return 'command_quota'
        }
      }
      this.cleanup(Date.now(), compressed.length)
      const available = this.repository.totalCompressedBytes() + compressed.length <= this.policy.totalBytes
      if (available) {
        db.prepare(`INSERT INTO agent_command_log_blocks
          (command_id, sequence, byte_start, byte_end, line_start, line_end, compressed, compressed_bytes, opening)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(chunk.commandId, chunk.sequence, chunk.byteStart, chunk.byteEnd,
          chunk.lineStart, chunk.lineEnd, compressed, compressed.length, opening ? 1 : 0)
        const stored = (db.prepare(`SELECT COALESCE(SUM(compressed_bytes), 0) AS size
          FROM agent_command_log_blocks WHERE command_id = ?`).get(chunk.commandId) as { size: number }).size
        this.repository.update(chunk.commandId, (previous) => ({ ...previous, storedCompressedBytes: stored }))
      }
      this.saveProgress(chunk.commandId, {
        logSequence: chunk.sequence, totalRawBytes: chunk.byteEnd, totalNewlines: chunk.lineEnd,
      }, available ? issues : [...issues, 'global_quota'])
      return available ? null : 'global_quota'
    })()
  }

  /** Clear expired first, then oldest-ended logs; active commands are never evicted here. */
  cleanup(now = Date.now(), reserveBytes = 0): string[] {
    return this.repository.db.transaction(() => {
      const changed: string[] = []
      const ended = this.repository.db.prepare(`SELECT command_id, ended_at FROM agent_commands
        WHERE ended_at IS NOT NULL AND stored_compressed_bytes > 0 ORDER BY ended_at, command_id`)
        .all() as { command_id: string; ended_at: number }[]
      for (const item of ended) {
        if (item.ended_at + this.policy.retentionMs <= now) {
          this.evict(item.command_id, 'expired')
          changed.push(item.command_id)
        }
      }
      let used = this.repository.totalCompressedBytes()
      for (const item of ended) {
        if (used + reserveBytes <= this.policy.totalBytes) break
        const record = this.repository.get(item.command_id)
        if (!record?.storedCompressedBytes) continue
        used -= record.storedCompressedBytes
        this.evict(item.command_id, 'evicted_by_quota')
        changed.push(item.command_id)
      }
      return changed
    })()
  }

  async read(commandId: string, input: { cursor?: number; direction?: 'forward' | 'backward'; limit?: number } = {}): Promise<CommandLogPage> {
    const record = this.repository.get(commandId)
    if (!record) throw new Error('命令记录不存在')
    const backward = input.direction === 'backward'
    const cursor = input.cursor ?? (backward ? record.logSequence + 1 : 0)
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > record.logSequence + 1) throw new Error('日志位置无效')
    const limit = Math.max(1, Math.min(input.limit ?? 8, 16))
    if (!Number.isSafeInteger(limit)) throw new Error('日志页大小无效')
    const rows = this.repository.db.prepare(`SELECT * FROM agent_command_log_blocks
      WHERE command_id = ? AND sequence ${backward ? '<' : '>'} ?
      ORDER BY sequence ${backward ? 'DESC' : 'ASC'} LIMIT ?`).all(commandId, cursor, limit + 1) as CommandLogBlockRow[]
    const hasMore = rows.length > limit
    const selected = rows.slice(0, limit)
    const nextCursor = hasMore ? selected[selected.length - 1]!.sequence : backward ? 0 : record.logSequence
    const ordered = [...selected].sort((a, b) => a.sequence - b.sequence)
    const chunks: CommandLogChunk[] = []
    const missing: CommandLogGap[] = []
    // Capture edges before decompression yields, so concurrent quota cleanup cannot
    // mix two different retention snapshots in a single page.
    const lower = backward ? (ordered[0]?.sequence ?? 1) - 1 : cursor
    const upper = backward ? cursor : nextCursor + 1
    const preceding = this.repository.db.prepare(`SELECT sequence, byte_end, line_end FROM agent_command_log_blocks
      WHERE command_id = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1`).get(commandId, lower) as Edge | undefined
    const following = this.repository.db.prepare(`SELECT sequence, byte_start, line_start FROM agent_command_log_blocks
      WHERE command_id = ? AND sequence >= ? ORDER BY sequence LIMIT 1`).get(commandId, upper) as
      { sequence: number; byte_start: number; line_start: number } | undefined
    for (const row of ordered) {
      try {
        const decoded = CommandLogChunkSchema.parse(JSON.parse((await decompress(row.compressed, { maxOutputLength: 192 * 1024 })).toString('utf8')))
        if (decoded.commandId !== commandId || decoded.sequence !== row.sequence || decoded.byteStart !== row.byte_start ||
          decoded.byteEnd !== row.byte_end || decoded.lineStart !== row.line_start || decoded.lineEnd !== row.line_end ||
          Buffer.from(decoded.dataBase64, 'base64').length !== row.byte_end - row.byte_start) throw new Error('日志块不一致')
        chunks.push(decoded)
      } catch {
        missing.push({ sequenceStart: row.sequence, sequenceEnd: row.sequence,
          byteStart: row.byte_start, byteEnd: row.byte_end, lineStart: row.line_start, lineEnd: row.line_end })
      }
    }
    // Whole contiguous missing ranges are returned even if the cursor lies inside one.
    let edge: Edge = preceding ?? { sequence: 0, byte_end: 0, line_end: 0 }
    for (const row of ordered) {
      if (row.sequence <= edge.sequence) continue
      this.gap(missing, edge, row.sequence, row.byte_start, row.line_start)
      edge = row
    }
    this.gap(missing, edge, following?.sequence ?? record.logSequence + 1,
      following?.byte_start ?? record.totalRawBytes, following?.line_start ?? record.totalNewlines)
    if (missing.some((gap) => gap.sequenceStart === gap.sequenceEnd && selected.some((row) => row.sequence === gap.sequenceStart))) {
      this.saveProgress(commandId, record, ['write_error'])
    }
    return { chunks, gaps: missing.sort((a, b) => a.sequenceStart - b.sequenceStart), nextCursor, hasMore,
      command: record }
  }

  private gap(gaps: CommandLogGap[], previous: Edge, nextSequence: number, byteEnd: number, lineEnd: number): void {
    if (nextSequence <= previous.sequence + 1) return
    gaps.push({ sequenceStart: previous.sequence + 1, sequenceEnd: nextSequence - 1,
      byteStart: previous.byte_end, byteEnd, lineStart: previous.line_end, lineEnd })
  }

  private evict(commandId: string, logStatus: 'expired' | 'evicted_by_quota'): void {
    this.repository.db.prepare('DELETE FROM agent_command_log_blocks WHERE command_id = ?').run(commandId)
    this.repository.update(commandId, (previous) => ({ ...previous, storedCompressedBytes: 0, logStatus }))
  }
}

/** One owner per command. The executor keeps running even if every storage operation fails. */
export class CommandLogRecorder {
  private readonly drain = new StreamingDrain()
  private readonly issues = new Set<CommandLogIssue>()
  private tail: Promise<void> = Promise.resolve()
  private pendingBytes = 0
  private progress: Progress
  private closed = false
  private finishing: Promise<void> | undefined
  private readonly summaryGaps = new Set<CommandLogChunk['stream']>()
  private lastSummarySave = 0
  readonly commandId: string

  constructor(private readonly store: CommandLogStore, record: AgentCommandRecord,
    private readonly onLive?: (chunk: CommandLogChunk) => void,
    private readonly onIssue?: (issue: CommandLogIssue) => void,
    private readonly onClosed?: () => void,
    private readonly onProgress?: () => void) {
    this.commandId = record.commandId
    this.progress = { logSequence: record.logSequence, totalRawBytes: record.totalRawBytes, totalNewlines: record.totalNewlines }
  }

  /** Sanitization is performed upstream, before bytes enter original logs, summaries or live events. */
  write(stream: CommandLogChunk['stream'], sanitized: Buffer, receivedAt = Date.now()): void {
    if (this.closed) return
    for (let offset = 0; offset < sanitized.length; offset += COMMAND_LOG_BLOCK_BYTES) {
      const part = sanitized.subarray(offset, offset + COMMAND_LOG_BLOCK_BYTES)
      let newlines = 0
      for (const byte of part) if (byte === 10) newlines += 1
      const chunk: CommandLogChunk = {
        commandId: this.commandId, sequence: ++this.progress.logSequence, stream, receivedAt,
        byteStart: this.progress.totalRawBytes, byteEnd: this.progress.totalRawBytes + part.length,
        lineStart: this.progress.totalNewlines, lineEnd: this.progress.totalNewlines + newlines,
        dataBase64: '',
      }
      this.progress.totalRawBytes = chunk.byteEnd
      this.progress.totalNewlines = chunk.lineEnd
      // No retained reference to a potentially huge incoming buffer after this turn.
      chunk.dataBase64 = part.toString('base64')
      try { this.onLive?.(chunk) } catch { /* A disconnected viewer cannot stop collection. */ }
      if (this.pendingBytes + part.length > COMMAND_PENDING_BYTES || !this.store.reserve(part.length)) {
        this.issue('buffer_limit')
        this.drain.markIncomplete()
        this.summaryGaps.add(stream)
        continue
      }
      const copied = Buffer.from(part)
      const gapBefore = this.summaryGaps.delete(stream)
      this.pendingBytes += copied.length
      this.tail = this.tail.then(async () => {
        try {
          if (gapBefore) this.drain.gap(stream)
          await this.drain.write(stream, copied)
          const compressed = await compress(Buffer.from(JSON.stringify(chunk)))
          const issue = this.store.saveBlock(chunk, compressed, [...this.issues])
          if (issue) this.issue(issue)
          if (Date.now() - this.lastSummarySave >= 1000) {
            this.store.repository.update(this.commandId, (previous) => ({ ...previous, drainSummary: this.drain.snapshot() }))
            this.lastSummarySave = Date.now()
            this.progressChanged()
          }
        } catch { this.issue('write_error') }
        finally {
          this.pendingBytes -= copied.length
          this.store.release(copied.length)
          if (!this.pendingBytes) this.persistProgress()
        }
      })
    }
    if (!this.pendingBytes) this.persistProgress()
  }

  /** Await before committing command completion; repeated callers share the same flush. */
  markIncomplete(issue: CommandLogIssue): void {
    this.issue(issue)
    this.drain.markIncomplete()
    this.summaryGaps.add('stdout')
    this.summaryGaps.add('stderr')
  }

  finish(): Promise<void> {
    if (this.finishing) return this.finishing
    this.closed = true
    this.finishing = this.tail.then(async () => {
      for (const stream of this.summaryGaps) this.drain.gap(stream)
      const drainSummary = await this.drain.finish()
      this.persistProgress()
      try {
        this.store.repository.update(this.commandId, (previous) => ({ ...previous, drainSummary,
          logStatus: previous.logStatus === 'active' ? 'complete' : previous.logStatus }))
      } catch { this.issue('write_error') }
    }).finally(() => this.onClosed?.())
    return this.finishing
  }

  private issue(issue: CommandLogIssue): void {
    if (this.issues.has(issue)) return
    this.issues.add(issue)
    try { this.onIssue?.(issue) } catch { /* Reporting is best effort. */ }
  }

  private persistProgress(): void {
    try { this.store.saveProgress(this.commandId, this.progress, [...this.issues]); this.progressChanged() }
    catch { this.issue('write_error') }
  }

  private progressChanged(): void {
    try { this.onProgress?.() } catch { /* A status viewer cannot change storage. */ }
  }
}
