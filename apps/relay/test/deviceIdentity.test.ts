import { describe, it, expect } from 'vitest'
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes, createPublicKey } from 'node:crypto'
import { loadOrCreatePrivateKey } from '../src/client.js'
import { DeviceAuthorizationSnapshotSchema } from '@chery/protocol'

const root = '/home/chery/.hermes/cache/scratch/login-development/device-tests'
describe('strict device identity', () => {
  it('concurrent provisioning preserves one identity and rejects old or unsafe files', async () => {
    const dir = join(root, randomBytes(12).toString('hex'))
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'identity.json')
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadOrCreatePrivateKey(file)))
    const fingerprints = keys.map((key) => createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url'))
    expect(new Set(fingerprints).size).toBe(1)
    const before = await readFile(file, 'utf8')
    await chmod(file, 0o644)
    await expect(loadOrCreatePrivateKey(file)).rejects.toThrow('0600')
    expect(await readFile(file, 'utf8')).toBe(before)
    await chmod(file, 0o600)
    await writeFile(file, JSON.stringify({ ...JSON.parse(before), version: 0 }))
    await expect(loadOrCreatePrivateKey(file)).rejects.toThrow()
  })
  it('rejects invalid control snapshots and duplicates', () => {
    const base = { type: 'authorizations.snapshot', revision: 'a'.repeat(32), authorizations: [{ id: 'binding', revision: 1, subject: 'user' }] }
    expect(DeviceAuthorizationSnapshotSchema.safeParse(base).success).toBe(true)
    for (const value of [{ ...base, revision: 1 }, { ...base, authorizations: [...base.authorizations, ...base.authorizations] }, { ...base, extra: true }]) expect(DeviceAuthorizationSnapshotSchema.safeParse(value).success).toBe(false)
  })
})
