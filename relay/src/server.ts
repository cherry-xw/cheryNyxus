import { createPublicKey, randomBytes, verify } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'
import {
  RELAY_PROTOCOL_VERSION,
  relaySignaturePayload,
  type RelayDiscovery,
  type RelayHello,
} from '@chery/protocol/relay'
import type { RelayTargetAdapter } from './adapter.js'
import { unavailableTargetAdapter } from './adapter.js'
import type { RelayConfig } from './config.js'
import { RelayError, asRelayError, relayErrorBody } from './errors.js'
import { IdentityStore } from './identityStore.js'
import type { RelayAuditLogger } from './logger.js'
import { jsonAuditLogger } from './logger.js'
import { FixedWindowRateLimiter } from './rateLimit.js'
import { BackendRegistry } from './registry.js'
import {
  backendSessionCookie,
  createBackendSession,
  readBackendSession,
} from './session.js'

const BACKEND_ID = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface CreateRelayServiceOptions {
  config: RelayConfig
  adapter?: RelayTargetAdapter
  identityStore?: IdentityStore
  logger?: RelayAuditLogger
}

export interface RelayService {
  registry: BackendRegistry
  listen(): Promise<AddressInfo>
  close(): Promise<void>
}

export async function createRelayService(options: CreateRelayServiceOptions): Promise<RelayService> {
  const { config } = options
  const adapter = options.adapter ?? unavailableTargetAdapter
  const audit = options.logger ?? jsonAuditLogger
  const identities = options.identityStore ?? new IdentityStore(config.identityFile)
  await identities.load()
  const registry = new BackendRegistry(identities, config)
  const limiter = new FixedWindowRateLimiter(config.limits.requestsPerMinutePerIp)
  const controlWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxRequestBytes })
  let activeHttp = 0

  const server = createServer((req, res) => {
    const startedAt = Date.now()
    const requestId = randomBytes(12).toString('base64url')
    let category: Parameters<RelayAuditLogger>[0]['pathCategory'] = 'unknown'
    let backendId: string | undefined
    handleHttp(req, res, requestId)
      .then((result) => {
        category = result.category
        backendId = result.backendId
      })
      .catch((error) => {
        const relayError = asRelayError(error)
        writeRelayError(res, relayError, requestId)
        category = routeCategory(req.url)
      })
      .finally(() => {
        audit({
          requestId,
          ...(backendId ? { backendId } : {}),
          pathCategory: category,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          ...(res.statusCode >= 400 ? { failureCategory: String(res.statusCode) } : {}),
        })
      })
  })

  controlWss.on('connection', (socket) => handleControlSocket(socket))

  server.on('upgrade', (req, socket, head) => {
    const requestId = randomBytes(12).toString('base64url')
    const startedAt = Date.now()
    try {
      limiter.consume(clientIp(req))
      const route = routePath(req.url, config.publicBasePath)
      if (route === '/control/backend') {
        if (controlWss.clients.size >= config.limits.maxControlConnections) {
          throw new RelayError('CAPACITY_EXCEEDED', 'Control connection capacity exceeded', 5)
        }
        controlWss.handleUpgrade(req, socket, head, (ws) => {
          controlWss.emit('connection', ws, req)
          audit({ requestId, pathCategory: 'control', status: 101, durationMs: Date.now() - startedAt })
        })
        return
      }
      const match = /^\/backend\/([^/]+)\/ws$/.exec(route)
      if (!match?.[1]) throw new RelayError('INVALID_REQUEST', 'WebSocket path is not allowed')
      const backendId = match[1]
      assertBackendId(backendId)
      requireBoundBackend(req, backendId)
      registry.requireOnline(backendId)
      const release = registry.acquireBrowserWebSocket(backendId)
      browserWss.handleUpgrade(req, socket, head, (client) => {
        client.once('close', release)
        const headers = forwardedHeaders(req.headers, requestId)
        Promise.resolve(
          adapter.acceptWebSocket({ requestId, backendId, path: '/ws', headers, client }),
        ).catch(() => client.close(1013, 'Backend unavailable'))
        audit({
          requestId,
          backendId,
          pathCategory: 'backend-ws',
          status: 101,
          durationMs: Date.now() - startedAt,
        })
      })
    } catch (error) {
      const relayError = asRelayError(error)
      writeUpgradeError(socket, relayError, requestId)
      audit({
        requestId,
        pathCategory: routeCategory(req.url),
        status: relayError.status,
        durationMs: Date.now() - startedAt,
        failureCategory: relayError.code,
      })
    }
  })

  const sweep = setInterval(() => registry.expire(), Math.min(config.heartbeatIntervalMs, 5_000))
  sweep.unref()

  async function handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<{ category: Parameters<RelayAuditLogger>[0]['pathCategory']; backendId?: string }> {
    const route = routePath(req.url, config.publicBasePath)
    if (route === '/healthz' && req.method === 'GET') {
      writeJson(res, 200, { status: 'ok' })
      return { category: 'health' }
    }
    limiter.consume(clientIp(req))
    if (route === '/api/backends' && req.method === 'GET') {
      writeJson(res, 200, { backends: registry.list() })
      return { category: 'list' }
    }
    const discovery = /^\/api\/backends\/([^/]+)$/.exec(route)
    if (discovery?.[1] && req.method === 'GET') {
      const backendId = discovery[1]
      assertBackendId(backendId)
      const summary = registry.requireOnline(backendId)
      writeJson(res, 200, discoveryFor(summary))
      return { category: 'discovery', backendId }
    }
    if (route === '/api/session/backend' && req.method === 'POST') {
      const body = await readJsonBody<{ backendId?: unknown }>(req, Math.min(config.limits.maxRequestBytes, 16 * 1024))
      if (typeof body.backendId !== 'string') throw new RelayError('INVALID_REQUEST', 'backendId is required')
      assertBackendId(body.backendId)
      const summary = registry.requireOnline(body.backendId)
      const value = createBackendSession(body.backendId, config.sessionSecret, config.sessionTtlSeconds)
      res.setHeader('Set-Cookie', backendSessionCookie({
        value,
        basePath: config.publicBasePath,
        secure: new URL(config.publicOrigin).protocol === 'https:',
        maxAge: config.sessionTtlSeconds,
      }))
      writeJson(res, 200, discoveryFor(summary))
      return { category: 'binding', backendId: body.backendId }
    }
    if (route === '/api/session/backend' && req.method === 'DELETE') {
      res.setHeader('Set-Cookie', backendSessionCookie({
        value: '',
        basePath: config.publicBasePath,
        secure: new URL(config.publicOrigin).protocol === 'https:',
        maxAge: 0,
      }))
      res.writeHead(204, { 'Cache-Control': 'no-store' })
      res.end()
      return { category: 'binding' }
    }
    const proxy = /^\/backend\/([^/]+)(\/api(?:\/.*)?)$/.exec(route)
    if (!proxy?.[1] || !proxy[2]) throw new RelayError('INVALID_REQUEST', 'Path is not allowed')
    const backendId = proxy[1]
    assertBackendId(backendId)
    assertSafeProxyUrl(req.url)
    requireBoundBackend(req, backendId)
    registry.requireOnline(backendId)
    if (activeHttp >= config.limits.maxConcurrentHttp) {
      throw new RelayError('CAPACITY_EXCEEDED', 'HTTP proxy capacity exceeded', 1)
    }
    const declaredLength = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declaredLength) && declaredLength > config.limits.maxRequestBytes) {
      throw new RelayError('REQUEST_TOO_LARGE', 'Request body is too large')
    }
    activeHttp += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.limits.upstreamTimeoutMs)
    try {
      const response = await adapter.forwardHttp({
        requestId,
        backendId,
        method: req.method ?? 'GET',
        path: proxy[2] + queryOf(req.url),
        headers: forwardedHeaders(req.headers, requestId),
        body: limitedBody(req, config.limits.maxRequestBytes, controller),
        signal: controller.signal,
      })
      writeProxyResponse(res, response.status, response.headers)
      if (response.body) {
        if (Symbol.asyncIterator in Object(response.body)) {
          for await (const chunk of response.body as AsyncIterable<Uint8Array>) res.write(chunk)
        } else {
          res.write(response.body)
        }
      }
      res.end()
      return { category: 'backend-api', backendId }
    } catch (error) {
      if (controller.signal.aborted) throw new RelayError('BACKEND_TIMEOUT', 'Backend response timed out')
      throw error
    } finally {
      clearTimeout(timer)
      activeHttp -= 1
    }
  }

  function handleControlSocket(socket: WebSocket): void {
    const requestId = randomBytes(12).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + config.challengeTtlMs
    let backendId: string | undefined
    let accepted = false
    socket.send(JSON.stringify({
      type: 'challenge',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      nonce,
      expiresAt: new Date(expiresAt).toISOString(),
    }))
    const timeout = setTimeout(() => socket.close(4003, 'Challenge expired'), config.challengeTtlMs)
    timeout.unref()

    socket.on('message', (data, isBinary) => {
      void (async () => {
        try {
          if (isBinary) throw new RelayError('INVALID_REQUEST', 'Control messages must be JSON text')
          const message = JSON.parse(data.toString()) as Record<string, unknown>
          if (!accepted) {
            if (Date.now() > expiresAt) throw new RelayError('BACKEND_AUTH_FAILED', 'Challenge expired')
            const hello = parseHello(message)
            backendId = hello.backendId
            if (registry.isOnline(backendId)) {
              throw new RelayError('BACKEND_ID_CONFLICT', 'Backend ID already has an active connection')
            }
            const publicKeyDer = decodeBase64url(hello.publicKey, 'publicKey')
            const publicKey = createPublicKey({ key: publicKeyDer, format: 'der', type: 'spki' })
            if (publicKey.asymmetricKeyType !== 'ed25519') {
              throw new RelayError('BACKEND_AUTH_FAILED', 'Device key must be Ed25519')
            }
            const signature = decodeBase64url(hello.signature, 'signature')
            const payload = relaySignaturePayload({
              nonce,
              backendId,
              protocolVersion: hello.protocolVersion,
              configVersion: hello.configVersion,
            })
            if (!verify(null, Buffer.from(payload), publicKey, signature)) {
              throw new RelayError('BACKEND_AUTH_FAILED', 'Device signature is invalid')
            }
            const identity = await identities.claim({
              backendId,
              publicKeyDer,
              displayName: hello.displayName,
              capabilities: hello.capabilities,
              now: new Date(),
            })
            const result = registry.register({
              identity,
              capabilities: hello.capabilities,
              socket,
              configVersion: hello.configVersion,
            })
            accepted = true
            clearTimeout(timeout)
            socket.send(JSON.stringify(result))
            return
          }
          if (message.type !== 'heartbeat' || typeof message.leaseId !== 'string' || !backendId) {
            throw new RelayError('INVALID_REQUEST', 'Expected heartbeat')
          }
          const leaseExpiresAt = registry.heartbeat(backendId, message.leaseId)
          socket.send(JSON.stringify({ type: 'heartbeat_ack', leaseId: message.leaseId, leaseExpiresAt }))
        } catch (error) {
          const relayError = error instanceof SyntaxError
            ? new RelayError('INVALID_REQUEST', 'Control message is not valid JSON')
            : asRelayError(error)
          socket.send(JSON.stringify({ type: 'error', ...relayErrorBody(relayError, requestId) }))
          socket.close(relayError.code === 'PROTOCOL_VERSION_UNSUPPORTED' ? 4006 : 4003, relayError.code)
        }
      })()
    })
    socket.once('close', () => {
      clearTimeout(timeout)
      if (backendId) registry.disconnect(backendId, socket)
    })
  }

  function discoveryFor(summary: ReturnType<BackendRegistry['requireOnline']>): RelayDiscovery {
    const root = `${config.publicBasePath}/backend/${summary.backendId}`
    return { ...summary, transport: 'binary', httpBasePath: root, wsPath: `${root}/ws` }
  }

  function requireBoundBackend(req: IncomingMessage, backendId: string): void {
    if (readBackendSession(req.headers.cookie, config.sessionSecret) !== backendId) {
      throw new RelayError('SESSION_BACKEND_MISMATCH', 'Session is not bound to this backend')
    }
  }

  function forwardedHeaders(headers: IncomingHttpHeaders, requestId: string): IncomingHttpHeaders {
    const result: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (
        HOP_BY_HOP.has(lower) ||
        lower === 'host' ||
        lower === 'forwarded' ||
        lower.startsWith('x-forwarded-') ||
        lower.startsWith('x-chery-relay-')
      ) continue
      result[lower] = value
    }
    const origin = new URL(config.publicOrigin)
    result.host = origin.host
    result['x-forwarded-host'] = origin.host
    result['x-forwarded-proto'] = origin.protocol.slice(0, -1)
    result['x-forwarded-prefix'] = config.publicBasePath || '/'
    result['x-chery-relay-request-id'] = requestId
    return result
  }

  return {
    registry,
    listen: () => new Promise<AddressInfo>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(config.port, config.host, () => {
        server.off('error', onError)
        resolve(server.address() as AddressInfo)
      })
    }),
    close: async () => {
      clearInterval(sweep)
      for (const client of controlWss.clients) client.close(1001, 'Relay shutting down')
      for (const client of browserWss.clients) client.close(1001, 'Relay shutting down')
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      controlWss.close()
      browserWss.close()
    },
  }
}

