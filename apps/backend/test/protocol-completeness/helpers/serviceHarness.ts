import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { closeAllDbs } from '@/db/index.js'
import {
  startService,
  type ServiceHandle,
} from '@/service/index.js'
import { closeAllConnections } from '@/service/websocket/index.js'
import { selectBusinessProtocols } from '@chery/protocol'
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
    host: '0.0.0.0',
    auth: { username: 'protocol-user', password: (await import('@/utils/password.js')).hashPassword('synthetic-protocol-password') },
  })
  await waitForListening(handle)
  const wsPort = addressedPort(handle.wss.address())
  const webPort = addressedPort(handle.httpServer.address())
  const base = `http://10.2.3.6:${webPort}`
  const discovery = await fetch(base + '/api/auth/capabilities'); const context = await discovery.json() as any
  const login = await fetch(base + '/api/browser-session/password', { method: 'POST', headers: { Cookie: discovery.headers.get('set-cookie')!.split(';')[0]!, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': context.csrfToken }, body: JSON.stringify({ username: 'protocol-user', password: 'synthetic-protocol-password', operationId: 'p'.repeat(32) }) })
  const session = await login.json() as any
  const ticketResponse = await fetch(base + '/api/browser-session/ws-ticket', { method: 'POST', headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ expectedRevision: session.revision }) })
  const ticket = await ticketResponse.json() as any
  const configResponse = await fetch(base + '/api/config', { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0]! } })
  if (!configResponse.ok) throw new Error(`Config rejected: ${configResponse.status}`)
  const discovered = await configResponse.json() as any
  const selected = selectBusinessProtocols(discovered.bootstrap)
  const client = new RpcClient({
    url: `ws://10.2.3.6:${wsPort}/?` + new URLSearchParams({ ticket: ticket.ticket, ...Object.fromEntries(Object.entries(selected).map(([key, value]) => [key, String(value)])) }),
    // startService builds its allow-list before an ephemeral port is assigned.
    origin: base,
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
