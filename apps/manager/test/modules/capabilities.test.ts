import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import yaml from 'js-yaml'
import { QQDefaultConfig } from '../../../../packages/protocol/src/qq'
import { BackendRpcClient } from '../../src/modules/capabilities/rpc.js'
import { createSettingsPackage as createCapabilitiesModule } from '../settingsPackage.js'
import type {
  SaveResourceResult,
  ResourceView,
  CapabilityCatalog,
} from '../../src/modules/contracts.js'

const root = mkdtempSync(join(tmpdir(), 'capability-core-'))
const env = {
  CHERY_DIR: process.env.CHERY_DIR,
  CHERY_ENV_FILE: process.env.CHERY_ENV_FILE,
  DB_DIR: process.env.DB_DIR,
  CHERY_AUTH_SESSION_SECRET: process.env.CHERY_AUTH_SESSION_SECRET,
}
let module: ReturnType<typeof createCapabilitiesModule>
let rpc: BackendRpcClient
let shutdown: () => Promise<void>
let commit: typeof import('../../../backend/src/service/config/commit.js')
let config: typeof import('../../../backend/src/utils/config.js')
let logSpy: ReturnType<typeof vi.spyOn>
const key = 'synthetic-model-key-only-for-tests'
async function request(method: string, kind: string, body?: unknown, name?: string) {
  return module.handle({
    method,
    url: new URL(
      `http://manager/api/modules/capabilities/${kind}${name ? `?name=${encodeURIComponent(name)}` : ''}`,
    ),
    body,
  })
}
async function read(kind: string, name: string): Promise<ResourceView> {
  const result = await request('GET', `resources/${kind}`, undefined, name)
  expect(result.status).toBe(200)
  return (result.body as { data: ResourceView }).data
}
async function save(kind: string, name: string, value: unknown, create = true, revision?: string) {
  const catalog = await request('GET', 'catalog')
  const base = (catalog.body as { data: CapabilityCatalog }).data.baseRevision
  return request(create ? 'POST' : 'PUT', `resources/${kind}`, {
    name,
    value,
    expectedBaseRevision: revision ?? base,
    requestId: crypto.randomUUID(),
  })
}
beforeAll(async () => {
  logSpy = vi.spyOn(process.stdout, 'write')
  process.env.CHERY_DIR = root
  process.env.CHERY_ENV_FILE = join(root, 'isolated.env')
  process.env.DB_DIR = join(root, 'db')
  process.env.CHERY_AUTH_SESSION_SECRET = 'synthetic-session-secret-for-core-tests'
  mkdirSync(join(root, '.chery'), { recursive: true })
  writeFileSync(process.env.CHERY_ENV_FILE, '')
  writeFileSync(
    join(root, '.chery/config.yaml'),
    yaml.dump({
      global: { thinking: false, stream: false, supervision: 'auto', textEditor: 'untouched' },
      llm: { brain: { base: { provider: 'openai', model: 'synthetic', key, thinking: 'high' } } },
      sense_groups: { empty: [] },
      roles: {
        shared: {
          brain: 'base',
          senseGroup: 'empty',
          description: 'keep',
          skills: [],
          permissions: { template: 'read-only' },
        },
      },
      presets: {
        first: {
          leader: 'shared',
          roles: ['shared'],
          schedule: { cron: '0 0 * * *', task: 'synthetic', enabled: false },
        },
        second: { leader: 'shared', roles: ['shared'] },
      },
      server: { port: 8182, transport: 'binary' },
    }),
  )
  const { RpcRouter } = await import('../../../backend/src/service/message/router.js')
  const { registerConfigHandlers } = await import('../../../backend/src/service/config/handler.js')
  const { registerBrainHandlers } = await import('../../../backend/src/service/brain/list.js')
  const { registerSenseHandlers } = await import('../../../backend/src/service/sense/list.js')
  const { OAuth2Auth } = await import('../../../backend/src/service/auth/index.js')
  const { hashPassword } = await import('../../../backend/src/utils/password.js')
  const { createWebSocketServer } = await import('../../../backend/src/service/websocket/index.js')
  config = await import('../../../backend/src/utils/config.js')
  commit = await import('../../../backend/src/service/config/commit.js')
  const router = new RpcRouter()
  const { z } = await import('zod')
  router.registerExtension({
    scope: 'management',
    method: 'qq.config.get',
    request: z.object({}),
    response: z.unknown(),
    authorize: (ctx) => ctx.credentialKind === 'control' || ctx.credentialKind === 'machine',
    handler: async () => ({
      config: QQDefaultConfig,
      baseRevision: 0,
      apply: { state: 'applied', revision: 0 },
    }),
  })
  registerConfigHandlers(router)
  registerBrainHandlers(router)
  registerSenseHandlers(router)
  await (await import('../../../backend/src/agent/sense/index.js')).reloadSenses()
  const auth = new OAuth2Auth({
    enabled: true,
    machine: { username: 'synthetic-manager', password: hashPassword('synthetic-manager-password') },
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
  const webPort = (http.address() as AddressInfo).port
  const ws = createWebSocketServer({ port: 0, host: '127.0.0.1', router, auth, listener: 'local' })
  if (!ws.address()) await new Promise<void>((resolve) => ws.once('listening', resolve))
  const wsPort = (ws.address() as AddressInfo).port
  rpc = new BackendRpcClient({
    target: async () => ({ http: `http://127.0.0.1:${webPort}`, ws: `ws://127.0.0.1:${wsPort}` }),
    credentials: async () => ({
      username: 'synthetic-manager',
      password: 'synthetic-manager-password',
    }),
  })
  module = createCapabilitiesModule(rpc)
  shutdown = async () => {
    rpc.close()
    for (const client of ws.clients) client.terminate()
    await new Promise<void>((resolve) => ws.close(() => resolve()))
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await commit.getConfigApplyCoordinator().retry()
    ;(await import('../../../backend/src/db/index.js')).closeAllDbs()
  }
})
afterAll(async () => {
  await shutdown?.()
  logSpy.mockRestore()
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
})
describe('capabilities over authenticated wire to real core handlers', () => {
  it('图片策略经管理路由与认证 RPC 保存到真实隔离 YAML，回读并拒绝过期 revision', async () => {
    const before = await request('GET', 'files')
    expect(before.status).toBe(200)
    const view = (before.body as any).data
    const policy = { ...view.policy, imageAdaptation: { ...view.policy.imageAdaptation, maxBytes: 1234567, maxEdge: 1024, quality: 80 } }
    const body = { policy, expectedBaseRevision: view.baseRevision, requestId: crypto.randomUUID() }
    const saved = await request('PUT', 'files', body)
    expect(saved.status).toBe(200)
    expect((await request('GET', 'files')).body).toMatchObject({ data: { policy } })
    const disk = yaml.load(readFileSync(join(root, '.chery/config.yaml'), 'utf8')) as any
    expect(disk.files.imageAdaptation).toEqual(policy.imageAdaptation)
    expect(disk.llm.brain.base.key).toBe(key)
    expect((await request('PUT', 'files', { ...body, requestId: crypto.randomUUID() })).status).toBe(409)
    expect((await request('PUT', 'files', { ...body, policy: { imageAdaptation: { maxBytes: 0 } } })).status).toBe(400)
  })
  it('deletes unused models and tool groups with persistent readback, while protecting references', async () => {
    for (const [kind, name, value] of [
      ['brains', 'delete-test-model', { provider: 'openai', model: 'synthetic-delete' }],
      ['sense-groups', 'delete-test-tools', []],
    ] as const) {
      expect((await save(kind, name, value)).status).toBe(201)
      const resource = await read(kind, name)
      expect(
        (
          await request('DELETE', `resources/${kind}`, {
            name,
            expectedBaseRevision: resource.baseRevision,
            requestId: crypto.randomUUID(),
          })
        ).status,
      ).toBe(200)
      expect((await request('GET', `resources/${kind}`, undefined, name)).status).toBe(404)
    }
    const resource = await read('brains', 'base')
    expect(
      (
        await request('DELETE', 'resources/brains', {
          name: 'base',
          expectedBaseRevision: resource.baseRevision,
          requestId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409)
    expect((await read('brains', 'base')).name).toBe('base')
  })
  it('lists real saved resources/tools and never returns key or env references', async () => {
    const result = await request('GET', 'catalog')
    expect(result.status).toBe(200)
    expect((result.body as { data: CapabilityCatalog }).data.tools.length).toBeGreaterThan(0)
    const brain = await read('brains', 'base')
    expect(brain.value).toMatchObject({ thinking: 'high' })
    expect(brain.secrets).toEqual({ keyConfigured: true })
    expect(JSON.stringify(brain)).not.toContain(key)
    expect(brain.value).not.toHaveProperty('key')
  })
  it('creates and edits same-name brain including thinking, while retaining unrelated config and omitted key', async () => {
    const result = await save('brains', 'new-model', {
      provider: 'openai',
      protocol: 'openai-chat-completions',
      model: 'new',
      key: 'synthetic-new-key',
      thinking: 'low',
      rpm: 12,
      contextLimit: 32000,
      fullUrl: false,
    })
    expect(result.status).toBe(201)
    const first = (result.body as { data: SaveResourceResult }).data
    expect(first.saved).toBe(true)
    expect(first.value).toMatchObject({ model: 'new', thinking: 'low' })
    expect(JSON.stringify(result.body)).not.toContain('synthetic-new-key')
    expect((await save('brains', 'new-model', { thinking: 'high' }, false)).status).toBe(200)
    expect((await read('brains', 'new-model')).value).toMatchObject({
      model: 'new',
      thinking: 'high',
      contextLimit: 32000,
    })
    const disk = yaml.load(readFileSync(join(root, '.chery/config.yaml'), 'utf8')) as any
    expect(disk.llm.brain['new-model'].key).toBe('synthetic-new-key')
    expect(disk.server).toEqual({ port: 8182, transport: 'binary' })
    expect(disk.global.thinking).toBe(false)
    expect(disk.global.textEditor).toBe('untouched')
  })
  it('rejects stale drafts, duplicate creates, invalid fields and names without persistence', async () => {
    const draft = await read('brains', 'new-model')
    expect((await save('sense-groups', 'reader', ['read_file:auto'])).status).toBe(201)
    expect(
      (await save('brains', 'new-model', { thinking: 'low' }, false, draft.baseRevision)).status,
    ).toBe(409)
    expect((await save('brains', 'new-model', { model: 'other', provider: 'openai' })).status).toBe(
      409,
    )
    expect(
      (await save('brains', 'bad', { model: 'bad', provider: 'openai', fullUrl: 'not-a-boolean' }))
        .status,
    ).toBe(400)
    expect((await save('sense-groups', '__proto__', [])).status).toBe(400)
    expect((await read('sense-groups', 'reader')).value).toEqual(['read_file:auto'])
  })
  it('creates a preset from existing selections and protects shared leader when editing advanced preset', async () => {
    expect(
      (await save('presets', 'created', { brain: 'new-model', senseGroup: 'reader' })).status,
    ).toBe(201)
    expect((await read('presets', 'created')).value).toMatchObject({
      brain: 'new-model',
      senseGroup: 'reader',
    })
    const secondBefore = await read('presets', 'second')
    const firstBefore = await read('presets', 'first')
    const result = await save(
      'presets',
      'first',
      { brain: 'new-model', senseGroup: 'reader' },
      false,
    )
    expect(result.status).toBe(200)
    const edited = (await read('presets', 'first')).value as any
    expect(edited.leader).not.toBe('shared')
    expect(edited.id).toBe((firstBefore.value as any).id)
    expect(edited.schedule).toEqual((firstBefore.value as any).schedule)
    expect((await read('presets', 'second')).value).toEqual(secondBefore.value)
    expect(config.readRawConfig().roles?.shared?.brain).toBe('base')
    expect(config.readRawConfig().roles?.[edited.leader]?.permissions).toEqual({
      template: 'read-only',
    })
  })
  it('supports no-tool models only with empty selections and preserves core validation', async () => {
    expect(
      (
        await save('brains', 'text-only', {
          provider: 'openai',
          model: 'text-only',
          capabilities: { toolCall: false },
        })
      ).status,
    ).toBe(201)
    expect((await save('presets', 'no-tools', { brain: 'text-only', senseGroup: '' })).status).toBe(
      201,
    )
    expect(
      (await save('presets', 'bad-tools', { brain: 'text-only', senseGroup: 'reader' })).status,
    ).toBe(400)
    expect((await save('presets', 'bad-group', { brain: 'base', senseGroup: '' })).status).toBe(400)
  })
  it('idempotent replay is bounded and different content under same request ID is refused', async () => {
    const draft = await read('brains', 'new-model')
    const body = {
      name: 'new-model',
      value: { rpm: 13 },
      expectedBaseRevision: draft.baseRevision,
      requestId: crypto.randomUUID(),
    }
    const first = await request('PUT', 'resources/brains', body)
    expect(first.status).toBe(200)
    expect(await request('PUT', 'resources/brains', body)).toEqual(first)
    expect((await request('PUT', 'resources/brains', { ...body, value: { rpm: 14 } })).status).toBe(
      409,
    )
  })
  it('rapid consecutive saves preserve runtime state reporting and never restart or drop real wire', async () => {
    const inFlight = config.captureRuntimeConfig()
    const oldBrain = structuredClone(inFlight.llm.brain['new-model'])
    for (let i = 0; i < 4; i++)
      expect((await save('brains', 'new-model', { rpm: 20 + i }, false)).status).toBe(200)
    await commit.getConfigApplyCoordinator().retry()
    expect(inFlight.llm.brain['new-model']).toEqual(oldBrain)
    expect(config.captureRuntimeConfig()).not.toBe(inFlight)
    expect(config.captureRuntimeConfig().llm.brain['new-model']?.rpm).toBe(23)
    const state = await request('GET', 'apply')
    expect(state.status).toBe(200)
    expect((state.body as any).data.protocolVersion).toBe(2)
    expect((await read('brains', 'new-model')).value).toMatchObject({ rpm: 23 })
  })
  it('write-only environment key references remain resolvable on disk but absent in view', async () => {
    expect((await save('brains', 'new-model', { key: '$SYNTHETIC_MODEL_KEY' }, false)).status).toBe(
      200,
    )
    expect(config.readRawConfig().llm.brain['new-model']?.key).toBe('$SYNTHETIC_MODEL_KEY')
    expect(JSON.stringify(await read('brains', 'new-model'))).not.toContain('$SYNTHETIC_MODEL_KEY')
  })
  it('clearing a key is explicit, invalid workspace preserves disk and parallel stale saves cannot overwrite', async () => {
    expect((await save('brains', 'new-model', { key: '' }, false)).status).toBe(200)
    expect((await read('brains', 'new-model')).secrets).toEqual({ keyConfigured: false })
    const before = readFileSync(join(root, '.chery/config.yaml'), 'utf8')
    expect(
      (await save('presets', 'created', { workspace: 'relative/not-valid' }, false)).status,
    ).toBe(400)
    expect(readFileSync(join(root, '.chery/config.yaml'), 'utf8')).toBe(before)
    const draft = await read('brains', 'new-model')
    const attempts = await Promise.all(
      [30, 31].map((rpm) =>
        request('PUT', 'resources/brains', {
          name: 'new-model',
          value: { rpm },
          expectedBaseRevision: draft.baseRevision,
          requestId: crypto.randomUUID(),
        }),
      ),
    )
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409])
  })
  it('core logs never expose model keys, and API method errors retain data/error envelope', async () => {
    const output = logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('')
    expect(output).not.toContain(key)
    expect(output).not.toContain('synthetic-new-key')
    expect((await request('DELETE', 'resources/brains')).body).toMatchObject({
      error: { code: 'invalid_params' },
    })
    expect((await request('GET', 'resources/brains', undefined, 'missing-resource')).status).toBe(
      404,
    )
  })
  it('renames a brain and updates role references while retaining the saved key', async () => {
    const original = await read('brains', 'base')
    const result = await request('PUT', 'resources/brains', {
      originalName: 'base',
      name: 'renamed-base',
      value: original.value,
      expectedBaseRevision: original.baseRevision,
      requestId: crypto.randomUUID(),
    })
    expect(result.status).toBe(200)
    const renamed = await read('brains', 'renamed-base')
    expect(renamed.secrets?.keyConfigured).toBe(true)
    const core = (await rpc.call('config.get', {})) as any
    expect(core.roles.shared.brain).toBe('renamed-base')
    const undo = await request('PUT', 'resources/brains', {
      originalName: 'renamed-base',
      name: 'base',
      value: renamed.value,
      expectedBaseRevision: renamed.baseRevision,
      requestId: crypto.randomUUID(),
    })
    expect(undo.status).toBe(200)
  })
  it('edits the named sense group and refuses simplified edits of a locked leader', async () => {
    expect((await save('sense-groups', 'reader', ['read_file:manual'], false)).status).toBe(200)
    expect((await read('sense-groups', 'reader')).value).toEqual(['read_file:manual'])
    expect((await read('sense-groups', 'empty')).value).toEqual([])
    const raw = config.readRawConfig()
    raw.roles!.shared!.lock = true
    writeFileSync(
      join(root, '.chery/config.yaml'),
      yaml.dump({
        ...raw,
        server: { port: 8182, transport: 'binary' },
      }),
    )
    const before = readFileSync(join(root, '.chery/config.yaml'), 'utf8')
    expect(
      (await save('presets', 'second', { brain: 'new-model', senseGroup: 'reader' }, false)).status,
    ).toBe(400)
    expect(readFileSync(join(root, '.chery/config.yaml'), 'utf8')).toBe(before)
    expect(config.readRawConfig().roles?.shared?.brain).toBe('base')
  })
})
