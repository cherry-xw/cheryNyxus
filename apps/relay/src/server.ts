import { RatholeLeaseManager, confirmPrivateListeners, verifyPrivateListeners } from './ratholeLeaseManager.js'
import { RelayBrowserSessions } from './browserSessions.js'
import { readSessionCookie } from './browserSessionStore.js'
import { UserProofSigner } from './userProof.js'
import { BusinessOidc } from './oidc.js'
import { BootstrapSchema, readBusinessSelection, DeviceBindingRequestSchema, DeviceControlMessageSchema, RelayHelloSchema } from '@chery/protocol'
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
import type { RelayConfig } from './config.js'
import { RelayError, asRelayError, relayErrorBody } from './errors.js'
import { IdentityStore } from './identityStore.js'
import type { RelayAuditLogger } from './logger.js'
import { jsonAuditLogger } from './logger.js'
import { FixedWindowRateLimiter } from './rateLimit.js'
import { BackendRegistry } from './registry.js'
import { AuthorizationStore } from './authorizationStore.js'
import { LoopbackTunnelAdapter } from './tunnelAdapter.js'

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
  leaseManager?: Pick<RatholeLeaseManager, 'initialize' | 'add' | 'remove'>
}

export interface RelayService {
  registry: BackendRegistry
  listen(): Promise<AddressInfo>
  close(): Promise<void>
}

