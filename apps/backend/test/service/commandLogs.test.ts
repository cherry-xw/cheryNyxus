import { randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { AgentCommandRecord, CommandLogChunk } from '@chery/protocol'
import { AgentCommandRepository, initAgentCommandTables } from '@/db/agentCommands.js'
import { CommandLogStore } from '@/service/commandLogs.js'

function record(id: string, startedAt = 1): AgentCommandRecord {
  return {
    commandId: id, backendInstanceId: 'instance-1', chatId: 'chat', rootChatId: 'chat', runId: null,
    toolCallId: null, sourceKind: 'host_bash', command: 'printf example', description: 'example', workdir: null,
    executionId: null, status: 'running', exitCode: null, signal: null, startedAt, endedAt: null,
    version: 1, logStatus: 'active', logIssues: [], logSequence: 0, totalRawBytes: 0, totalNewlines: 0,
    storedCompressedBytes: 0, logTailUnconfirmed: false, drainSummary: null,
  }
}

function setup(policy: ConstructorParameters<typeof CommandLogStore>[1] = {}, file = ':memory:') {
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY); INSERT OR IGNORE INTO chats VALUES (\'chat\')')
  initAgentCommandTables(db)
  const repository = new AgentCommandRepository(db)
  const store = new CommandLogStore(repository, policy)
  return { db, repository, store }
}

function chunk(commandId: string, sequence: number, bytes = Buffer.from(`line ${sequence}\n`)): CommandLogChunk {
  return { commandId, sequence, stream: 'stdout', receivedAt: sequence,
    byteStart: (sequence - 1) * bytes.length, byteEnd: sequence * bytes.length,
    lineStart: sequence - 1, lineEnd: sequence, dataBase64: bytes.toString('base64') }
}

