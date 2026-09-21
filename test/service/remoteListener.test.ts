import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { hashPassword } from '@/utils/password.js'
import { OAuth2Auth } from '@/service/auth/index.js'
import { createHttpServer } from '@/service/http/index.js'
import { createRouter } from '@/service/message/router.js'
import { createWebSocketServer } from '@/service/websocket/index.js'

const servers: Array<ReturnType<typeof createHttpServer>> = []
const sockets: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve()
            return
          }
          server.close(() => resolve())
        }),
    ),
  )
  await Promise.all(
    sockets.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve()
            return
          }
          server.close(() => resolve())
        }),
    ),
  )
})

describe('remote listener authentication boundary', () => {
  it('does not grant loopback bypass to the remote HTTP listener', async () => {
    const auth = new OAuth2Auth({ username: 'admin', password: hashPassword('secret') })
    const remote = createHttpServer({
      webPort: 0,
      host: '127.0.0.1',
      auth,
      listener: 'remote',
    })
    servers.push(remote)
    await waitForListening(remote)

    const port = (remote.address() as { port: number }).port
    const config = await fetch(`http://127.0.0.1:${port}/api/config`)
    expect(config.status).toBe(401)

    const capabilities = await fetch(`http://127.0.0.1:${port}/api/auth/capabilities`)
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toEqual({ password: true, oidc: false })

    const tokens = auth.authenticate('admin', 'secret')
    expect(tokens).not.toBeNull()
    const discovered = await fetch(`http://127.0.0.1:${port}/api/config`, {
      headers: {
        Authorization: `Bearer ${tokens?.accessToken ?? ''}`,
        'x-forwarded-prefix': '/nyxus',
      },
    })
    const body = (await discovered.json()) as Record<string, unknown>
    expect(discovered.status).toBe(200)
    expect(body.remote).toBe(true)
    expect(body.publicBasePath).toBe('/nyxus')
    expect(body.wsPort).toBeUndefined()
    expect(body.webPort).toBeUndefined()
  })

  it('keeps the local loopback compatibility behavior', async () => {
    const auth = new OAuth2Auth({ username: 'admin', password: hashPassword('secret') })
    const local = createHttpServer({
      webPort: 0,
      host: '127.0.0.1',
      auth,
      listener: 'local',
    })
    servers.push(local)
    await waitForListening(local)

    const port = (local.address() as { port: number }).port
    const config = await fetch(`http://127.0.0.1:${port}/api/config`)
    expect(config.status).toBe(200)
    expect((await config.json()).sessionToken).toBeUndefined()
  })

  it('shares account cooldown state across both listener policies', () => {
    const auth = new OAuth2Auth({ username: 'admin', password: hashPassword('secret') })
    for (let attempt = 0; attempt < 15; attempt += 1) {
      expect(auth.authenticate('admin', 'wrong')).toBeNull()
    }
    expect(auth.passwordRetryAfter('admin')).toBeGreaterThan(0)
  })

  it('requires authentication on the remote WebSocket listener', async () => {
    const auth = new OAuth2Auth({ username: 'admin', password: hashPassword('secret') })
    const wss = createWebSocketServer({
      port: 0,
      host: '127.0.0.1',
      router: createRouter(),
      auth,
      listener: 'remote',
      allowedOrigins: ['http://127.0.0.1:1'],
    })
    sockets.push(wss)
    await waitForListening(wss)
    const port = (wss.address() as { port: number }).port

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Origin: 'http://127.0.0.1:1' },
      })
      socket.once('open', () =>
        reject(new Error('remote WebSocket unexpectedly accepted an anonymous connection')),
      )
      socket.once('unexpected-response', (_request, response) => {
        try {
          expect(response.statusCode).toBe(401)
          resolve()
        } catch (error) {
          reject(error)
        }
      })
      socket.once('error', () => undefined)
    })
  })
})

function waitForListening(server: {
  listening: boolean
  once(event: 'listening', listener: () => void): void
}): Promise<void> {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve) => server.once('listening', resolve))
}
