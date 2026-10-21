import { once } from 'node:events'
import { generateKeyPairSync, sign } from 'node:crypto'
import { request } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { describe, expect, it, onTestFinished } from 'vitest'
import { RELAY_PROTOCOL_VERSION, relaySignaturePayload } from '@chery/protocol/relay'
import { createRelayService } from '../src/server.js'
import { IdentityStore } from '../src/identityStore.js'
import { FixedWindowRateLimiter } from '../src/rateLimit.js'
import { RelayError } from '../src/errors.js'
import { AuthorizationStore } from '../src/authorizationStore.js'

const config = {
  host: '0.0.0.0',
  port: 0,
  publicBasePath: '/nyxus',
  publicOrigin: 'http://10.2.3.6:4080',
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
  it.each([
    { protocolVersion: 1, invalidSignature: false, code: 'PROTOCOL_VERSION_UNSUPPORTED', closeCode: 4006 },
    { protocolVersion: RELAY_PROTOCOL_VERSION, invalidSignature: true, code: 'BACKEND_AUTH_FAILED', closeCode: 4003 },
  ])('rejects hello with version $protocolVersion and invalid signature $invalidSignature', async ({ protocolVersion, invalidSignature, code, closeCode }) => {
    const identities = new IdentityStore()
    const service = await createRelayService({ config, identityStore: identities, logger: () => undefined })
    let socket: WebSocket | undefined
    try {
      const address = await service.listen()
      socket = new WebSocket(`ws://10.2.3.6:${address.port}/nyxus/control/backend`)
      const [challengeRaw] = await once(socket, 'message')
      const challenge = JSON.parse(String(challengeRaw)) as { nonce: string; protocolVersion: number }
      expect(challenge.protocolVersion).toBe(RELAY_PROTOCOL_VERSION)
      const { publicKey, privateKey } = generateKeyPairSync('ed25519')
      const backendId = 'rejected-device'
      const signature = sign(null, Buffer.from(relaySignaturePayload({
        nonce: invalidSignature ? 'wrong-nonce' : challenge.nonce,
        backendId,
        protocolVersion,
        configVersion: 1,
      })), privateKey).toString('base64url')
      const response = once(socket, 'message')
      const closed = once(socket, 'close')
      socket.send(JSON.stringify({
        type: 'hello',
        protocolVersion,
        backendId,
        displayName: 'Rejected device',
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        signature,
        configVersion: 1,
        capabilities: { http: true, websocket: true },
      }))
      const [errorRaw] = await response
      expect(JSON.parse(String(errorRaw))).toMatchObject({ type: 'error', error: { code } })
      const [actualCloseCode, reason] = await closed
      expect(actualCloseCode).toBe(closeCode)
      expect(String(reason)).toBe(code)
      expect(identities.get(backendId)).toBeUndefined()
      expect(service.registry.isOnline(backendId)).toBe(false)
    } finally {
      socket?.terminate()
      await service.close()
    }
  })

  it.each([false, true])('authenticates a device and enforces discovery/password policy enabled=%s', async (enabled) => {
    const root = await mkdtemp(join(tmpdir(), 'nyxus-relay-policy-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    const authorizationFile = join(root, 'authorizations.json')
    const policies = new AuthorizationStore(authorizationFile)
    await policies.setBackendPolicy({
      backendId: 'home-nyxus',
      publicDiscovery: enabled,
      remotePasswordEnabled: enabled,
    })
    const service = await createRelayService({
      config: { ...config, authorizationFile },
      identityStore: new IdentityStore(),
      adapter: {
        async forwardHttp(input) {
          if (input.path === '/api/auth/challenge') return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ challengeId: 'synthetic-challenge', nonce: 'synthetic-nonce' })) }
          if (input.path === '/api/auth/login') return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh' })) }
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
    onTestFinished(() => service.close())
    const base = `http://10.2.3.6:${address.port}`
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')

    const socket = new WebSocket(`${base}/nyxus/control/backend`)
    onTestFinished(() => socket.terminate())
    const [challengeRaw] = await once(socket, 'message')
    const challenge = JSON.parse(String(challengeRaw)) as { nonce: string; protocolVersion: number }
    expect(RELAY_PROTOCOL_VERSION).toBe(2)
    expect(challenge.protocolVersion).toBe(RELAY_PROTOCOL_VERSION)
    const backendId = 'home-nyxus'
    const signature = sign(
      null,
      Buffer.from(relaySignaturePayload({ nonce: challenge.nonce, backendId, protocolVersion: RELAY_PROTOCOL_VERSION, configVersion: 1 })),
      privateKey,
    ).toString('base64url')
    socket.send(JSON.stringify({
      type: 'hello',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      backendId,
      displayName: 'Home',
      publicKey: publicKeyDer,
      signature,
      configVersion: 1,
      capabilities: { http: true, websocket: true },
    }))
    const [acceptedRaw] = await once(socket, 'message')
    expect(JSON.parse(String(acceptedRaw))).toMatchObject({
      type: 'accepted',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      backendId,
    })

    const ready = once(socket, 'message')
    const lease = JSON.parse(String(acceptedRaw))
    socket.send(JSON.stringify({ type: 'tunnel.applied', leaseId: lease.leaseId, probeToken: 'synthetic-probe-token' }))
    expect(JSON.parse(String((await ready)[0])).type).toBe('tunnel.ready')

    const list = await getJson(`${base}/nyxus/api/backends`)
    expect(list.status).toBe(200)
    if (enabled) {
      expect(list.body.backends).toHaveLength(1)
      expect(list.body.backends[0]).toMatchObject({ backendId, status: 'online' })
      expect(list.body.backends[0]).not.toHaveProperty('fingerprint')
    } else {
      expect(list.body.backends).toEqual([])
      const discovery = await getJson(`${base}/nyxus/api/backends/${backendId}`)
      expect(discovery.status).toBe(404)
      expect(discovery.body.error.code).toBe('PUBLIC_DISCOVERY_DISABLED')
    }

    const unauthenticated = await postJson(`${base}/nyxus/backend/${backendId}/api/echo`, 'x')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.body.error.code).toBe('SESSION_EXPIRED')
    // Old route-only cookies are deliberately removed; only authenticated sessions proxy.
    const old = await postJson(`${base}/nyxus/api/session/backend`, JSON.stringify({ backendId }))
    expect(old.status).toBe(400)
    const capabilities = await getJson(`${base}/nyxus/api/auth/capabilities`)
    const cookie = String(capabilities.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''
    const login = await postJson(`${base}/nyxus/api/browser-session/password`, JSON.stringify({ backendId, username: 'synthetic-user', password: 'synthetic-password', operationId: 'o'.repeat(32) }), { cookie, origin: config.publicOrigin, 'x-csrf-token': capabilities.body.csrfToken })
    expect(login.status).toBe(enabled ? 200 : 403)
    if (!enabled) return
    const sessionCookie = String(login.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? ''
    const proxied = await postJson(`${base}/nyxus/backend/${backendId}/api/echo`, 'hello', { cookie: sessionCookie, origin: config.publicOrigin, 'x-csrf-token': login.body.csrfToken })
    expect(proxied.status).toBe(200)
    expect(proxied.body).toBe('hello')
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
