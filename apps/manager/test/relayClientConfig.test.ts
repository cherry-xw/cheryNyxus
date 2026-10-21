import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { DeviceControlMessageSchema, RelayControlMessageSchema, relaySignaturePayload } from '@chery/protocol'
import { RelayClientConfigStore } from '../src/relayClientConfig.js'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const root = '/home/chery/.hermes/cache/scratch/login-development/client-config-tests/'
describe('formal device client configuration', () => {
  it('stores fixed-path configuration and never returns encrypted transport contents', async () => {
    const folder = root + randomBytes(12).toString('hex')
    const store = new RelayClientConfigStore(folder + '/client.json')
    const input = { protocolVersion: 1, url: 'wss://relay.example/control/backend', backendId: 'test-device', displayName: 'Test', keyFile: folder + '/identity.json', authorizationFile: folder + '/authorizations.json', ratholeConfigPath: folder + '/rathole.toml', ratholeServerAddr: 'relay.example:2333', proofIssuer: 'https://relay.example', encryptedTransport: '[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = "' + Buffer.alloc(32, 7).toString('base64') + '"\n' }
    const view = await store.save(input)
    expect(view.configured).toBe(true)
    expect(view).not.toHaveProperty('encryptedTransport')
    await store.save({ ...input, encryptedTransport: '' })
    expect(JSON.parse(await readFile(folder + '/client.json', 'utf8')).encryptedTransport).toBe(input.encryptedTransport)
    await expect(store.save({ ...input, protocolVersion: 0 })).rejects.toThrow()
    await expect(store.save({ ...input, authorizationFile: input.keyFile })).rejects.toThrow()
    await expect(new RelayClientConfigStore().save(input)).rejects.toThrow()
  })
})
describe('strict device control contracts', () => {
  it('rejects unknown fields, invalid dates, foreign private maps and omitted IDs', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const nonce = 'n'.repeat(32)
    const hello = { type: 'hello', protocolVersion: 2, backendId: 'test-device', displayName: 'Test', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), signature: sign(null, Buffer.from(relaySignaturePayload({ nonce, backendId: 'test-device', protocolVersion: 2, configVersion: 1 })), privateKey).toString('base64url'), configVersion: 1, capabilities: { http: true, websocket: true } }
    expect(hello.signature.length).toBe(86)
    expect(DeviceControlMessageSchema.safeParse({ type: 'policy.get' }).success).toBe(false)
    expect(DeviceControlMessageSchema.safeParse({ type: 'policy.get', requestId: nonce, backendId: 'other-device' }).success).toBe(false)
    expect(RelayControlMessageSchema.safeParse({ type: 'challenge', protocolVersion: 2, nonce, expiresAt: 'not-a-date' }).success).toBe(false)
    const accepted = { type: 'accepted', protocolVersion: 2, backendId: 'test-device', leaseId: nonce, configVersion: 1, heartbeatIntervalMs: 500, leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), tunnel: { httpService: 'http-' + nonce, websocketService: 'ws-' + nonce, token: nonce, httpBindAddr: '127.0.0.1:42000', websocketBindAddr: '127.0.0.1:43000' } }
    expect(RelayControlMessageSchema.safeParse(accepted).success).toBe(true)
    expect(RelayControlMessageSchema.safeParse({ ...accepted, tunnel: { ...accepted.tunnel, httpBindAddr: '10.2.3.6:39980' } }).success).toBe(false)
  })
})
