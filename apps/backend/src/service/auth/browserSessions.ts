import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BrowserTargetSchema, PasswordSessionRequestSchema, SessionMutationSchema, WsTicketRequestSchema, type BrowserTarget } from '@chery/protocol'
import { BrowserSessionStore, SessionError, readSessionCookie, requestDigest, sessionCookie } from '../../../../relay/src/browserSessionStore.js'
import type { OAuth2Auth } from './index.js'

/** Owns the direct-listener browser boundary; never exposes backend bearer credentials. */
export class DirectBrowserSessions {
  readonly store = new BrowserSessionStore()
  private readonly digestKey = randomBytes(32).toString('hex')
  constructor(private readonly auth: OAuth2Auth) {}
  private target(req: IncomingMessage): BrowserTarget { const deployment = this.auth.browserDeployment(); const origin = deployment?.origin ?? `${secure(req) ? 'https' : 'http'}://${req.headers.host}`; const basePath = deployment?.basePath ?? ''; return BrowserTargetSchema.parse({ origin, basePath, httpBasePath: basePath, wsPath: `${basePath}/ws` }) }
  private secure(req: IncomingMessage): boolean { return this.auth.browserDeployment()?.origin.startsWith('https:') ?? secure(req) }
  user(req: IncomingMessage) {
    try {
      const s = this.store.get(readSessionCookie(req.headers.cookie))
      if (req.headers.origin && req.headers.origin !== s.view.target?.origin) return null
      return { sub: s.view.identity.subject, username: s.view.identity.displayName ?? s.view.identity.subject, isAdmin: true as const }
    } catch { return null }
  }
  /** Creates direct trusted-local sessions only after the listener verifies the actual source. */
  trustedLocal(req: IncomingMessage, res: ServerResponse): void {
    const user = this.auth.getUser(req, { allowLoopback: true })
    const address = req.socket.remoteAddress
    if (this.auth.browserDeployment() || req.headers['x-forwarded-for'] || req.headers.forwarded || user?.sub !== 'local' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') || !this.auth.isTrustedOrigin(req.headers.origin, req)) throw new SessionError('TARGET_FORBIDDEN', 403)
    const value = this.store.create({ identity: { subject: 'local', provider: 'local' }, mode: 'trusted-local', target: this.target(req) }, readSessionCookie(req.headers.cookie))
    res.setHeader('Set-Cookie', sessionCookie(value.id, this.auth.browserDeployment()?.basePath || '/', this.secure(req), 8 * 3600)); json(res, 200, value.view)
  }
  consumeTicket(req: IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://internal.invalid')
    const ticket = url.searchParams.get('ticket')
    if (!ticket || !req.headers.origin) throw new SessionError('WS_TICKET_INVALID', 401)
    const origin = req.headers.origin
    const session = this.store.consume(ticket, { origin, basePath: this.auth.browserDeployment()?.basePath ?? '', httpBasePath: this.auth.browserDeployment()?.basePath ?? '', wsPath: `${this.auth.browserDeployment()?.basePath ?? ''}/ws` })
    return session
  }
  capabilities(req: IncomingMessage, res: ServerResponse): { csrfToken: string; trustedLocal: boolean } {
    const trustedLocal = !this.auth.browserDeployment() && !req.headers['x-forwarded-for'] && !req.headers.forwarded && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    try { const session = this.store.get(readSessionCookie(req.headers.cookie)); return { csrfToken: session.view.csrfToken, trustedLocal } } catch {
      const context = this.store.context()
      res.setHeader('Set-Cookie', sessionCookie(context.id, this.auth.browserDeployment()?.basePath || '/', this.secure(req), 300))
      return { csrfToken: context.csrfToken, trustedLocal }
    }
  }
  async handle(req: IncomingMessage, res: ServerResponse, _wsPort: number): Promise<boolean> {
    const rawPath = new URL(req.url ?? '/', 'http://internal.invalid').pathname
    const prefix = this.auth.browserDeployment()?.basePath ?? ''
    const path = prefix && rawPath.startsWith(prefix + '/') ? rawPath.slice(prefix.length) : rawPath
    if (!path.startsWith('/api/browser-session')) return false
    const id = readSessionCookie(req.headers.cookie)
    try {
      if (path === '/api/browser-session' && req.method === 'GET') { json(res, 200, this.store.view(this.store.get(id).id)); return true }
      if (req.headers.origin !== this.target(req).origin || req.headers['sec-fetch-site'] === 'cross-site') throw new SessionError('ORIGIN_REJECTED', 403)
      if ((req.headers['content-type'] ?? '').split(';')[0]?.trim() !== 'application/json') throw new SessionError('INVALID_REQUEST', 400)
      const body = await readBody(req)
      const replayBody = PasswordSessionRequestSchema.safeParse(body)
      if (path === '/api/browser-session/password' && req.method === 'POST' && replayBody.success && id) {
        const replay = this.store.replay(id, 'password', replayBody.data.operationId, requestDigest(this.digestKey, 'password', body), String(req.headers['x-csrf-token'] ?? ''))
        if (replay) { const result = await replay as import('../../../../relay/src/browserSessionStore.js').SessionRecord; this.store.get(result.id); res.setHeader('Set-Cookie', sessionCookie(result.id, this.auth.browserDeployment()?.basePath || '/', this.secure(req), 8 * 3600)); json(res, 200, result.view); return true }
      }
      const logoutReplay = SessionMutationSchema.safeParse(body)
      if (path === '/api/browser-session' && req.method === 'DELETE' && logoutReplay.success && id) {
        const replay = this.store.replay(id, 'logout', logoutReplay.data.operationId, requestDigest(this.digestKey, 'logout', body), String(req.headers['x-csrf-token'] ?? ''))
        if (replay) { await replay; res.setHeader('Set-Cookie', sessionCookie('', this.auth.browserDeployment()?.basePath || '/', this.secure(req), 0)); res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return true }
      }
      this.store.checkCsrf(id, typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined)
      if (path === '/api/browser-session/local' && req.method === 'POST') { this.trustedLocal(req, res); return true }
      if (path === '/api/browser-session/password' && req.method === 'POST') {
        if (this.auth.passwordRetryAfter() > 0) res.setHeader('Retry-After', String(this.auth.passwordRetryAfter()))
        const parsed = PasswordSessionRequestSchema.safeParse(body)
        if (!parsed.success || parsed.data.backendId) throw new SessionError('INVALID_REQUEST', 400)
        const input = parsed.data
        const result = await this.store.mutate(id!, 'password', input.operationId, requestDigest(this.digestKey, 'password', body), input.expectedRevision, async () => {
          const tokens = this.auth.authenticate(input.username, input.password)
          if (!tokens) throw new SessionError(this.auth.passwordRetryAfter() ? 'RATE_LIMITED' : 'INVALID_CREDENTIALS', this.auth.passwordRetryAfter() ? 429 : 401)
          if (input.expectedRevision !== undefined) this.store.assertRevision(id!, input.expectedRevision)
          return this.store.create({ identity: { subject: input.username, displayName: input.username, provider: 'password' }, mode: 'direct-password', target: this.target(req), credentials: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } }, id)
        })
        res.setHeader('Set-Cookie', sessionCookie(result.id, this.auth.browserDeployment()?.basePath || '/', this.secure(req), 8 * 3600))
        json(res, 200, result.view); return true
      }
      if (path === '/api/browser-session/ws-ticket' && req.method === 'POST') {
        const parsed = WsTicketRequestSchema.safeParse(body)
        if (!parsed.success || parsed.data.backendId) throw new SessionError('INVALID_REQUEST', 400)
        json(res, 200, this.store.ticket(id!, parsed.data.expectedRevision)); return true
      }
      const parsed = SessionMutationSchema.safeParse(body)
      if (!parsed.success) throw new SessionError('INVALID_REQUEST', 400)
      const input = parsed.data
      if (path === '/api/browser-session/refresh' && req.method === 'POST') {
        const view = await this.store.mutate(id!, 'refresh', input.operationId, requestDigest(this.digestKey, 'refresh', body), input.expectedRevision, async (session) => {
          if (session?.view.mode === 'trusted-local') return this.store.update(id!, input.expectedRevision, this.target(req))
          if (!session?.credentials) throw new SessionError('SESSION_EXPIRED', 401)
          const result = this.auth.refresh(session.credentials.refreshToken)
          if (!result) { this.store.revoke(id!); throw new SessionError('SESSION_EXPIRED', 401) }
          return this.store.update(id!, input.expectedRevision, this.target(req), { ...session.credentials, accessToken: result.accessToken })
        })
        json(res, 200, view); return true
      }
      if (path === '/api/browser-session' && req.method === 'DELETE') {
        await this.store.mutate(id!, 'logout', input.operationId, requestDigest(this.digestKey, 'logout', body), input.expectedRevision, async () => { this.store.assertRevision(id!, input.expectedRevision); this.store.revoke(id!) })
        res.setHeader('Set-Cookie', sessionCookie('', this.auth.browserDeployment()?.basePath || '/', this.secure(req), 0)); res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return true
      }
      throw new SessionError('INVALID_REQUEST', 400)
    } catch (error) {
      const failure = error instanceof SessionError ? error : new SessionError('INVALID_REQUEST', 400)
      json(res, failure.status, { error: { code: failure.code, message: '登录操作未完成，请核对会话后重试', requestId: randomBytes(18).toString('base64url'), ...(failure.revision ? { revision: failure.revision } : {}) } }); return true
    }
  }
}
function secure(req: IncomingMessage): boolean { return Boolean((req.socket as { encrypted?: boolean }).encrypted) }
function json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)) }
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of req) { const b = Buffer.from(chunk); bytes += b.length; if (bytes > 16384) throw new SessionError('REQUEST_TOO_LARGE', 413); chunks.push(b) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
