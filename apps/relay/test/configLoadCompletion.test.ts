import { mkdtemp } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadRelayConfig } from '../src/config'
import { createRelayService } from '../src/server'
import { BrowserSessionStore } from '../src/browserSessionStore'
describe('F10 production config load without retired session secret', () => {
  it('starts real HTTP discovery from production load with isolated persistent paths and no old secret', async () => {
    const root = await mkdtemp('/home/chery/.hermes/cache/scratch/login-development/relay-load-')
    const config = loadRelayConfig({ RELAY_PUBLIC_ORIGIN: 'http://10.2.3.6:4080', RELAY_IDENTITY_FILE: root + '/identities.json', RELAY_AUTHORIZATION_FILE: root + '/authorizations.json' }); config.port = 0
    expect(config).not.toHaveProperty('sessionSecret')
    const service = await createRelayService({ config, logger: () => {} }); const address = await service.listen()
    try {
      const base = `http://10.2.3.6:${address.port}`
      const discovery = await fetch(base + '/api/auth/capabilities'); expect(discovery.status).toBe(200); expect(await discovery.json()).toMatchObject({ service: 'relay' })
      const payload = Buffer.from(JSON.stringify({ backendId: 'test-device', exp: Date.now() + 60000 })).toString('base64url'), signed = payload + '.' + createHmac('sha256', 's'.repeat(32)).update(payload).digest('base64url')
      for (const cookie of ['chery_backend_session=' + signed, 'chery_business_session=' + signed]) expect((await fetch(base + '/api/browser-session', { headers: { Cookie: cookie } })).status).toBe(401)
    } finally { await service.close() }
  })
  it('real current session is memory-only and cannot authenticate a fresh process store', () => {
    const old = new BrowserSessionStore(), session = old.create({ identity: { provider: 'oidc', subject: 'user', issuer: 'https://id.example' }, target: null, mode: 'relay-oidc' })
    expect(old.get(session.id)).toBe(session); expect(() => new BrowserSessionStore().get(session.id)).toThrow('SESSION_EXPIRED')
  })
})