function parseHello(message: Record<string, unknown>): RelayHello {
  if (message.type !== 'hello') throw new RelayError('INVALID_REQUEST', 'Expected hello')
  if (message.protocolVersion !== RELAY_PROTOCOL_VERSION) {
    throw new RelayError('PROTOCOL_VERSION_UNSUPPORTED', 'Relay protocol version is unsupported')
  }
  if (typeof message.backendId !== 'string') throw new RelayError('INVALID_REQUEST', 'backendId is required')
  assertBackendId(message.backendId)
  if (typeof message.displayName !== 'string' || !message.displayName.trim() || message.displayName.length > 80) {
    throw new RelayError('INVALID_REQUEST', 'displayName must contain 1 to 80 characters')
  }
  if (typeof message.publicKey !== 'string' || typeof message.signature !== 'string') {
    throw new RelayError('INVALID_REQUEST', 'publicKey and signature are required')
  }
  if (!Number.isSafeInteger(message.configVersion) || Number(message.configVersion) < 1) {
    throw new RelayError('INVALID_REQUEST', 'configVersion must be a positive integer')
  }
  const capabilities = message.capabilities as Record<string, unknown> | undefined
  if (capabilities?.http !== true || capabilities.websocket !== true) {
    throw new RelayError('INVALID_REQUEST', 'HTTP and WebSocket capabilities are required')
  }
  return message as unknown as RelayHello
}

