import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isHashed, verifyPassword } from '@/utils/password.js'
import { xorDecrypt } from '@/utils/obfuscate.js'

export interface OAuth2Config {
  enabled?: boolean
  issuer?: string
  authorizationUrl?: string
  tokenUrl?: string
  userInfoUrl?: string
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  /** Accounts allowed to administer this installation. Match provider sub, email or preferred_username. */
  adminUsers?: string[]
  /** Optional claim-based admin mapping, e.g. roles + ["admin"]. */
  adminClaim?: string
  adminValues?: string[]
  /** Additional separately-hosted internal UIs allowed to open a control socket. */
  trustedOrigins?: string[]
  /** 本地用户名/密码认证：设置 username 后启用（远端强制，loopback 豁免）。 */
  username?: string
  /** password 明文或 scrypt 哈希（scrypt$<salt>$<hash>）；启动自检明文→哈希。 */
  password?: string
}

export interface AuthenticatedUser {
  sub: string
  username: string
  isAdmin: true
}

interface SessionPayload extends AuthenticatedUser {
  exp: number
}
interface OAuthState {
  verifier: string
  returnTo: string
  exp: number
}

const SESSION_COOKIE = 'chery_session'
const STATE_COOKIE = 'chery_oauth_state'
const SESSION_TTL_SECONDS = 8 * 60 * 60
const STATE_TTL_SECONDS = 10 * 60
const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60
/** 登录挑战（challenge）TTL：前端须在有效期内完成加密登录，过期作废。 */
const CHALLENGE_TTL_SECONDS = 120

/**
 * Server-side OIDC/OAuth2 login gate. OAuth2 alone does not identify people,
 * so this implementation requires the provider userinfo endpoint (OIDC is the
 * usual choice) and never offers public self-registration.
 */
export class OAuth2Auth {
  readonly enabled: boolean
  private readonly cfg: Required<
    Pick<OAuth2Config, 'adminUsers' | 'adminValues' | 'trustedOrigins'>
  > &
    OAuth2Config
  private readonly secret: string
  /** 一次性登录挑战：challengeId → nonce + 过期时间。解密后即删除（防重放）。 */
  private readonly challenges = new Map<string, { nonce: string; exp: number }>()

  constructor(config: OAuth2Config | undefined) {
    this.cfg = {
      ...config,
      adminUsers: config?.adminUsers ?? [],
      adminValues: config?.adminValues ?? ['admin'],
      trustedOrigins: config?.trustedOrigins ?? [],
    }
    // 会话签名密钥：环境变量 > 后端动态生成。由 config.ts ensureAuthSessionSecret 持久化到
    // 根 .env（CHERY_AUTH_SESSION_SECRET）跨重启复用；未注入时动态生成兜底。
    this.secret = process.env.CHERY_AUTH_SESSION_SECRET || randomBytes(32).toString('hex')
    // 密码认证或 OAuth2 任一启用即开启鉴权门禁。
    this.enabled = config?.enabled === true || !!config?.username
    if (!this.enabled) return
    if (this.cfg.username) {
      // 密码认证模式：password 必须是已哈希值（明文由 worker 启动自检改写后重启）。
      if (!this.cfg.password || !isHashed(this.cfg.password))
        throw new Error(
          'server.auth.password must be a scrypt hash (scrypt$<salt>$<hash>); plaintext is rewritten to hash on startup',
        )
      return
    }
    // OAuth2 issuer 模式：保留原有强制校验。
    for (const key of ['authorizationUrl', 'tokenUrl', 'userInfoUrl', 'clientId', 'redirectUri']) {
      if (!this.cfg[key as keyof OAuth2Config])
        throw new Error(`server.auth.enabled=true requires server.auth.${key}`)
    }
    if (this.cfg.adminUsers.length === 0 && !this.cfg.adminClaim)
      throw new Error(
        'OAuth2 login needs server.auth.adminUsers or server.auth.adminClaim; public registration is intentionally disabled',
      )
  }

  getUser(req: IncomingMessage): AuthenticatedUser | null {
    if (!this.enabled) return { sub: 'local', username: 'local', isAdmin: true }
    // 本地 loopback 信任豁免：直连不鉴权。
    if (isLoopback(req)) return { sub: 'local', username: 'local', isAdmin: true }
    // 远端：校验 access token（Authorization: Bearer / WS ?token=）或 OAuth2 会话 cookie。
    const token = readBearer(req) ?? readCookie(req, SESSION_COOKIE) ?? readTokenQuery(req)
    const payload = token ? this.verifyAuthToken(token) : null
    return payload ? { sub: payload.sub, username: payload.username, isAdmin: true } : null
  }

