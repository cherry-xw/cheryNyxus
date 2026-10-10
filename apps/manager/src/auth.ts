import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AccountStore } from './accountStore.js'
import { OidcLogin, oidcConfigured, type OidcOptions } from './oidc.js'

export interface AuthOptions {
  trustedOrigins?: string[]
  trustedProxies?: string[]
  sessionTtlMs?: number
  oidc?: OidcOptions
}
export interface InitialSetupHooks {
  status: () => Promise<boolean>
  create: (username: string, password: string) => Promise<void>
}
interface Session { username: string; provider: 'password' | 'oidc'; expiresAt: number }
export const SESSION_COOKIE = 'chery-manager-session'
const BINDING_COOKIE = 'chery-manager-oidc'

export function cookie(req: IncomingMessage, name: string): string {
  const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1))
  return values.length === 1 ? values[0]! : ''
}
export function loopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
export function constantEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
export function localOrigin(req: IncomingMessage): string | undefined {
  if (!loopback(req.socket.remoteAddress)) return undefined
  const origin = `http://${req.headers.host ?? ''}`
  return [`http://127.0.0.1:${req.socket.localPort}`, `http://localhost:${req.socket.localPort}`, `http://[::1]:${req.socket.localPort}`].includes(origin) ? origin : undefined
}
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new Error('invalid_json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 16 * 1024) throw new Error('body_too_large')
    chunks.push(buffer)
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_json')
  return body as Record<string, unknown>
}

