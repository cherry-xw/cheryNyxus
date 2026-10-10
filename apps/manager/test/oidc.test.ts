import { createServer } from 'node:http'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManager } from '../src/server.js'
import type { OidcOptions } from '../src/oidc.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const wrongPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const ecPair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
async function fixture(options: { claims?: Record<string, unknown>; badSignature?: boolean; alg?: string; emptySubjects?: boolean; badDiscovery?: boolean } = {}) {
  let issuer = ''
  let nonce = '', challenge = ''
  let tokenCalls = 0
  const useEc = options.alg === 'ES256'
  const keyPair = useEc ? ecPair : pair
  const provider = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer: options.badDiscovery ? 'https://wrong.example' : issuer,
        authorization_endpoint: `${issuer}/custom/authorize`, token_endpoint: `${issuer}/custom/token`, jwks_uri: `${issuer}/custom/keys`, token_endpoint_auth_methods_supported: ['client_secret_basic'] })); return
    }
    if (req.url === '/custom/keys') {
      res.end(JSON.stringify({ keys: [{ ...keyPair.publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: useEc ? 'ES256' : 'RS256' }] })); return
    }
    if (req.url === '/custom/token') {
      tokenCalls++
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = new URLSearchParams(Buffer.concat(chunks).toString())
      if (body.get('code') !== 'test-code' || body.get('grant_type') !== 'authorization_code' ||
          createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== challenge ||
          req.headers.authorization !== `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`) {
        res.writeHead(400); res.end('{}'); return
      }
      const now = Math.floor(Date.now() / 1000)
      const header = Buffer.from(JSON.stringify({ alg: options.alg ?? 'RS256', kid: 'test-key' })).toString('base64url')
      const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: 'test-client', sub: 'admin-subject', nonce, iat: now, exp: now + 300, ...options.claims })).toString('base64url')
      const data = `${header}.${claims}`
      const signature = sign('sha256', Buffer.from(data), useEc ? { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' } : options.badSignature ? wrongPair.privateKey : keyPair.privateKey).toString('base64url')
      res.end(JSON.stringify({ id_token: `${data}.${signature}`, access_token: 'not-for-browser' })); return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  cleanups.push(() => new Promise<void>((resolve) => provider.close(() => resolve())))
  const root = await mkdtemp(join(tmpdir(), 'manager-oidc-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  // 固定可信外部 origin，用精确回环代理头测试 HTTPS Cookie；不需真实 TLS。
  const origin = 'https://manager.example'
  const oidc: OidcOptions = { issuer, clientId: 'test-client', clientSecret: 'test-secret', redirectUri: `${origin}/api/auth/oidc/callback`, adminSubjects: options.emptySubjects ? [] : ['admin-subject'] }
  const manager = createManager({ port: 0, authFile: join(root, 'auth.json'), controlToken: 'test-machine',
    auth: { oidc, trustedOrigins: [origin], trustedProxies: ['127.0.0.1'] } })
  await manager.listen(); cleanups.push(() => manager.close())
  const base = `http://127.0.0.1:${manager.address()!.port}`
  const headers = { 'X-Forwarded-Host': 'manager.example', 'X-Forwarded-Proto': 'https' }
  const request = (path: string, extra: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { ...headers, ...extra }, redirect: 'manual' })
  async function begin() {
    const response = await request('/api/auth/oidc/login')
    if (response.status !== 302) return { response, callback: '', Cookie: '' }
    const url = new URL(response.headers.get('location')!)
    expect(url.pathname).toBe('/custom/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(oidc.redirectUri)
    nonce = url.searchParams.get('nonce')!; challenge = url.searchParams.get('code_challenge')!
    const callback = `/api/auth/oidc/callback?state=${url.searchParams.get('state')}&code=test-code&iss=${encodeURIComponent(issuer)}`
    return { response, callback, Cookie: response.headers.get('set-cookie')!.split(';')[0]! }
  }
  return { request, begin, tokenCalls: () => tokenCalls }
}

describe('Manager mock OIDC HTTP', () => {
  it.each(['RS256', 'ES256'])('verifies %s signature, discovered endpoints and PKCE, then issues revocable session', async (alg) => {
    const f = await fixture({ alg }), login = await f.begin()
    const response = await f.request(login.callback, { Cookie: login.Cookie })
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/')
    const cookies = response.headers.getSetCookie()
    const Cookie = cookies.find((value) => value.startsWith('chery-manager-session='))!.split(';')[0]!
    expect(cookies.join(';')).toContain('HttpOnly'); expect(cookies.join(';')).toContain('Secure')
    const me = await f.request('/api/auth/me', { Cookie })
    expect(await me.json()).toMatchObject({ username: 'admin-subject', provider: 'oidc' })
    expect((await f.request(login.callback, { Cookie: login.Cookie })).status).toBe(401)
    expect(f.tokenCalls()).toBe(1)
  })
  it('rejects unbound state without token exchange, but permits original bound browser', async () => {
    const f = await fixture(), login = await f.begin()
    expect((await f.request(login.callback)).status).toBe(401)
    expect(f.tokenCalls()).toBe(0)
    expect((await f.request(login.callback, { Cookie: login.Cookie })).status).toBe(302)
  })
  it.each([
    ['issuer', { iss: 'https://evil.example' }], ['audience', { aud: 'wrong-client' }],
    ['subject', { sub: 'not-admin' }], ['nonce', { nonce: 'wrong' }],
    ['expiration', { exp: 1 }], ['issued future', { iat: 9999999999 }],
    ['issued missing', { iat: null }], ['not before', { nbf: 9999999999 }],
    ['authorized party', { azp: 'wrong-client' }], ['multi audience', { aud: ['test-client', 'other'] }],
  ])('rejects invalid %s claim', async (_name, claims) => {
    const f = await fixture({ claims: claims as Record<string, unknown> }), login = await f.begin()
    const response = await f.request(login.callback, { Cookie: login.Cookie })
    expect(response.status).toBe(401)
    expect(response.headers.getSetCookie().join(';')).not.toContain('chery-manager-session=')
  })
  it.each([{ badSignature: true }, { alg: 'none' }, { badDiscovery: true }])('rejects signature/algorithm/discovery failure %j', async (options) => {
    const f = await fixture(options), login = await f.begin()
    if (options.badDiscovery) expect(login.response.status).toBe(401)
    else expect((await f.request(login.callback, { Cookie: login.Cookie })).status).toBe(401)
  })
  it('disables OIDC with empty subject list', async () => {
    const f = await fixture({ emptySubjects: true })
    expect(await (await f.request('/api/auth/capabilities')).json()).toMatchObject({ password: false, oidc: false, allowInitialSetup: true, initialized: false })
    expect((await f.request('/api/auth/oidc/login')).status).toBe(503)
  })
  it('accepts explicit azp for multiple audiences', async () => {
    const f = await fixture({ claims: { aud: ['test-client', 'other'], azp: 'test-client' } }), login = await f.begin()
    expect((await f.request(login.callback, { Cookie: login.Cookie })).status).toBe(302)
  })
})