  /** 校验用户名/密码，成功签发双 token。失败返回 null。 */
  authenticate(
    username: string,
    password: string,
  ): { accessToken: string; refreshToken: string; accessTtl: number } | null {
    if (!this.cfg.username || !this.cfg.password) return null
    if (username !== this.cfg.username) return null
    if (!verifyPassword(password, this.cfg.password)) return null
    return this.issueTokens(username)
  }

  /** 校验 refresh token，换发新 access token。失败返回 null。 */
  refresh(refreshToken: string): { accessToken: string; expiresIn: number } | null {
    const payload = this.verifyToken(refreshToken, 'refresh')
    if (!payload) return null
    const accessToken = this.sign<SessionPayload & { type: string }>({
      sub: payload.sub,
      username: payload.username,
      isAdmin: true,
      type: 'access',
      exp: nowSeconds() + ACCESS_TTL_SECONDS,
    })
    return { accessToken, expiresIn: ACCESS_TTL_SECONDS }
  }

  /** 清理已过期的登录挑战。 */
  private pruneChallenges(): void {
    const now = nowSeconds()
    for (const [id, challenge] of this.challenges) {
      if (challenge.exp <= now) this.challenges.delete(id)
    }
  }

  /**
   * 解密前端 SHA-256 CTR 流密码凭据信封。challenge 单次使用（命中即删除，防重放）。
   * 信封明文 = JSON.stringify({username, password})。
   * 失败（challenge 无效/过期/解密失败/解析失败）返回 null。
   */
  private decryptCredentials(
    challengeId: string,
    cipher: string,
  ): { username: string; password: string } | null {
    const challenge = this.challenges.get(challengeId)
    this.challenges.delete(challengeId)
    if (!challenge || challenge.exp <= nowSeconds() || !challenge.nonce) return null
    try {
      const plain = xorDecrypt(challenge.nonce, cipher)
      const parsed = JSON.parse(plain) as { username?: unknown; password?: unknown }
      if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') return null
      return { username: parsed.username, password: parsed.password }
    } catch {
      return null
    }
  }

  private issueTokens(username: string): {
    accessToken: string
    refreshToken: string
    accessTtl: number
  } {
    const now = nowSeconds()
    const accessToken = this.sign<SessionPayload & { type: string }>({
      sub: username,
      username,
      isAdmin: true,
      type: 'access',
      exp: now + ACCESS_TTL_SECONDS,
    })
    const refreshToken = this.sign<SessionPayload & { type: string }>({
      sub: username,
      username,
      isAdmin: true,
      type: 'refresh',
      exp: now + REFRESH_TTL_SECONDS,
    })
    return { accessToken, refreshToken, accessTtl: ACCESS_TTL_SECONDS }
  }

  private verifyAuthToken(token: string): SessionPayload | null {
    const payload = this.verify<SessionPayload & { type?: string }>(token)
    return payload && payload.exp > nowSeconds() ? payload : null
  }

