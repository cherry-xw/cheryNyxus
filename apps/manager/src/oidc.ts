import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'

export interface OidcOptions {
  issuer: string
  clientId: string
  clientSecret: string
  redirectUri: string
  adminSubjects: string[]
}
interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  token_endpoint_auth_methods_supported?: string[]
}
interface Pending {
  binding: string
  nonce: string
  verifier: string
  expiresAt: number
  revision: string
  discovery: Discovery
}

export function safeEndpoint(value: string): URL {
  const url = new URL(value)
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new Error('oidc_invalid_endpoint')
  }
  return url
}

export function oidcConfigured(options: OidcOptions | undefined, origins: string[]): boolean {
  if (!options || !options.clientId || !options.clientSecret || !Array.isArray(options.adminSubjects) ||
      !options.adminSubjects.length || options.adminSubjects.some((sub) => typeof sub !== 'string' || !sub)) return false
  try {
    const issuer = safeEndpoint(options.issuer)
    const redirect = safeEndpoint(options.redirectUri)
    return !issuer.search && redirect.pathname === '/api/auth/oidc/callback' && !redirect.search && origins.includes(redirect.origin)
  } catch { return false }
}

async function boundedJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(safeEndpoint(url), {
    ...init, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Accept: 'application/json', ...init?.headers },
  })
  if (!response.ok || !response.body) throw new Error('oidc_provider_failed')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 256 * 1024) throw new Error('oidc_response_too_large')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('oidc_provider_failed')
  return parsed as Record<string, unknown>
}

export class OidcLogin {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly options: OidcOptions, private readonly now: () => number) {}

  clear(): void { this.pending.clear() }

  async begin(revision: string): Promise<{ url: string; binding: string }> {
    for (const [key, value] of this.pending) if (value.expiresAt <= this.now()) this.pending.delete(key)
    if (this.pending.size >= 200) throw new Error('oidc_capacity')
    const metadata = await boundedJson(`${this.options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
    if (metadata.issuer !== this.options.issuer) throw new Error('oidc_issuer_mismatch')
    for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof metadata[name] !== 'string') throw new Error('oidc_discovery_invalid')
      safeEndpoint(metadata[name] as string)
    }
    const discovery = metadata as unknown as Discovery
    const state = randomBytes(32).toString('base64url')
    const binding = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    if (this.pending.size >= 200) throw new Error('oidc_capacity')
    this.pending.set(state, { binding, nonce, verifier, revision, discovery, expiresAt: this.now() + 300_000 })
    const url = safeEndpoint(discovery.authorization_endpoint)
    const params = {
      response_type: 'code', scope: 'openid', client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri, state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    return { url: url.href, binding }
  }

  async finish(url: URL, binding: string, revision: string): Promise<string> {
    for (const name of ['state', 'code', 'iss']) if (url.searchParams.getAll(name).length > 1) throw new Error('oidc_callback_invalid')
    const state = url.searchParams.get('state') ?? ''
    const pending = this.pending.get(state)
    if (!pending || !binding || pending.binding !== binding) throw new Error('oidc_state_invalid')
    this.pending.delete(state)
    if (pending.expiresAt <= this.now() || pending.revision !== revision || url.searchParams.has('error')) throw new Error('oidc_state_invalid')
    const responseIssuer = url.searchParams.get('iss')
    if (responseIssuer !== null && responseIssuer !== this.options.issuer) throw new Error('oidc_issuer_mismatch')
    const code = url.searchParams.get('code')
    if (!code || code.length > 4096) throw new Error('oidc_code_invalid')
    const body = new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: this.options.redirectUri, code_verifier: pending.verifier })
    const methods = pending.discovery.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
    let headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (methods.includes('client_secret_basic')) {
      const encode = (value: string) => new URLSearchParams({ x: value }).toString().slice(2)
      headers.Authorization = `Basic ${Buffer.from(`${encode(this.options.clientId)}:${encode(this.options.clientSecret)}`).toString('base64')}`
    } else if (methods.includes('client_secret_post')) {
      body.set('client_id', this.options.clientId)
      body.set('client_secret', this.options.clientSecret)
    } else throw new Error('oidc_client_auth_unsupported')
    const tokens = await boundedJson(pending.discovery.token_endpoint, { method: 'POST', headers, body })
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 32768) throw new Error('oidc_token_invalid')
    const parts = tokens.id_token.split('.')
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('oidc_token_invalid')
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as Record<string, unknown>
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>
    if (!['RS256', 'ES256'].includes(String(header.alg)) || typeof header.kid !== 'string' || header.crit !== undefined) throw new Error('oidc_algorithm_invalid')
    const jwks = await boundedJson(pending.discovery.jwks_uri)
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 100) throw new Error('oidc_jwks_invalid')
    const keys = (jwks.keys as Record<string, unknown>[]).filter((key) => key && key.kid === header.kid &&
      (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === header.alg) &&
      (header.alg === 'RS256' ? key.kty === 'RSA' : key.kty === 'EC' && key.crv === 'P-256') &&
      (key.key_ops === undefined || Array.isArray(key.key_ops) && key.key_ops.includes('verify')))
    if (keys.length !== 1) throw new Error('oidc_key_invalid')
    const key = createPublicKey({ key: keys[0]!, format: 'jwk' })
    if (header.alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('oidc_key_invalid')
    const verified = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
      header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2]!, 'base64url'))
    if (!verified) throw new Error('oidc_signature_invalid')
    const now = Math.floor(this.now() / 1000)
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud
    if (claims.iss !== this.options.issuer || !Array.isArray(audiences) || !audiences.length ||
        audiences.some((aud) => typeof aud !== 'string') || !audiences.includes(this.options.clientId) ||
        typeof claims.sub !== 'string' || !claims.sub || claims.nonce !== pending.nonce ||
        typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > now + 30 || claims.iat < now - 300 ||
        typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now || claims.exp <= claims.iat ||
        (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now)) ||
        (audiences.length > 1 && claims.azp !== this.options.clientId) ||
        (claims.azp !== undefined && claims.azp !== this.options.clientId) ||
        !this.options.adminSubjects.includes(claims.sub)) throw new Error('oidc_claims_invalid')
    return claims.sub
  }
}