function assertBackendId(value: string): void {
  if (!BACKEND_ID.test(value)) throw new RelayError('INVALID_REQUEST', 'Backend ID format is invalid')
}

function decodeBase64url(value: string, name: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new RelayError('INVALID_REQUEST', `${name} is not base64url`)
  const decoded = Buffer.from(value, 'base64url')
  if (!decoded.length || decoded.toString('base64url') !== value) {
    throw new RelayError('INVALID_REQUEST', `${name} is not canonical base64url`)
  }
  return decoded
}

function routePath(rawUrl: string | undefined, basePath: string): string {
  const raw = rawUrl ?? '/'
  assertSafeProxyUrl(raw)
  const pathname = new URL(raw, 'http://relay.invalid').pathname
  if (!basePath) return pathname
  if (pathname === basePath) return '/'
  if (!pathname.startsWith(`${basePath}/`)) throw new RelayError('INVALID_REQUEST', 'Path is outside the public base path')
  return pathname.slice(basePath.length)
}

function assertSafeProxyUrl(rawUrl: string | undefined): void {
  const rawPath = (rawUrl ?? '/').split('?')[0] ?? '/'
  if (/%(?:2f|5c|00)/i.test(rawPath) || rawPath.includes('\\') || rawPath.includes('\0')) {
    throw new RelayError('INVALID_REQUEST', 'Encoded separators and NUL are not allowed')
  }
  for (const segment of rawPath.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      throw new RelayError('INVALID_REQUEST', 'Path encoding is invalid')
    }
    if (decoded === '.' || decoded === '..') throw new RelayError('INVALID_REQUEST', 'Path traversal is not allowed')
  }
}

