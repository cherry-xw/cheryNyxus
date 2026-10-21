import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { OAuth2Auth } from '../../src/service/auth'
import { hashPassword } from '../../src/utils/password'
const captured = vi.hoisted(() => ({ options: undefined as any }))
vi.mock('../../../relay/src/client.js', () => ({ RelayBackendClient: class { constructor(options: unknown) { captured.options = options } async start() {} async stop() { captured.options.onControlDisconnected() } } }))
import { startBackendRelay } from '../../src/service/relayLifecycle'
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })
async function start(callback: (v: Array<{ id: string; revision: number; subject: string }>) => Promise<void>) {
  const root = '/home/chery/.hermes/cache/scratch/login-development/lifecycle-' + randomBytes(12).toString('hex'); await mkdir(root, { recursive: true })
  const config = { protocolVersion: 1, backendId: 'test-device', displayName: 'Test', url: 'wss://relay.example/control/backend', keyFile: root + '/key.json', authorizationFile: root + '/auth.json', proofIssuer: 'https://relay.example', ratholeServerAddr: 'relay.example:2333', ratholeConfigPath: root + '/client.toml', encryptedTransport: '[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = "' + Buffer.alloc(32, 7).toString('base64') + '"\n' }
  await writeFile(root + '/client.json', JSON.stringify(config)); vi.stubEnv('CHERY_RELAY_CLIENT_CONFIG_FILE', root + '/client.json')
  const client = await startBackendRelay({ local: { httpPort: 1, websocketPort: 2 }, remote: { httpPort: 3, websocketPort: 4 } }, () => 'synthetic-probe', callback)
  return { client: client!, options: captured.options, root }
}
describe('F06 actual startBackendRelay callback assembly', () => {
  it('password-only repeated disconnect and stop safely clear with no proof installation', async () => {
    const auth = new OAuth2Auth({ username: 'business', password: hashPassword('synthetic-business-password') }), callback = vi.fn(async (v) => auth.updateAuthorizations(v))
    const f = await start(callback); f.options.onControlDisconnected(); f.options.onControlDisconnected(); await f.client.stop()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(3)); expect(callback.mock.calls.every(([v]) => v.length === 0)).toBe(true)
    await expect(f.options.onAuthorizations([{ id: 'binding', revision: 1, subject: 'user' }])).rejects.toThrow('not configured')
    expect(auth.authenticate('business', 'synthetic-business-password')).not.toBeNull()
  })
  it('disconnect cleanup rejection is caught and logged without unhandled rejection', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}), callback = vi.fn(async () => { throw new Error('synthetic-private-error') })
    const f = await start(callback); f.options.onControlDisconnected(); await f.client.stop()
    await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(2)); expect(warning.mock.calls.flat().join(' ')).not.toContain('synthetic-private-error')
  })
  it('snapshot arriving after disconnect is persisted but cannot re-install runtime authority', async () => {
    const applied: unknown[] = [], f = await start(async (v) => { applied.push(v) })
    const pending = f.options.onAuthorizations([{ id: 'binding', revision: 1, subject: 'user' }]); f.options.onControlDisconnected(); await pending
    await vi.waitFor(() => expect(applied).toHaveLength(2)); expect(applied).toEqual([[], []]); expect(JSON.parse(await readFile(f.root + '/auth.json', 'utf8')).authorizations).toHaveLength(1)
    await f.client.stop()
  })
  it('disk failure rejects snapshot before callback and ACK opportunity', async () => {
    const callback = vi.fn(async () => {}), f = await start(callback)
    await mkdir(f.root + '/auth.json')
    await expect(f.options.onAuthorizations([{ id: 'binding', revision: 1, subject: 'user' }])).rejects.toThrow(); expect(callback).not.toHaveBeenCalled(); await f.client.stop()
  })
})
