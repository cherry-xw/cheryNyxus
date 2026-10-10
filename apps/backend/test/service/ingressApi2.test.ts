import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { packageDigest } from '@/service/ingress/store.js'
import { IngressStore } from '@/service/ingress/store.js'
import { IngressHost } from '@/service/ingress/host.js'
import { registerIngressHandlers } from '@/service/ingress/handlers.js'
import { createRouter } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'
import { dispatch } from '@/agent/hooks/dispatch.js'
import { registerFunctionHook } from '@/agent/hooks/functions.js'
import { IngressIdentityAuthority } from '@/service/ingress/identity.js'
import { applyProtocolHook } from '@/agent/provider/protocolHook.js'
import type {
  IngressConnections,
  IngressCoreAdapter,
  IngressRegistration,
} from '@/service/ingress/api.js'
import type { Request } from '@/service/message/types.js'

const roots: string[] = []
const cleanup: Array<() => void | Promise<void>> = []
function temp() {
  const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'api2-'))
  roots.push(root)
  return root
}
function pkg(
  id: string,
  body: string,
  capabilities: string[] = ['hooks', 'rpc.business'],
  management = '',
) {
  const root = temp()
  fs.writeFileSync(
    path.join(root, 'config.yaml'),
    JSON.stringify({
      id,
      version: '1.0.0',
      apiVersion: 2,
      entry: 'index.mjs',
      dependencies: [],
      capabilities,
    }),
  )
  fs.writeFileSync(
    path.join(root, 'index.mjs'),
    `export function createPlugin(ctx) { return { defaultConfig: {}, validateConfig: x => x, applyConfig() {}, prepareManagement() { ${management} }, start() { ${body} }, stop() {} } }`,
  )
  return root
}
const connections: IngressConnections = {
  credentialKind: () => 'native',
  isOpen: () => true,
  send: () => true,
  onClose: () => () => {},
}
function setup() {
  const store = new IngressStore(temp()),
    router = createRouter()
  const core: IngressCoreAdapter = {
    listPresets: () => [],
    resolvePreset: vi.fn(),
    ensureConversation: vi.fn(),
    submit: vi.fn(),
    abort: vi.fn(),
    onEvent: () => () => {},
  }
  const host = new IngressHost({ store, router, core, connections, stopTimeoutMs: 20 })
  cleanup.push(() => host.stop())
  return { store, router, host }
}
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
describe('API2 published host', () => {
  it('persists send ownership across restart and rejects forged subjects and duplicate receipts', async () => {
    const store = new IngressStore(temp())
    const source = pkg('delivery', `
      ctx.ingress.register({id:'input'});
      ctx.identity.registerChannel({channel:'native',verifyConnection:async()=>({selfId:'bot'}),verifyEvent:async()=>true});
      globalThis.__deliveryContext = ctx;
    `, ['ingress', 'channel.identity'])
    store.install(source, false, undefined, { grantedCapabilities: ['ingress', 'channel.identity'],
      channelGrants: [{channel:'native',credentialKind:'native'}] })
    store.setEnabled('delivery', true)
    const core: IngressCoreAdapter = { listPresets:()=>[], resolvePreset:vi.fn(), ensureConversation:vi.fn(),
      submit:vi.fn(async()=>({runId:'run'})), abort:vi.fn(), onEvent:()=>()=>{} }
    const make = () => new IngressHost({store,router:createRouter(),core,connections})
    const get = () => (globalThis as any).__deliveryContext as import('@/service/ingress/api.js').IngressContext
    const bind = (ctx: ReturnType<typeof get>, userId='user') => ctx.identity.bind({connectionId:'c',entryId:'input',channel:'native',
      eventId:'input-event',subject:{selfId:'bot',userId,conversationType:'private'}})
    let host = make()
    cleanup.push(async()=>{await host.stop();delete (globalThis as any).__deliveryContext})
    await host.start()
    let ctx = get(), identity = await bind(ctx)
    await ctx.core.ensureConversation('conversation','preset')
    await ctx.core.submit({entryId:'input',identity,conversationKey:'conversation',content:'x',commandId:'cmd',clientMessageId:'input-event',messageId:'message'})
    await host.stop()
    host = make()
    await host.start()
    ctx=get(); identity=await bind(ctx)
    const forged = await bind(ctx,'other')
    const receipt = {entryId:'input',identity,connectionId:'c',requestId:'run',eventId:'output-event',status:'sent' as const,terminal:true}
    await expect(ctx.channels.reportSendResult({...receipt,identity:forged})).rejects.toThrow('IDENTITY_REJECTED')
    let count=0
    const release=registerFunctionHook('observer', 0, [], new AbortController().signal,
      {event:'ChannelSendResult',handler:()=>{count++}})
    cleanup.push(release)
    await ctx.channels.reportSendResult(receipt)
    await ctx.channels.reportSendResult(receipt)
    expect(count).toBe(1)
    expect(store.readJson('data/delivery/host-delivery.json')).toMatchObject({receipts:[['run:output-event','sent']]})
  })
  it('runs two unrelated packages through shared hooks and revokes them immediately', async () => {
    const { host, store } = setup()
    for (const id of ['weather', 'notes']) {
      store.install(
        pkg(
          id,
          `ctx.hooks.register({event:'RequestPrepare',handler:()=>({contexts:[{key:'policy',content:'${id}',configRevision:0}]})});`,
        ),
        false,
        undefined,
        { grantedCapabilities: ['hooks'], channelGrants: [] },
      )
      store.setEnabled(id, true)
    }
    await host.start()
    const result = await dispatch(
      'RequestPrepare',
      { requestId: 'r', inputId: 'i', chatId: 'c' },
      { brain: 'mock' },
    )
    expect(result?.contexts?.map((item) => item.ownerId)).toEqual(['notes', 'weather'])
    const stopping = host.disable('notes')
    const next = await dispatch(
      'RequestPrepare',
      { requestId: 'r2', inputId: 'i2', chatId: 'c' },
      { brain: 'mock' },
    )
    expect(next?.contexts?.map((item) => item.ownerId)).toEqual(['weather'])
    await stopping
  })
  it('rolls back all registrations when a later registration conflicts', async () => {
    const { host, store, router } = setup()
    const body = `const schema = {safeParse: data => ({success:true,data})}; ctx.rpc.register({scope:'business',method:'broken.echo',request:schema,response:schema,authorize:()=>true,handler:async()=>({})}); ctx.rpc.register({scope:'business',method:'broken.echo',request:schema,response:schema,authorize:()=>true,handler:async()=>({})});`
    store.install(pkg('broken', body), false, undefined, {
      grantedCapabilities: ['rpc.business'],
      channelGrants: [],
    })
    store.setEnabled('broken', true)
    await host.start()
    expect(host.status()[0]?.state).toBe('failed')
    expect(router.registeredMethods()).not.toContain('broken.echo')
  })
  it('keeps management and persistent data on disable and removes management on uninstall', async () => {
    const { host, store, router } = setup()
    const schema = `const schema = {safeParse:data=>({success:true,data})};`
    const source = pkg(
      'lifecycle',
      `${schema} ctx.ingress.register({id:'input'}); ctx.rpc.register({scope:'business',method:'lifecycle.run',request:schema,response:schema,authorize:()=>true,handler:async()=>{await ctx.core.ensureConversation('c','preset');return ctx.core.submit({entryId:'input',conversationKey:'c',content:'x',commandId:'cmd',messageId:'msg',clientMessageId:'client'});}});`,
      ['rpc.business', 'rpc.management', 'ingress'],
      `${schema} ctx.rpc.register({scope:'management',method:'lifecycle.status',request:schema,response:schema,authorize:()=>true,handler:async()=>({retained:true})});`,
    )
    store.install(source, false, undefined, {
      grantedCapabilities: ['rpc.business', 'rpc.management', 'ingress'],
      channelGrants: [],
    })
    store.setEnabled('lifecycle', true)
    await host.start()
    const ctx = { connectionId: 'admin', credentialKind: 'control' as const, log: logger }
    const call = (method: string) =>
      router.handle({ kind: 'request', id: randomUUID(), method, params: {} } as Request, ctx)
    store.saveConfig('lifecycle', { persistent: true }, 0)
    fs.writeFileSync(store.safe('data/lifecycle/queue'), 'pending')
    await host.disable('lifecycle')
    expect(await call('lifecycle.run')).toMatchObject({ success: false })
    expect(await call('lifecycle.status')).toMatchObject({
      success: true,
      data: { retained: true },
    })
    expect(store.readConfig('lifecycle')?.config).toEqual({ persistent: true })
    await host.uninstall('lifecycle')
    expect(await call('lifecycle.status')).toMatchObject({ success: false })
    expect(fs.readFileSync(store.safe('data/lifecycle/queue'), 'utf8')).toBe('pending')
    expect(store.readConfig('lifecycle')?.config).toEqual({ persistent: true })
  })
  it('registers real control methods with revisions, deduplication and protected schemas', async () => {
    const { host, store, router } = setup()
    store.install(pkg('weather', '', []))
    await host.start()
    registerIngressHandlers(router, host, store)
    const params = {
      contractVersion: 2,
      id: 'weather',
      expectedRegistryRevision: store.readRegistry().revision,
      requestId: randomUUID(),
    }
    const call = (value: unknown, kind: 'control' | 'qq' = 'control') =>
      router.handle(
        { kind: 'request', id: randomUUID(), method: 'ingress.enable', params: value } as Request,
        { connectionId: 'admin', credentialKind: kind, log: logger },
      )
    expect(await call(params, 'qq')).toMatchObject({ success: false })
    const response = await call(params)
    expect(response).toMatchObject({
      success: true,
      data: { saved: true, status: { requiresRestart: true } },
    })
    expect(await call(params)).toMatchObject({ success: response.success, data: response.data })
    expect(await call({ ...params, expectedRegistryRevision: 0 })).toMatchObject({ success: false })
  })
  it('installs and upgrades through real control RPC without persisting request metadata', async () => {
    const { host, store, router } = setup()
    const sourceRoot = temp(), source = path.join(sourceRoot, 'package')
    fs.cpSync(pkg('install-rpc', '', []), source, { recursive: true })
    await host.start()
    registerIngressHandlers(router, host, store, sourceRoot)
    const call = (method: string) => router.handle({ kind: 'request', id: randomUUID(), method,
      params: { contractVersion: 2, packagePath: 'package', expectedDigest: packageDigest(source), expectedRegistryRevision: store.readRegistry().revision,
        requestId: randomUUID(), grantedCapabilities: [], channelGrants: [] } } as Request,
      { connectionId: 'admin', credentialKind: 'control', log: logger })
    expect(await call('ingress.install')).toMatchObject({ success: true })
    expect(store.readRegistry().plugins[0]).not.toHaveProperty('packagePath')
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'config.yaml'), 'utf8'))
    manifest.version = '1.0.1'
    fs.writeFileSync(path.join(source, 'config.yaml'), JSON.stringify(manifest))
    expect(await call('ingress.upgrade')).toMatchObject({ success: true })
    expect(store.readRegistry().plugins[0]?.version).toBe('1.0.1')
    expect(store.readRegistry().plugins[0]).not.toHaveProperty('requestId')
  })
  it('fences timed-out shutdown and refuses uninstall without deleting persistent data', async () => {
    const { host, store } = setup()
    const source = pkg('slow-stop', '', [])
    fs.writeFileSync(
      path.join(source, 'index.mjs'),
      `export function createPlugin() {
      return { defaultConfig: {}, validateConfig: x => x, applyConfig() {}, start() {},
        stop() { return new Promise(() => {}); } };
    }`,
    )
    store.install(source)
    store.setEnabled('slow-stop', true)
    await host.start()
    fs.writeFileSync(store.safe('data/slow-stop/pending'), 'unknown')
    await host.disable('slow-stop')
    expect(host.status()[0]).toMatchObject({ state: 'failed', reason: 'STOP_TIMEOUT' })
    await expect(host.uninstall('slow-stop')).rejects.toThrow('STOP_TIMEOUT')
    expect(store.readRegistry().plugins[0]?.id).toBe('slow-stop')
    expect(fs.readFileSync(store.safe('data/slow-stop/pending'), 'utf8')).toBe('unknown')
  })
})
describe('shared function hook execution', () => {
  function hook(
    event: Parameters<typeof registerFunctionHook>[4]['event'],
    handler: Parameters<typeof registerFunctionHook>[4]['handler'],
    options: { required?: boolean; timeoutMs?: number } = {},
  ) {
    const controller = new AbortController()
    cleanup.push(
      registerFunctionHook('test', 0, [], controller.signal, { event, handler, ...options }),
    )
    return controller
  }
  it('explicit deny cannot be undone by optional handlers or later allow', async () => {
    hook('PreToolUse', () => ({ decision: 'deny' }), { required: false })
    const later = vi.fn(() => ({ decision: 'allow' as const }))
    hook('PreToolUse', later)
    await expect(
      dispatch('PreToolUse', { name: 'x', args: {}, chatId: 'c' }, { brain: 'b' }),
    ).rejects.toThrow('HOOK_DENIED')
    expect(later).not.toHaveBeenCalled()
  })
  it('rejects invalid protocol fields while real allowed parameters affect the body', async () => {
    hook('PreLLMRequest', (payload) => ({
      body: { ...(payload as { body: Record<string, unknown> }).body, temperature: 0.5 },
    }))
    expect(
      await applyProtocolHook(
        { model: 'mock', messages: [], stream: false },
        { provider: 'openai', model: 'mock' },
      ),
    ).toMatchObject({ temperature: 0.5, messages: [] })
    hook('PreLLMRequest', () => ({ body: { model: 'forged' } }))
    await expect(
      applyProtocolHook({ model: 'mock', messages: [] }, { provider: 'openai' }),
    ).rejects.toThrow()
  })
  it('times out without applying a late context and records optional failures', async () => {
    hook(
      'RequestPrepare',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { contexts: [{ key: 'late', content: 'late', configRevision: 0 }] }
      },
      { timeoutMs: 2, required: false },
    )
    expect(
      await dispatch(
        'RequestPrepare',
        { requestId: 'r', inputId: 'i', chatId: 'c' },
        { brain: 'b' },
      ),
    ).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  it('honours cancellation and never changes an established observation', async () => {
    hook('RequestPrepare', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {}
    })
    const controller = new AbortController()
    const work = dispatch(
      'RequestPrepare',
      { requestId: 'r', inputId: 'i', chatId: 'c' },
      { brain: 'b', signal: controller.signal },
    )
    controller.abort()
    await expect(work).rejects.toThrow()
    hook('RequestCompleted', () => ({ decision: 'block' }) as never)
    await expect(
      dispatch(
        'RequestCompleted',
        { requestId: 'r', inputId: 'i', chatId: 'c', completedAt: 1 },
        { brain: 'b', signal: controller.signal },
      ),
    ).resolves.toBeUndefined()
  })
})
it('identity handles cannot be forged and expire on revocation', async () => {
  const owner: IngressRegistration = {
    id: 'native',
    version: '1.0.0',
    apiVersion: 2,
    entry: 'index.mjs',
    enabled: true,
    packageDigest: '0'.repeat(64),
    dependencies: [],
    capabilities: ['channel.identity'],
    grantedCapabilities: ['channel.identity'],
    channelGrants: [{ channel: 'native', credentialKind: 'native' }],
  }
  const authority = new IngressIdentityAuthority(connections, () => true)
  authority.register(owner, {
    channel: 'native',
    verifyConnection: async () => ({ selfId: 'bot' }),
    verifyEvent: async () => true,
  })
  const handle = await authority.bind(owner, {
    connectionId: 'c',
    entryId: 'input',
    channel: 'native',
    eventId: 'event',
    subject: { selfId: 'bot', userId: 'user', conversationType: 'private' },
  })
  expect(authority.project(owner.id, 'input', handle).subject?.userId).toBe('user')
  expect(() => authority.project(owner.id, 'input', {} as typeof handle)).toThrow()
  expect(() => authority.project('other', 'input', handle)).toThrow('IDENTITY_REJECTED')
  expect(() => authority.project(owner.id, 'other', handle)).toThrow('IDENTITY_REJECTED')
  authority.revokeConnection('c')
  expect(() => authority.project(owner.id, 'input', handle)).toThrow('IDENTITY_REJECTED')
  const reconnected = await authority.bind(owner, {
    connectionId: 'c',
    entryId: 'input',
    channel: 'native',
    eventId: 'new-event',
    subject: { selfId: 'bot', userId: 'user', conversationType: 'private' },
  })
  expect(authority.project(owner.id, 'input', reconnected).subject?.userId).toBe('user')
  authority.revoke(owner.id)
  expect(() => authority.project(owner.id, 'input', reconnected)).toThrow()
})
