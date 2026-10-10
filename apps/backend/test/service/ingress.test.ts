import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { IngressStore, packageDigest } from '@/service/ingress/store.js'
import { IngressHost } from '@/service/ingress/host.js'
import { createRouter } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'
import {
  createIngressCoreAdapter,
  createIngressConnections,
} from '@/service/ingress/coreAdapter.js'
import { startService } from '@/service/index.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { getMessages } from '@/db/message.js'
import { closeAllDbs } from '@/db/index.js'
import type { IngressCoreAdapter, IngressConnections } from '@/service/ingress/api.js'
import type { Request } from '@/service/message/types.js'

const roots: string[] = []
const hosts: IngressHost[] = []
function temporary(): string {
  const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'ingress-'))
  roots.push(root)
  return root
}
function packageAt(id = 'synthetic', version = '1.0.0', body = ''): string {
  const root = temporary()
  fs.writeFileSync(
    path.join(root, 'config.yaml'),
    JSON.stringify({
      id,
      version,
      apiVersion: 2,
      entry: 'index.mjs',
      dependencies: [],
      capabilities: ['rpc.business'],
    }),
  )
  fs.writeFileSync(
    path.join(root, 'index.mjs'),
    `
import fs from 'node:fs';
export function createPlugin(ctx) {
  let snapshot;
  return {
    defaultConfig: { value: 1 },
    validateConfig(config) { if (!config || typeof config.value !== 'number') throw new Error('bad'); return config; },
    applyConfig(next) { if (next.config.value === 99) throw new Error('apply failed'); if (next.config.value === 88) return 'restart_required'; snapshot = next; },
    start() { fs.writeFileSync(ctx.dataDir + '/started.json', JSON.stringify({ id: ctx.id, version: ctx.version, config: snapshot, options: ctx.runtimeOptions })); ${body} },
    stop() { fs.writeFileSync(ctx.dataDir + '/stopped', 'yes'); },
  };
}`,
  )
  return root
}
function fakeCore(): IngressCoreAdapter {
  return {
    listPresets: () => [],
    resolvePreset: () => {
      throw new Error('not configured')
    },
    ensureConversation: vi.fn(),
    submit: vi.fn(),
    abort: vi.fn(),
    onEvent: () => () => {},
  }
}
function fakeConnections(): IngressConnections {
  return {
    credentialKind: () => undefined,
    isOpen: () => false,
    send: () => false,
    onClose: () => () => {},
  }
}
function setup(
  store = new IngressStore(temporary()),
  options: Partial<ConstructorParameters<typeof IngressHost>[0]> = {},
) {
  const router = createRouter()
  const host = new IngressHost({
    store,
    router,
    core: fakeCore(),
    connections: fakeConnections(),
    ...options,
  })
  hosts.push(host)
  return { host, store, router }
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function request(method: string, params: unknown): Request {
  return { kind: 'request', id: randomUUID(), method, params } as Request
}

describe('independent ingress packages', () => {
  it('installs and starts two non-QQ packages independently, with permissions and immutable namespaces', async () => {
    const { host, store } = setup(undefined, { runtimeOptions: { validationPaused: true } })
    for (const id of ['synthetic', 'weather']) {
      store.install(packageAt(id))
      store.setEnabled(id, true)
    }
    await host.start()
    expect(host.status().map((entry) => entry.state)).toEqual(['active', 'active'])
    expect(Object.keys(host.extensions)).toEqual(['synthetic', 'weather'])
    expect(Object.isFrozen(host.extensions.synthetic?.config)).toBe(true)
    for (const id of ['synthetic', 'weather']) {
      const recorded = JSON.parse(fs.readFileSync(store.safe(`data/${id}/started.json`), 'utf8'))
      expect(recorded.id).toBe(id)
      expect(recorded.options).toEqual({ validationPaused: true })
      expect(fs.statSync(store.safe(`data/${id}`)).mode & 0o777).toBe(0o700)
    }
    expect(fs.statSync(store.safe('registry.json')).mode & 0o777).toBe(0o600)
    await host.stop()
    expect(host.status().every((entry) => entry.activeVersion === null)).toBe(true)
    expect(fs.existsSync(store.safe('data/weather/stopped'))).toBe(true)
  })
  it('disabled package prepares management and reports invalid factories without starting business', async () => {
    const { host, store } = setup()
    const source = packageAt()
    fs.writeFileSync(path.join(source, 'index.mjs'), `throw new Error('MUST NOT IMPORT');`)
    store.install(source)
    fs.writeFileSync(store.safe('config/synthetic.json'), '{broken')
    const read = vi.spyOn(store, 'readConfig')
    const verify = vi.spyOn(store, 'verify')
    await host.start()
    expect(read).not.toHaveBeenCalled()
    expect(verify).toHaveBeenCalled()
    expect(host.status()[0]?.state).toBe('failed')
  })
  it('enable/disable/upgrade/uninstall never claim saved changes are already active', async () => {
    const { host, store } = setup()
    store.install(packageAt())
    store.setEnabled('synthetic', true)
    await host.start()
    store.setEnabled('synthetic', false)
    expect(host.status()[0]).toMatchObject({
      enabled: false,
      activeVersion: '1.0.0',
      requiresRestart: false,
    })
    store.setEnabled('synthetic', true)
    store.install(packageAt('synthetic', '2.0.0'), true)
    expect(host.status()[0]).toMatchObject({
      savedVersion: '2.0.0',
      activeVersion: '1.0.0',
      requiresRestart: true,
    })
    store.saveConfig('synthetic', { value: 7 }, 0)
    store.uninstall('synthetic')
    expect(host.status()[0]).toMatchObject({
      installed: false,
      activeVersion: '1.0.0',
      requiresRestart: false,
    })
    expect(store.readConfig('synthetic')?.config).toEqual({ value: 7 })
    expect(fs.existsSync(store.safe('data/synthetic/started.json'))).toBe(true)
  })
  it('hot saves protect revisions, old request snapshots and failed/restart-required application', async () => {
    const { host, store } = setup()
    store.install(packageAt())
    store.setEnabled('synthetic', true)
    await host.start()
    const oldRequestSnapshot = host.extensions.synthetic
    const saved = await host.saveConfig('synthetic', { value: 2 }, 0)
    expect(saved.apply.state).toBe('applied')
    expect(oldRequestSnapshot?.config).toEqual({ value: 1 })
    expect(host.extensions.synthetic?.config).toEqual({ value: 2 })
    await expect(host.saveConfig('synthetic', { value: 3 }, 0)).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    })
    await expect(host.saveConfig('synthetic', { wrong: true }, 1)).rejects.toThrow()
    expect((await host.saveConfig('synthetic', { value: 99 }, 1)).apply.state).toBe('failed')
    expect(host.status()[0]).toMatchObject({ savedRevision: 2, appliedRevision: 1 })
    expect(host.extensions.synthetic?.config).toEqual({ value: 2 })
    expect((await host.saveConfig('synthetic', { value: 88 }, 2)).apply.state).toBe(
      'restart_required',
    )
    expect(host.status()[0]?.requiresRestart).toBe(true)
    expect(host.extensions.synthetic?.revision).toBe(1)
  })
  it('rejects duplicate IDs, unknown API version, invalid versions, entry traversal and malformed package syntax', () => {
    const { store } = setup()
    store.install(packageAt())
    expect(() => store.install(packageAt())).toThrow(/Duplicate/)
    for (const override of [
      { apiVersion: 3 },
      { version: '../bad' },
      { entry: '../outside.mjs' },
      { id: '../evil' },
    ]) {
      const source = packageAt('other')
      fs.writeFileSync(
        path.join(source, 'config.yaml'),
        JSON.stringify({
          id: 'other',
          version: '1.0.0',
          apiVersion: 2,
          dependencies: [],
          capabilities: [],
          entry: 'index.mjs',
          ...override,
        }),
      )
      expect(() => store.install(source)).toThrow()
    }
    const source = packageAt('syntax')
    fs.writeFileSync(path.join(source, 'index.mjs'), 'export function {')
    expect(() => store.install(source)).toThrow()
    expect(store.readRegistry().plugins).toHaveLength(1)
  })
  it('rejects package and managed symlinks and expected/runtime digest mismatches', async () => {
    const { store, host } = setup()
    const source = packageAt()
    fs.symlinkSync(path.join(source, 'index.mjs'), path.join(source, 'escape.mjs'))
    expect(() => store.install(source)).toThrow(/symlink/)
    fs.unlinkSync(path.join(source, 'escape.mjs'))
    expect(() => store.install(source, false, '0'.repeat(64))).toThrow(/digest/)
    const installed = store.install(source, false, packageDigest(source))
    store.setEnabled('synthetic', true)
    fs.appendFileSync(path.join(store.packageDirectory(installed), 'index.mjs'), '\n// tampered')
    await host.start()
    expect(host.status()[0]).toMatchObject({ state: 'failed', activeVersion: null })
    const other = new IngressStore(temporary())
    other.initialize()
    fs.rmSync(other.safe('config'), { recursive: true })
    fs.symlinkSync(source, other.safe('config'))
    expect(() => other.readConfig('synthetic')).toThrow(/symlink/)
  })
  it('rejects duplicate IDs or unknown schema in registry', () => {
    const { store } = setup()
    const registration = store.install(packageAt())
    store.atomicJson('registry.json', {
      schemaVersion: 2,
      revision: 2,
      plugins: [registration, registration],
    })
    expect(() => store.readRegistry()).toThrow(/Duplicate/)
    store.atomicJson('registry.json', { schemaVersion: 3, revision: 2, plugins: [] })
    expect(() => store.readRegistry()).toThrow()
  })
  it('rolls back a failed upgrade publication and preserves old registry, config and package', () => {
    const { store } = setup()
    const installed = store.install(packageAt())
    store.saveConfig('synthetic', { value: 7 }, 0)
    const registry = store.readRegistry()
    const write = vi.spyOn(store, 'atomicJson').mockImplementation(() => {
      throw new Error('disk failure')
    })
    expect(() => store.install(packageAt('synthetic', '2.0.0'), true)).toThrow(/disk failure/)
    write.mockRestore()
    expect(store.readRegistry()).toEqual(registry)
    expect(store.verify(installed)).toContain('/1.0.0/')
    expect(fs.existsSync(store.safe('packages/synthetic/2.0.0'))).toBe(false)
    expect(store.readConfig('synthetic')?.config).toEqual({ value: 7 })
  })
  it('cleans subscriptions and partial startup once, does not report a failed package as active', async () => {
    let cleanups = 0
    const { host, store } = setup(undefined, {
      connections: {
        ...fakeConnections(),
        onClose: () => () => {
          cleanups++
        },
      },
    })
    store.install(
      packageAt(
        'broken',
        '1.0.0',
        `ctx.connections.onClose(() => {}); ctx.defer(() => fs.writeFileSync(ctx.dataDir + '/deferred', 'yes')); throw new Error('secret');`,
      ),
    )
    store.setEnabled('broken', true)
    await host.start()
    expect(host.status()[0]).toMatchObject({ state: 'failed', activeVersion: null })
    expect(JSON.stringify(host.status())).not.toContain('secret')
    expect(cleanups).toBe(1)
    expect(fs.existsSync(store.safe('data/broken/deferred'))).toBe(true)
    await host.stop()
    await host.stop()
    // The host's identity connection observer is released once as well.
    expect(cleanups).toBe(2)
  })
  it('dynamic router requires permissions and validates both schemas without weakening core schemas', async () => {
    const { router } = setup()
    const dispose = router.registerExtension({
      method: 'synthetic.echo',
      request: z.object({ text: z.string() }).strict(),
      response: z.object({ text: z.string() }).strict(),
      authorize: (ctx) => ctx.connectionId === 'allowed',
      handler: async (paramsCtx, params) =>
        ({ text: paramsCtx.requestId === 'bad-response' ? 42 : params.text }) as { text: string },
    })
    const ctx = { connectionId: 'allowed', log: logger }
    expect(await router.handle(request('synthetic.echo', { text: 'hello' }), ctx)).toMatchObject({
      success: true,
      data: { text: 'hello' },
    })
    expect(await router.handle(request('synthetic.echo', { text: 3 }), ctx)).toMatchObject({
      success: false,
      error: { code: 'INVALID_PARAMS' },
    })
    expect(
      await router.handle(request('synthetic.echo', { text: 'hello' }), {
        ...ctx,
        connectionId: 'denied',
      }),
    ).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } })
    expect(
      await router.handle(request('synthetic.echo', { text: 'hello' }), {
        ...ctx,
        requestId: 'bad-response',
      }),
    ).toMatchObject({ success: false, error: { code: 'INTERNAL' } })
    expect(() =>
      router.registerExtension({
        method: 'config.save',
        request: z.unknown(),
        response: z.unknown(),
        authorize: () => true,
        handler: async () => ({}),
      }),
    ).toThrow(/reserved/)
    dispose()
    expect(await router.handle(request('synthetic.echo', { text: 'hello' }), ctx)).toMatchObject({
      error: { code: 'METHOD_NOT_FOUND' },
    })
  })
  it('package-owned RPC registrations and config readers are released on shutdown', async () => {
    const { host, store, router } = setup()
    store.install(
      packageAt(
        'reader',
        '1.0.0',
        `
      const schema = { safeParse(data) { return { success: true, data }; } };
      ctx.rpc.register({ scope: 'business', method: 'reader.config', request: schema, response: schema,
        authorize: () => true,
        handler: async () => ({ saved: ctx.config.saved(), applied: ctx.config.snapshot() }) });
    `,
      ),
      false,
      undefined,
      { grantedCapabilities: ['rpc.business'], channelGrants: [] },
    )
    store.setEnabled('reader', true)
    await host.start()
    await host.saveConfig('reader', { value: 99 }, 0)
    const response = await router.handle(request('reader.config', {}), {
      connectionId: 'admin',
      log: logger,
    })
    expect(response).toMatchObject({
      success: true,
      data: {
        saved: { revision: 1, config: { value: 99 } },
        applied: { revision: 0, config: { value: 1 } },
      },
    })
    await host.stop()
    expect(
      await router.handle(request('reader.config', {}), { connectionId: 'admin', log: logger }),
    ).toMatchObject({ success: false, error: { code: 'METHOD_NOT_FOUND' } })
  })
  it('starts/stops host through actual service readiness without opening real service ports', async () => {
    const store = new IngressStore(temporary())
    store.install(packageAt('service-check'))
    store.setEnabled('service-check', true)
    const service = startService({
      port: 0,
      webPort: 0,
      ingress: {
        cheryDir: path.dirname(path.dirname(store.root)),
        runtimeOptions: { paused: true },
      },
    })
    try {
      const addresses = await service.ready
      expect(addresses.local.websocketPort).toBeGreaterThan(0)
      expect(service.ingress.status()[0]?.state).toBe('active')
      await service.stopIngress()
      expect(fs.existsSync(store.safe('data/service-check/stopped'))).toBe(true)
    } finally {
      await service.stopIngress()
      service.stopSchedule()
      await Promise.all([
        new Promise<void>((resolve) => service.wss.close(() => resolve())),
        new Promise<void>((resolve) => service.httpServer.close(() => resolve())),
      ])
    }
  })
  it('real public core adapter resolves resources, executes offline model and scopes event/conversation access', async () => {
    await bootstrapAgentRuntime()
    const core = createIngressCoreAdapter()
    const name = 'detail-test'
    expect(core.listPresets().some((preset) => preset.name === name)).toBe(true)
    const resolved = core.resolvePreset(name)
    expect(resolved.brain).toBe('mock_content')
    expect(JSON.stringify(resolved)).not.toContain('key')
    const owner = 'offline'
    const key = randomUUID()
    const { chatId } = await core.ensureConversation(owner, key, name)
    expect(await core.ensureConversation(owner, key, name)).toEqual({ chatId })
    await expect(
      core.submit('other', key, {
        entryId: 'input',
        requestIdentity: { source: 'plugin', ownerId: 'other', entryId: 'input' },
        validateIdentity() {},
        content: 'forbidden',
        commandId: randomUUID(),
        messageId: randomUUID(),
        clientMessageId: randomUUID(),
      }),
    ).rejects.toThrow()
    const events: Readonly<Record<string, unknown>>[] = []
    const dispose = core.onEvent(owner, (_key, event) => events.push(event))
    const accepted = await core.submit(owner, key, {
      entryId: 'input',
      requestIdentity: { source: 'plugin', ownerId: owner, entryId: 'input' },
      validateIdentity() {},
      content: 'offline hello',
      commandId: randomUUID(),
      messageId: randomUUID(),
      clientMessageId: randomUUID(),
    })
    expect(accepted.chatId).toBe(chatId)
    await vi.waitFor(
      () =>
        expect(events.some((event) => event.type === 'done' || event.type === 'run.outcome')).toBe(
          true,
        ),
      { timeout: 8000 },
    )
    expect(getMessages(chatId).some((message) => message.role === 'assistant')).toBe(true)
    dispose()
    expect(createIngressConnections().isOpen('unknown')).toBe(false)
    expect(createIngressConnections().send('unknown', {})).toBe(false)
    await core.abort(owner, key)
    closeAllDbs()
  })
})