  private verifyToken(token: string, type: 'access' | 'refresh'): SessionPayload | null {
    const payload = this.verify<SessionPayload & { type?: string }>(token)
    return payload && payload.exp > nowSeconds() && payload.type === type ? payload : null
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/auth/me') {
      const user = this.getUser(req)
      writeJson(
        res,
        user ? 200 : 401,
        user ? { authenticated: true, user } : { authenticated: false },
      )
      return true
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      this.clearCookies(res, req)
      writeJson(res, 204)
      return true
    }
    // 密码认证：POST /api/auth/challenge → 分发一次性 nonce（公开，供前端派生加密密钥）。
    if (path === '/api/auth/challenge' && req.method === 'POST') {
      if (!this.cfg.username) {
        writeJson(res, 404, { error: 'Not found' })
        return true
      }
      this.pruneChallenges()
      const challengeId = randomBytes(16).toString('base64url')
      const nonce = randomBytes(24).toString('hex')
      this.challenges.set(challengeId, { nonce, exp: nowSeconds() + CHALLENGE_TTL_SECONDS })
      writeJson(res, 200, { challengeId, nonce })
      return true
    }
    // 密码认证：POST /api/auth/login → 解密凭据信封 → 校验用户名/密码 → 签发双 token。
    if (path === '/api/auth/login' && req.method === 'POST') {
      if (!this.cfg.username) {
        writeJson(res, 404, { error: 'Not found' })
        return true
      }
      const body = await readJsonBody<{ challengeId?: string; cipher?: string }>(req)
      const creds = body?.challengeId && body?.cipher
        ? this.decryptCredentials(body.challengeId, body.cipher)
        : null
      const tokens =
        creds &&
        this.authenticate(creds.username ?? '', creds.password ?? '')
      if (!tokens) {
        writeJson(res, 401, { error: 'Invalid credentials' })
        return true
      }
      writeJson(res, 200, {
        username: creds?.username ?? '',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.accessTtl,
      })
      return true
    }
    // 密码认证：POST /api/auth/refresh → 校验 refresh token → 换发新 access token。
    if (path === '/api/auth/refresh' && req.method === 'POST') {
      if (!this.cfg.username) {
        writeJson(res, 404, { error: 'Not found' })
        return true
      }
      const body = await readJsonBody<{ refreshToken?: string }>(req)
      const result = body?.refreshToken ? this.refresh(body.refreshToken) : null
      if (!result) {
        writeJson(res, 401, { error: 'Invalid refresh token' })
        return true
      }
      writeJson(res, 200, { accessToken: result.accessToken, expiresIn: result.expiresIn })
      return true
    }
    if (path === '/api/auth/login') {
      if (!this.enabled) {
        res.writeHead(302, { Location: '/' })
        res.end()
        return true
      }
      const returnTo = safeReturnTo(
        new URL(req.url ?? '/', 'http://localhost').searchParams.get('returnTo'),
      )
      const verifier = randomBytes(32).toString('base64url')
      const state = this.sign<OAuthState>({
        verifier,
        returnTo,
        exp: nowSeconds() + STATE_TTL_SECONDS,
      })
      this.setCookie(res, STATE_COOKIE, state, req, STATE_TTL_SECONDS)
      const url = new URL(this.cfg.authorizationUrl!)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', this.cfg.clientId!)
      url.searchParams.set('redirect_uri', this.cfg.redirectUri!)
      url.searchParams.set('scope', 'openid profile email')
      url.searchParams.set('state', state)
      url.searchParams.set(
        'code_challenge',
        base64url(createHash('sha256').update(verifier).digest()),
      )
      url.searchParams.set('code_challenge_method', 'S256')
      res.writeHead(302, { Location: url.toString() })
      res.end()
      return true
    }
    if (path === '/api/auth/callback') {
      await this.callback(req, res)
      return true
    }
    return false
  }

  isTrustedOrigin(origin: string | undefined, req: IncomingMessage): boolean {
    if (!this.enabled) return true
    if (!origin) return false
    if (this.cfg.trustedOrigins.includes(origin)) return true
    try {
      const originUrl = new URL(origin)
      const forwardedHost =
        String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')
          .split(',')[0]
          ?.trim() ?? ''
      const host = forwardedHost ? new URL(`http://${forwardedHost}`).hostname.toLowerCase() : ''
      return Boolean(host) && originUrl.hostname.toLowerCase() === host
    } catch {
      return false
    }
  }

  private async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const state = url.searchParams.get('state') ?? ''
    const expected = readCookie(req, STATE_COOKIE)
    const saved =
      expected && constantTimeEqual(state, expected) ? this.verify<OAuthState>(state) : null
    const code = url.searchParams.get('code')
    if (!saved || saved.exp <= nowSeconds() || !code) {
      writeJson(res, 400, { error: 'Invalid or expired OAuth2 login state' })
      return
    }
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.cfg.redirectUri!,
        client_id: this.cfg.clientId!,
        code_verifier: saved.verifier,
      })
      if (this.cfg.clientSecret) body.set('client_secret', this.cfg.clientSecret)
      const tokenRes = await fetch(this.cfg.tokenUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      })
      if (!tokenRes.ok) throw new Error(`token endpoint returned ${tokenRes.status}`)
      const token = (await tokenRes.json()) as { access_token?: string }
      if (!token.access_token) throw new Error('token response has no access_token')
      const infoRes = await fetch(this.cfg.userInfoUrl!, {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
      })
      if (!infoRes.ok) throw new Error(`userinfo endpoint returned ${infoRes.status}`)
      const profile = (await infoRes.json()) as Record<string, unknown>
      const sub = typeof profile.sub === 'string' ? profile.sub : ''
      const username = firstString(profile, ['preferred_username', 'email', 'name', 'sub'])
      if (!sub || !username || !this.isAdmin(profile, sub, username)) {
        writeJson(res, 403, {
          error: 'Only configured admin accounts may access or register this service',
        })
        return
      }
      this.setCookie(
        res,
        SESSION_COOKIE,
        this.sign<SessionPayload>({
          sub,
          username,
          isAdmin: true,
          exp: nowSeconds() + SESSION_TTL_SECONDS,
        }),
        req,
        SESSION_TTL_SECONDS,
      )
      this.setCookie(res, STATE_COOKIE, '', req, 0)
      res.writeHead(302, { Location: saved.returnTo })
      res.end()
    } catch (error) {
      writeJson(res, 502, { error: 'OAuth2 login failed', detail: (error as Error).message })
    }
  }

  private isAdmin(profile: Record<string, unknown>, sub: string, username: string): boolean {
    const identifiers = [sub, username, typeof profile.email === 'string' ? profile.email : '']
    if (identifiers.some((id) => this.cfg.adminUsers.includes(id))) return true
    const claim = this.cfg.adminClaim ? profile[this.cfg.adminClaim] : undefined
    const values = Array.isArray(claim)
      ? claim.filter((v): v is string => typeof v === 'string')
      : typeof claim === 'string'
        ? [claim]
        : []
    return values.some((value) => this.cfg.adminValues.includes(value))
  }

  private sign<T>(payload: T): string {
    const encoded = base64url(Buffer.from(JSON.stringify(payload)))
    return `${encoded}.${base64url(createHmac('sha256', this.secret).update(encoded).digest())}`
  }
  private verify<T>(token: string): T | null {
    const [encoded, sig, ...extra] = token.split('.')
    if (
      !encoded ||
      !sig ||
      extra.length ||
      !constantTimeEqual(sig, base64url(createHmac('sha256', this.secret).update(encoded).digest()))
    )
      return null
    try {
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T
    } catch {
      return null
    }
  }
  private setCookie(
    res: ServerResponse,
    name: string,
    value: string,
    req: IncomingMessage,
    maxAge: number,
  ): void {
    const secure = isHttps(req)
    const attrs = [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
    ]
    if (secure) attrs.push('Secure')
    appendCookie(res, attrs.join('; '))
  }
  private clearCookies(res: ServerResponse, req: IncomingMessage): void {
    this.setCookie(res, SESSION_COOKIE, '', req, 0)
    this.setCookie(res, STATE_COOKIE, '', req, 0)
  }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
