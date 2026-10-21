import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { BootstrapSchema, BrowserSessionSchema, PasswordSessionRequestSchema } from '@chery/protocol'
import { BrowserSessionStore, SessionError } from '../src/browserSessionStore.js'
import { UserProofSigner, UserProofVerifier } from '../src/userProof.js'

const target = { origin: 'https://service.example', basePath: '/nyxus', httpBasePath: '/nyxus/backend/home-nyxus', wsPath: '/nyxus/backend/home-nyxus/ws', backendId: 'home-nyxus' }
const identity = { subject: 'subject', provider: 'password' as const }
describe('formal login contracts', () => {
  it('rejects unsupported bootstrap, missing core, duplicate capabilities and invalid ranges; ignores future optional capabilities', () => {
    const base = { protocolVersion: 1, instanceId: 'instance', revision: 'revision', preset: 'basic', capabilities: ['chat.core', 'interaction.respond', 'timeline.read'], protocolRanges: { relay: { min: 2, max: 2 }, websocket: { min: 1, max: 1 } } }
    expect(BootstrapSchema.parse({ ...base, capabilities: [...base.capabilities, 'future.optional'] }).capabilities).toEqual(base.capabilities)
    for (const raw of [{ ...base, protocolVersion: 2 }, { ...base, capabilities: ['chat.core'] }, { ...base, capabilities: [...base.capabilities, 'chat.core'] }, { ...base, protocolRanges: { ...base.protocolRanges, relay: { min: 3, max: 2 } } }]) expect(BootstrapSchema.safeParse(raw).success).toBe(false)
  })
  it('requires safe target paths, positive revisions and strict payloads', () => {
    expect(PasswordSessionRequestSchema.safeParse({ username: 'user', password: 'password', operationId: 'a'.repeat(32) }).success).toBe(true)
    const store = new BrowserSessionStore(); const session = store.create({ identity, target, mode: 'direct-password' })
    expect(BrowserSessionSchema.safeParse(session.view).success).toBe(true)
    expect(BrowserSessionSchema.safeParse({ ...session.view, revision: -1 }).success).toBe(false)
    expect(BrowserSessionSchema.safeParse({ ...session.view, target: { ...target, wsPath: '//evil.example/ws' } }).success).toBe(false)
  })
})
describe('memory browser sessions', () => {
  it('binds CSRF to prelogin/session and expires sessions server-side closing sockets', () => {
    let now = 1000; const store = new BrowserSessionStore(1000, 1000, () => now)
    const context = store.context(); store.checkCsrf(context.id, context.csrfToken)
    expect(() => store.checkCsrf(context.id, 'wrong')).toThrow(SessionError)
    const session = store.create({ identity, target, mode: 'direct-password' }, context.id)
    expect(() => store.checkCsrf(context.id, context.csrfToken)).toThrow()
    let closed = 0; store.attach(session.id, { close: () => closed++ })
    now += 1001; expect(() => store.get(session.id)).toThrow('SESSION_EXPIRED'); expect(closed).toBe(1)
  })
  it('consumes tickets once and invalidates old revision/target connections', () => {
    const store = new BrowserSessionStore(); const session = store.create({ identity, target, mode: 'direct-password' })
    const first = store.ticket(session.id, 1); expect(store.consume(first.ticket, target).id).toBe(session.id)
    expect(() => store.consume(first.ticket, target)).toThrow()
    const old = store.ticket(session.id, 1); let closed = 0; store.attach(session.id, { close: () => closed++ })
    store.update(session.id, 1, { ...target, backendId: 'other-nyxus' })
    expect(closed).toBe(1); expect(() => store.consume(old.ticket, target)).toThrow()
    expect(() => store.update(session.id, 1, target)).toThrow('SESSION_REVISION_CONFLICT')
    store.clear(); expect(() => store.get(session.id)).toThrow()
  })
  it('deduplicates same operation and rejects changed content and concurrent old CAS', async () => {
    const store = new BrowserSessionStore(); const session = store.create({ identity, target, mode: 'direct-password' }); let writes = 0
    const work = async () => { writes++; return store.update(session.id, 1, target) }
    const id = randomBytes(24).toString('base64url')
    const one = store.mutate(session.id, 'target', id, 'digest', 1, work)
    const two = store.mutate(session.id, 'target', id, 'digest', 1, work)
    expect(await one).toEqual(await two); expect(writes).toBe(1)
    await expect(store.mutate(session.id, 'target', id, 'different', 1, work)).rejects.toThrow('OPERATION_CONFLICT')
  })
})
describe('Ed25519 limited audience user proofs', () => {
  it('verifies signature, request binding, audience, permission, expiry and one-time jti', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const kid = 'k'.repeat(32)
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const signer = new UserProofSigner('https://relay.example', kid, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    const input = { sub: 'pocket-user', aud: 'home-nyxus', sessionId: 's'.repeat(32), authorizationId: 'authorization', authorizationRevision: 1, permissions: ['business'] as ['business'] }
    const token = signer.issue(input, 'GET', '/api/config', 1000)
    const verifier = new UserProofVerifier('https://relay.example', 'home-nyxus', { [kid]: pem }, () => true)
    expect(verifier.consume(token, 'GET', '/api/config', 1001).sub).toBe('pocket-user')
    expect(() => verifier.consume(token, 'GET', '/api/config', 1001)).toThrow()
    for (const [aud, allowed, method, path, time] of [['other-nyxus', true, 'GET', '/api/config', 1001], ['home-nyxus', false, 'GET', '/api/config', 1001], ['home-nyxus', true, 'POST', '/api/config', 1001], ['home-nyxus', true, 'GET', '/api/other', 1001], ['home-nyxus', true, 'GET', '/api/config', 1061]] as const) {
      const v = new UserProofVerifier('https://relay.example', aud, { [kid]: pem }, () => allowed)
      expect(() => v.consume(token, method, path, time)).toThrow()
    }
    expect(() => verifier.consume(token + 'x', 'GET', '/api/config', 1001)).toThrow()
  })
})
