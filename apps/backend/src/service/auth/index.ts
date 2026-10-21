import type { DirectBrowserSessions } from './browserSessions.js'
import { UserProofVerifier } from '../../../../relay/src/userProof.js'
import { DirectBrowserSessions as BrowserSessions } from './browserSessions.js'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isHashed, verifyPassword } from '@/utils/password.js'
import { xorDecrypt } from '@/utils/obfuscate.js'

export interface OAuth2Config {
  enabled?: boolean
  /** Additional separately-hosted internal UIs allowed to open a control socket. */
  trustedOrigins?: string[]
  /** 本地用户名/密码认证：设置 username 后启用（远端强制，loopback 豁免）。 */
  username?: string
  /** password 明文或 scrypt 哈希（scrypt$<salt>$<hash>）；启动自检明文→哈希。 */
  password?: string
  /** Remote-only listeners set this false; local loopback compatibility remains default true. */
  allowLoopback?: boolean
  /** Independent internal identity; cannot be used at business login endpoints. */
  browserDeployment?: { origin: string; basePath: string }
  userProof?: { issuer: string; backendId: string; keys: Record<string, string>; authorizations: Array<{ id: string; revision: number; subject: string }> }
  machine?: { username: string; password: string }
}

export interface AuthenticatedUser {
  sub: string
  username: string
  isAdmin: true
}

/** Per-listener policy. Remote listeners must not inherit the local loopback exemption. */
export interface AuthRequestOptions {
  allowLoopback?: boolean
  /** Trust the relay-provided public prefix for cookie paths on the remote listener only. */
  trustForwardedPrefix?: boolean
}

interface SessionPayload extends AuthenticatedUser {
  exp: number
}
const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60
/** 登录挑战（challenge）TTL：前端须在有效期内完成加密登录，过期作废。 */
const CHALLENGE_TTL_SECONDS = 120
const PASSWORD_FAILURE_STEP = 15
const PASSWORD_COOLDOWN_START_SECONDS = 5 * 60
const PASSWORD_COOLDOWN_MAX_SECONDS = 60 * 60

interface PasswordFailureState {
  failures: number
  cooldownUntil: number
}

/**
 * Backend authentication gate. OIDC is handled by the relay; this class keeps
 * local loopback trust and the backend username/password token flow.
 */
export class OAuth2Auth {
  readonly enabled: boolean
  readonly browser: DirectBrowserSessions = new BrowserSessions(this)
  private readonly cfg: Required<Pick<OAuth2Config, 'trustedOrigins'>> & OAuth2Config
  private readonly secret: string
  private readonly proof?: UserProofVerifier
  private readonly proofUsers = new WeakMap<IncomingMessage, AuthenticatedUser>()
  private readonly authorizationSockets = new Map<{ close(code?: number, reason?: string): void }, { id: string; revision: number; subject: string }>()
  private readonly proofAuthorization = new WeakMap<IncomingMessage, { id: string; revision: number; subject: string }>()
  attachProofSocket(req: IncomingMessage, socket: { close(code?: number, reason?: string): void }): () => void {
    const authorization = this.proofAuthorization.get(req)
    if (authorization) this.authorizationSockets.set(socket, authorization)
    return () => this.authorizationSockets.delete(socket)
  }
  /** 一次性登录挑战：challengeId → nonce + 过期时间。解密后即删除（防重放）。 */
  private readonly challenges = new Map<string, { nonce: string; exp: number }>()
  private readonly machineAttempts = new Map<string, { count: number; reset: number }>()
  private readonly passwordFailures = new Map<string, PasswordFailureState>()

  private machineState: 'configured' | 'not_configured' | 'invalid' = 'not_configured'
  maintenanceDiagnostic() { return { status: this.machineState, ...(this.machineState === 'invalid' ? { code: 'MACHINE_CONFIG_INVALID' as const } : {}) } }

