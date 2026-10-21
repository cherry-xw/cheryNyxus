import { once } from 'node:events'
import { createServer } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BusinessOidc } from '../src/oidc.js'

describe('business OIDC discovery and verification', () => {
  it('uses issuer path, PKCE and nonce; rejects wrong binding, wrong audience, nonce and replay', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    let issuer = ''; let nonce = ''; let audience = 'business-client'; let tokenNonce = ''; let verifierSeen = ''; let state = ''
    const server = createServer(async (req, res) => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/identity/.well-known/openid-configuration') { res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, token_endpoint_auth_methods_supported: ['client_secret_post'] })); return }
      if (req.url === '/identity/keys') { res.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }] })); return }
      if (req.url === '/identity/token') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const form = new URLSearchParams(Buffer.concat(chunks).toString()); verifierSeen = form.get('code_verifier') ?? ''
        const now = Math.floor(Date.now() / 1000)
        const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url')
        const p = Buffer.from(JSON.stringify({ iss: issuer, sub: 'ordinary-user', aud: audience, nonce: tokenNonce || nonce, iat: now, exp: now + 60 })).toString('base64url')
        res.end(JSON.stringify({ id_token: `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}` })); return
      }
      res.writeHead(404); res.end('{}')
    })
    server.listen(0, '0.0.0.0'); await once(server, 'listening'); issuer = `http://localhost:${(server.address() as { port: number }).port}/identity`
    const oidc = new BusinessOidc({ issuer, clientId: 'business-client', clientSecret: 'synthetic-secret', redirectUri: 'http://localhost/nyxus/api/auth/oidc/callback' }, '/nyxus')
    try {
      async function begin() { const started = await oidc.begin('/nyxus/bindings/test'); const url = new URL(started.url); state = url.searchParams.get('state')!; nonce = url.searchParams.get('nonce')!; expect(url.pathname).toBe('/identity/authorize'); expect(url.searchParams.get('code_challenge_method')).toBe('S256'); return { started, callback: new URL(`http://localhost/nyxus/api/auth/oidc/callback?state=${state}&code=synthetic-code`) } }
      const one = await begin()
      await expect(oidc.finish(one.callback, 'wrong-browser')).rejects.toThrow('OIDC_STATE_INVALID')
      expect(await oidc.finish(one.callback, one.started.binding)).toEqual({ subject: 'ordinary-user', issuer, returnTo: '/nyxus/bindings/test' })
      expect(verifierSeen.length).toBeGreaterThan(32)
      await expect(oidc.finish(one.callback, one.started.binding)).rejects.toThrow('OIDC_STATE_INVALID')
      audience = 'manager-client'; const two = await begin(); await expect(oidc.finish(two.callback, two.started.binding)).rejects.toThrow('OIDC_CLAIMS_INVALID')
      audience = 'business-client'; tokenNonce = 'wrong-nonce'; const three = await begin(); await expect(oidc.finish(three.callback, three.started.binding)).rejects.toThrow('OIDC_CLAIMS_INVALID')
      const safe = await oidc.begin('//evil.example/'); const unsafeReturn = new URL(safe.url); expect(unsafeReturn.host).toBe(new URL(issuer).host)
    } finally { oidc.clear(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