describe('CommandLogStore', () => {
  it('does not advance the captured page boundary while asynchronous decompression yields', async () => {
    const { db, repository, store } = setup()
    try {
      repository.create(record('one'))
      const first = chunk('one', 1), second = chunk('one', 2)
      store.saveBlock(first, gzipSync(JSON.stringify(first)), [])
      const pending = store.read('one', { direction: 'backward' })
      store.saveBlock(second, gzipSync(JSON.stringify(second)), [])
      const page = await pending
      expect(page.command.logSequence).toBe(1)
      expect(page.chunks.map(entry => entry.sequence)).toEqual([1])
      expect((await store.read('one', { cursor: page.command.logSequence })).chunks.map(entry => entry.sequence)).toEqual([2])
    } finally { db.close() }
  })
  it('stores original bytes including split UTF-8, and survives reopening independently of command completion', async () => {
    const root = await mkdtemp('/tmp/opencode/command-logs-')
    const file = path.join(root, 'logs.db')
    const first = setup({}, file)
    try {
      first.repository.create(record('one'))
      const live: CommandLogChunk[] = []
      const writer = first.store.recorder('one', (entry) => live.push(entry))
      const raw = Buffer.from([0xe4, 0xb8, 0xad, 0xff, 10, 0])
      writer.write('stdout', raw.subarray(0, 1))
      writer.write('stderr', Buffer.from('problem\n'))
      writer.write('stdout', raw.subarray(1))
      await writer.finish()
      const before = await first.store.read('one')
      expect(before.command).toMatchObject({ status: 'running', endedAt: null, logStatus: 'complete' })
      expect(before.gaps).toEqual([])
      expect(Buffer.concat(before.chunks.filter((entry) => entry.stream === 'stdout').map((entry) => Buffer.from(entry.dataBase64, 'base64')))).toEqual(raw)
      expect(before.chunks).toEqual(live)
      first.db.close()
      const second = setup({}, file)
      try {
        expect((await second.store.read('one')).chunks).toEqual(before.chunks)
        expect(second.repository.interruptPreviousInstances('instance-2', 100)).toMatchObject([
          { status: 'result_unknown', endedAt: 100, logTailUnconfirmed: true, logIssues: ['restart'] },
        ])
      } finally { second.db.close() }
    } finally {
      if (first.db.open) first.db.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains opening and newest tail within quota, returns exact gaps and pages in both directions', async () => {
    const bytes = randomBytes(1024)
    const sample = chunk('one', 1, bytes)
    const size = gzipSync(JSON.stringify(sample)).length
    const { db, repository, store } = setup({ commandBytes: size * 5 + 100, openingRatio: 0.2 })
    try {
      repository.create(record('one'))
      for (let i = 1; i <= 12; i++) {
        const entry = chunk('one', i, bytes)
        store.saveBlock(entry, gzipSync(JSON.stringify(entry)), [])
      }
      const detail = repository.get('one')!
      expect(detail.status).toBe('running')
      expect(detail.storedCompressedBytes).toBeLessThanOrEqual(store.policy.commandBytes)
      expect(detail.logIssues).toContain('command_quota')
      const page = await store.read('one')
      expect(page.chunks[0]!.sequence).toBe(1)
      expect(page.chunks[page.chunks.length - 1]!.sequence).toBe(12)
      expect(page.gaps).toMatchObject([{ sequenceStart: 2, byteStart: 1024 }])
      expect(page.gaps[0]!.byteEnd).toBe((page.gaps[0]!.sequenceEnd) * 1024)
      const readAll = async (direction: 'forward' | 'backward') => {
        let cursor: number | undefined
        let hasMore = true
        const ids: number[] = []
        while (hasMore) {
          const next = await store.read('one', { cursor, direction, limit: 1 })
          ids.push(...next.chunks.map((entry) => entry.sequence))
          cursor = next.nextCursor
          hasMore = next.hasMore
        }
        return ids.sort((a, b) => a - b)
      }
      const expected = page.chunks.map((entry) => entry.sequence)
      expect(await readAll('forward')).toEqual(expected)
      expect(await readAll('backward')).toEqual(expected)
      // A cursor in an omitted range reports the entire missing range, not guessed byte boundaries.
      expect((await store.read('one', { cursor: 3 })).gaps).toContainEqual(page.gaps[0])
    } finally { db.close() }
  })

  it('clears expired logs first, then oldest-ended logs; preserves details and running commands', async () => {
    const entry = chunk('a', 1, randomBytes(1024))
    const encoded = gzipSync(JSON.stringify(entry))
    const { db, repository, store } = setup({ totalBytes: encoded.length * 3 + 40, retentionMs: 100 })
    try {
      for (const id of ['a', 'b', 'c', 'd']) repository.create(record(id))
      for (const id of ['a', 'b', 'c']) {
        const next = { ...entry, commandId: id }
        store.saveBlock(next, gzipSync(JSON.stringify(next)), [])
      }
      repository.update('a', (previous) => ({ ...previous, endedAt: 10, status: 'exited' }))
      repository.update('b', (previous) => ({ ...previous, endedAt: 1000, status: 'exited' }))
      expect(store.cleanup(200)).toEqual(['a'])
      expect(repository.get('a')).toMatchObject({ logStatus: 'expired', storedCompressedBytes: 0, command: 'printf example' })
      store.cleanup(1001, encoded.length * 2)
      expect(repository.get('b')!.logStatus).toBe('evicted_by_quota')
      expect(repository.get('c')!.storedCompressedBytes).toBeGreaterThan(0)
      expect((await store.read('a')).gaps).toMatchObject([{ sequenceStart: 1, sequenceEnd: 1 }])
      db.prepare('DELETE FROM chats WHERE id = ?').run('chat')
      expect(repository.get('c')).toBeUndefined()
      expect(db.prepare('SELECT count(*) AS n FROM agent_command_log_blocks').get()).toEqual({ n: 0 })
    } finally { db.close() }
  })

  it('pauses disk writes when only active logs fill global quota, then resumes without claiming a complete log', async () => {
    const one = chunk('one', 1, randomBytes(1024))
    const two = chunk('two', 1, randomBytes(1024))
    const size = gzipSync(JSON.stringify(one)).length
    const { db, repository, store } = setup({ totalBytes: size + 100 })
    try {
      repository.create(record('one'))
      repository.create(record('two'))
      expect(store.saveBlock(one, gzipSync(JSON.stringify(one)), [])).toBeNull()
      expect(store.saveBlock(two, gzipSync(JSON.stringify(two)), [])).toBe('global_quota')
      expect(repository.get('two')).toMatchObject({ status: 'running', totalRawBytes: 1024, logIssues: ['global_quota'] })
      expect((await store.read('two')).gaps).toMatchObject([{ sequenceStart: 1, byteStart: 0, byteEnd: 1024 }])
      repository.update('one', (previous) => ({ ...previous, endedAt: Date.now(), status: 'exited' }))
      const newer = chunk('two', 2, Buffer.from(two.dataBase64, 'base64'))
      expect(store.saveBlock(newer, gzipSync(JSON.stringify(newer)), [])).toBeNull()
      expect(repository.get('one')!.logStatus).toBe('evicted_by_quota')
      expect((await store.read('two')).command.logStatus).toBe('partial_truncated')
    } finally { db.close() }
  })

  it('bounds queued output and remains non-throwing when storage fails', async () => {
    const { db, repository, store } = setup()
    repository.create(record('one'))
    const live: number[] = []
    const writer = store.recorder('one', (entry) => live.push(entry.sequence))
    writer.write('stdout', Buffer.alloc(1024 * 1024, 120))
    await writer.finish()
    expect(live.length).toBe(16)
    const page = await store.read('one')
    expect(page.command.totalRawBytes).toBe(1024 * 1024)
    expect(page.command.logIssues).toContain('buffer_limit')
    expect(page.gaps).toMatchObject([{ sequenceStart: 5, sequenceEnd: 16 }])
    repository.create(record('two'))
    const failed = store.recorder('two')
    db.close()
    expect(() => failed.write('stderr', Buffer.from('error\n'))).not.toThrow()
    await expect(failed.finish()).resolves.toBeUndefined()
  })
})