  constructor(config: OAuth2Config | undefined) {
    this.cfg = {
      ...config,
      trustedOrigins: config?.trustedOrigins ?? [],
    }
    // 会话签名密钥：环境变量 > 后端动态生成。由 config.ts ensureAuthSessionSecret 持久化到
    // 根 .env（CHERY_AUTH_SESSION_SECRET）跨重启复用；未注入时动态生成兜底。
    this.secret = process.env.CHERY_AUTH_SESSION_SECRET || randomBytes(32).toString('hex')
    // 密码认证开启鉴权门禁；OIDC 只在中转处理。
    this.enabled = config?.enabled === true || !!config?.username || !!config?.machine || !!config?.userProof || !!config?.browserDeployment
    if (config?.userProof) {
      const trusted = config.userProof
      this.cfg.userProof = { ...trusted, authorizations: [] }
      this.proof = new UserProofVerifier(trusted.issuer, trusted.backendId, trusted.keys, (claims) => this.cfg.userProof!.authorizations.some((a) => a.id === claims.authorizationId && a.revision === claims.authorizationRevision && a.subject === claims.sub))
    }
    if (this.cfg.browserDeployment && !this.cfg.username) throw new Error('Public browser deployment requires a business account')
    if (this.cfg.browserDeployment) {
      const { origin, basePath } = this.cfg.browserDeployment
      if (new URL(origin).origin !== origin || !/^https?:/.test(origin) || (basePath !== '' && (!basePath.startsWith('/') || basePath.startsWith('//') || basePath.endsWith('/'))) || /[\\?#%\x00-\x20]/.test(basePath) || basePath.split('/').some((x) => x === '.' || x === '..')) throw new Error('Invalid browser deployment')
    }
    if (this.cfg.machine) this.machineState = 'configured'
    if (this.cfg.machine && (typeof this.cfg.machine.username !== 'string' || !this.cfg.machine.username || this.cfg.machine.username.length > 256 || typeof this.cfg.machine.password !== 'string' || !isHashed(this.cfg.machine.password))) {
      // A broken optional maintenance identity never disables the business gate.
      this.cfg.machine = undefined
      this.machineState = 'invalid'
    }
    if (!this.enabled) return
    if (this.cfg.username) {
      // 密码认证模式：password 必须是已哈希值（明文由 worker 启动自检改写后重启）。
      if (!this.cfg.password || !isHashed(this.cfg.password))
        throw new Error(
          'server.auth.password must be a scrypt hash (scrypt$<salt>$<hash>); plaintext is rewritten to hash on startup',
        )
      return
    }
  }

  getUser(req: IncomingMessage, options?: AuthRequestOptions): AuthenticatedUser | null {
    if (options?.allowLoopback === false && this.proof) {
      const cached = this.proofUsers.get(req)
      if (cached) return cached
      const token = req.headers['x-chery-relay-user-proof']
      if (typeof token === 'string') {
        try { const claims = this.proof.consume(token, req.method ?? 'GET', req.url ?? '/'); const user = { sub: claims.sub, username: claims.sub, isAdmin: true as const }; this.proofUsers.set(req, user); this.proofAuthorization.set(req, { id: claims.authorizationId, revision: claims.authorizationRevision, subject: claims.sub }); return user } catch { return null }
      }
    }
    if (options?.allowLoopback !== false) {
      const browserUser = this.browser.user(req)
      if (browserUser) return browserUser
    }
    if (!this.enabled && options?.allowLoopback !== false && isLoopback(req)) return { sub: 'local', username: 'local', isAdmin: true }
    if (options?.allowLoopback !== false && this.cfg.browserDeployment && !this.browser.user(req)) return null
    // 本地 loopback 信任豁免：直连不鉴权。
    const allowLoopback = options?.allowLoopback ?? this.cfg.allowLoopback !== false
    if (allowLoopback && isLoopback(req)) return { sub: 'local', username: 'local', isAdmin: true }
    // 远端：校验 access token（Authorization: Bearer / WS ?token=）。
    const token = readBearer(req) ?? readRelayBearer(req) ?? readTokenQuery(req)
    const payload = token ? this.verifyAuthToken(token) : null
    return payload ? { sub: payload.sub, username: payload.username, isAdmin: true } : null
  }

  /** 校验用户名/密码，成功签发双 token。失败返回 null。 */
  authenticate(
    username: string,
    password: string,
  ): { accessToken: string; refreshToken: string; accessTtl: number } | null {
    if (!this.cfg.username || !this.cfg.password) return null
    // Cooldown belongs to the configured account, not attacker-controlled input.
    const key = this.cfg.username
    const state = this.passwordFailures.get(key)
    if (state && state.cooldownUntil > Date.now()) return null
    if (username !== this.cfg.username || !verifyPassword(password, this.cfg.password)) {
      this.recordPasswordFailure(key)
      return null
    }
    this.passwordFailures.delete(key)
    return this.issueTokens(username)
  }

  /** Current account cooldown, used by HTTP handlers to reject challenge and login consistently. */
  passwordRetryAfter(username = ''): number {
    if (this.cfg.username && username && username !== this.cfg.username) return 0
    const state = this.passwordFailures.get(this.cfg.username ?? '<empty>')
    if (!state || state.cooldownUntil <= Date.now()) return 0
    return Math.max(1, Math.ceil((state.cooldownUntil - Date.now()) / 1000))
  }

  private recordPasswordFailure(key: string): void {
    const current = this.passwordFailures.get(key) ?? { failures: 0, cooldownUntil: 0 }
    current.failures += 1
    if (current.failures % PASSWORD_FAILURE_STEP === 0) {
      const step = Math.min(
        Math.floor(current.failures / PASSWORD_FAILURE_STEP) - 1,
        Math.log2(PASSWORD_COOLDOWN_MAX_SECONDS / PASSWORD_COOLDOWN_START_SECONDS),
      )
      const seconds = Math.min(
        PASSWORD_COOLDOWN_MAX_SECONDS,
        PASSWORD_COOLDOWN_START_SECONDS * 2 ** step,
      )
      current.cooldownUntil = Date.now() + seconds * 1000
    }
    this.passwordFailures.set(key, current)
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
      if (typeof parsed.username !== 'string' || !parsed.username || parsed.username.length > 256 || typeof parsed.password !== 'string' || !parsed.password || parsed.password.length > 1024 || Object.keys(parsed).some((key) => !['username', 'password'].includes(key))) return null
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
    const payload = this.verifyToken(token, 'access')
    return payload && !(payload as SessionPayload & { domain?: string }).domain ? payload : null
  }

  private verifyToken(token: string, type: 'access' | 'refresh' | 'probe'): SessionPayload | null {
    const payload = this.verify<SessionPayload & { type?: string }>(token)
    return payload && payload.exp > nowSeconds() && payload.type === type ? payload : null
  }

  updateAuthorizations(values: Array<{ id: string; revision: number; subject: string }>): void {
    if (!this.cfg.userProof) {
      if (values.length) throw new Error('User proof trust is not configured')
      return
    }
    if (values.length > 10000 || values.some((a) => !a || typeof a.id !== 'string' || typeof a.subject !== 'string' || !Number.isSafeInteger(a.revision) || a.revision < 1)) throw new Error('Invalid authorization snapshot')
    this.cfg.userProof.authorizations.splice(0, this.cfg.userProof.authorizations.length, ...structuredClone(values))
    for (const [socket, previous] of this.authorizationSockets) {
      if (!values.some((a) => a.id === previous.id && a.revision === previous.revision && a.subject === previous.subject)) {
        socket.close(4003, 'Authorization revoked')
        this.authorizationSockets.delete(socket)
      }
    }
  }
  tunnelProbeToken(): string {
    return this.sign({ sub: 'tunnel-probe', username: 'tunnel-probe', isAdmin: true, type: 'probe', exp: nowSeconds() + 30 })
  }
  getMachineUser(req: IncomingMessage): AuthenticatedUser | null {
    if (req.headers.origin || req.headers.cookie || req.headers['x-forwarded-host'] || req.headers['x-forwarded-for'] || req.headers['x-chery-relay-authorization'] || req.headers['x-chery-relay-user-proof']) return null
    const token = readBearer(req)
    const payload = token ? this.verify<SessionPayload & { type?: string; domain?: string }>(token) : null
    return payload && payload.domain === 'machine' && payload.type === 'machine-access' && payload.exp > nowSeconds() && payload.username === this.cfg.machine?.username ? payload : null
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    options?: AuthRequestOptions,
  ): Promise<boolean> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/api/machine/login' && req.method === 'POST') {
      if (options?.allowLoopback === false || req.headers.origin || req.headers.cookie || req.headers['x-forwarded-host'] || req.headers['x-forwarded-for']) { writeJson(res, 403, { error: 'Machine source rejected' }); return true }
      const now = Date.now()
      for (const [key, value] of this.machineAttempts) if (value.reset <= now) this.machineAttempts.delete(key)
      const source = req.socket.remoteAddress ?? 'unknown'
      const attempts = this.machineAttempts.get(source) ?? { count: 0, reset: now + 60000 }
      if (this.machineAttempts.size >= 1000 || ++attempts.count > 600) { res.setHeader('Retry-After', '60'); writeJson(res, 429, { error: 'Machine login rate limited' }); return true }
      this.machineAttempts.set(source, attempts)
      const body = await readJsonBody<{ username?: string; password?: string }>(req)
      const machine = this.cfg.machine
      if (!machine || !body || Object.keys(body).some((key) => !['username', 'password'].includes(key)) || body.username !== machine.username || typeof body.password !== 'string' || body.password.length > 1024 || !verifyPassword(body.password, machine.password)) { writeJson(res, 401, { error: 'Invalid credentials' }); return true }
      writeJson(res, 200, { accessToken: this.sign({ sub: machine.username, username: machine.username, isAdmin: true, domain: 'machine', type: 'machine-access', exp: nowSeconds() + 60 }), expiresIn: 60 })
      return true
    }
    if (path === '/api/auth/me') {
      const probeToken = options?.allowLoopback === false ? readRelayBearer(req) : undefined
      if (probeToken && req.method === 'GET' && this.verifyToken(probeToken, 'probe')) { writeJson(res, 200, { authenticated: true, purpose: 'tunnel-probe' }); return true }
      const user = this.getUser(req, options)
      writeJson(
        res,
        user ? 200 : 401,
        user ? { authenticated: true, user } : { authenticated: false },
      )
      return true
    }
    if (path === '/api/auth/capabilities' && req.method === 'GET') {
      writeJson(res, 200, {
        password: Boolean(this.cfg.username),
        oidc: false,
        service: 'backend',
        ...(options?.allowLoopback !== false ? this.browser.capabilities(req, res) : {}),
      })
      return true
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      writeJson(res, 204)
      return true
    }
    // 密码认证：POST /api/auth/challenge → 分发一次性 nonce（公开，供前端派生加密密钥）。
    if (path === '/api/auth/challenge' && req.method === 'POST') {
      if (!this.cfg.username) {
        writeJson(res, 404, { error: 'Not found' })
        return true
      }
      const challengeBody = await readJsonBody<{ username?: string }>(req)
      const retryAfter = this.passwordRetryAfter(challengeBody?.username ?? '')
      if (retryAfter > 0) {
        res.setHeader('Retry-After', retryAfter)
        writeJson(res, 429, { error: 'Password login is temporarily locked', retryAfter })
        return true
      }
      this.pruneChallenges()
      if (this.challenges.size >= 1000) { writeJson(res, 429, { error: 'Challenge capacity reached' }); return true }
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
      const creds =
        body?.challengeId && body?.cipher
          ? this.decryptCredentials(body.challengeId, body.cipher)
          : null
      const tokens = creds && this.authenticate(creds.username ?? '', creds.password ?? '')
      if (!tokens) {
        const retryAfter = this.passwordRetryAfter(creds?.username ?? '')
        if (retryAfter > 0) res.setHeader('Retry-After', retryAfter)
        writeJson(res, retryAfter > 0 ? 429 : 401, {
          error: retryAfter > 0 ? 'Password login is temporarily locked' : 'Invalid credentials',
          ...(retryAfter > 0 ? { retryAfter } : {}),
        })
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
    return false
  }

  browserDeployment(): { origin: string; basePath: string } | undefined { return this.cfg.browserDeployment }
  isTrustedOrigin(origin: string | undefined, req: IncomingMessage): boolean {
    if (this.cfg.browserDeployment) return origin === this.cfg.browserDeployment.origin
    if (!origin) return false
    if (this.cfg.trustedOrigins.includes(origin)) return true
    try {
      const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https:' : 'http:'
      return origin === `${protocol}//${req.headers.host ?? ''}` && new URL(origin).origin === origin
    } catch { return false }
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
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
function base64url(value: Buffer): string {
  return value.toString('base64url')
}
function readBearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? ''
  const [scheme, token, ...extra] = header.split(/\s+/)
  return scheme?.toLowerCase() === 'bearer' && token && extra.length === 0 ? token : undefined
}
function readRelayBearer(req: IncomingMessage): string | undefined {
  const header = req.headers['x-chery-relay-authorization']
  if (typeof header !== 'string') return undefined
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
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > 16384) return null
    chunks.push(bytes)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
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
function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
