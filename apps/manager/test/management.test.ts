import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { IngressStore } from '../../backend/src/service/ingress/store.js'
import { IngressHost } from '../../backend/src/service/ingress/host.js'

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import yaml from 'js-yaml'
import { createManager } from '../src/server.js'
import { AccountStore } from '../src/accountStore.js'
import { CredentialStore } from '../src/credentials.js'


const env = Object.fromEntries(
  ['CHERY_DIR', 'CHERY_ENV_FILE', 'DB_DIR', 'CHERY_AUTH_SESSION_SECRET'].map((key) => [
    key,
    process.env[key],
  ]),
)
let root: string, configFile: string, base: string, Cookie: string
let manager: ReturnType<typeof createManager>
let shutdown: (() => Promise<void>) | undefined
let now = Date.now()
let core: typeof import('../../backend/src/utils/config.js')
let ingress: IngressHost, ingressStore: IngressStore

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = { Cookie },
) {
  return fetch(base + path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
async function login() {
  const response = await request(
    '/api/auth/login',
    'POST',
    { username: 'owner', password: 'synthetic-manager-password' },
    { Origin: base },
  )
  expect(response.status).toBe(200)
  return response.headers.get('set-cookie')!.split(';')[0]!
}
async function catalog() {
  const response = await request('/api/modules/capabilities/catalog')
  expect(response.status).toBe(200)
  return (await response.json()).data
}
async function save(
  kind: string,
  name: string,
  value: unknown,
  method = 'POST',
  revision?: string,
) {
  return request(
    `/api/modules/capabilities/resources/${kind}`,
    method,
    {
      name,
      value,
      expectedBaseRevision: revision ?? (await catalog()).baseRevision,
      requestId: crypto.randomUUID(),
    },
    { Cookie, Origin: base },
  )
}
async function read(kind: string, name: string) {
  const response = await request(
    `/api/modules/capabilities/resources/${kind}?name=${encodeURIComponent(name)}`,
  )
  expect(response.status).toBe(200)
  return (await response.json()).data
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'manager-mounted-core-'))
  configFile = join(root, '.chery/config.yaml')
  process.env.CHERY_DIR = root
  process.env.CHERY_ENV_FILE = join(root, 'isolated.env')
  process.env.DB_DIR = join(root, 'db')
  process.env.CHERY_AUTH_SESSION_SECRET = 'synthetic-core-session-secret'
  await mkdir(join(root, '.chery'), { recursive: true })
  for (const name of ['cheryNyxus', 'curator', 'roleArchitect', 'roleAcceptance']) {
    const directory = join(root, '.chery', 'prompt', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${name}.md`), 'Synthetic offline prompt')
  }
  await writeFile(process.env.CHERY_ENV_FILE, '')
  await writeFile(
    configFile,
    yaml.dump({
      global: { thinking: false, stream: false, supervision: 'auto', textEditor: 'unchanged' },
      llm: { brain: { base: { provider: 'openai', model: 'synthetic-not-called', key: 'synthetic-base-key', contextLimit: 128000 } } },
      sense_groups: {},
      roles: {},
      presets: {},
    }),
  )
  const credentialsFile = join(root, 'credentials.json')
  await new CredentialStore({ configFile, credentialsFile }).rotate({
    username: 'synthetic-backend',
    password: 'synthetic-backend-password',
  })
  const { RpcRouter } = await import('../../backend/src/service/message/router.js')
  const { registerConfigHandlers } = await import('../../backend/src/service/config/handler.js')
  const { registerBrainHandlers } = await import('../../backend/src/service/brain/list.js')
  const { registerSenseHandlers } = await import('../../backend/src/service/sense/list.js')
  const { OAuth2Auth } = await import('../../backend/src/service/auth/index.js')
  const { hashPassword } = await import('../../backend/src/utils/password.js')
  const { createWebSocketServer } = await import('../../backend/src/service/websocket/index.js')
  core = await import('../../backend/src/utils/config.js')

  const router = new RpcRouter()

  registerConfigHandlers(router)
  registerBrainHandlers(router)
  registerSenseHandlers(router)
  await (await import('../../backend/src/agent/sense/index.js')).reloadSenses()
  const { createIngressCoreAdapter, createIngressConnections } =
    await import('../../backend/src/service/ingress/coreAdapter.js')
  ingressStore = new IngressStore(join(root, 'ingress'))
  ingressStore.install(resolve('plugins/qq/dist'), false, undefined, {
    grantedCapabilities: [
      'ingress',
      'rpc.business',
      'rpc.management',
      'tools',
      'hooks',
      'channel.identity',
      'manager.ui',
    ],
    channelGrants: [{ channel: 'qq', credentialKind: 'qq' }],
  })
  ingressStore.setEnabled('cherynyxus-qq-module', true)
  ingressStore.install(resolve('plugins/settings/dist'), false, undefined, {
    grantedCapabilities: ['rpc.management', 'manager.ui'],
    channelGrants: [],
  })
  ingressStore.setEnabled('cherynyxus-settings-module', true)
  ingress = new IngressHost({
    store: ingressStore,
    router,
    core: createIngressCoreAdapter(),
    connections: createIngressConnections(),
    coreCall: async (method, params) => {
      const response = await router.handle(
        { kind: 'request', id: 'management-test', method, params } as any,
        {
          connectionId: 'management-test',
          credentialKind: 'control',
          log: { info() {}, warn() {}, error() {} },
        } as any,
      )
      if (Symbol.asyncIterator in response) throw new Error('MANAGEMENT_CALL_FAILED')
      if (!response.success)
        throw Object.assign(new Error('MANAGEMENT_CALL_FAILED'), {
          code: (response.error as any)?.code,
        })
      return response.data
    },
  })
  await ingress.start()
  const { registerIngressHandlers } = await import('../../backend/src/service/ingress/handlers.js')
  registerIngressHandlers(router, ingress, ingressStore)
  expect(ingress.status()[0]?.state).toBe('active')
  const auth = new OAuth2Auth({
    enabled: true,
    machine: { username: 'synthetic-backend', password: hashPassword('synthetic-backend-password') },
    allowLoopback: false,
  })
  const http = createServer((req, res) => {
    void auth.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const ws = createWebSocketServer({ port: 0, host: '127.0.0.1', router, auth, listener: 'local' })
  if (!ws.address()) await new Promise<void>((resolve) => ws.once('listening', resolve))
  const raw = yaml.load(await readFile(configFile, 'utf8')) as any
  raw.server = {
    ...raw.server,
    host: '127.0.0.1',
    port: (ws.address() as AddressInfo).port,
    webPort: (http.address() as AddressInfo).port,
  }
  await writeFile(configFile, yaml.dump(raw))
  const authFile = join(root, 'manager-auth.json')
  await new AccountStore(authFile).save('owner', 'synthetic-manager-password')
  manager = createManager({
    port: 0,
    configFile,
    credentialsFile,
    authFile,
    tokenFile: join(root, 'machine.json'),
    controlToken: 'synthetic-machine-key',

    now: () => now,
    auth: { sessionTtlMs: 10000 },
  })
  await manager.listen()
  base = `http://127.0.0.1:${manager.address()!.port}`
  Cookie = await login()
  shutdown = async () => {
    await manager.close()
    await ingress.stop()
    for (const client of ws.clients) client.terminate()
    await new Promise<void>((resolve) => ws.close(() => resolve()))
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await (await import('../../backend/src/service/config/commit.js')).getConfigApplyCoordinator().retry()
    ;(await import('../../backend/src/db/index.js')).closeAllDbs()
  }
})
afterAll(async () => {
  await shutdown?.()
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('mounted Manager Session → capability HTTP → real authenticated core', () => {
  it('uses Session for pages, API and module discovery; old tokens and machine paths cannot bypass', async () => {
    for (const path of [
      '/modules/capabilities',
      '/modules/qq',
      '/api/modules',
      '/api/modules/capabilities/catalog',
      '/api/modules/qq/status',
      '/api/modules/qq/entry?requestId=synthetic',
    ]) {
      expect((await request(path, 'GET', undefined, {})).status).toBe(401)
      expect(
        (
          await request(path + '?token=synthetic-machine-key', 'GET', undefined, {
            'X-Chery-Manager-Token': 'synthetic-machine-key',
          })
        ).status,
      ).toBe(401)
      expect(
        (
          await request(path, 'GET', undefined, {
            Cookie,
            'X-Chery-Manager-Machine-Key': 'synthetic-machine-key',
          })
        ).status,
      ).toBe(401)
    }
    expect(
      (
        await request('/api/machine/modules/capabilities/catalog', 'GET', undefined, {
          'X-Chery-Manager-Machine-Key': 'synthetic-machine-key',
        })
      ).status,
    ).toBe(404)
    const capabilitiesPage = await fetch(base + '/modules/capabilities?embedded=1', {
      headers: { Cookie, 'Sec-Fetch-Dest': 'iframe' },
      redirect: 'manual',
    })
    expect(capabilitiesPage.status).toBe(200)
    expect(capabilitiesPage.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(capabilitiesPage.headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
    expect((await request('/')).headers.get('x-frame-options')).toBe('DENY')
    const html = await capabilitiesPage.text()
    expect((await request('/modules/capabilities')).status).toBe(403)
    const embeddedPage = await fetch(base + '/modules/capabilities?embedded=1', {
      headers: { Cookie, 'Sec-Fetch-Dest': 'iframe' },
    })
    expect(embeddedPage.status).toBe(200)
    const embeddedHtml = await embeddedPage.text()
    expect(embeddedHtml).toContain('data-manager-embedded')
    expect(embeddedHtml).toContain('main.manager > header { display: none; }')
    expect(embeddedHtml).toContain('min-height: 0; border: 0;')
    expect(html).toContain('/modules/capabilities/assets/')
    const prefix = html.match(/<base href="([^"]+)"/)![1]!
    const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)]
    expect(assets).toHaveLength(2)
    for (const asset of assets) {
      const response = await fetch(new URL(asset[1]!, base + prefix), { headers: { Cookie } })
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect((await response.text()).length).toBeGreaterThan(100)
    }
    expect((await request('/modules/qq?embedded=1', 'GET', undefined, { Cookie, 'Sec-Fetch-Dest': 'iframe' })).status).toBe(200)
    expect(
      (await (await request('/api/modules')).json()).data.modules
        .map((module: any) => module.descriptor.id)
        .sort(),
    ).toEqual(['capabilities', 'qq'])
  })
  it('rejects missing/cross Origin and invalid JSON before resource writes', async () => {
    const before = await readFile(configFile, 'utf8')
    for (const headers of [{ Cookie }, { Cookie, Origin: 'https://evil.example' }] as Record<
      string,
      string
    >[])
      expect(
        (await request('/api/modules/capabilities/resources/brains', 'POST', {}, headers)).status,
      ).toBe(403)
    for (const body of ['{', JSON.stringify({ value: 'x'.repeat(17000) })])
      expect(
        (
          await fetch(base + '/api/modules/capabilities/resources/brains', {
            method: 'POST',
            headers: { Cookie, Origin: base, 'Content-Type': 'application/json' },
            body,
          })
        ).status,
      ).toBe(400)
    expect(await readFile(configFile, 'utf8')).toBe(before)
  })
  it('creates all three resources from a minimal valid core, edits same name and never exposes model keys', async () => {
    // The real core requires one brain; empty-catalog UI is tested by controller.test.ts.
    expect(await catalog()).toMatchObject({ senseGroups: [], presets: [] })
    const brain = await save('brains', 'synthetic-brain', {
      provider: 'openai',
      model: 'never-called',
      contextLimit: 128000,
      thinking: 'high',
      key: 'synthetic-model-key',
    })
    expect(brain.status).toBe(200)
    expect(JSON.stringify(await brain.json())).not.toContain('synthetic-model-key')
    expect((await save('sense-groups', 'synthetic-tools', [])).status).toBe(200)
    expect(
      (
        await save('presets', 'synthetic-preset', {
          brain: 'synthetic-brain',
          senseGroup: 'synthetic-tools',
        })
      ).status,
    ).toBe(200)
    expect((await read('presets', 'synthetic-preset')).value).toMatchObject({
      brain: 'synthetic-brain',
      senseGroup: 'synthetic-tools',
    })
    const draft = await read('brains', 'synthetic-brain')
    const snapshot = core.captureRuntimeConfig()
    expect(
      (
        await save(
          'brains',
          'synthetic-brain',
          { thinking: 'low', rpm: 25 },
          'PUT',
          draft.baseRevision,
        )
      ).status,
    ).toBe(200)
    expect((await read('brains', 'synthetic-brain')).value).toMatchObject({
      model: 'never-called',
      thinking: 'low',
      rpm: 25,
    })
    expect(snapshot.llm.brain['synthetic-brain']?.thinking).toBe('high')
    expect(
      (await save('brains', 'synthetic-brain', { thinking: 'high' }, 'PUT', draft.baseRevision))
        .status,
    ).toBe(409)
    const disk = yaml.load(await readFile(configFile, 'utf8')) as any
    expect(disk.llm.brain['synthetic-brain'].key).toBe('synthetic-model-key')
    expect(disk.global).toMatchObject({ thinking: false, textEditor: 'unchanged' })
    expect(
      (await (await request('/api/modules/capabilities/apply')).json()).data.protocolVersion,
    ).toBe(2)
  })
  it('creates resources then binds both channels through real QQ package schemas, disk and apply', async () => {
    const initial = (await (await request('/api/modules/qq/config')).json()).data
    expect(initial.baseRevision).toBe(0)
    const body = {
      config: {
        ...initial.config,
        selfId: '123',
        groups: ['456'],
        users: ['789'],
        bindings: { 'group:456': 'synthetic-preset', 'private:user:789': 'synthetic-preset' },
      },
      expectedBaseRevision: initial.baseRevision,
      requestId: crypto.randomUUID(),
    }
    for (const headers of [{ Cookie }, { Cookie, Origin: 'https://evil.example' }] as Record<
      string,
      string
    >[])
      expect((await request('/api/modules/qq/config', 'PUT', body, headers)).status).toBe(403)
    const result = await request('/api/modules/qq/config', 'PUT', body, { Cookie, Origin: base })
    expect(result.status).toBe(200)
    const saved = (await result.json()).data
    expect(saved).toMatchObject({
      config: body.config,
      baseRevision: 1,
      saved: true,
      apply: { state: 'restart_required', revision: 1 },
    })
    expect((await (await request('/api/modules/qq/config')).json()).data).toMatchObject({
      config: body.config,
      baseRevision: 1,
    })
    expect(ingressStore.readConfig('cherynyxus-qq-module')?.config).toEqual(body.config)
    expect(
      (
        await request(
          '/api/modules/qq/config',
          'PUT',
          { ...body, requestId: crypto.randomUUID() },
          { Cookie, Origin: base },
        )
      ).status,
    ).toBe(409)
    expect(
      (
        await request(
          '/api/modules/qq/config',
          'PUT',
          { ...body, expectedBaseRevision: 1, target: 'http://evil.example' },
          { Cookie, Origin: base },
        )
      ).status,
    ).toBe(400)
    for (const name of ['status', 'queue', 'history']) {
      const response = await request('/api/modules/qq/' + name)
      expect(response.status).toBe(200)
      const data = (await response.json()).data
      if (name === 'status')
        expect(data).toMatchObject({
          installed: true,
          enabled: true,
          savedRevision: 1,
          appliedRevision: 0,
          apply: { state: 'restart_required' },
          napcatConnected: false,
          missingBindings: [],
          missingResources: [],
        })
      else expect(data).toEqual({ entries: [] })
    }
    expect((await request('/api/modules/qq/status?method=qq.event.submit')).status).toBe(400)
    expect((await request('/api/modules/qq/rpc')).status).toBe(404)
    // Binding persistence must not be mistaken for readiness of newly created core resources.
    const { createIngressCoreAdapter } = await import('../../backend/src/service/ingress/coreAdapter.js')
    const apply = (await (await request('/api/modules/capabilities/apply')).json()).data
    console.log('RESOURCE_APPLY_EVIDENCE', JSON.stringify(apply))

    expect(apply.impacts).not.toContainEqual(expect.objectContaining({ boundary: 'unsupported' }))
    expect(() => createIngressCoreAdapter().resolvePreset('synthetic-preset')).not.toThrow()
    expect(createIngressCoreAdapter().resolvePreset('synthetic-preset')).toMatchObject({
      brain: 'synthetic-brain',
      senseGroup: 'synthetic-tools',
    })
  })
  it('inactive QQ is unavailable without disk changes, then logout and expiry reject every module', async () => {
    await ingress.stop()
    const before = await readFile(configFile, 'utf8')
    const response = await request('/api/modules/qq/status')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
    expect(
      (await request('/api/modules/qq/config', 'PUT', {}, { Cookie, Origin: base })).status,
    ).toBe(404)
    expect(await readFile(configFile, 'utf8')).toBe(before)
    expect((await request('/api/auth/logout', 'POST', {}, { Cookie, Origin: base })).status).toBe(
      200,
    )
    expect((await request('/modules/capabilities')).status).toBe(401)
    expect((await request('/api/modules/capabilities/catalog')).status).toBe(401)
    Cookie = await login()
    now += 10001
    expect((await request('/modules/qq')).status).toBe(401)
    expect((await request('/api/modules')).status).toBe(401)
  })
  it('disabling modules leaves offline login and service management intact, no resource fallback', async () => {
    const offlineRoot = await mkdtemp(join(tmpdir(), 'manager-disabled-'))
    const authFile = join(offlineRoot, 'auth.json'),
      offlineConfig = join(offlineRoot, 'config.yaml')
    await new AccountStore(authFile).save('owner', 'synthetic-manager-password')
    await writeFile(offlineConfig, 'server:\n  port: 1\n  webPort: 1\n')
    {
      const offline = createManager({
        port: 0,
        configFile: offlineConfig,
        authFile,
        credentialsFile: join(offlineRoot, 'missing.json'),
        tokenFile: join(offlineRoot, 'machine.json'),

      })
      await offline.listen()
      try {
        const url = `http://127.0.0.1:${offline.address()!.port}`
        const loginResponse = await fetch(url + '/api/auth/login', {
          method: 'POST',
          headers: { Origin: url, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'owner', password: 'synthetic-manager-password' }),
        })
        expect(loginResponse.status).toBe(200)
        const headers = {
          Cookie: loginResponse.headers.get('set-cookie')!.split(';')[0]!,
          Origin: url,
        }
        expect((await fetch(url + '/api/status', { headers })).status).toBe(200)
        expect((await fetch(url + '/api/backend/stop', { method: 'POST', headers })).status).toBe(
          200,
        )
        expect((await fetch(url + '/modules/qq?embedded=1', { headers: { ...headers, 'Sec-Fetch-Dest': 'iframe' } })).status).toBe(502)
        expect((await fetch(url + '/api/modules/qq/status', { headers })).status).toBe(502)
        const resources = await fetch(url + '/api/modules/capabilities/catalog', { headers })
        expect(resources.status).toBe(502)
        expect(await resources.json()).toMatchObject({ error: { code: 'backend_auth_failed' } })
        expect(await readFile(offlineConfig, 'utf8')).toBe('server:\n  port: 1\n  webPort: 1\n')
      } finally {
        await offline.close()
      }
    }
  })

})
