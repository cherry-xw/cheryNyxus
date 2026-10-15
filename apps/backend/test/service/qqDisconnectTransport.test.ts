import { once } from 'node:events'
import { expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { BackendWire } from '../../../../platform/napcat-plugin/src/wire.js'

it('reports a transport close without reconnecting or issuing any RPC', async () => {
  const server = new WebSocketServer({ host: '0.0.0.0', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing LAN listener')
  let connections = 0
  const requests: string[] = []
  server.on('connection', socket => {
    connections++
    socket.on('message', data => requests.push(data.toString()))
  })
  const wire = new BackendWire(`ws://10.2.3.6:${address.port}`, 'synthetic-isolated-token')
  const notices: unknown[] = []
  wire.onMessage(message => notices.push(message))
  try {
    await wire.connect()
    expect(connections).toBe(1)
    for (const socket of server.clients) socket.close(1001, 'isolated backend replacement')
    await expect.poll(() => notices.length).toBe(1)
    expect(notices[0]).toEqual({ kind: 'notification', type: 'qq.connection.state', data: { state: 'disconnected' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(connections).toBe(1)
    expect(requests).toEqual([])
  } finally {
    wire.close()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