function queryOf(rawUrl: string | undefined): string {
  const index = (rawUrl ?? '').indexOf('?')
  return index < 0 ? '' : (rawUrl ?? '').slice(index)
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes: number): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new RelayError('REQUEST_TOO_LARGE', 'Request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new RelayError('INVALID_REQUEST', 'Request body is not valid JSON')
  }
}

async function* limitedBody(
  req: IncomingMessage,
  maxBytes: number,
  controller: AbortController,
): AsyncGenerator<Buffer> {
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) {
      controller.abort()
      throw new RelayError('REQUEST_TOO_LARGE', 'Request body is too large')
    }
    yield buffer
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function writeRelayError(res: ServerResponse, error: RelayError, requestId: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  if (error.retryAfterSeconds !== undefined) res.setHeader('Retry-After', error.retryAfterSeconds)
  writeJson(res, error.status, relayErrorBody(error, requestId))
}

function writeProxyResponse(res: ServerResponse, status: number, headers: IncomingHttpHeaders = {}): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    res.setHeader(name, value)
  }
  res.statusCode = status
}

function writeUpgradeError(
  socket: import('node:stream').Duplex,
  error: RelayError,
  requestId: string,
): void {
  const body = JSON.stringify(relayErrorBody(error, requestId))
  socket.end([
    `HTTP/1.1 ${error.status} ${error.message}`,
    'Content-Type: application/json; charset=utf-8',
    'Cache-Control: no-store',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n'))
}

function routeCategory(rawUrl: string | undefined): Parameters<RelayAuditLogger>[0]['pathCategory'] {
  const path = rawUrl ?? ''
  if (path.includes('/control/backend')) return 'control'
  if (path.includes('/api/backends')) return 'discovery'
  if (path.includes('/api/session/backend')) return 'binding'
  if (/\/backend\/[^/]+\/api/.test(path)) return 'backend-api'
  if (/\/backend\/[^/]+\/ws/.test(path)) return 'backend-ws'
  return 'unknown'
}