export async function createRelayService(options: CreateRelayServiceOptions): Promise<RelayService> {
  const { config } = options
  const audit = options.logger ?? jsonAuditLogger
  const identities = options.identityStore ?? new IdentityStore(config.identityFile)
  await identities.load()
  const authorizations = new AuthorizationStore(config.authorizationFile, { confirmationBaseUrl: config.publicOrigin + config.publicBasePath, currentFingerprint: (id) => identities.get(id)?.fingerprint })
  await authorizations.load()
  const registry = new BackendRegistry(identities, config)
  const authorizationSync = new Map<string, string>()
  const authorizationDirty = new Set<string>()
  function synchronizeAuthorizations(backendId: string): void {
    const socket = registry.authorizationSocket(backendId)
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (authorizationSync.has(backendId)) { authorizationDirty.add(backendId); return }
    const revision = randomBytes(24).toString('base64url'); authorizationSync.set(backendId, revision)
    socket.send(JSON.stringify({ type: 'authorizations.snapshot', revision, authorizations: authorizations.listAuthorizationsForBackend(backendId).map((a) => ({ id: a.bindingId, revision: a.revision ?? 1, subject: a.identity.subject })) }))
  }
  const adapter = options.adapter ?? new LoopbackTunnelAdapter(registry)
  const signer = config.userProof ? new UserProofSigner(config.userProof.issuer, config.userProof.kid, config.userProof.privateKeyPem) : undefined
  const browser = new RelayBrowserSessions(config, registry, authorizations, adapter, signer, authorizationSync)
  const tunnels = options.leaseManager ?? (config.rathole ? new RatholeLeaseManager(config.rathole.configFile, config.rathole.bindAddr, confirmPrivateListeners, config.rathole.transport) : undefined)
  await tunnels?.initialize()
  const limiter = new FixedWindowRateLimiter(config.limits.requestsPerMinutePerIp)
  const controlWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxRequestBytes })
  const oidc = config.oidc ? new BusinessOidc(config.oidc, config.publicBasePath) : undefined
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
       if (req.headers.origin !== config.publicOrigin) throw new RelayError('USER_BACKEND_FORBIDDEN', 'Origin rejected')
       const incoming = new URL(req.url ?? '/', config.publicOrigin)
       const allowed = new Set(['ticket', 'profile', 'v', 'maxFrameBytes', 'turnDelta', 'protocolVersion', 'bootstrapVersion', 'instanceId', 'capabilityRevision'])
       if (incoming.search.length > 8192 || [...incoming.searchParams.keys()].some((key) => !allowed.has(key) || incoming.searchParams.getAll(key).length !== 1)) throw new RelayError('INVALID_REQUEST', 'Invalid WebSocket query')
       readBusinessSelection(incoming)
       const ticket = incoming.searchParams.get('ticket') ?? ''
       incoming.searchParams.delete('ticket')
       const upstreamPath = '/ws' + incoming.search
       const businessSession = browser.store.consume(ticket, { backendId, origin: config.publicOrigin, basePath: config.publicBasePath, httpBasePath: `${config.publicBasePath}/backend/${backendId}`, wsPath: `${config.publicBasePath}/backend/${backendId}/ws` })
       browser.validate(businessSession, backendId)
      registry.requireOnline(backendId)
      const release = registry.acquireBrowserWebSocket(backendId)
      browserWss.handleUpgrade(req, socket, head, (client) => {
        client.once('close', release)
        const detach = browser.store.attach(businessSession.id, client)
        client.once('close', detach)
        const headers = { ...forwardedHeaders(req.headers, requestId), ...browser.headers(businessSession, 'GET', upstreamPath) }
        Promise.resolve(
          adapter.acceptWebSocket({
            requestId,
            backendId,
            path: upstreamPath,
            headers,
            client,
          }),
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

  const sweep = setInterval(() => {
    registry.expire(); browser.store.sweep()
    browser.store.revokeWhere((session) => {
      const target = session.view.target?.backendId
      if (!target) return false
      if (registry.get(target)?.status !== 'online') return true
      if (session.view.mode === 'relay-oidc') return !session.view.identity.issuer || !authorizations.isAuthorized({ issuer: session.view.identity.issuer, subject: session.view.identity.subject }, target)
      return !authorizations.getBackendPolicy(target).remotePasswordEnabled
    })
    void authorizations.expire().catch(() => {})
  }, Math.min(config.heartbeatIntervalMs, 5_000))
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
    if (await browser.handle(req, res, route)) return { category: 'binding' }
    if (route === '/api/auth/capabilities' && req.method === 'GET') {
      writeJson(res, 200, { password: true, oidc: Boolean(config.oidc && signer), service: 'relay', ...browser.context(req, res) })
      return { category: 'binding' }
    }
    if (route === '/api/admin/backends/policy' && (req.method === 'PUT' || req.method === 'POST')) {
      requireAdmin(req)
      const body = await readJsonBody<{ backendId?: unknown; publicDiscovery?: unknown; remotePasswordEnabled?: unknown }>(req, 16 * 1024)
      if (typeof body.backendId !== 'string') throw new RelayError('INVALID_REQUEST', 'backendId is required')
      assertBackendId(body.backendId)
      const policy = await authorizations.setBackendPolicy({
        backendId: body.backendId,
        ...(typeof body.publicDiscovery === 'boolean' ? { publicDiscovery: body.publicDiscovery } : {}),
        ...(typeof body.remotePasswordEnabled === 'boolean' ? { remotePasswordEnabled: body.remotePasswordEnabled } : {}),
      })
      writeJson(res, 200, policy)
      return { category: 'binding', backendId: body.backendId }
    }
    if (route === '/api/admin/bindings' && req.method === 'GET') {
      requireAdmin(req)
      const backendId = new URL(req.url ?? '/', config.publicOrigin).searchParams.get('backendId')
      writeJson(res, 200, {
        bindings: backendId ? authorizations.listAuthorizationsForBackend(backendId) : [],
      })
      return { category: 'binding', ...(backendId ? { backendId } : {}) }
    }
    if (route === '/api/admin/bindings/request' && req.method === 'POST') {
      requireAdmin(req)
      const body = await readJsonBody<{ backendId?: unknown }>(req, 16 * 1024)
      if (typeof body.backendId !== 'string') throw new RelayError('INVALID_REQUEST', 'backendId is required')
      assertBackendId(body.backendId)
      const identity = identities.get(body.backendId)
      if (!identity) throw new RelayError('BACKEND_NOT_FOUND', 'Backend ID is not registered')
      const request = await authorizations.createBindingRequest({
        backendId: identity.backendId,
        displayName: identity.displayName,
        publicKeyFingerprint: identity.fingerprint,
      })
      writeJson(res, 201, request)
      return { category: 'binding', backendId: body.backendId }
    }
    if (route === '/api/admin/bindings/revoke' && req.method === 'POST') {
      requireAdmin(req)
      const body = await readJsonBody<{ bindingId?: unknown }>(req, 16 * 1024)
      if (typeof body.bindingId !== 'string') throw new RelayError('INVALID_REQUEST', 'bindingId is required')
      const binding = authorizations.getAuthorization(body.bindingId)
      const changed = await authorizations.revokeAuthorization(body.bindingId)
      if (binding) browser.store.revokeWhere((session) => session.view.identity.provider === 'oidc' && session.view.identity.issuer === binding.identity.issuer && session.view.identity.subject === binding.identity.subject && session.view.target?.backendId === binding.backendId)
      if (binding) synchronizeAuthorizations(binding.backendId)
      writeJson(res, 200, { revoked: changed })
      return { category: 'binding' }
    }
    if (route === '/api/auth/oidc/start' && req.method === 'GET') {
      if (!oidc) throw new RelayError('OIDC_LOGIN_UNAVAILABLE', 'Pocket ID is not configured on this relay')
      const returnTo = new URL(req.url ?? '/', config.publicOrigin).searchParams.get('returnTo') ?? `${config.publicBasePath}/`
      const started = await oidc.begin(returnTo)
      res.writeHead(302, { Location: started.url, 'Cache-Control': 'no-store', 'Set-Cookie': `chery_oidc_state=${started.binding}; HttpOnly; SameSite=Lax; Max-Age=300; Path=${config.publicBasePath || '/'}${new URL(config.publicOrigin).protocol === 'https:' ? '; Secure' : ''}` }); res.end()
      return { category: 'binding' }
    }
    if (route === '/api/auth/oidc/callback' && req.method === 'GET') {
      if (!oidc || !config.oidc) throw new RelayError('OIDC_LOGIN_UNAVAILABLE', 'Pocket ID is not configured on this relay')
      const cleared = `chery_oidc_state=; HttpOnly; SameSite=Lax; Max-Age=0; Path=${config.publicBasePath || '/'}${new URL(config.publicOrigin).protocol === 'https:' ? '; Secure' : ''}`
      res.setHeader('Set-Cookie', cleared)
      const user = await oidc.finish(new URL(req.url ?? '/', config.publicOrigin), readCookie(req.headers.cookie, 'chery_oidc_state') ?? '')
      browser.oidc(res, user, readSessionCookie(req.headers.cookie))
      const businessCookie = res.getHeader('Set-Cookie')
      res.setHeader('Set-Cookie', [String(businessCookie), cleared])
      res.writeHead(302, { Location: user.returnTo, 'Cache-Control': 'no-store' }); res.end()
      return { category: 'binding' }
    }
    const bindingConfirmation = /^\/bindings\/([^/]+)$/.exec(route)
    if (bindingConfirmation?.[1] && (req.method === 'GET' || req.method === 'POST')) {
      let session
      try { session = browser.read(req) } catch {
        if (req.method !== 'GET') throw new RelayError('AUTH_REQUIRED', 'Pocket ID login required')
        res.writeHead(302, { Location: `${config.publicBasePath}/api/auth/oidc/start?returnTo=${encodeURIComponent(config.publicBasePath + route)}`, 'Cache-Control': 'no-store' }); res.end(); return { category: 'binding' }
      }
      if (session.view.identity.provider !== 'oidc' || !session.view.identity.issuer) throw new RelayError('AUTH_REQUIRED', 'Pocket ID login required')
      const request = authorizations.getBindingRequest(bindingConfirmation[1])
      if (!request) throw new RelayError('BINDING_NOT_FOUND', 'Binding request was not found')
      if (req.method === 'GET') {
        const escape = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
        const csrf = session.view.csrfToken
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" })
        res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>确认设备授权</title><body><main><h1>允许当前Pocket ID账号访问这台后端</h1><p>账号：${escape(session.view.identity.subject)}</p><p>来源：${escape(session.view.identity.issuer)}</p><p>设备：${escape(request.displayName)} / ${escape(request.backendId)}</p><p>指纹：${escape(request.publicKeyFingerprint)}</p><p>有效期：${escape(request.expiresAt)}</p><p>权限：后端业务使用，不包含Manager管理权限</p><button id="confirm">确认授权</button><button id="cancel">取消</button><p id="result" role="status"></p></main><script>async function submit(cancel){let r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':${JSON.stringify(csrf)}},body:JSON.stringify({cancel})});document.getElementById('result').textContent=r.ok?'操作已完成':'操作未完成，请刷新核对申请';}document.getElementById('confirm').onclick=()=>submit(false);document.getElementById('cancel').onclick=()=>submit(true);</script></body></html>`)
      } else {
        browser.writeGuard(req); browser.store.checkCsrf(session.id, String(req.headers['x-csrf-token'] ?? ''))
        const body = await readJsonBody<{ cancel?: boolean }>(req, 16384)
        if (body.cancel) writeJson(res, 200, { cancelled: await authorizations.cancelBindingRequest(bindingConfirmation[1]) })
        else {
          const authorization = await authorizations.confirmBindingRequest(bindingConfirmation[1], { issuer: session.view.identity.issuer, subject: session.view.identity.subject })
          synchronizeAuthorizations(request.backendId)
          writeJson(res, 200, { authorization, applyState: 'pending-device-ack' })
        }
      }
      return { category: 'binding', backendId: request.backendId }
    }
    if (route === '/api/backends' && req.method === 'GET') {
      let session
      try { session = browser.read(req) } catch { session = undefined }
      const backends = registry.list().filter((item) => session?.view.mode === 'relay-oidc'
        ? Boolean(session.view.identity.issuer && authorizations.isAuthorized({ issuer: session.view.identity.issuer, subject: session.view.identity.subject }, item.backendId))
        : item.status === 'online' && authorizations.getBackendPolicy(item.backendId).publicDiscovery)
      writeJson(res, 200, { backends })
      return { category: 'list' }
    }
    const discovery = /^\/api\/backends\/([^/]+)$/.exec(route)
    if (discovery?.[1] && req.method === 'GET') {
      const backendId = discovery[1]
      assertBackendId(backendId)
      const summary = registry.requireOnline(backendId)
      let session
      try { session = browser.read(req) } catch { session = undefined }
      if (!authorizations.getBackendPolicy(backendId).publicDiscovery && !(session?.view.identity.provider === 'oidc' && session.view.identity.issuer && authorizations.isAuthorized({ issuer: session.view.identity.issuer, subject: session.view.identity.subject }, backendId))) {
        throw new RelayError('PUBLIC_DISCOVERY_DISABLED', 'Backend discovery is disabled')
      }
      writeJson(res, 200, discoveryFor(summary))
      return { category: 'discovery', backendId }
    }
    const proxy = /^\/backend\/([^/]+)(\/api(?:\/.*)?)$/.exec(route)
    if (!proxy?.[1] || !proxy[2]) throw new RelayError('INVALID_REQUEST', 'Path is not allowed')
    const backendId = proxy[1]
    assertBackendId(backendId)
    assertSafeProxyUrl(req.url)
    if (/^\/api\/(?:machine|browser-session|auth)(?:\/|$)/.test(proxy[2])) throw new RelayError('INVALID_REQUEST', 'Proxy authentication and machine paths are forbidden')
    const businessSession = browser.read(req)
    browser.validate(businessSession, backendId)
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
      if (req.headers.origin !== config.publicOrigin) throw new RelayError('USER_BACKEND_FORBIDDEN', 'Origin rejected')
      browser.store.checkCsrf(businessSession.id, typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined)
    }
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
    const abortClient = () => { if (!res.writableEnded) controller.abort() }
    res.once('close', abortClient)
    const timer = setTimeout(() => controller.abort(), config.limits.upstreamTimeoutMs)
    try {
      const response = await adapter.forwardHttp({
        requestId,
        backendId,
        method: req.method ?? 'GET',
        path: proxy[2] + queryOf(req.url),
        headers: { ...forwardedHeaders(req.headers, requestId), ...browser.headers(businessSession, req.method ?? 'GET', proxy[2] + queryOf(req.url)) },
        body: limitedBody(req, config.limits.maxRequestBytes, controller),
        signal: controller.signal,
      })
      if (proxy[2] === '/api/config' && response.status === 200 && response.body) {
        const chunks: Uint8Array[] = []; let bytes = 0
        if (Symbol.asyncIterator in Object(response.body)) for await (const chunk of response.body as AsyncIterable<Uint8Array>) { bytes += chunk.byteLength; if (bytes > 65536) throw new RelayError('BACKEND_UNAVAILABLE', 'Invalid startup response'); chunks.push(chunk) }
        else { const body = response.body as Uint8Array; if (body.byteLength > 65536) throw new RelayError('BACKEND_UNAVAILABLE', 'Invalid startup response'); chunks.push(body) }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        const bootstrap = BootstrapSchema.parse(payload.bootstrap)
        payload.bootstrap = { ...bootstrap, software: { ...bootstrap.software, relay: { version: '1.0.0' } } }
        writeJson(res, 200, payload)
        return { category: 'backend-api', backendId }
      }
      writeProxyResponse(res, response.status, response.headers)
      if (response.body) {
        if (Symbol.asyncIterator in Object(response.body)) {
          for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
            if (!res.write(chunk)) await new Promise<void>((resolve, reject) => { const done = () => { cleanup(); resolve() }; const failed = () => { cleanup(); reject(new Error('Client disconnected')) }; const cleanup = () => { res.off('drain', done); res.off('close', failed) }; res.once('drain', done); res.once('close', failed) })
          }
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
      res.off('close', abortClient)
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
    let closed = false
    const current = () => !closed && socket.readyState === WebSocket.OPEN
    let leaseId: string | undefined
    socket.send(JSON.stringify({
      type: 'challenge',
      protocolVersion: RELAY_PROTOCOL_VERSION,
      nonce,
      expiresAt: new Date(expiresAt).toISOString(),
    }))
    const timeout = setTimeout(() => socket.close(4003, 'Challenge expired'), config.challengeTtlMs)
    timeout.unref()

    let controlQueue = Promise.resolve()
    socket.on('message', (data, isBinary) => {
      controlQueue = controlQueue.then(async () => {
        if (!current()) return
        try {
          if (isBinary) throw new RelayError('INVALID_REQUEST', 'Control messages must be JSON text')
          const raw = JSON.parse(data.toString()) as Record<string, unknown>
          if (!accepted && raw.protocolVersion !== RELAY_PROTOCOL_VERSION) throw new RelayError('PROTOCOL_VERSION_UNSUPPORTED', 'Unsupported control protocol')
          const parsedMessage = (accepted ? DeviceControlMessageSchema : RelayHelloSchema).safeParse(raw)
          if (!parsedMessage.success) throw new RelayError('INVALID_REQUEST', 'Invalid control message')
          const message = parsedMessage.data as Record<string, unknown>
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
            if (!current()) return
            const result = registry.register({
              identity,
              capabilities: hello.capabilities,
              socket,
              configVersion: hello.configVersion,
            })
            leaseId = result.leaseId
            await tunnels?.add(result)
            if (!current() || registry.authorizationSocket(backendId) !== socket) {
              registry.disconnect(backendId, socket)
              await tunnels?.remove(result.leaseId)
              registry.releaseRetiredLease(result.leaseId)
              return
            }
            accepted = true
            clearTimeout(timeout)
            socket.send(JSON.stringify(result))
            if (signer) synchronizeAuthorizations(backendId)
            return
          }
          if (message.type === 'authorizations.ack' && backendId) {
            if (registry.authorizationSocket(backendId) !== socket) return
            if (message.revision !== authorizationSync.get(backendId)) return
            authorizationSync.delete(backendId)
            if (authorizationDirty.delete(backendId)) synchronizeAuthorizations(backendId)
            return
          }
          if (message.type === 'tunnel.applied' && backendId && message.leaseId === leaseId) {
            const proof = typeof message.probeToken === 'string' ? message.probeToken : ''
            if (!proof) throw new RelayError('BACKEND_AUTH_FAILED', 'Authenticated tunnel probe required')
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 5000)
            try {
              if (config.rathole) { const addresses = registry.tunnelAddresses(backendId); await verifyPrivateListeners({ bindAddr: config.rathole.bindAddr, services: [{ name: 'http-probe', token: 'unused-probe-token', bindAddr: addresses.httpBindAddr }, { name: 'ws-probe', token: 'unused-probe-token', bindAddr: addresses.websocketBindAddr }] }) }
              const response = await adapter.forwardHttp({ requestId, backendId, method: 'GET', path: '/api/auth/me', headers: { 'x-chery-relay-authorization': `Bearer ${proof}` }, body: (async function* () {})(), signal: controller.signal })
              if (response.status !== 200) throw new RelayError('BACKEND_AUTH_FAILED', 'Tunnel authentication probe failed')
              if (response.body && Symbol.asyncIterator in Object(response.body)) for await (const _chunk of response.body as AsyncIterable<Uint8Array>) { void _chunk }
              if (!current() || registry.authorizationSocket(backendId) !== socket) return
              registry.markReady(backendId, leaseId!)
              socket.send(JSON.stringify({ type: 'tunnel.ready', leaseId }))
            } catch {
              if (current() && registry.authorizationSocket(backendId) === socket) socket.send(JSON.stringify({ type: 'tunnel.pending', leaseId }))
            } finally { clearTimeout(timer) }
            return
          }
          if (message.type === 'binding.request' && backendId) {
            const parsed = DeviceBindingRequestSchema.safeParse(message)
            if (!parsed.success) throw new RelayError('INVALID_REQUEST', 'Invalid binding request')
            const identity = identities.get(backendId)
            if (!identity || message.backendId !== backendId || message.deviceFingerprint !== identity.fingerprint || message.requestedPermission !== 'business') throw new RelayError('BACKEND_AUTH_FAILED', 'Device binding identity rejected')
            const request = await authorizations.createBindingRequest({ requestId: parsed.data.requestId, backendId, displayName: identity.displayName, publicKeyFingerprint: identity.fingerprint })
            socket.send(JSON.stringify({ type: 'binding.result', requestId: message.requestId, request }))
            return
          }
          if (backendId && ['binding.cancel', 'binding.status', 'authorization.list', 'authorization.revoke', 'policy.get', 'policy.set'].includes(String(message.type))) {
            if (typeof message.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(message.requestId)) throw new RelayError('INVALID_REQUEST', 'Operation ID required')
            let result: unknown
            if (message.type === 'binding.cancel' || message.type === 'binding.status') {
              if (typeof message.bindingRequestId !== 'string') throw new RelayError('INVALID_REQUEST', 'Binding ID required')
              const request = authorizations.getBindingRequest(message.bindingRequestId)
              if (!request || request.backendId !== backendId || request.publicKeyFingerprint !== identities.get(backendId)?.fingerprint) throw new RelayError('BINDING_NOT_FOUND', 'Device request not found')
              if (message.type === 'binding.cancel') await authorizations.cancelBindingRequest(request.requestId)
              result = authorizations.getBindingRequest(request.requestId)
            } else if (message.type === 'authorization.list') result = { authorizations: authorizations.listAuthorizationsForBackend(backendId) }
            else if (message.type === 'authorization.revoke') {
              if (typeof message.bindingId !== 'string') throw new RelayError('INVALID_REQUEST', 'Binding ID required')
              const binding = authorizations.getAuthorization(message.bindingId)
              if (!binding || binding.backendId !== backendId) throw new RelayError('BINDING_NOT_FOUND', 'Device authorization not found')
              await authorizations.revokeAuthorization(binding.bindingId)
              browser.store.revokeWhere((s) => s.view.target?.backendId === backendId && s.view.identity.issuer === binding.identity.issuer && s.view.identity.subject === binding.identity.subject)
              synchronizeAuthorizations(backendId)
              result = authorizations.getAuthorization(binding.bindingId)
            } else if (message.type === 'policy.set') {
              if (typeof message.publicDiscovery !== 'boolean' || typeof message.remotePasswordEnabled !== 'boolean') throw new RelayError('INVALID_REQUEST', 'Policy booleans required')
              result = await authorizations.setBackendPolicy({ backendId, publicDiscovery: message.publicDiscovery, remotePasswordEnabled: message.remotePasswordEnabled })
              if (!message.remotePasswordEnabled) browser.store.revokeWhere((s) => s.view.target?.backendId === backendId && s.view.mode === 'relay-password')
            } else result = authorizations.getBackendPolicy(backendId)
            socket.send(JSON.stringify({ type: 'binding.result', requestId: message.requestId, request: result }))
            return
          }
          if (message.type !== 'heartbeat' || typeof message.leaseId !== 'string' || !backendId) {
            throw new RelayError('INVALID_REQUEST', 'Expected heartbeat')
          }
          const leaseExpiresAt = registry.heartbeat(backendId, message.leaseId)
          socket.send(JSON.stringify({ type: 'heartbeat_ack', leaseId: message.leaseId, leaseExpiresAt }))
        } catch (error) {
          if (!current()) return
          const relayError = error instanceof SyntaxError
            ? new RelayError('INVALID_REQUEST', 'Control message is not valid JSON')
            : asRelayError(error)
          socket.send(JSON.stringify({ type: 'error', ...relayErrorBody(relayError, requestId) }))
          socket.close(relayError.code === 'PROTOCOL_VERSION_UNSUPPORTED' ? 4006 : 4003, relayError.code)
        }
      })
    })
    socket.once('close', () => {
      closed = true
      clearTimeout(timeout)
      if (backendId && registry.authorizationSocket(backendId) === socket) {
        registry.disconnect(backendId, socket)
        authorizationSync.delete(backendId)
        authorizationDirty.delete(backendId)
        browser.store.revokeWhere((session) => session.view.target?.backendId === backendId)
      }
      if (leaseId) void tunnels?.remove(leaseId).then(() => registry.releaseRetiredLease(leaseId!)).catch(() => audit({ requestId, pathCategory: 'control', status: 502, durationMs: 0, failureCategory: 'TUNNEL_REMOVE_FAILED' }))
    })
  }

  function discoveryFor(summary: ReturnType<BackendRegistry['requireOnline']>): RelayDiscovery {
    const root = `${config.publicBasePath}/backend/${summary.backendId}`
    return { ...summary, transport: 'binary', httpBasePath: root, wsPath: `${root}/ws` }
  }

  function requireAdmin(req: IncomingMessage): void {
    const expected = config.adminSecret
    const presented = req.headers['x-chery-relay-admin-token']
    if (!expected || typeof presented !== 'string' || presented !== expected) {
      throw new RelayError('AUTH_REQUIRED', 'Relay administration authorization is required')
    }
  }

  function forwardedHeaders(headers: IncomingHttpHeaders, requestId: string): IncomingHttpHeaders {
    const result: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (
        HOP_BY_HOP.has(lower) ||
        lower === 'host' ||
        lower === 'cookie' ||
        lower === 'authorization' ||
        lower === 'forwarded' ||
        lower.startsWith('x-forwarded-') ||
        lower.startsWith('x-chery-relay-')
      ) continue
      result[lower] = value
    }
    // Browser requests cannot send a second header for the backend token.
    // Keep the relay cookie private and carry the backend bearer token in a
    // relay-owned header that the remote backend explicitly understands.
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
      oidc?.clear()
      browser.store.clear()
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

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0 || part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
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
