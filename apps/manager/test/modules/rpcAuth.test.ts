import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { BackendRpcClient } from '../../src/modules/capabilities/rpc.js'

// Real local HTTP/WS transport, synthetic credentials; no running backend involved.
describe('backend authentication failures are not Manager session failures', () => {
  it.each([
    { username: '' },
    { username: 'synthetic' },
    { username: 'synthetic', password: 'synthetic-secret', consistent: false },
  ])('rejects missing or inconsistent credentials before connecting: %j', async (credentials) => {
    const rpc = new BackendRpcClient({
      target: async () => ({ http: 'http://127.0.0.1:1', ws: 'ws://127.0.0.1:1' }),
      credentials: async () => credentials,
    })
    try {
      await expect(rpc.call('qq.config.save')).rejects.toMatchObject({
        code: 'backend_auth_failed',
        status: 502,
      })
    } finally {
      rpc.close()
    }
  })

  const cases = [
    { stage: 'login', status: 401 },
    { stage: 'login', status: 403 },
    { stage: 'login', status: 429 },
    { stage: 'ws', status: 401 },
    { stage: 'ws', status: 403 },
    { stage: 'rpc', code: 'UNAUTHORIZED' },
    { stage: 'rpc', code: 'FORBIDDEN' },
  ] as const
  it.each(cases)(
    'safely classifies $stage rejection $status $code without retries',
    async (failure) => {
      let challenges = 0
      let logins = 0
      let upgrades = 0
      let calls = 0
      const server = createServer((req, res) => {
        req.resume()
        const stage = req.url === '/api/machine/login' ? 'login' : 'unknown'
        if (stage === 'challenge') challenges++
        else logins++
        if (stage === failure.stage && 'status' in failure) {
          res.writeHead(failure.status)
          res.end('private-upstream-diagnostic synthetic-secret')
        } else {
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify(
              stage === 'challenge'
                ? { challengeId: 'synthetic-challenge', nonce: 'a'.repeat(48) }
                : { accessToken: 'synthetic-token' },
            ),
          )
        }
      })
      const ws = new WebSocketServer({ noServer: true })
      server.on('upgrade', (req, socket, head) => {
        upgrades++
        if (failure.stage === 'ws') {
          socket.end(
            `HTTP/1.1 ${failure.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
          )
          return
        }
        ws.handleUpgrade(req, socket, head, (client) => {
          client.on('message', (raw) => {
            calls++
            const request = JSON.parse(raw.toString())
            client.send(
              JSON.stringify({
                kind: 'response',
                requestId: request.id,
                success: false,
                error: {
                  code: failure.stage === 'rpc' ? failure.code : 'INTERNAL_ERROR',
                  message: 'private-upstream-diagnostic synthetic-secret',
                },
              }),
            )
          })
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port
      const rpc = new BackendRpcClient({
        target: async () => ({ http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` }),
        credentials: async () => ({ username: 'synthetic', password: 'synthetic-secret' }),
        timeoutMs: 1000,
      })
      try {
        for (const method of ['config.save', 'qq.config.save'] as const) {
          const error = await rpc.call(method).catch((error: unknown) => error)
          expect(error).toMatchObject({ code: 'backend_auth_failed', status: 502 })
          expect(String(error)).not.toContain('synthetic-secret')
          expect(String(error)).not.toContain('private-upstream-diagnostic')
        }
        expect(challenges).toBe(0)
        expect(logins).toBe(2)
        expect(upgrades).toBe(['ws', 'rpc'].includes(failure.stage) ? 2 : 0)
        expect(calls).toBe(failure.stage === 'rpc' ? 2 : 0)
      } finally {
        rpc.close()
        for (const client of ws.clients) client.terminate()
        await new Promise<void>((resolve) => ws.close(() => resolve()))
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    },
  )
})
