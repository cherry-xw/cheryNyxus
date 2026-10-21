import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { afterEach, expect, it } from 'vitest'
import { AccountStore } from '../src/accountStore.js'
import { CredentialStore } from '../src/credentials.js'
import { createManager } from '../src/server.js'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })

for (const failure of ['absent', '404', 'missing', 'inconsistent', 'legacy', 'invalid-json', 'unreadable'] as const) {
  it(`Manager remains independent with Backend ${failure}; no startup credential/config writes`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-independent-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    let backendRequests = 0
    const backend = createServer((req, res) => {
      backendRequests++
      expect(req.url).toBe('/api/machine/login')
      req.resume()
      res.writeHead(404).end('not a machine authentication server')
    })
    await new Promise<void>((resolve) => backend.listen(0, '0.0.0.0', resolve))
    const backendPort = (backend.address() as { port: number }).port
    if (failure === 'absent') await new Promise<void>((resolve) => backend.close(() => resolve()))
    else cleanup.push(() => new Promise<void>((resolve) => backend.close(() => resolve())))
    const configFile = join(root, 'config.yaml'), credentialsFile = join(root, 'credentials.json')
    const authFile = join(root, 'manager-auth.json')
    await writeFile(configFile, yaml.dump({ server: { host: '10.2.3.6', port: backendPort, webPort: backendPort,
      auth: { username: 'business-account', password: 'untouched-business-password' } },
      manager: { auth: { trustedOrigins: ['https://manager.example'], allowInitialSetup: false } },
      unrelated: { keep: ['all', 'data'] } }))
    const store = new CredentialStore({ configFile, credentialsFile })
    if (['absent', '404', 'inconsistent'].includes(failure)) {
      // Explicit test fixture provisioning, never part of Manager startup.
      await store.rotate({ username: 'synthetic-machine', password: 'synthetic-machine-password' })
      if (failure === 'inconsistent') {
        const config = yaml.load(await readFile(configFile, 'utf8')) as any
        config.server.auth.machine.username = 'not-the-same-machine'
        await writeFile(configFile, yaml.dump(config))
      }
    }
    if (failure === 'legacy') await writeFile(credentialsFile, JSON.stringify({ version: 1, username: 'legacy', password: 'must-not-use' }))
    if (failure === 'invalid-json') await writeFile(credentialsFile, '{broken')
    if (failure === 'unreadable') await mkdir(credentialsFile)
    const snapshot = async () => {
      const result: Record<string, string | null> = {}
      for (const file of [configFile, credentialsFile, credentialsFile + '.key']) {
        try { result[file] = (await readFile(file)).toString('base64') }
        catch (error) { result[file] = (error as NodeJS.ErrnoException).code ?? null }
      }
      return result
    }
    const before = await snapshot()
    await new AccountStore(authFile).save('owner', 'synthetic-manager-password')
    const manager = createManager({ host: '0.0.0.0', port: 0, backendMode: 'external', configFile, credentialsFile,
      authFile, tokenFile: join(root, 'manager-token.json'),
      auth: { trustedOrigins: ['https://manager.example'], trustedProxies: ['10.2.3.6', '::ffff:10.2.3.6'] },
    })
    await manager.listen()
    cleanup.push(() => manager.close())
    const base = `http://10.2.3.6:${manager.address()!.port}`
    // A fixed trusted public origin lets the temporary LAN listener use the same auth contract.
    let Cookie = ''
    const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method,
      headers: { Host: 'manager.example', 'X-Forwarded-Host': 'manager.example', 'X-Forwarded-Proto': 'https',
        ...(Cookie ? { Cookie } : {}), ...(method !== 'GET' ? { Origin: 'https://manager.example', 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    expect((await request('/')).status).toBe(200)
    expect((await request('/api/status')).status).toBe(401)
    expect(await snapshot()).toEqual(before)
    const login = await request('/api/auth/login', 'POST', { username: 'owner', password: 'synthetic-manager-password' })
    expect(login.status).toBe(200)
    Cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect(await (await request('/api/status')).json()).toMatchObject({ manager: 'running', maintenance: { status: 'not_checked' } })
    expect(backendRequests).toBe(0)
    expect(await snapshot()).toEqual(before)
    const diagnostic = await request('/api/credentials')
    expect(diagnostic.status).toBe(200)
    const credentialView = await diagnostic.json()
    expect(credentialView).not.toHaveProperty('password')
    if (['legacy', 'invalid-json', 'unreadable'].includes(failure)) expect(credentialView).toMatchObject({ consistent: false, source: 'unavailable' })
    const remote = await request('/api/plugins')
    expect(remote.status).toBe(['absent', '404'].includes(failure) ? 503 : 502)
    expect(await remote.json()).toMatchObject({ error: { code: failure === '404' ? 'backend_version_unsupported' : failure === 'absent' ? 'unavailable' : 'backend_auth_failed' } })
    const device = await request('/api/relay/device-operation', 'POST', { type: 'authorization.list' })
    expect(device.status).toBe(['absent', '404'].includes(failure) ? 503 : 502)
    expect(await device.json()).toHaveProperty('error.code')
    expect((await request('/api/auth/me')).status).toBe(200)
    expect((await request('/api/backend/restart', 'POST', {})).status).toBe(409)
    expect((await request('/api/credentials/rotate', 'POST', {})).status).toBe(409)
    expect(await snapshot()).toEqual(before)
    const requestsBeforeLocalSave = backendRequests
    const relay = { url: 'https://offline.example', backendId: 'test-device', publicDiscovery: false, remotePasswordEnabled: true }
    expect((await request('/api/relay/config', 'PUT', relay)).status).toBe(200)
    expect(await (await request('/api/relay/config')).json()).toEqual(relay)
    const oidc = { issuer: 'https://id.example', clientId: 'manager', clientSecret: 'synthetic-secret',
      redirectUri: 'https://manager.example/api/auth/oidc/callback', adminSubjects: ['owner'] }
    expect((await request('/api/auth/oidc/config', 'PUT', oidc)).status).toBe(200)
    const oidcView = await (await request('/api/auth/oidc/config')).json()
    expect(oidcView).toMatchObject({ data: { configured: true, clientSecretConfigured: true }, restartRequired: true })
    expect(JSON.stringify(oidcView)).not.toContain('synthetic-secret')
    expect(backendRequests).toBe(requestsBeforeLocalSave)
    const config = yaml.load(await readFile(configFile, 'utf8')) as any
    const original = yaml.load(Buffer.from(before[configFile]!, 'base64').toString()) as any
    expect(config.server).toEqual(original.server)
    expect(config.unrelated).toEqual(original.unrelated)
    const afterLocal = await snapshot()
    expect(afterLocal[credentialsFile]).toBe(before[credentialsFile])
    expect(afterLocal[credentialsFile + '.key']).toBe(before[credentialsFile + '.key'])
    expect((await request('/api/auth/password', 'POST', { currentPassword: 'synthetic-manager-password', newPassword: 'synthetic-new-manager-password' })).status).toBe(200)
    expect((await request('/api/auth/me')).status).toBe(401)
    const relogin = await request('/api/auth/login', 'POST', { username: 'owner', password: 'synthetic-new-manager-password' })
    expect(relogin.status).toBe(200)
    Cookie = relogin.headers.get('set-cookie')!.split(';')[0]!
    expect((await request('/api/relay/config')).status).toBe(200)
    expect(backendRequests).toBe(requestsBeforeLocalSave)
    expect(await snapshot()).toEqual(afterLocal)
  })
}
