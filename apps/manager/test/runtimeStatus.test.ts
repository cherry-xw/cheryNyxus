import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readBackendStatus, readRelayStatus } from '../src/runtimeStatus.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const now = Date.parse('2026-10-21T03:00:00Z')
async function file(value: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'manager-runtime-status-')); roots.push(root)
  const path = join(root, 'status.json')
  await writeFile(path, JSON.stringify(value))
  return path
}
const backend = { protocolVersion: 2, instanceId: 'b'.repeat(32), status: 'running', heartbeatIntervalMs: 2_000,
  addresses: { local: { httpPort: 8183, websocketPort: 8182 } }, agents: { initializedChats: 1, runningChats: 1, activeRuns: 1 }, updatedAt: new Date(now).toISOString() }
const desired = { backendId: 'test-device', desiredRevision: 'revision-a' }
const relay = { protocolVersion: 3, instanceId: 'r'.repeat(32), ...desired, status: 'online', configVersion: 1,
  appliedRevision: desired.desiredRevision, leaseId: 'l'.repeat(32), leaseExpiresAt: new Date(now + 45_000).toISOString(), updatedAt: new Date(now).toISOString() }

describe('runtime evidence, never process control', () => {
  it('expires Backend at exactly three declared update cycles and accepts a fresh update', async () => {
    const path = await file(backend)
    expect(await readBackendStatus(path, now + 5_999)).toMatchObject({ status: 'running' })
    expect(await readBackendStatus(path, now + 6_000)).toEqual({ status: 'unknown', reason: 'stale_status' })
    await writeFile(path, JSON.stringify({ ...backend, updatedAt: new Date(now + 6_000).toISOString() }))
    expect(await readBackendStatus(path, now + 6_000)).toMatchObject({ status: 'running' })
  })
  it('uses the actual period rather than a fixed six or sixty seconds', async () => {
    const path = await file({ ...backend, heartbeatIntervalMs: 5_000 })
    expect(await readBackendStatus(path, now + 14_999)).toMatchObject({ status: 'running' })
    expect(await readBackendStatus(path, now + 15_000)).toMatchObject({ status: 'unknown', reason: 'stale_status' })
  })
  it.each([{ protocolVersion: 1 }, { heartbeatIntervalMs: 0 }, { extra: 'secret' }, { instanceId: '' }])('rejects invalid Backend evidence %j', async change => {
    const view = await readBackendStatus(await file({ ...backend, ...change }), now)
    expect(view).toEqual({ status: 'unknown', reason: 'invalid_status' })
    expect(view).not.toHaveProperty('agents')
  })
  it('does not trust future timestamps in either file', async () => {
    const updatedAt = new Date(now + 1).toISOString()
    expect(await readBackendStatus(await file({ ...backend, updatedAt }), now)).toMatchObject({ status: 'unknown', reason: 'future_status' })
    expect(await readRelayStatus(await file({ ...relay, updatedAt }), desired, now)).toMatchObject({ status: 'unknown', reason: 'future_status' })
  })
  it('does not use the previous managed instance after a restart', async () => {
    const path = await file(backend)
    expect(await readBackendStatus(path, now, 'n'.repeat(32))).toEqual({ status: 'unknown', reason: 'instance_identity_mismatch' })
    expect(await readBackendStatus(path, now, backend.instanceId)).toMatchObject({ status: 'running' })
  })
  it('uses confirmed Relay expiry even with a long heartbeat and no recent file write', async () => {
    const path = await file({ ...relay, updatedAt: new Date(now - 120_000).toISOString() })
    expect(await readRelayStatus(path, desired, now + 44_999)).toMatchObject({ status: 'online' })
    expect(await readRelayStatus(path, desired, now + 45_000)).toEqual({ status: 'unknown', reason: 'stale_status' })
  })
  it.each([
    [{ protocolVersion: 2 }, 'invalid_status'], [{ leaseExpiresAt: undefined }, 'invalid_status'],
    [{ backendId: 'foreign-device' }, 'device_identity_mismatch'], [{ desiredRevision: 'old', appliedRevision: 'old' }, 'configuration_not_applied'],
    [{ extra: 'secret' }, 'invalid_status'],
  ] as const)('rejects foreign, old or un-applied Relay evidence %j', async (change, reason) => {
    expect(await readRelayStatus(await file({ ...relay, ...change }), desired, now)).toEqual({ status: 'unknown', reason })
  })
  it('labels a stopped Relay observation without claiming Backend exit', async () => {
    const view = await readRelayStatus(await file({ ...relay, status: 'stopped', leaseId: undefined, leaseExpiresAt: undefined, appliedRevision: undefined }), desired, now)
    expect(view).toMatchObject({ status: 'stopped', observedOnly: true })
    expect(view).not.toHaveProperty('backend')
  })
  it('bounds file reads and reports absent files without throwing', async () => {
    const path = await file({ value: 'x'.repeat(70_000) })
    expect(await readBackendStatus(path, now)).toMatchObject({ status: 'unknown' })
    expect(await readRelayStatus(path + '.absent', desired, now)).toMatchObject({ status: 'unknown' })
  })
})
