import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IngressStore } from '@/service/ingress/store.js'
import { IngressHost } from '@/service/ingress/host.js'
import { registerIngressHandlers } from '@/service/ingress/handlers.js'
import { createRouter } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'
import { registerFunctionHook } from '@/agent/hooks/functions.js'
import { dispatch } from '@/agent/hooks/dispatch.js'
import { publishHookRegistry, clearHookRegistry } from '@/agent/hooks/registry.js'
import { registerDeepseekAdapter } from '@/agent/provider/deepseek.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import type { IngressContext, IngressCoreAdapter } from '@/service/ingress/api.js'
import type { Request } from '@/service/message/types.js'

const roots: string[] = []
const releases: Array<() => void | Promise<void>> = []
function temporary() {
  const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'consolidation-'))
  roots.push(root)
  return root
}
function source(version: string, ui = false) {
  const root = temporary()
  fs.writeFileSync(
    path.join(root, 'config.yaml'),
    JSON.stringify({
      id: 'sample',
      version,
      apiVersion: 2,
      entry: 'index.mjs',
      dependencies: [],
      capabilities: ui ? ['rpc.management', 'manager.ui'] : [],
      ...(ui
        ? {
            ui: [
              {
                id: 'sample',
                title: 'Sample',
                entry: 'ui/index.html',
                apiPrefix: '/api/modules/sample/',
                resourceVersion: version.split('.')[0],
              },
            ],
          }
        : {}),
    }),
  )
  if (ui) {
    fs.mkdirSync(path.join(root, 'ui'))
    fs.writeFileSync(
      path.join(root, 'ui/index.html'),
      `<html><head></head><body>${version.split('.')[0]}</body></html>`,
    )
  }
  fs.writeFileSync(
    path.join(root, 'index.mjs'),
    `export function createPlugin(ctx) {
    globalThis.__consolidationContext = ctx;
    return {defaultConfig:{value:0},validateConfig:x=>x,
      async applyConfig(snapshot) { if(snapshot.revision) await globalThis.__consolidationGate; },
      prepareManagement() { ${ui ? `const schema={safeParse:data=>({success:true,data})};ctx.management.register({moduleId:'sample',routes:[{method:'GET',path:'config',rpcMethod:'sample.config',requestSchema:schema,responseSchema:schema,handler:async()=>({version:'${version}'})}]});` : ''} },
      start(){}, stop(){} };
  }`,
  )
  return root
}
function setup() {
  const store = new IngressStore(temporary())
  const router = createRouter()
  const core: IngressCoreAdapter = {
    listPresets: () => [],
    resolvePreset: vi.fn(),
    ensureConversation: vi.fn(),
    submit: vi.fn(),
    abort: vi.fn(),
    onEvent: () => () => {},
  }
  const host = new IngressHost({
    store,
    router,
    core,
    connections: {
      credentialKind: () => undefined,
      isOpen: () => false,
      send: () => false,
      onClose: () => () => {},
    },
  })
  releases.push(() => host.stop())
  return { store, router, host }
}
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release()
  clearHookRegistry()
  vi.unstubAllGlobals()
  delete (globalThis as any).__consolidationContext
  delete (globalThis as any).__consolidationGate
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('independent plugin consolidation boundaries', () => {
  it('applies dependency/order/priority function results before global and brain commands', async () => {
    const ordered: string[] = []
    for (const [owner, order, priority] of [
      ['second', 1, -10],
      ['first', 0, 10],
      ['first', 0, -10],
    ] as const) {
      releases.push(
        registerFunctionHook(owner, order, [], new AbortController().signal, {
          event: 'PreToolUse',
          priority,
          handler: (payload) => {
            ordered.push(`${owner}:${priority}`)
            return { updatedInput: { count: Number(payload.args.count ?? 0) + 1 } }
          },
        }),
      )
    }
    const command = `node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({updatedInput:{count:d.payload.args.count*10}}))"`
    publishHookRegistry({
      PreToolUse: [{ command }, { command, brain: 'selected' }, { command, brain: 'other' }],
    })
    const payload = { name: 'tool', args: { count: 0 }, chatId: 'chat' }
    await dispatch('PreToolUse', payload, { brain: 'selected' })
    expect(ordered).toEqual(['first:-10', 'first:10', 'second:-10'])
    expect(payload.args.count).toBe(300)
  })

  it('keeps the applied snapshot unchanged when disable cancels a pending configuration application', async () => {
    const { host, store } = setup()
    store.install(source('1.0.0'))
    store.setEnabled('sample', true)
    await host.start()
    let resolve!: () => void
    ;(globalThis as any).__consolidationGate = new Promise<void>((r) => {
      resolve = r
    })
    const saving = host.saveConfig('sample', { value: 1 }, 0)
    await vi.waitFor(() => expect(store.readConfig('sample')?.revision).toBe(1))
    const stopping = host.disable('sample')
    resolve()
    await saving
    await stopping
    expect(host.status()[0]).toMatchObject({
      state: 'stopped',
      savedRevision: 1,
      appliedRevision: 0,
      apply: 'pending',
    })
    expect((globalThis as any).__consolidationContext.config.snapshot().config).toEqual({ value: 0 })
  })

  it.each(['disable', 'uninstall'] as const)('ignores late config completion after %s', async action => {
    const { host, store } = setup()
    store.install(source('1.0.0'))
    store.setEnabled('sample', true)
    await host.start()
    let resolve!: () => void
    ;(globalThis as any).__consolidationGate = new Promise<void>(r => { resolve = r })
    const saving = host.saveConfig('sample', { value: 2 }, 0)
    await vi.waitFor(() => expect(store.readConfig('sample')?.revision).toBe(1))
    // The handler deliberately ignores cancellation. Stopping must not wait for its result.
    await host[action]('sample')
    await saving
    resolve()
    await Promise.resolve()
    if (action === 'disable') expect(host.status()[0]).toMatchObject({ appliedRevision: 0, apply: 'pending' })
    else expect(host.status()).toHaveLength(0)
    expect(store.readConfig('sample')?.revision).toBe(1)
  })

  it('serves only the loaded UI version until a saved code update is restarted', async () => {
    const { host, store, router } = setup()
    store.install(source('1.0.0', true), false, undefined, {
      grantedCapabilities: ['rpc.management', 'manager.ui'],
      channelGrants: [],
    })
    await host.start()
    registerIngressHandlers(router, host, store)
    store.install(source('2.0.0', true), true, undefined, {
      grantedCapabilities: ['rpc.management', 'manager.ui'],
      channelGrants: [],
    })
    expect(host.uiList()[0]?.descriptor.resourceVersion).toBe('1')
    const read = await router.handle(
      {
        kind: 'request',
        id: randomUUID(),
        method: 'ingress.ui.read',
        params: {
          contractVersion: 2,
          pluginId: 'sample',
          moduleId: 'sample',
          resourceVersion: '1',
          path: 'index.html',
        },
      } as Request,
      { connectionId: 'admin', credentialKind: 'control', log: logger },
    )
    expect(read).toMatchObject({ success: true, data: { resourceVersion: '1' } })
    if (read.success)
      expect(Buffer.from((read.data as any).contentBase64, 'base64').toString()).toContain('>1<')
  })

  it('rejects an inactive UI version rather than serving newly saved code early', async () => {
    const { host, store, router } = setup()
    store.install(source('1.0.0', true), false, undefined, {
      grantedCapabilities: ['rpc.management', 'manager.ui'],
      channelGrants: [],
    })
    await host.start()
    registerIngressHandlers(router, host, store)
    store.install(source('2.0.0', true), true, undefined, {
      grantedCapabilities: ['rpc.management', 'manager.ui'],
      channelGrants: [],
    })
    const response = await router.handle(
      {
        kind: 'request',
        id: randomUUID(),
        method: 'ingress.ui.read',
        params: {
          contractVersion: 2,
          pluginId: 'sample',
          moduleId: 'sample',
          resourceVersion: '2',
          path: 'index.html',
        },
      } as Request,
      { connectionId: 'admin', credentialKind: 'control', log: logger },
    )
    expect(response.success).toBe(false)
  })

  it('rejects a protocol-specific unsupported field before any provider network request', async () => {
    registerDeepseekAdapter()
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'offline' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    releases.push(
      registerFunctionHook('protocol-policy', 0, [], new AbortController().signal, {
        event: 'PreLLMRequest',
        handler: (payload) => ({ body: { ...payload.body, stop_sequences: ['stop'] } }),
      }),
    )
    await expect(
      getLLMAdapter('deepseek')!.chat([], [], {
        model: 'mock',
        url: 'https://offline.invalid',
        key: 'synthetic',
      }),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reinstalling a new version after uninstall retains config and data, and loads it on restart', async () => {
    const { host, store } = setup()
    store.install(source('1.0.0'))
    store.setEnabled('sample', true)
    await host.start()
    await host.saveConfig('sample', { value: 5 }, 0)
    fs.writeFileSync(store.safe('data/sample/pending'), 'unknown')
    await host.uninstall('sample')
    store.install(source('2.0.0'))
    store.setEnabled('sample', true)
    await host.stop()
    const next = new IngressHost({
      store,
      router: createRouter(),
      core: {
        listPresets: () => [],
        resolvePreset: vi.fn(),
        ensureConversation: vi.fn(),
        submit: vi.fn(),
        abort: vi.fn(),
        onEvent: () => () => {},
      },
      connections: {
        credentialKind: () => undefined,
        isOpen: () => false,
        send: () => false,
        onClose: () => () => {},
      },
    })
    releases.push(() => next.stop())
    await next.start()
    expect(next.status()[0]).toMatchObject({
      activeVersion: '2.0.0',
      savedRevision: 1,
      appliedRevision: 1,
    })
    expect((globalThis as any).__consolidationContext.config.snapshot().config).toEqual({
      value: 5,
    })
    expect(fs.readFileSync(store.safe('data/sample/pending'), 'utf8')).toBe('unknown')
  })
})
