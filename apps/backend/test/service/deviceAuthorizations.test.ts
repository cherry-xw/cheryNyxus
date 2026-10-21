import { describe, expect, it } from 'vitest'
import { mkdir, readFile } from 'node:fs/promises'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { DeviceAuthorizationStore } from '../../src/service/auth/deviceAuthorizations'
import { OAuth2Auth } from '../../src/service/auth'
import { UserProofSigner } from '../../../relay/src/userProof'
import type { IncomingMessage } from 'node:http'

describe('device authorization persistence and socket revocation', () => {
  it('persists ordered snapshots and rejects identity mismatch', async () => {
    const root = '/home/chery/.hermes/cache/scratch/login-development/authorization-tests/' + randomBytes(12).toString('hex')
    await mkdir(root, { recursive: true })
    const file = root + '/authorizations.json'
    const store = new DeviceAuthorizationStore(file, 'home-nyxus', 'https://relay.example')
    await store.load()
    await Promise.all([store.save([{ id: 'a', revision: 1, subject: 'user' }]), store.save([])])
    const value = JSON.parse(await readFile(file, 'utf8'))
    expect(value.revision).toBe(2); expect(value.authorizations).toEqual([])
    await expect(new DeviceAuthorizationStore(file, 'other-nyxus', 'https://relay.example').load()).rejects.toThrow('mismatch')
  })
  it('immediately closes a proof-authenticated socket when its relationship is revoked', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const kid = 'k'.repeat(32)
    const signer = new UserProofSigner('https://relay.example', kid, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    const auth = new OAuth2Auth({ allowLoopback: false, userProof: { issuer: 'https://relay.example', backendId: 'home-nyxus', keys: { [kid]: publicKey.export({ format: 'pem', type: 'spki' }).toString() }, authorizations: [{ id: 'binding', revision: 1, subject: 'user' }] } })
    auth.updateAuthorizations([{ id: 'binding', revision: 1, subject: 'user' }])
    const token = signer.issue({ sub: 'user', aud: 'home-nyxus', sessionId: 's'.repeat(32), authorizationId: 'binding', authorizationRevision: 1, permissions: ['business'] }, 'GET', '/ws')
    const req = { method: 'GET', url: '/ws', headers: { 'x-chery-relay-user-proof': token }, socket: { remoteAddress: '10.2.3.6' } } as unknown as IncomingMessage
    expect(auth.getUser(req, { allowLoopback: false })?.sub).toBe('user')
    let closed = 0
    auth.attachProofSocket(req, { close: () => { closed++ } })
    auth.updateAuthorizations([])
    expect(closed).toBe(1)
  })
})
