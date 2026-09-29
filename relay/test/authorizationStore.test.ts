import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthorizationStore } from '../src/authorizationStore.js'

const identity = { issuer: 'https://pocket.example', subject: 'user-1' }

describe('AuthorizationStore', () => {
  it('creates a one-time binding request and grants stable issuer/subject authorization', async () => {
    const store = new AuthorizationStore()
    const request = await store.createBindingRequest({
      backendId: 'home-nyxus',
      displayName: 'Home',
      publicKeyFingerprint: 'fingerprint',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(request.status).toBe('pending')
    expect(request.confirmationCode).toMatch(/^[A-F0-9]{10}$/)

    const authorization = await store.confirmBindingRequest(
      request.requestId,
      identity,
      new Date('2026-01-01T00:01:00.000Z'),
    )
    expect(authorization.identity).toEqual(identity)
    expect(store.isAuthorized(identity, 'home-nyxus')).toBe(true)
    expect(store.listAuthorizationsForUser(identity)).toHaveLength(1)
    await expect(store.confirmBindingRequest(request.requestId, identity)).rejects.toMatchObject({
      code: 'BINDING_REQUEST_USED',
    })
  })

  it('expires requests and supports policy defaults, persistence, and revocation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chery-relay-auth-'))
    const file = join(directory, 'authorizations.json')
    const store = new AuthorizationStore(file, { defaultRequestTtlMs: 1000 })
    const policy = await store.setBackendPolicy({
      backendId: 'private',
      publicDiscovery: true,
      remotePasswordEnabled: true,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(policy).toMatchObject({ publicDiscovery: true, remotePasswordEnabled: true })
    const request = await store.createBindingRequest({
      backendId: 'private',
      displayName: 'Private',
      publicKeyFingerprint: 'key',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    await store.expire(new Date('2026-01-01T00:00:02.000Z'))
    expect(store.getBindingRequest(request.requestId)?.status).toBe('expired')

    const activeRequest = await store.createBindingRequest({
      backendId: 'private',
      displayName: 'Private',
      publicKeyFingerprint: 'key',
      now: new Date('2026-01-01T00:00:00.000Z'),
    })
    const binding = await store.confirmBindingRequest(
      activeRequest.requestId,
      identity,
      new Date('2026-01-01T00:00:00.500Z'),
    )
    expect(await store.revokeAuthorization(binding.bindingId)).toBe(true)
    expect(store.isAuthorized(identity, 'private')).toBe(false)

    const restored = new AuthorizationStore(file)
    await restored.load()
    expect(restored.getBackendPolicy('private').publicDiscovery).toBe(true)
    expect(restored.getAuthorization(binding.bindingId)?.status).toBe('revoked')
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1)
  })
})
