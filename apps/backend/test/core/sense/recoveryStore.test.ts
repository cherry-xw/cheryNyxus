import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DurableSenseStore } from '@/core/sense/recoveryStore.js'
import { createSenseCheckpoint } from '@/core/sense/senseCreator.js'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'chery-sense-recovery-'))
  dirs.push(dir)
  const filePath = join(dir, 'records.json')
  let now = 100
  const store = () =>
    new DurableSenseStore({ filePath, ttlMs: 100, maxEntries: 2, maxBytes: 50_000, now: () => now })
  const record = (key: string, status: 'completed' | 'incomplete' = 'completed') => ({
    key,
    operationId: `operation-${key}`,
    operationClass: 'web-search',
    replayPolicy: 'observation' as const,
    checkpoint: createSenseCheckpoint({
      operationId: `operation-${key}`,
      senseCallId: `call-${key}`,
      status,
      completedAt: status === 'completed' ? now : undefined,
    }),
    result: {
      content: JSON.stringify({ ok: true, results: [{ title: key }] }),
      status: 'ok' as const,
      observation: {
        kind: 'observation' as const,
        content: `source-${key}`,
        untrusted: true,
      },
    },
    observation: { kind: 'observation' as const, content: `source-${key}`, untrusted: true },
    source: 'fixture-provider',
  })
  return { filePath, store, record, tick: (value: number) => (now = value) }
}

describe('durable Sense recovery store', () => {
  it('persists completed observations and replays them after a new store instance', () => {
    const f = fixture()
    const first = f.store()
    expect(first.save(f.record('one'))).toBe(true)

    const restarted = f.store()
    expect(restarted.replay('one')).toEqual({
      status: 'replayed',
      result: expect.objectContaining({ content: expect.stringContaining('one') }),
      source: 'fixture-provider',
    })
    const replay = restarted.replay('one')
    if (replay.status === 'replayed') {
      replay.result.observation!.content = 'mutated'
    }
    expect(restarted.replay('one')).toEqual(expect.objectContaining({ status: 'replayed' }))
  })

  it('returns recovery_required for missing, expired, incomplete and side-effect records', () => {
    const f = fixture()
    const store = f.store()
    expect(store.replay('missing')).toEqual({ status: 'recovery_required', reason: 'missing' })
    expect(store.save(f.record('incomplete', 'incomplete'))).toBe(false)
    expect(store.replay('incomplete')).toEqual({ status: 'recovery_required', reason: 'missing' })
    expect(store.save({ ...f.record('effect'), replayPolicy: 'side_effect' as const })).toBe(false)
    expect(store.replay('effect', 'side_effect')).toEqual({
      status: 'recovery_required',
      reason: 'side_effect_not_replayable',
    })
    expect(store.save(f.record('expired'))).toBe(true)
    f.tick(200)
    expect(store.replay('expired')).toEqual({ status: 'recovery_required', reason: 'expired' })
  })

  it('fails closed on a corrupt fixture and enforces entry capacity', () => {
    const f = fixture()
    const store = f.store()
    expect(store.save(f.record('one'))).toBe(true)
    f.tick(101)
    expect(store.save(f.record('two'))).toBe(true)
    f.tick(102)
    expect(store.save(f.record('three'))).toBe(true)
    expect(store.size).toBe(2)
    expect(store.replay('one')).toEqual({ status: 'recovery_required', reason: 'missing' })

    writeFileSync(f.filePath, '{broken', 'utf8')
    expect(f.store().replay('two')).toEqual({ status: 'recovery_required', reason: 'corrupt' })
  })
})
