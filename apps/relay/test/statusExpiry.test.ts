import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayClientStatusSchema } from '@chery/protocol'
import { RelayBackendClient } from '../src/client.js'

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  sent: Array<Record<string, unknown>> = []
  receive(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
  send(raw: string) {
    const value = JSON.parse(raw); this.sent.push(value)
    if (value.type === 'tunnel.applied') this.receive({ type: 'tunnel.ready', leaseId: value.leaseId })
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit('close') }
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'relay-status-expiry-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const sockets: Socket[] = []
  const file = join(root, 'status.json')
  const client = new RelayBackendClient({ url: 'ws://synthetic.invalid/control/backend', backendId: 'test-device', displayName: 'Test', configVersion: 1,
    desiredRevision: 'revision-a', keyFile: join(root, 'key.json'), statusFile: file, ratholeServerAddr: 'relay.example:2333', ratholeConfigPath: join(root, 'client.toml'),
    tunnelAddresses: { httpLocalAddr: '127.0.0.1:8183', websocketLocalAddr: '127.0.0.1:8182' }, tunnelBindAddresses: { httpBindAddr: '127.0.0.1:42000', wsBindAddr: '127.0.0.1:43000' },
    encryptedTransport: '[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = "' + Buffer.alloc(32, 7).toString('base64') + '"\n',
    probeToken: () => 'p'.repeat(32), reconnectMinMs: 1,
    webSocketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket },
    ratholeProcessFactory: () => ({ process: new EventEmitter() as ChildProcess, stop: async () => {} }),
  })
  cleanup.push(() => client.stop())
  await client.start()
  const read = async () => RelayClientStatusSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const accepted = (id: string, leaseExpiresAt: string) => ({ type: 'accepted', protocolVersion: 2, backendId: 'test-device', configVersion: 1,
    leaseId: id.repeat(32), leaseExpiresAt, heartbeatIntervalMs: 100,
    tunnel: { httpService: 'h'.repeat(32), websocketService: 'w'.repeat(32), token: 't'.repeat(32), httpBindAddr: '127.0.0.1:42000', websocketBindAddr: '127.0.0.1:43000' } })
  return { client, sockets, read, accepted }
}
it('persists only confirmed expiry; sending heartbeats and stale acknowledgments do not renew it', async () => {
  const f = await fixture(), expiry = new Date(Date.now() + 45_000).toISOString()
  f.sockets[0]!.receive(f.accepted('a', expiry))
  await vi.waitFor(async () => expect(await f.read()).toMatchObject({ protocolVersion: 3, status: 'online', leaseExpiresAt: expiry }))
  await vi.waitFor(() => expect(f.sockets[0]!.sent.some(message => message.type === 'heartbeat')).toBe(true))
  expect((await f.read()).leaseExpiresAt).toBe(expiry)
  const renewed = new Date(Date.now() + 90_000).toISOString()
  f.sockets[0]!.receive({ type: 'heartbeat_ack', leaseId: 'a'.repeat(32), leaseExpiresAt: renewed })
  await vi.waitFor(async () => expect((await f.read()).leaseExpiresAt).toBe(renewed))
  f.sockets[0]!.receive({ type: 'heartbeat_ack', leaseId: 'z'.repeat(32), leaseExpiresAt: new Date(Date.now() + 180_000).toISOString() })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect((await f.read()).leaseExpiresAt).toBe(renewed)
  await f.client.stop()
  expect(await f.read()).toMatchObject({ status: 'stopped' })
  expect(await f.read()).not.toHaveProperty('leaseExpiresAt')
})
it('does not carry expiry or accept ready/renewal events from a disconnected instance', async () => {
  const f = await fixture(), first = f.sockets[0]!, expiry = new Date(Date.now() + 45_000).toISOString()
  first.receive(f.accepted('a', expiry))
  await vi.waitFor(async () => expect((await f.read()).status).toBe('online'))
  first.close()
  await vi.waitFor(() => expect(f.sockets).toHaveLength(2))
  await vi.waitFor(async () => expect(await f.read()).not.toHaveProperty('leaseExpiresAt'))
  f.sockets[1]!.receive(f.accepted('b', expiry))
  await vi.waitFor(async () => expect(await f.read()).toMatchObject({ status: 'online', leaseId: 'b'.repeat(32) }))
  first.receive({ type: 'heartbeat_ack', leaseId: 'a'.repeat(32), leaseExpiresAt: new Date(Date.now() + 180_000).toISOString() })
  first.receive({ type: 'tunnel.ready', leaseId: 'a'.repeat(32) })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await f.read()).toMatchObject({ leaseId: 'b'.repeat(32), leaseExpiresAt: expiry })
})
