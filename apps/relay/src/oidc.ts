import { createHash, createPublicKey, randomBytes, verify, timingSafeEqual } from 'node:crypto'

export interface BusinessOidcOptions { issuer: string; clientId: string; clientSecret?: string; redirectUri: string }
interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; token_endpoint_auth_methods_supported?: string[] }
interface Pending { binding: string; nonce: string; verifier: string; expires: number; discovery: Discovery; returnTo: string }
export class BusinessOidc {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly config: BusinessOidcOptions, private readonly basePath: string) { endpoint(config.issuer); endpoint(config.redirectUri) }
  async begin(returnTo: string): Promise<{ url: string; binding: string }> {
    const fallback = `${this.basePath}/`
    if (!returnTo.startsWith(fallback) || returnTo.startsWith('//') || /[\\\x00-\x20]/.test(returnTo) || /%(?:2f|5c|2e)/i.test(returnTo)) returnTo = fallback
    for (const [id, p] of this.pending) if (p.expires <= Date.now()) this.pending.delete(id)
    if (this.pending.size >= 200) throw new Error('OIDC_CAPACITY')
    const raw = await json(`${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
    if (raw.issuer !== this.config.issuer) throw new Error('OIDC_ISSUER_INVALID')
    for (const name of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) { if (typeof raw[name] !== 'string') throw new Error('OIDC_DISCOVERY_INVALID'); endpoint(raw[name] as string) }
    const discovery = raw as unknown as Discovery
    const state = random(); const binding = random(); const nonce = random(); const verifier = random()
    if (this.pending.size >= 200) throw new Error('OIDC_CAPACITY')
    this.pending.set(state, { binding, nonce, verifier, discovery, expires: Date.now() + 300000, returnTo })
    const url = endpoint(discovery.authorization_endpoint)
    for (const [k, v] of Object.entries({ response_type: 'code', scope: 'openid profile', client_id: this.config.clientId, redirect_uri: this.config.redirectUri, state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(k, v)
    return { url: url.href, binding }
  }
  async finish(url: URL, binding: string): Promise<{ subject: string; issuer: string; returnTo: string }> {
    for (const field of ['state', 'code', 'iss']) if (url.searchParams.getAll(field).length > 1) throw new Error('OIDC_CALLBACK_INVALID')
    const state = url.searchParams.get('state') ?? ''; const p = this.pending.get(state)
    if (!p || !equal(binding, p.binding)) throw new Error('OIDC_STATE_INVALID')
    this.pending.delete(state)
    if (p.expires <= Date.now() || url.searchParams.has('error') || (url.searchParams.has('iss') && url.searchParams.get('iss') !== this.config.issuer)) throw new Error('OIDC_STATE_INVALID')
    const code = url.searchParams.get('code'); if (!code || code.length > 4096) throw new Error('OIDC_CODE_INVALID')
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: this.config.redirectUri })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    const methods = p.discovery.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
    if (this.config.clientSecret && methods.includes('client_secret_basic')) {
      const encode = (s: string) => new URLSearchParams({ x: s }).toString().slice(2)
      headers.Authorization = `Basic ${Buffer.from(`${encode(this.config.clientId)}:${encode(this.config.clientSecret)}`).toString('base64')}`
    } else if (this.config.clientSecret && methods.includes('client_secret_post')) { body.set('client_id', this.config.clientId); body.set('client_secret', this.config.clientSecret) }
    else if (!this.config.clientSecret && methods.includes('none')) body.set('client_id', this.config.clientId)
    else throw new Error('OIDC_CLIENT_AUTH_UNSUPPORTED')
    const tokens = await json(p.discovery.token_endpoint, { method: 'POST', body, headers })
    if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 32768) throw new Error('OIDC_TOKEN_INVALID')
    const parts = tokens.id_token.split('.')
    if (parts.length !== 3 || parts.some((v) => !/^[A-Za-z0-9_-]+$/.test(v))) throw new Error('OIDC_TOKEN_INVALID')
    const header = decode(parts[0]!); const claims = decode(parts[1]!)
    if (!['RS256', 'ES256', 'EdDSA'].includes(String(header.alg)) || typeof header.kid !== 'string' || header.crit !== undefined || header.jku !== undefined || header.x5u !== undefined) throw new Error('OIDC_ALGORITHM_INVALID')
    const jwks = await json(p.discovery.jwks_uri)
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 100) throw new Error('OIDC_JWKS_INVALID')
    const keys = (jwks.keys as Record<string, unknown>[]).filter((k) => k && k.kid === header.kid && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === header.alg) && (k.key_ops === undefined || Array.isArray(k.key_ops) && k.key_ops.includes('verify')) && (header.alg === 'RS256' ? k.kty === 'RSA' : header.alg === 'ES256' ? k.kty === 'EC' && k.crv === 'P-256' : k.kty === 'OKP' && k.crv === 'Ed25519'))
    if (keys.length !== 1) throw new Error('OIDC_KEY_INVALID')
    const key = createPublicKey({ key: keys[0]!, format: 'jwk' })
    if (header.alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('OIDC_KEY_INVALID')
    if (!verify(header.alg === 'EdDSA' ? null : 'sha256', Buffer.from(`${parts[0]}.${parts[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(parts[2]!, 'base64url'))) throw new Error('OIDC_SIGNATURE_INVALID')
    const now = Math.floor(Date.now() / 1000); const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud
    if (claims.iss !== this.config.issuer || !Array.isArray(audiences) || !audiences.length || audiences.some((v) => typeof v !== 'string') || !audiences.includes(this.config.clientId) || typeof claims.sub !== 'string' || !claims.sub || claims.nonce !== p.nonce || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 || claims.iat < now - 300 || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp <= claims.iat || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now + 30)) || (audiences.length > 1 && claims.azp !== this.config.clientId) || (claims.azp !== undefined && claims.azp !== this.config.clientId)) throw new Error('OIDC_CLAIMS_INVALID')
    return { subject: claims.sub, issuer: this.config.issuer, returnTo: p.returnTo }
  }
  clear(): void { this.pending.clear() }
}
function random(): string { return randomBytes(32).toString('base64url') }
function equal(a: string, b: string): boolean { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
function decode(s: string): Record<string, unknown> { const b = Buffer.from(s, 'base64url'); if (b.toString('base64url') !== s) throw new Error('OIDC_TOKEN_INVALID'); const value: unknown = JSON.parse(b.toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OIDC_TOKEN_INVALID'); return value as Record<string, unknown> }
function endpoint(s: string): URL { const u = new URL(s); if (u.username || u.password || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error('OIDC_ENDPOINT_INVALID'); return u }
async function json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint(url), { ...init, redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', ...init?.headers } })
  if (!response.ok || !response.body) throw new Error('OIDC_PROVIDER_FAILED')
  const chunks: Uint8Array[] = []; let bytes = 0
  for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 262144) throw new Error('OIDC_RESPONSE_TOO_LARGE'); chunks.push(chunk) }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OIDC_PROVIDER_FAILED')
  return value as Record<string, unknown>
}
