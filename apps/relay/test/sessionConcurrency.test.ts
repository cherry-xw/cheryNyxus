import { describe, expect, it } from 'vitest'
import { BrowserSessionStore } from '../src/browserSessionStore.js'
import { DeviceIdentityRegistrySchema, RelayAuthorizationRegistrySchema, RelayControlMessageSchema } from '@chery/protocol'

const target = { origin: 'https://relay.example', basePath: '', backendId: 'test-device', httpBasePath: '/backend/test-device', wsPath: '/backend/test-device/ws' }
describe('session concurrency and persistent contract rejection', () => {
  it('rejects concurrent CAS while preserving idempotent results after Cookie rotation', async () => {
    const store = new BrowserSessionStore()
    const context = store.context()
    let commit!: () => void
    const barrier = new Promise<void>((resolve) => { commit = resolve })
    const operationId = 'o'.repeat(32)
    const create = store.mutate(context.id, 'password', operationId, 'digest', undefined, async () => {
      await barrier
      return store.create({ identity: { subject: 'user', provider: 'password' }, mode: 'relay-password', target }, context.id)
    })
    await expect(store.mutate(context.id, 'password', 'p'.repeat(32), 'other', undefined, async () => undefined)).rejects.toThrow('SESSION_REVISION_CONFLICT')
    commit(); const result = await create
    expect(await store.replay(result.id, 'password', operationId, 'digest', context.csrfToken)).toBe(result)
    expect(() => store.replay(result.id, 'password', operationId, 'changed', context.csrfToken)).toThrow('OPERATION_CONFLICT')
    expect(() => store.replay(result.id, 'password', operationId, 'digest', 'wrong')).toThrow('CSRF_REJECTED')
  })
  it('never imports old persistent formats or accepts malformed control envelopes', () => {
    expect(DeviceIdentityRegistrySchema.safeParse({ version: 1, backends: [] }).success).toBe(false)
    expect(RelayAuthorizationRegistrySchema.safeParse({ version: 1, policies: [], requests: [], authorizations: [] }).success).toBe(false)
    expect(RelayAuthorizationRegistrySchema.safeParse({ version: 2, policies: [], requests: [], authorizations: [] }).success).toBe(true)
    expect(RelayControlMessageSchema.safeParse({ type: 'heartbeat_ack', leaseId: 'l'.repeat(32), leaseExpiresAt: 'invalid' }).success).toBe(false)
  })
})
