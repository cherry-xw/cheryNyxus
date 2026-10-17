import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { BackendWire } from '../src/wire.js'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

const resources: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of resources.reverse().splice(0)) await close() })
it('backend wire uses real project envelopes, header auth, binary notifications and reconnect', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening')
  resources.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const frames: any[] = []; const headers: any[] = []
  server.on('connection', (socket, req) => {
    headers.push(req.headers)
    socket.on('message', raw => {
      const frame = JSON.parse(raw.toString()); frames.push(frame)
      if (frame.kind === 'ping') socket.send(JSON.stringify({ kind: 'pong' }))
      else {
        socket.send(JSON.stringify({ kind: 'response', requestId: frame.id, success: true, data: { observed: frame.method } }))
        socket.send(Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ kind: 'notification', type: 'qq.tool.icon', data: { eventId: 'same' } }))]))
      }
    })
  })
  const wire = new BackendWire(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, 'synthetic-token-123', 100)
  resources.push(() => wire.close())
  const events: any[] = []; let opens = 0
  wire.onMessage(f => { if ('kind' in f && f.kind === 'notification') { if (f.type === 'qq.connection.state') { if (f.data.state === 'connected') opens++ } else events.push(f) } })
  await wire.connect()
  await vi.waitFor(() => expect(opens).toBe(1))
  expect(await wire.request('qq.plugin.hello', {})).toMatchObject({ success: true, data: { observed: 'qq.plugin.hello' } })
  await vi.waitFor(() => expect(events).toHaveLength(1))
  for (const socket of server.clients) socket.terminate()
  await vi.waitFor(() => expect(opens).toBe(2), { timeout: 2000 })
  await wire.request('qq.plugin.hello', {}); await vi.waitFor(() => expect(events).toHaveLength(2))
  expect(frames[0]).toMatchObject({ kind: 'request', method: 'qq.plugin.hello' }); expect(typeof frames[0].id).toBe('string'); expect(frames[0]).not.toHaveProperty('requestId')
  expect(headers[0]['x-qqbot-token']).toBe('synthetic-token-123'); expect(headers[0].origin).toMatch(/^http:\/\/127.0.0.1:/)
})
it('wire keeps pending RPC alive until transport closes', async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening')
  resources.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const wire = new BackendWire(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, 'synthetic-token-123', 30)
  resources.push(() => wire.close()); await wire.connect()
  const pending = wire.request('qq.delivery.result', {})
  let settled = false; void pending.then(() => { settled = true }, () => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(settled).toBe(false)
  wire.close()
  await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
})