function base64url(value: Buffer): string {
  return value.toString('base64url')
}
function readCookie(req: IncomingMessage, name: string): string | undefined {
  const pair = req.headers.cookie?.split(/;\s*/).find((item) => item.startsWith(`${name}=`))
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : undefined
}
function readBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? ''
  const [scheme, token, ...extra] = header.split(/\s+/)
  return scheme?.toLowerCase() === 'bearer' && token && extra.length === 0 ? token : undefined
}
function readTokenQuery(req: IncomingMessage): string | undefined {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const token = url.searchParams.get('token')
  return token ? decodeURIComponent(token) : undefined
}
/** 本地 loopback 判定：remoteAddress 为 127.0.0.1 / ::1 / ::ffff:127.0.0.1。 */
function isLoopback(req: IncomingMessage): boolean {
  const addr = (req.socket.remoteAddress ?? '').toLowerCase()
  return (
    addr === '127.0.0.1' ||
    addr === '::1' ||
    addr === '::ffff:127.0.0.1' ||
    addr === '::ffff:127.0.0.1%0'
  )
}
async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
function appendCookie(res: ServerResponse, value: string): void {
  const current = res.getHeader('Set-Cookie')
  res.setHeader(
    'Set-Cookie',
    current ? [...(Array.isArray(current) ? current : [String(current)]), value] : value,
  )
}
function writeJson(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(
    status,
    body === undefined
      ? undefined
      : { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  )
  res.end(body === undefined ? undefined : JSON.stringify(body))
}
function safeReturnTo(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/'
}
function firstString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys)
    if (typeof value[key] === 'string' && value[key]) return value[key] as string
  return ''
}
function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
function isHttps(req: IncomingMessage): boolean {
  return (
    (req.socket as { encrypted?: boolean }).encrypted === true ||
    (String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      ?.trim() ?? '') === 'https'
  )
}
