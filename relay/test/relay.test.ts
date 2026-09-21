import { once } from 'node:events'
import { generateKeyPairSync, sign } from 'node:crypto'
import { request } from 'node:http'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import { relaySignaturePayload } from '@chery/protocol/relay'
import { createRelayService } from '../src/server.js'
import { IdentityStore } from '../src/identityStore.js'
import { FixedWindowRateLimiter } from '../src/rateLimit.js'
import { RelayError } from '../src/errors.js'

const config = {
  host: '127.0.0.1',
  port: 0,
  publicBasePath: '/nyxus',
  publicOrigin: 'http://127.0.0.1:4080',
  sessionSecret: 'x'.repeat(32),
  sessionTtlSeconds: 300,
  challengeTtlMs: 2_000,
  heartbeatIntervalMs: 500,
  leaseTtlMs: 2_000,
  limits: {
    maxOnlineBackends: 10,
    maxControlConnections: 10,
    maxBrowserWebSockets: 10,
    maxWebSocketsPerBackend: 10,
    maxConcurrentHttp: 10,
    maxRequestBytes: 1024,
    requestsPerMinutePerIp: 100,
    upstreamTimeoutMs: 500,
  },
} as const

describe('relay control service', () => {
  it('authenticates a device, exposes minimal discovery and enforces session binding', async () => {
    const service = await createRelayService({
      config,
      identityStore: new IdentityStore(),
      adapter: {
        async forwardHttp(input) {
          const chunks: Buffer[] = []
          for await (const chunk of input.body) chunks.push(chunk)
          return {
            status: 200,
            headers: { 'x-backend': 'ok' },
            body: Buffer.concat(chunks),
          }
        },
        acceptWebSocket() {},
      },
      logger: () => undefined,
    })
    const address = await service.listen()
    const base = `http://127.0.0.1:${address.port}`
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')

    const socket = new WebSocket(`${base}/nyxus/control/backend`)
    const [challengeRaw] = await once(socket, 'message')
    const challenge = JSON.parse(String(challengeRaw)) as { nonce: string }
    const backendId = 'home-nyxus'
    const signature = sign(
      null,
      Buffer.from(relaySignaturePayload({ nonce: challenge.nonce, backendId, protocolVersion: 1, configVersion: 1 })),
      privateKey,
    ).toString('base64url')
    socket.send(JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      backendId,
      displayName: 'Home',
      publicKey: publicKeyDer,
      signature,
      configVersion: 1,
      capabilities: { http: true, websocket: true },
    }))
    const [acceptedRaw] = await once(socket, 'message')
    expect(JSON.parse(String(acceptedRaw)).type).toBe('accepted')

    const list = await getJson(`${base}/nyxus/api/backends`)
    expect(list.status).toBe(200)
    expect(list.body.backends[0]).toMatchObject({ backendId, status: 'online' })
    expect(list.body.backends[0]).not.toHaveProperty('fingerprint')

    const unauthenticated = await postJson(`${base}/nyxus/backend/${backendId}/api/echo`, 'x')
    expect(unauthenticated.status).toBe(403)
    const bound = await postJson(`${base}/nyxus/api/session/backend`, JSON.stringify({ backendId }))
    expect(bound.status).toBe(200)
    const cookie = String(bound.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''
    const proxied = await postJson(
      `${base}/nyxus/backend/${backendId}/api/echo`,
      'hello',
      { cookie },
    )
    expect(proxied.status).toBe(200)
    expect(proxied.body).toBe('hello')

    socket.close()
    await service.close()
  })
})

describe('relay primitives', () => {
  it('rejects a second key for a claimed Backend ID', async () => {
    const store = new IdentityStore()
    const first = Buffer.from('first')
    await store.claim({
      backendId: 'same-id',
      publicKeyDer: first,
      displayName: 'One',
      capabilities: { http: true, websocket: true },
      now: new Date(0),
    })
    await expect(
      store.claim({
        backendId: 'same-id',
        publicKeyDer: Buffer.from('second'),
        displayName: 'Two',
        capabilities: { http: true, websocket: true },
        now: new Date(0),
      }),
    ).rejects.toMatchObject({ code: 'BACKEND_ID_CONFLICT' })
    expect(await store.revoke('same-id')).toBe(true)
    expect(store.get('same-id')).toBeUndefined()
  })

  it('returns a retryable rate limit error', () => {
    const limiter = new FixedWindowRateLimiter(1, 100)
    limiter.consume('ip', 0)
    expect(() => limiter.consume('ip', 1)).toThrow(RelayError)
    try {
      limiter.consume('ip', 1)
    } catch (error) {
      expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 1 })
    }
  })
})

async function getJson(url: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function postJson(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: any }> {
  return await new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw.startsWith('{') ? JSON.parse(raw) : raw })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}
