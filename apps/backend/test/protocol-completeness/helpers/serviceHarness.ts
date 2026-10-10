import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { closeAllDbs } from '@/db/index.js'
import {
  startService,
  type ServiceHandle,
} from '@/service/index.js'
import { closeAllConnections } from '@/service/websocket/index.js'
import { RpcClient } from '@test/helpers/rpcClient.js'

let bootstrapped = false

export interface ProtocolService {
  handle: ServiceHandle
  client: RpcClient
  close(): Promise<void>
}

export async function bootProtocolService(): Promise<ProtocolService> {
  if (!bootstrapped) {
    await bootstrapAgentRuntime()
    bootstrapped = true
  }
  const token = 'protocol-completeness-token'
  const handle = startService({
    port: 0,
    webPort: 0,
    staticDir: process.env.CHERY_DIR,
    sessionToken: token,
    host: '127.0.0.1',
  })
  await waitForListening(handle)
  const wsPort = addressedPort(handle.wss.address())
  const client = new RpcClient({
    url: `ws://127.0.0.1:${wsPort}/?token=${token}`,
    // startService builds its allow-list before an ephemeral port is assigned.
    origin: 'http://127.0.0.1:0',
  })
  await client.connect()

  return {
    handle,
    client,
    close: async () => {
      client.close()
      closeAllConnections(handle.wss)
      await new Promise<void>((resolve) => handle.wss.close(() => resolve()))
      await new Promise<void>((resolve) => handle.httpServer.close(() => resolve()))
      handle.stopSchedule()
      closeAllDbs()
    },
  }
}

function waitForListening(handle: ServiceHandle): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let remaining = 2
    const done = (error?: Error) => {
      if (error) reject(error)
      else if (--remaining === 0) resolve()
    }
    handle.wss.on('listening', () => done())
    handle.wss.on('error', done)
    if (handle.httpServer.listening) done()
    else {
      handle.httpServer.once('listening', () => done())
      handle.httpServer.once('error', done)
    }
  })
}

function addressedPort(address: { port?: number } | string | null): number {
  if (address && typeof address === 'object' && typeof address.port === 'number') {
    return address.port
  }
  throw new Error('protocol service did not bind a WebSocket port')
}

export async function waitFor<T>(
  inspect: () => T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = inspect()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out after ${timeoutMs}ms`)
}
