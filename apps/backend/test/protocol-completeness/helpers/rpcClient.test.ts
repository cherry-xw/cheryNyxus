import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcClient } from '@test/helpers/rpcClient.js'

interface WireRequest {
  id: string
  kind: 'request'
  method: string
  params: unknown
}

describe('RpcClient correlation journal', () => {
  let server: WebSocketServer
  let client: RpcClient
  const sockets = new Set<WebSocket>()
  let onRequest: (socket: WebSocket, request: WireRequest) => void

  beforeEach(async () => {
    onRequest = (socket, request) => {
      socket.send(JSON.stringify({
        kind: 'response',
        requestId: request.id,
        success: true,
        data: { method: request.method },
      }))
    }
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('message', (raw) => {
        onRequest(socket, JSON.parse(raw.toString()) as WireRequest)
      })
    })
    await once(server, 'listening')
    const address = server.address() as AddressInfo
    client = new RpcClient({
      url: `ws://127.0.0.1:${address.port}`,
      origin: 'http://127.0.0.1:0',
    })
    await client.connect()
  })

  afterEach(async () => {
    client.close()
    for (const socket of sockets) socket.terminate()
    sockets.clear()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('releases unary call correlation after its response settles', async () => {
    expect(client.pendingCount).toBe(0)
    const response = await client.call('test.unary', { value: 1 })
    expect(response.success).toBe(true)
    expect(client.pendingCount).toBe(0)
  })

  it('retains streaming request correlation until explicit release', async () => {
    onRequest = (socket, request) => {
      socket.send(JSON.stringify({
        kind: 'response',
        requestId: request.id,
        success: true,
        data: {},
      }))
      setTimeout(() => socket.send(JSON.stringify({
        kind: 'notification',
        type: 'test.event',
        requestId: request.id,
        data: { value: 1 },
      })), 0)
    }

    const handle = client.request('test.stream', {})
    await client.awaitResponse(handle)
    await waitFor(() => handle.events.length === 1)

    expect(client.pendingCount).toBe(1)
    expect(handle.events).toHaveLength(1)
    client.release(handle)
    expect(client.pendingCount).toBe(0)
  })

  it('records each inbound event once before projecting it to a request handle', async () => {
    onRequest = (socket, request) => {
      socket.send(JSON.stringify({
        kind: 'response',
        requestId: request.id,
        success: true,
        data: {},
      }))
      setTimeout(() => socket.send(JSON.stringify({
        kind: 'notification',
        type: 'test.event',
        requestId: request.id,
        data: { marker: 'one' },
      })), 0)
    }

    const handle = client.request('test.journal', {})
    await client.awaitResponse(handle)
    await waitFor(() => client.received.length === 1)

    expect(client.received).toHaveLength(1)
    expect(handle.events).toHaveLength(1)
    expect(client.received[0]).toBe(handle.events[0])
    client.release(handle)
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`condition timed out after ${timeoutMs}ms`)
}
