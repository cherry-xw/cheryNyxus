import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountStore } from '../src/accountStore.js'
import { createManager, isPortOpen } from '../src/server.js'
import { readAuthOptions } from '../src/authConfig.js'
import { OidcLogin } from '../src/oidc.js'
import { runManagerCli } from '../src/cli.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const action of cleanup.splice(0).reverse()) await action() })
async function root() {
  const value = await mkdtemp(join(tmpdir(), 'manager-regression-'))
  cleanup.push(() => rm(value, { recursive: true, force: true })); return value
}
it('restarts only owned mock backend after credential rotation and verifies challenge/login', async () => {
  const dir = await root()
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const configFile = join(dir, 'config.yaml'), authFile = join(dir, 'auth.json')
  await writeFile(configFile, `server:\n  port: ${port}\n  webPort: ${port}\n`)
  await new AccountStore(authFile).save('owner', 'manager-test-password')
  const mockBackend = `const http=require('node:http');http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/api/auth/challenge'){res.end(JSON.stringify({challengeId:'test',nonce:'0'.repeat(48)}));}else if(req.url==='/api/auth/login'){res.end('{}')}else{res.writeHead(404);res.end('{}')}}).listen(${port},'127.0.0.1')`
  const manager = createManager({ port: 0, authFile, configFile, credentialsFile: join(dir, 'credentials.json'), controlToken: 'machine-key', backendCommand: process.execPath, backendArgs: ['-e', mockBackend] })
  await manager.listen(); cleanup.push(() => manager.close())
  const base = `http://127.0.0.1:${manager.address()!.port}`
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'manager-test-password' }) })
  const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0]!, Origin: base, 'Content-Type': 'application/json' }
  const started = await fetch(`${base}/api/backend/start`, { method: 'POST', headers })
  const first = await started.json() as { pid: number }
  for (let i = 0; i < 50 && !await isPortOpen('127.0.0.1', port); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  expect(await isPortOpen('127.0.0.1', port)).toBe(true)
  const rotated = await fetch(`${base}/api/credentials/rotate`, { method: 'POST', headers, body: JSON.stringify({ username: 'backend-owner', password: 'backend-new-password' }) })
  const data = await rotated.json() as { backend: { pid: number }; verification: unknown }
  expect(data).toMatchObject({ backend: { managed: true }, verification: { status: 'verified' } })
  expect(data).not.toHaveProperty('credentials.password')
  expect(data.backend.pid).not.toBe(first.pid)
})
it('CLI migrates status/info/control to dedicated machine paths without creating secrets', async () => {
  const old = process.env.CHERY_MANAGER_TOKEN
  process.env.CHERY_MANAGER_TOKEN = 'mock-machine-key'
  const requests: { url: string; init?: RequestInit }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    requests.push({ url: String(url), init }); return new Response('{}', { status: 200 })
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    for (const args of [['status'], ['info'], ['start'], ['stop', 'rathole'], ['restart']]) await runManagerCli(args)
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(['/api/machine/status', '/api/machine/connection', '/api/machine/backend/start', '/api/machine/rathole/stop', '/api/machine/backend/restart'])
    for (const request of requests) expect(request.init?.headers).toEqual({ 'X-Chery-Manager-Machine-Key': 'mock-machine-key' })
  } finally { if (old === undefined) delete process.env.CHERY_MANAGER_TOKEN; else process.env.CHERY_MANAGER_TOKEN = old }
})
it('reads explicit auth configuration and rejects invalid structures', async () => {
  const dir = await root(), file = join(dir, 'config.yaml')
  expect(await readAuthOptions(file)).toEqual({})
  await writeFile(file, 'manager:\n  auth:\n    trustedOrigins: [https://manager.example]\n    trustedProxies: [127.0.0.1]\n    sessionTtlMs: 60000\n')
  expect(await readAuthOptions(file)).toMatchObject({ trustedOrigins: ['https://manager.example'], sessionTtlMs: 60000 })
  await writeFile(file, 'manager:\n  auth:\n    trustedOrigins: evil\n')
  await expect(readAuthOptions(file)).rejects.toThrow('字符串数组')
})
it('expires pending OIDC transaction before token exchange', async () => {
  let now = Date.now(), base = ''
  const provider = createServer((_req, res) => res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/keys` })))
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => provider.close(() => resolve())))
  base = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const oidc = new OidcLogin({ issuer: base, clientId: 'test', clientSecret: 'secret', redirectUri: 'https://manager.example/api/auth/oidc/callback', adminSubjects: ['admin'] }, () => now)
  const pending = await oidc.begin('revision')
  now += 300001
  const callback = new URL(`https://manager.example/api/auth/oidc/callback?state=${new URL(pending.url).searchParams.get('state')}&code=code`)
  await expect(oidc.finish(callback, pending.binding, 'revision')).rejects.toThrow('state_invalid')
})
it('bounds discovery response size and times out stalled network', async () => {
  let stalled = false, base = ''
  const provider = createServer((_req, res) => {
    if (stalled) return
    res.end(JSON.stringify({ padding: 'x'.repeat(300000) }))
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => { provider.closeAllConnections(); provider.close(() => resolve()) }))
  base = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  const oidc = new OidcLogin({ issuer: base, clientId: 'test', clientSecret: 'secret', redirectUri: 'https://manager.example/api/auth/oidc/callback', adminSubjects: ['admin'] }, Date.now)
  await expect(oidc.begin('revision')).rejects.toThrow('response_too_large')
  stalled = true
  await expect(oidc.begin('revision')).rejects.toThrow()
})
