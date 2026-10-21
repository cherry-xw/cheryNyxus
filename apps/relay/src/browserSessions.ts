import { randomBytes } from 'node:crypto'
import { RelayError } from './errors.js'
import type { IncomingMessage, ServerResponse, IncomingHttpHeaders } from 'node:http'
import { PasswordSessionRequestSchema, TargetSessionRequestSchema, SessionMutationSchema, WsTicketRequestSchema, type BrowserTarget } from '@chery/protocol'
import { BrowserSessionStore, SessionError, readSessionCookie, requestDigest, sessionCookie, type SessionRecord } from './browserSessionStore.js'
import type { RelayTargetAdapter } from './adapter.js'
import type { RelayConfig } from './config.js'
import type { BackendRegistry } from './registry.js'
import type { AuthorizationStore } from './authorizationStore.js'
import type { UserProofSigner } from './userProof.js'
import { xorEncrypt } from '../../backend/src/utils/obfuscate.js'

export class RelayBrowserSessions {
  readonly store: BrowserSessionStore
  private readonly digestKey = randomBytes(32).toString('hex')
  constructor(private readonly config: RelayConfig, private readonly registry: BackendRegistry, private readonly authorization: AuthorizationStore, private readonly adapter: RelayTargetAdapter, private readonly signer?: UserProofSigner, private readonly pendingAuthorization?: ReadonlyMap<string, string>) { this.store = new BrowserSessionStore(config.sessionTtlSeconds * 1000) }
  context(req: IncomingMessage, res: ServerResponse): { csrfToken: string } {
    try { return { csrfToken: this.store.get(readSessionCookie(req.headers.cookie)).view.csrfToken } } catch {
      const context = this.store.context(); this.cookie(res, context.id, 300); return { csrfToken: context.csrfToken }
    }
  }
  oidc(res: ServerResponse, identity: { issuer: string; subject: string }, previous?: string): void {
    const session = this.store.create({ identity: { issuer: identity.issuer, subject: identity.subject, provider: 'oidc' }, mode: 'relay-oidc', target: null }, previous)
    this.cookie(res, session.id, this.config.sessionTtlSeconds)
  }
  read(req: IncomingMessage): SessionRecord { return this.store.get(readSessionCookie(req.headers.cookie)) }
  validate(session: SessionRecord, backendId: string): void {
    if (session.view.target?.backendId !== backendId) throw new SessionError('TARGET_FORBIDDEN', 403)
    this.registry.requireOnline(backendId)
    if (session.view.mode === 'relay-oidc') {
      if (this.pendingAuthorization?.has(backendId)) throw new SessionError('AUTHORIZATION_PENDING', 409)
      const identity = session.view.identity
      if (!identity.issuer || !this.authorization.isAuthorized({ issuer: identity.issuer, subject: identity.subject }, backendId)) { this.store.revoke(session.id); throw new SessionError('TARGET_FORBIDDEN', 403) }
    } else if (!session.credentials || !this.authorization.getBackendPolicy(backendId).remotePasswordEnabled) throw new SessionError('TARGET_FORBIDDEN', 403)
  }
  headers(session: SessionRecord, method: string, path: string): IncomingHttpHeaders {
    const backendId = session.view.target?.backendId
    this.store.assertRevision(session.id, session.view.revision)
    if (!backendId) throw new SessionError('TARGET_FORBIDDEN', 403)
    this.validate(session, backendId)
    if (session.view.mode === 'relay-password') return { 'x-chery-relay-authorization': `Bearer ${session.credentials!.accessToken}` }
    const identity = session.view.identity
    const binding = this.authorization.listAuthorizationsForUser({ issuer: identity.issuer!, subject: identity.subject }).find((v) => v.backendId === backendId)
    if (!binding || !this.signer) throw new SessionError('USER_PROOF_UNAVAILABLE', 503)
    return { 'x-chery-relay-user-proof': this.signer.issue({ sub: identity.subject, aud: backendId, sessionId: session.id, authorizationId: binding.bindingId, authorizationRevision: binding.revision ?? 1, permissions: ['business'] }, method, path) }
  }
  async handle(req: IncomingMessage, res: ServerResponse, route: string): Promise<boolean> {
    if (!route.startsWith('/api/browser-session') && route !== '/api/auth/me') return false
    try {
      const id = readSessionCookie(req.headers.cookie)
      if ((route === '/api/browser-session' || route === '/api/auth/me') && req.method === 'GET') { output(res, 200, this.store.view(this.store.get(id).id)); return true }
      this.writeGuard(req)
      const raw = await body(req)
      const replayBody = PasswordSessionRequestSchema.safeParse(raw)
      if (route === '/api/browser-session/password' && req.method === 'POST' && replayBody.success && id) {
        const replay = this.store.replay(id, 'password', replayBody.data.operationId, requestDigest(this.digestKey, 'password', raw), String(req.headers['x-csrf-token'] ?? ''))
        if (replay) { const result = await replay as SessionRecord; this.store.get(result.id); this.cookie(res, result.id, this.config.sessionTtlSeconds); output(res, 200, result.view); return true }
      }
      const logoutReplay = SessionMutationSchema.safeParse(raw)
      if (route === '/api/browser-session' && req.method === 'DELETE' && logoutReplay.success && id) {
        const replay = this.store.replay(id, 'logout', logoutReplay.data.operationId, requestDigest(this.digestKey, 'logout', raw), String(req.headers['x-csrf-token'] ?? ''))
        if (replay) { await replay; this.cookie(res, '', 0); res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return true }
      }
      this.store.checkCsrf(id, typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined)
      if (route === '/api/browser-session/password' && req.method === 'POST') {
        const parsed = PasswordSessionRequestSchema.safeParse(raw)
        if (!parsed.success || !parsed.data.backendId) throw new SessionError('INVALID_REQUEST', 400)
        const input = parsed.data; const backendId = input.backendId!
        this.registry.requireOnline(backendId)
        if (!this.authorization.getBackendPolicy(backendId).remotePasswordEnabled) throw new SessionError('TARGET_FORBIDDEN', 403)
        const session = await this.store.mutate(id!, 'password', input.operationId, requestDigest(this.digestKey, 'password', raw), input.expectedRevision, async () => {
          const challenge = await this.call(backendId, '/api/auth/challenge', { username: input.username })
          if (typeof challenge.nonce !== 'string' || typeof challenge.challengeId !== 'string') throw new SessionError('BACKEND_UNAVAILABLE', 502)
          const login = await this.call(backendId, '/api/auth/login', { challengeId: challenge.challengeId, cipher: xorEncrypt(challenge.nonce, JSON.stringify({ username: input.username, password: input.password })) })
          if (typeof login.accessToken !== 'string' || typeof login.refreshToken !== 'string') throw new SessionError('INVALID_CREDENTIALS', 401)
          if (input.expectedRevision !== undefined) this.store.assertRevision(id!, input.expectedRevision)
          return this.store.create({ identity: { provider: 'password', subject: input.username }, mode: 'relay-password', target: this.target(backendId), credentials: { accessToken: login.accessToken, refreshToken: login.refreshToken } }, id)
        })
        this.cookie(res, session.id, this.config.sessionTtlSeconds); output(res, 200, session.view); return true
      }
      if (route === '/api/browser-session/target' && req.method === 'PUT') {
        const parsed = TargetSessionRequestSchema.safeParse(raw); if (!parsed.success) throw new SessionError('INVALID_REQUEST', 400)
        const input = parsed.data
        const view = await this.store.mutate(id!, 'target', input.operationId, requestDigest(this.digestKey, 'target', raw), input.expectedRevision, async (session) => {
          if (session?.view.mode !== 'relay-oidc') throw new SessionError('TARGET_REAUTHENTICATION_REQUIRED', 403)
          if (this.pendingAuthorization?.has(input.backendId)) throw new SessionError('AUTHORIZATION_PENDING', 409)
          this.registry.requireOnline(input.backendId)
          const identity = session.view.identity
          if (!this.authorization.isAuthorized({ issuer: identity.issuer!, subject: identity.subject }, input.backendId)) throw new SessionError('TARGET_FORBIDDEN', 403)
          return this.store.update(id!, input.expectedRevision, this.target(input.backendId))
        }); output(res, 200, view); return true
      }
      if (route === '/api/browser-session/ws-ticket' && req.method === 'POST') {
        const parsed = WsTicketRequestSchema.safeParse(raw); if (!parsed.success) throw new SessionError('INVALID_REQUEST', 400)
        const session = this.store.assertRevision(id!, parsed.data.expectedRevision)
        const backendId = session.view.target?.backendId
        if (!backendId || (parsed.data.backendId && parsed.data.backendId !== backendId)) throw new SessionError('TARGET_FORBIDDEN', 403)
        this.validate(session, backendId); output(res, 200, this.store.ticket(id!, parsed.data.expectedRevision)); return true
      }
      const parsed = SessionMutationSchema.safeParse(raw); if (!parsed.success) throw new SessionError('INVALID_REQUEST', 400)
      const input = parsed.data
      if (route === '/api/browser-session/refresh' && req.method === 'POST') {
        const view = await this.store.mutate(id!, 'refresh', input.operationId, requestDigest(this.digestKey, 'refresh', raw), input.expectedRevision, async (session) => {
          if (!session) throw new SessionError('SESSION_EXPIRED', 401)
          let credentials = session.credentials
          if (session.view.target?.backendId) this.validate(session, session.view.target.backendId)
          if (credentials) {
            const result = await this.call(session.view.target!.backendId!, '/api/auth/refresh', { refreshToken: credentials.refreshToken })
            if (typeof result.accessToken !== 'string') { this.store.revoke(id!); throw new SessionError('SESSION_EXPIRED', 401) }
            credentials = { ...credentials, accessToken: result.accessToken }
          }
          return this.store.update(id!, input.expectedRevision, session.view.target, credentials)
        }); output(res, 200, view); return true
      }
      if (route === '/api/browser-session' && req.method === 'DELETE') {
        await this.store.mutate(id!, 'logout', input.operationId, requestDigest(this.digestKey, 'logout', raw), input.expectedRevision, async () => this.store.revoke(id!))
        this.cookie(res, '', 0); res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return true
      }
      throw new SessionError('INVALID_REQUEST', 400)
    } catch (error) { const e = error instanceof SessionError ? error : error instanceof RelayError ? new SessionError(error.code, error.status) : error instanceof SyntaxError ? new SessionError('INVALID_REQUEST', 400) : new SessionError('BACKEND_UNAVAILABLE', 502); output(res, e.status, { error: { code: e.code, message: '操作未完成，请核对会话与目标', requestId: randomBytes(18).toString('base64url'), ...(e.revision ? { revision: e.revision } : {}) } }); return true }
  }
  writeGuard(req: IncomingMessage): void {
    if (req.headers.origin !== this.config.publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') throw new SessionError('ORIGIN_REJECTED', 403)
    if ((req.headers['content-type'] ?? '').split(';')[0]?.trim() !== 'application/json') throw new SessionError('INVALID_REQUEST', 400)
  }
  private target(backendId: string): BrowserTarget { const root = `${this.config.publicBasePath}/backend/${backendId}`; return { backendId, origin: this.config.publicOrigin, basePath: this.config.publicBasePath, httpBasePath: root, wsPath: `${root}/ws` } }
  private cookie(res: ServerResponse, id: string, ttl: number): void { res.setHeader('Set-Cookie', sessionCookie(id, this.config.publicBasePath || '/', new URL(this.config.publicOrigin).protocol === 'https:', ttl)) }
  private async call(backendId: string, path: string, data: unknown): Promise<Record<string, unknown>> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.limits.upstreamTimeoutMs)
    try {
      const response = await this.adapter.forwardHttp({ requestId: randomBytes(18).toString('base64url'), backendId, method: 'POST', path, headers: { 'content-type': 'application/json' }, body: (async function* () { yield Buffer.from(JSON.stringify(data)) })(), signal: controller.signal })
      if (response.status !== 200) throw new SessionError(response.status === 429 ? 'RATE_LIMITED' : response.status === 401 ? 'INVALID_CREDENTIALS' : 'BACKEND_UNAVAILABLE', response.status === 429 ? 429 : response.status === 401 ? 401 : 502)
      let chunks: Uint8Array[] = []; let size = 0
      if (response.body instanceof Uint8Array) chunks = [response.body]
      else if (response.body) for await (const chunk of response.body) { size += chunk.byteLength; if (size > 65536) throw new SessionError('BACKEND_UNAVAILABLE', 502); chunks.push(chunk) }
      if (chunks.reduce((n, c) => n + c.byteLength, 0) > 65536) throw new SessionError('BACKEND_UNAVAILABLE', 502)
      return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    } finally { clearTimeout(timer) }
  }
}
function output(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
async function body(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const c of req) { const b = Buffer.from(c); size += b.length; if (size > 16384) throw new SessionError('REQUEST_TOO_LARGE', 413); chunks.push(b) } return JSON.parse(Buffer.concat(chunks).toString()) }
