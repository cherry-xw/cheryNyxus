import { describe, expect, it } from 'vitest'
import { OAuth2Auth } from '../../src/service/auth/index.js'
import { hashPassword } from '../../src/utils/password.js'
import { parseLiteProfile } from '../../src/service/websocket/index.js'
import { BootstrapSchema, PublicAuthCapabilitiesSchema } from '@chery/protocol'

describe('cross-end repair security boundaries', () => {
  it('F06 password-only cleanup is bounded but cannot install proof authority', () => {
    const auth = new OAuth2Auth({ username: 'business', password: hashPassword('isolated-test-password') })
    expect(() => auth.updateAuthorizations([])).not.toThrow()
    expect(() => auth.updateAuthorizations([{ id: 'id', revision: 1, subject: 'subject' }])).toThrow()
  })
  it('F08 malformed optional machine identity does not disable business authentication', () => {
    const auth = new OAuth2Auth({ username: 'business', password: hashPassword('isolated-test-password'), machine: { username: '', password: 'invalid' } })
    expect(auth.authenticate('business', 'isolated-test-password')).not.toBeNull()
    expect(auth.authenticate('business', 'wrong')).toBeNull()
    expect(() => new OAuth2Auth({ username: 'business', password: 'invalid', machine: { username: '', password: 'invalid' } })).toThrow()
  })
  it.each(['?profile=unknown', '?profile=', '?profile=lite&maxFrameBytes=garbage', '?profile=lite&maxFrameBytes=511', '?profile=lite&maxFrameBytes=65537', '?profile=lite&maxFrameBytes=1e3', '?profile=lite&profile=lite', '?profile=lite&v=1&v=1', '?profile=lite&turnDelta=maybe', '?maxFrameBytes=4096'])('F12 rejects explicit invalid projection %s', (query) => {
    expect(parseLiteProfile('/ws' + query)).toBe('unsupported')
  })
  it('F12 permits default and bounded explicit Lite without changing ordinary traffic', () => {
    expect(parseLiteProfile('/ws')).toBeUndefined()
    expect(parseLiteProfile('/ws?profile=lite')).toMatchObject({ kind: 'lite', v: 1, maxFrameBytes: 4096, turnDelta: false })
    expect(parseLiteProfile('/ws?profile=lite&maxFrameBytes=512&turnDelta=1')).toMatchObject({ maxFrameBytes: 512, turnDelta: true })
  })
  it('F04/F13 reject nested unknown fields and malformed public discovery', () => {
    const bootstrap = { protocolVersion: 1, instanceId: 'instance', revision: 'revision', preset: 'basic', capabilities: ['chat.core', 'interaction.respond', 'timeline.read'], protocolRanges: { relay: { min: 2, max: 2 }, websocket: { min: 1, max: 1 } } }
    expect(BootstrapSchema.safeParse(bootstrap).success).toBe(true)
    expect(BootstrapSchema.safeParse({ ...bootstrap, protocolRanges: { ...bootstrap.protocolRanges, websocket: { min: 1, max: 1, extra: true } } }).success).toBe(false)
    expect(PublicAuthCapabilitiesSchema.safeParse({ service: 'backend', password: 'true', oidc: false, csrfToken: 'x'.repeat(32) }).success).toBe(false)
    expect(PublicAuthCapabilitiesSchema.safeParse({ service: 'backend', password: true, oidc: false, csrfToken: 'x'.repeat(32), secret: 'must-reject' }).success).toBe(false)
  })
})