export class ManagerAuth {
  private readonly sessions = new Map<string, Session>()
  private revision = ''
  private readonly oidc: OidcLogin | undefined
  private readonly limits = new Map<string, { start: number; count: number }>()
  private globalLimit = { start: 0, count: 0 }
  private passwordChecks = 0
  private readonly ttl: number
  readonly origins: string[]
  constructor(private readonly account: AccountStore, private readonly options: AuthOptions = {},
    private readonly now: () => number = Date.now, private readonly initialSetup?: InitialSetupHooks) {
    this.origins = options.trustedOrigins ?? []
    for (const origin of this.origins) {
      const url = new URL(origin)
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('Manager trustedOrigins 必须是无路径的完整 HTTP/HTTPS origin')
      }
    }
    this.ttl = options.sessionTtlMs ?? 8 * 60 * 60 * 1000
    if (!Number.isInteger(this.ttl) || this.ttl <= 0 || this.ttl > 24 * 60 * 60 * 1000) throw new Error('Manager sessionTtlMs 无效')
    if (oidcConfigured(options.oidc, this.origins)) this.oidc = new OidcLogin(options.oidc!, now)
  }

  requestOrigin(req: IncomingMessage): string | undefined {
    const forwarded = Object.keys(req.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-'))
    const proxy = this.options.trustedProxies?.includes(req.socket.remoteAddress ?? '') === true
    if (forwarded && !proxy) return undefined
    let host = req.headers.host
    let protocol = 'encrypted' in req.socket ? 'https' : 'http'
    if (forwarded && proxy) {
      if (req.headers.forwarded) return undefined
      const forwardedHost = req.headers['x-forwarded-host']
      const forwardedProto = req.headers['x-forwarded-proto']
      if (typeof forwardedHost !== 'string' || typeof forwardedProto !== 'string' || !['http', 'https'].includes(forwardedProto)) return undefined
      host = forwardedHost
      protocol = forwardedProto
    }
    if (!host || /[\s,/@\\?#]/.test(host)) return undefined
    try {
      const origin = new URL(`${protocol}://${host}`).origin
      if (origin !== `${protocol}://${host}`) return undefined
      if (this.origins.includes(origin)) return origin
      // 默认信任仅实际监听端口的回环地址；不能任意猜测 Host。
      if (!this.origins.length && localOrigin(req) === origin) return origin
    } catch { /* 拒绝非法 Host。 */ }
    return undefined
  }

  private async refresh(): Promise<Awaited<ReturnType<AccountStore['read']>>> {
    const account = await this.account.read()
    const revision = account?.revision ?? 'unconfigured'
    if (revision !== this.revision) {
      this.sessions.clear()
      this.oidc?.clear()
      this.revision = revision
    }
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id)
    return account
  }

  private setCookie(res: ServerResponse, name: string, value: string, origin: string, seconds: number): void {
    res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${origin.startsWith('https:') ? '; Secure' : ''}`)
  }
  private issue(req: IncomingMessage, res: ServerResponse, origin: string, username: string, provider: Session['provider']): void {
    this.sessions.delete(cookie(req, SESSION_COOKIE))
    if (this.sessions.size >= 1000) throw new Error('session_capacity')
    const id = randomBytes(32).toString('base64url')
    this.sessions.set(id, { username, provider, expiresAt: this.now() + this.ttl })
    this.setCookie(res, SESSION_COOKIE, id, origin, Math.ceil(this.ttl / 1000))
  }
  private allowedAttempt(req: IncomingMessage): boolean {
    const now = this.now()
    if (now - this.globalLimit.start >= 60_000) this.globalLimit = { start: now, count: 0 }
    for (const [key, limit] of this.limits) if (now - limit.start >= 60_000) this.limits.delete(key)
    const key = req.socket.remoteAddress ?? 'unknown'
    let limit = this.limits.get(key)
    if (!limit) {
      if (this.limits.size >= 1000) return false
      limit = { start: now, count: 0 }
      this.limits.set(key, limit)
    }
    this.globalLimit.count++
    limit.count++
    return limit.count <= 10 && this.globalLimit.count <= 100
  }

  async authorize(req: IncomingMessage, res: ServerResponse, path: string, origin: string): Promise<boolean> {
    const account = await this.refresh()
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') &&
        (req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site')) {
      sendJson(res, 403, { error: 'origin_rejected' }); return false
    }
    if (req.headers.origin && req.headers.origin !== origin) {
      sendJson(res, 403, { error: 'origin_rejected' }); return false
    }
    const session = this.sessions.get(cookie(req, SESSION_COOKIE))
    if (path === '/api/auth/capabilities' && req.method === 'GET') {
      const initialized = Boolean(account)
      sendJson(res, 200, {
        password: initialized,
        oidc: Boolean(this.oidc),
        allowInitialSetup: !initialized && (await this.initialSetup?.status() ?? false),
        initialized,
      }); return false
    }
    if (path === '/api/auth/setup' && req.method === 'POST') {
      if (!this.allowedAttempt(req)) { res.setHeader('Retry-After', '60'); sendJson(res, 429, { error: 'setup_limited' }); return false }
      if (!this.initialSetup || account) { sendJson(res, 409, { error: 'setup_unavailable' }); return false }
      const body = await readBody(req)
      if (typeof body.username !== 'string' || typeof body.password !== 'string') {
        sendJson(res, 400, { error: 'invalid_setup' }); return false
      }
      try {
        await this.initialSetup.create(body.username, body.password)
        await this.refresh()
        sendJson(res, 200, { initialized: true, allowInitialSetup: false })
      } catch (error) {
        const message = (error as Error).message
        const status = message.includes('账号已存在') || message.includes('正在进行') ? 409 : 400
        sendJson(res, status, { error: status === 409 ? 'setup_unavailable' : 'invalid_setup' })
      }
      return false
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      if (!this.allowedAttempt(req) || this.passwordChecks >= 4) {
        res.setHeader('Retry-After', '60'); sendJson(res, 429, { error: 'login_limited' }); return false
      }
      if (!account) { sendJson(res, 503, { error: 'password_unconfigured' }); return false }
      const body = await readBody(req)
      if (typeof body.username !== 'string' || typeof body.password !== 'string') {
        sendJson(res, 400, { error: 'invalid_login' }); return false
      }
      this.passwordChecks++
      let valid: boolean
      try { valid = await this.account.verify(account, body.username, body.password) }
      finally { this.passwordChecks-- }
      // 恢复账号可能在密码校验期间发生，不能签发旧账号的会话。
      await this.refresh()
      if (!valid || this.revision !== account.revision) { sendJson(res, 401, { error: 'invalid_login' }); return false }
      this.issue(req, res, origin, account.username, 'password')
      sendJson(res, 200, { authenticated: true }); return false
    }
    if (path === '/api/auth/oidc/login' && req.method === 'GET') {
      if (!this.oidc) { sendJson(res, 503, { error: 'oidc_unconfigured' }); return false }
      if (!this.allowedAttempt(req)) { sendJson(res, 429, { error: 'login_limited' }); return false }
      const revision = this.revision
      try {
        const login = await this.oidc.begin(revision)
        await this.refresh()
        if (revision !== this.revision) throw new Error()
        this.setCookie(res, BINDING_COOKIE, login.binding, origin, 300)
        res.writeHead(302, { Location: login.url, 'Cache-Control': 'no-store' }); res.end()
      } catch { sendJson(res, 401, { error: 'oidc_login_failed' }) }
      return false
    }
    if (path === '/api/auth/oidc/callback' && req.method === 'GET') {
      const revision = this.revision
      try {
        if (!this.oidc || origin !== new URL(this.options.oidc!.redirectUri).origin) throw new Error()
        const sub = await this.oidc.finish(new URL(req.url!, origin), cookie(req, BINDING_COOKIE), revision)
        await this.refresh()
        if (revision !== this.revision) throw new Error()
        this.issue(req, res, origin, sub, 'oidc')
        const sessionCookie = res.getHeader('Set-Cookie') as string
        this.setCookie(res, BINDING_COOKIE, '', origin, 0)
        res.setHeader('Set-Cookie', [sessionCookie, res.getHeader('Set-Cookie') as string])
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); res.end()
      } catch {
        this.setCookie(res, BINDING_COOKIE, '', origin, 0)
        sendJson(res, 401, { error: 'oidc_login_failed' })
      }
      return false
    }
    if (!session) { sendJson(res, 401, { authenticated: false, error: 'unauthorized' }); return false }
    if (path === '/api/auth/password' && req.method === 'POST') {
      if (!this.allowedAttempt(req) || this.passwordChecks >= 4) { sendJson(res, 429, { error: 'login_limited' }); return false }
      const body = await readBody(req)
      if (!account || typeof body.currentPassword !== 'string' || typeof body.newPassword !== 'string' || body.newPassword.length < 12 || body.newPassword.length > 1024) {
        sendJson(res, 400, { error: 'invalid_password_change' }); return false
      }
      this.passwordChecks++
      try {
        if (!await this.account.verify(account, account.username, body.currentPassword)) { sendJson(res, 400, { error: 'current_password_invalid' }); return false }
        await this.refresh()
        if (this.revision !== account.revision) { sendJson(res, 409, { error: 'account_changed' }); return false }
        await this.account.save(account.username, body.newPassword, true)
        await this.refresh()
        this.setCookie(res, SESSION_COOKIE, '', origin, 0)
        sendJson(res, 200, { changed: true, loginRequired: true })
      } finally { this.passwordChecks-- }
      return false
    }
    if (path === '/api/auth/me' && req.method === 'GET') {
      sendJson(res, 200, { authenticated: true, ...session }); return false
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      this.sessions.delete(cookie(req, SESSION_COOKIE))
      this.setCookie(res, SESSION_COOKIE, '', origin, 0)
      sendJson(res, 200, { authenticated: false }); return false
    }
    return true
  }
}
