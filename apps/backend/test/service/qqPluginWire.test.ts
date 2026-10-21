/** Real installed QQ package / host / router / WebSocket / native Adapter. Only core execution and QQ actions are synthetic. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, type WebSocketServer } from 'ws'
import { IngressHost } from '@/service/ingress/host.js'
import { startService, type ServiceHandle } from '@/service/index.js'
import { IngressStore } from '@/service/ingress/store.js'
import { createRouter } from '@/service/message/router.js'
import { createWebSocketServer } from '@/service/websocket/index.js'
import {
  createIngressConnections,
  createIngressCoreAdapter,
} from '@/service/ingress/coreAdapter.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { getMessages } from '@/db/message.js'
import { logger } from '@/utils/logger/index.js'
import { OAuth2Auth } from '@/service/auth/index.js'
import type { IngressCoreAdapter } from '@/service/ingress/api.js'
import type { Request, Response } from '@/service/message/types.js'
import { QQCapabilities, QQDefaultConfig } from '../../../../packages/protocol/src/qq.js'
import { BackendWire } from '../../../../platform/napcat-plugin/src/wire.js'
import { Adapter } from '../../../../platform/napcat-plugin/src/adapter.js'

const roots: string[] = [],
  hosts: IngressHost[] = [],
  servers: WebSocketServer[] = [],
  adapters: Adapter[] = []
const TOKEN = 'synthetic-wire-qq-token'
function temp() {
  const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'qq-wire-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.close()
  for (const host of hosts.splice(0)) await host.stop()
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate()
    await new Promise<void>((r) => server.close(() => r()))
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  delete process.env.QQBOT_PLATFORM_TOKEN
})
async function start(
  paused = false,
  broken = false,
  overrides: Partial<typeof QQDefaultConfig> = {},
) {
  process.env.QQBOT_PLATFORM_TOKEN = TOKEN
  const store = new IngressStore(temp()),
    router = createRouter()
  store.install(path.resolve('plugins/qq/dist'), false, undefined, {
    grantedCapabilities: ['ingress', 'rpc.business', 'rpc.management', 'tools', 'hooks', 'channel.identity', 'manager.ui'],
    channelGrants: [{ channel: 'qq', credentialKind: 'qq' }],
  })
  store.setEnabled('cherynyxus-qq-module', true)
  store.saveConfig(
    'cherynyxus-qq-module',
    {
      ...structuredClone(QQDefaultConfig),
      selfId: '123',
      groups: ['456'],
      users: ['789'],
      bindings: { 'group:456': 'p', 'private:user:789': 'p' },
      ...overrides,
    },
    0,
  )
  if (broken) {
    store.directory('data/cherynyxus-qq-module')
    fs.writeFileSync(store.safe('data/cherynyxus-qq-module/state.json'), '{bad')
  }
  const calls: any[] = []
  let emit: (key: string, event: Readonly<Record<string, unknown>>) => void = () => {}
  const core: IngressCoreAdapter = {
    listPresets: () => [],
    resolvePreset: () => ({
      name: 'p',
      presetId: 'p-id',
      leaderName: 'l',
      brain: 'b',
      senseGroup: 's',
      mcpServers: [],
    }),
    ensureConversation: async () => ({ chatId: 'synthetic' }),
    submit: async (_owner, key, data) => {
      calls.push(data)
      emit(key, { type: 'sense_started', data: { id: 'one', senseName: 'read_file' } })
      emit(key, { type: 'sense_started', data: { id: 'two', senseName: 'unknown_tool' } })
      emit(key, {
        kind: 'chunk',
        type: 'staged',
        data: { type: 'content_end', role: 'assistant', content: 'synthetic answer' },
      })
      emit(key, { type: 'run.outcome', data: { status: 'completed' } })
      return {} as any
    },
    abort: async () => {},
    onEvent: (_owner, listener) => {
      emit = listener
      return () => {}
    },
  }
  const host = new IngressHost({
    store,
    router,
    core,
    connections: createIngressConnections(),
    runtimeOptions: { QQ_INGRESS_PAUSED: paused },
  })
  hosts.push(host)
  await host.start()
  const server = createWebSocketServer({
    port: 0,
    host: '127.0.0.1',
    router,
    authToken: 'control-token',
    channelAuth: { token: TOKEN, credentialKind: 'qq', header: 'x-qqbot-token' },
    listener: 'local',
  })
  servers.push(server)
  await new Promise<void>((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  return { host, store, router, calls, port }
}
async function connect(port: number, headers: Record<string, string>, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, { headers })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}
async function request(ws: WebSocket, method: string, params: unknown) {
  const id = randomUUID()
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RPC timeout')), 3000)
    const receive = (raw: any) => {
      const buf = Buffer.from(raw)
      const f = JSON.parse((buf[0] === 2 ? buf.subarray(1) : buf).toString())
      if (f.requestId === id) {
        clearTimeout(timer)
        ws.off('message', receive)
        resolve(f)
      }
    }
    ws.on('message', receive)
    ws.send(JSON.stringify({ kind: 'request', id, method, params }))
  })
}
function native(port: number, reactionFailure = false, getMessage?: () => unknown) {
  const sends: any[][] = []
  const dir = temp()
  const adapter = new Adapter(
    {
      configPath: path.join(dir, 'config.json'),
      dataPath: dir,
      adapterName: 'synthetic',
      pluginManager: { config: {} },
      logger: { info() {}, warn(...args: unknown[]) { console.warn(...args) } },
      actions: {
        call: async (...args: any[]) => {
          if (args[0] === 'get_login_info') return { user_id: '123' }
          if (args[0] === 'get_status') return { online: true, good: true }
          if (args[0] === 'get_msg' && getMessage) return getMessage()
          sends.push(args)
          if (args[0] === 'set_msg_emoji_like') {
            if (reactionFailure) throw new Error('unsupported')
            return { result: 0 }
          }
          return { message_id: String(900 + sends.length) }
        },
      },
    },
    new BackendWire(`ws://127.0.0.1:${port}`, TOKEN),
  )
  adapters.push(adapter)
  return { adapter, sends }
}
const event = (kind: 'private' | 'group', id: number) => ({
  post_type: 'message',
  self_id: 123,
  user_id: 789,
  ...(kind === 'group' ? { group_id: 456 } : {}),
  message_type: kind,
  message_id: id,
  time: 1,
  sender: { nickname: 'synthetic' },
  message: [
    { type: 'text', data: { text: 'hello' } },
    ...(kind === 'group' ? [{ type: 'at', data: { qq: '123' } }] : []),
  ],
})
describe('native adapter and real installed backend wire', () => {
  it('installed QQ attachment failure crosses production startService host filter and actual JSON logger', async () => {
    process.env.QQBOT_PLATFORM_TOKEN = TOKEN
    const root = temp(), store = new IngressStore(root)
    store.install(path.resolve('plugins/qq/dist'), false, undefined, {
      grantedCapabilities: ['ingress', 'rpc.business', 'rpc.management', 'tools', 'hooks', 'channel.identity', 'manager.ui'],
      channelGrants: [{ channel: 'qq', credentialKind: 'qq' }],
    })
    store.setEnabled('cherynyxus-qq-module', true)
    store.saveConfig('cherynyxus-qq-module', { ...structuredClone(QQDefaultConfig), selfId: '123', groups: ['456'], bindings: { 'group:456': 'p' } }, 0)
    const previous = logger.getConfig(), lines: string[] = []
    logger.setConfig({ level: 'info', output: ['console'], format: 'json', location: false })
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true }) as any)
    let service: ServiceHandle | undefined
    let image: any, refreshCount = 0, importCount = 0
    try {
      const core: IngressCoreAdapter = {
        listPresets: () => [], resolvePreset: () => ({ name: 'p', presetId: 'p-id', leaderName: 'l', brain: 'b', senseGroup: 's', mcpServers: [] }),
        ensureConversation: async () => ({ chatId: 'synthetic' }),
        importFile: async () => { importCount++; throw Object.assign(new Error('https://secret.invalid/?token=credential'), { stage: 'download', code: 'HTTP_400' }) },
        submit: async () => ({} as any), abort: async () => {}, onEvent: () => () => {},
      }
      service = startService({ port: 0, webPort: 0, ingress: { cheryDir: root, core }, channelAuth: { token: TOKEN, credentialKind: 'qq', header: 'x-qqbot-token' } })
      const addresses = await service.ready
      const n = native(addresses.local.websocketPort, false, () => { refreshCount++; return { ...image, sender: { user_id: 789 }, message: [{ type: 'image', data: { url: 'https://secret.invalid/?token=credential&rkey=new' } }] } })
      await n.adapter.start()
      await vi.waitFor(() => expect(n.adapter.status().ready).toBe(true))
      image = event('group', 1691784683)
      image.time = Math.floor(Date.now() / 1000)
      image.message = [{ type: 'image', data: { file: 'fixture', url: 'https://secret.invalid/?token=credential&rkey=old' } }] as any
      await n.adapter.receive(image)
      const trigger = event('group', 905662704); trigger.time = image.time
      await n.adapter.receive(trigger)
      await vi.waitFor(() => expect(lines.some(line => line.includes('qq.attachment.unavailable'))).toBe(true), { timeout: 10000 })
      const logged = lines.flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } }).find(row => row.type === 'qq.attachment.unavailable')
      expect(logged.data).toMatchObject({ pluginId: 'cherynyxus-qq-module', stage: 'import', code: 'UNAVAILABLE', messageId: '1691784683', attachmentIndex: 0 })
      expect(refreshCount).toBe(0); expect(importCount).toBe(0)
      expect(logged.scope.requestId).toMatch(/^[0-9a-f-]{36}$/)
      expect(logged.scope.requestId).toBe(logged.data.requestId)
      expect(JSON.stringify(logged)).not.toMatch(/secret.invalid|credential|token|fixture/)
    } finally {
      for (const adapter of adapters.splice(0)) adapter.close()
      if (service) { await service.stopIngress(); service.stopSchedule(); for (const client of service.wss.clients) client.terminate(); await new Promise<void>(r => service!.wss.close(() => r())); await new Promise<void>(r => service!.httpServer.close(() => r())) }
      output.mockRestore(); logger.setConfig({ ...previous, level: 'silent' })
    }
  })
  it.each(['private', 'group'] as const)(
    'real %s RPC produces exact ACK, ordered real tool icons, body and confirmations',
    async (kind) => {
      const s = await start()
      const n = native(s.port)
      await n.adapter.start()
      await vi.waitFor(() => expect(n.adapter.status().ready).toBe(true))
      await n.adapter.receive(event(kind, 1))
      await vi.waitFor(() => expect(n.sends).toHaveLength(2), { timeout: 8000 })
      const texts = n.sends.filter((c) => c[0] === 'send_msg')
      expect(texts.map((c) => c[1].message[0].data.text)).toEqual(
        kind === 'group'
          ? ['synthetic answer']
          : ['收到', 'synthetic answer'],
      )
      const reactions = n.sends.filter((c) => c[0] === 'set_msg_emoji_like')
      expect(reactions).toHaveLength(kind === 'group' ? 1 : 0)
      if (kind === 'group') {
        expect(reactions[0]![1]).toMatchObject({ message_id: '1', set: true })
        expect([
          '268',
          '269',
          '270',
          '271',
          '272',
          '277',
          '307',
          '306',
          '281',
          '283',
          '284',
          '285',
          '286',
          '287',
          '289',
          '294',
          '297',
          '298',
          '299',
          '323',
          '475',
          '476',
          '477',
          '478',
          '479',
          '353',
          '356',
          '354',
          '352',
          '357',
          '428',
          '201',
          '317',
          '324',
          '341',
          '26',
          '27',
          '29',
          '427',
          '34',
          '38',
          '177',
          '33',
          '265',
          '264',
          '346',
          '262',
          '178',
        ]).toContain(reactions[0]![1].emoji_id)
      }
      expect(n.sends.every((c) => c.length === 4 && c[2] === 'synthetic')).toBe(true)
      expect(texts[0]![1]).toMatchObject(
        kind === 'group'
          ? { group_id: '456', message_type: 'group' }
          : { user_id: '789', message_type: 'private' },
      )
      await vi.waitFor(() =>
        expect(
          JSON.parse(fs.readFileSync(s.store.safe('data/cherynyxus-qq-module/state.json'), 'utf8'))
            .jobs[0].state,
        ).toBe('completed'),
      )
      await n.adapter.receive(event(kind, 1))
      expect(s.calls).toHaveLength(1)
      expect(n.sends).toHaveLength(2)
    },
  )
  it('unsupported group reaction never sends acknowledgement text or blocks the answer', async () => {
    const s = await start()
    const n = native(s.port, true)
    await n.adapter.start()
    await n.adapter.receive(event('group', 9))
    // The failure notice can precede the normal reply; it is not evidence of completion.
    await vi.waitFor(() =>
      expect(
        JSON.parse(fs.readFileSync(s.store.safe('data/cherynyxus-qq-module/state.json'), 'utf8'))
          .jobs[0].state,
      ).toBe('completed'),
      { timeout: 10000 },
    )
    expect(s.calls).toHaveLength(1)
    expect(n.sends.filter((c) => c[0] === 'send_msg').length).toBeGreaterThanOrEqual(2)
    expect(n.adapter.status().ready).toBe(true)
  })
  it('real verifyClient rejects wrong token and foreign Origin, control auth cannot call transport', async () => {
    const s = await start()
    const origin = `http://127.0.0.1:${s.port}`
    await expect(connect(s.port, { 'X-QQBot-Token': 'wrong', Origin: origin })).rejects.toThrow()
    await expect(
      connect(s.port, { 'X-QQBot-Token': TOKEN, Origin: 'http://foreign.invalid' }),
    ).rejects.toThrow()
    const control = await connect(s.port, { Origin: origin }, '?token=control-token')
    expect((await request(control, 'qq.plugin.hello', {})).success).toBe(false)
    control.close()
    const qq = await connect(s.port, { 'X-QQBot-Token': TOKEN, Origin: origin })
    expect((await request(qq, 'qq.config.get', {})).success).toBe(false)
    expect((await request(qq, 'chat.list', {})).success).toBe(false)
    expect(
      (
        await request(qq, 'qq.plugin.hello', {
          protocolVersion: 1,
          pluginVersion: '0.1.0',
          selfId: '999',
          capabilities: [...QQCapabilities],
        })
      ).success,
    ).toBe(false)
    qq.close()
  })
  it('deployment pause leaves native adapter safely unready and no QQ actions', async () => {
    const s = await start(true)
    const n = native(s.port)
    await n.adapter.start()
    await vi.waitFor(() => expect(n.adapter.status().state).toBe('backend-unsupported'))
    await n.adapter.receive(event('private', 1))
    expect(n.sends).toHaveLength(0)
    expect(s.calls).toHaveLength(0)
  })
  it('rejects forged self identity and self-sent native events before backend submission', async () => {
    const s = await start()
    const n = native(s.port)
    await n.adapter.start()
    await vi.waitFor(() => expect(n.adapter.status().ready).toBe(true))
    await n.adapter.receive({ ...event('private', 11), self_id: 999 })
    await n.adapter.receive({ ...event('private', 12), user_id: 123 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(s.calls).toHaveLength(0)
    expect(n.sends).toHaveLength(0)
  })

  it('requires a group mention and submits attributed messages', async () => {
    const s = await start()
    const n = native(s.port)
    await n.adapter.start()
    await vi.waitFor(() => expect(n.adapter.status().ready).toBe(true))
    const withoutMention = event('group', 21)
    withoutMention.message = [{ type: 'text', data: { text: 'hello' } }]
    await n.adapter.receive(withoutMention)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(s.calls).toHaveLength(0)
    await n.adapter.receive(event('group', 22))
    // 群确认的持久延迟最多 5 秒，需同时留出 tick、回执与消息合并时间。
    await vi.waitFor(() => expect(s.calls).toHaveLength(1), { timeout: 8000 })
    expect(s.calls[0]).toMatchObject({
      content: expect.stringContaining('hello'),
      requestIdentity: { source: 'plugin', channel: 'qq', subject: {
        selfId: '123', conversationType: 'group', groupId: '456', userId: '789',
      } },
    })
  })
  it('rejects events outside the configured private/group allowlists without invoking core', async () => {
    const s = await start(false, false, { groups: [], users: [], bindings: {} })
    const n = native(s.port)
    await n.adapter.start()
    await vi.waitFor(() => expect(n.adapter.status().ready).toBe(true))
    await n.adapter.receive(event('private', 1))
    await n.adapter.receive(event('group', 2))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(s.calls).toHaveLength(0)
    expect(n.sends).toHaveLength(0)
    expect(JSON.stringify(s.store.readConfig('cherynyxus-qq-module') ?? '')).not.toContain(TOKEN)
  })

  it('keeps rejected duplicate event decisions stable and leaves no message record', async () => {
    const s = await start(false, false, { groups: [], users: [], bindings: {} })
    const n = native(s.port)
    await n.adapter.start()
    await vi.waitFor(() => expect(n.adapter.status().ready).toBe(true))
    const first = event('private', 7)
    await n.adapter.receive(first)
    await n.adapter.receive(first)
    const control = await connect(
      s.port,
      { Origin: `http://127.0.0.1:${s.port}` },
      '?token=control-token',
    )
    const queue = await request(control, 'qq.queue.get', {})
    const history = await request(control, 'qq.history.get', {})
    expect(queue.success).toBe(true)
    expect(history.success).toBe(true)
    expect(JSON.stringify({ queue, history })).not.toContain('synthetic')
    expect(JSON.stringify({ queue, history })).not.toContain(TOKEN)
    expect(s.calls).toHaveLength(0)
    control.close()
  })

  it('only administrators can read accepted message summaries and details over the real wire', async () => {
    const s = await start()
    const n = native(s.port)
    await n.adapter.start()
    await vi.waitFor(() => expect(n.adapter.status().ready).toBe(true))
    await n.adapter.receive(event('private', 71))
    const control = await connect(s.port, { Origin: `http://127.0.0.1:${s.port}` }, '?token=control-token')
    let entry: any
    await vi.waitFor(async () => {
      const queue = await request(control, 'qq.queue.get', {})
      const history = await request(control, 'qq.history.get', {})
      entry = [...queue.data.entries, ...history.data.entries][0]
      expect(entry).toMatchObject({ senderId: '789', senderName: 'synthetic', targetId: '789', inputPreview: 'hello' })
    })
    const details = await request(control, 'qq.entry.get', { requestId: entry.requestId })
    expect(details.success).toBe(true)
    expect(details.data.messages[0]).toMatchObject({ content: 'hello', senderId: '789' })
    expect(JSON.stringify(details)).not.toContain(TOKEN)
    const qq = await connect(s.port, { 'X-QQBot-Token': TOKEN })
    expect((await request(qq, 'qq.entry.get', { requestId: entry.requestId })).success).toBe(false)
    expect((await request(qq, 'qq.history.get', {})).success).toBe(false)
    qq.close(); control.close()
  })

  it('QQ header remains independent when core authentication is enabled', async () => {
    process.env.QQBOT_PLATFORM_TOKEN = TOKEN
    const server = createWebSocketServer({
      port: 0,
      host: '127.0.0.1',
      router: createRouter(),
      channelAuth: { token: TOKEN, credentialKind: 'qq', header: 'x-qqbot-token' },
      listener: 'local',
      auth: new OAuth2Auth({ enabled: true, allowLoopback: false }),
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const port = (server.address() as { port: number }).port
    const ws = await connect(port, { Origin: `http://127.0.0.1:${port}`, 'X-QQBot-Token': TOKEN })
    ws.close()
    await expect(
      connect(port, { Origin: `http://127.0.0.1:${port}`, 'X-QQBot-Token': 'wrong' }),
    ).rejects.toThrow()
  })
  it('bad QQ package state does not stop second independent package or Web RPC', async () => {
    const s = await start(false, true)
    expect(s.host.status()[0]?.state).toBe('failed')
    await s.host.stop()
    const source = temp()
    fs.writeFileSync(
      path.join(source, 'config.yaml'),
      JSON.stringify({ id: 'synthetic', version: '1.0.0', apiVersion: 2, entry: 'index.mjs', dependencies: [], capabilities: ['rpc.business'] }),
    )
    fs.writeFileSync(
      path.join(source, 'index.mjs'),
      `export function createPlugin(ctx) { return {defaultConfig:{},validateConfig:c=>c,applyConfig(){},start(){ctx.rpc.register({scope:'business',method:'synthetic.read',request:{safeParse:data=>({success:true,data})},response:{safeParse:data=>({success:true,data})},authorize:()=>true,handler:async()=>({alive:true})})},stop(){}} }`,
    )
    s.store.install(source, false, undefined, { grantedCapabilities: ['rpc.business'], channelGrants: [] })
    s.store.setEnabled('synthetic', true)
    const host = new IngressHost({
      store: s.store,
      router: s.router,
      core: createIngressCoreAdapter(),
      connections: createIngressConnections(),
    })
    hosts.push(host)
    await host.start()
    expect(host.status().find((v) => v.id === 'synthetic')?.state).toBe('active')
    const ws = await connect(
      s.port,
      { Origin: `http://127.0.0.1:${s.port}` },
      '?token=control-token',
    )
    expect((await request(ws, 'synthetic.read', {})).data).toEqual({ alive: true })
    ws.close()
  })
  it('trusted QQ core adapter and ordinary Web input both execute real offline mock provider', async () => {
    await bootstrapAgentRuntime()
    const core = createIngressCoreAdapter()
    const owner = 'cherynyxus-qq-module',
      key = randomUUID()
    const { chatId } = await core.ensureConversation(owner, key, 'detail-test')
    const events: any[] = []
    const dispose = core.onEvent(owner, (_key, event) => events.push(event))
    await core.submit(owner, key, {
      commandId: randomUUID(),
      clientMessageId: randomUUID(),
      messageId: randomUUID(),
      content: 'offline QQ',
      entryId: 'qq',
      requestIdentity: { source: 'plugin', ownerId: owner, entryId: 'qq', channel: 'qq',
        subject: { selfId: '123', conversationType: 'private', userId: '789' } },
      validateIdentity: () => {},
      execution: { toolHistory: 'request', retry: 'never' },
    })
    await vi.waitFor(
      () => expect(events.some((e) => e.type === 'done' || e.type === 'run.outcome')).toBe(true),
      { timeout: 8000 },
    )
    expect(getMessages(chatId).some((m) => m.role === 'assistant')).toBe(true)
    dispose()
    const webKey = randomUUID()
    const webChat = await core.ensureConversation('webtest', webKey, 'detail-test')
    await core.submit('webtest', webKey, {
      commandId: randomUUID(),
      clientMessageId: randomUUID(),
      messageId: randomUUID(),
      content: 'offline Web',
      entryId: 'web', requestIdentity: { source: 'plugin', ownerId: 'webtest', entryId: 'web' },
      validateIdentity: () => {},
    })
    await vi.waitFor(
      () => expect(getMessages(webChat.chatId).some((m) => m.role === 'assistant')).toBe(true),
      { timeout: 8000 },
    )
    await expect(
      core.submit('webtest', webKey, {
        commandId: randomUUID(),
        clientMessageId: randomUUID(),
        messageId: randomUUID(),
        content: 'forged',
        platformIdentity: {
          platform: 'qq',
          conversationType: 'private',
          userId: '789',
          nickname: 'synthetic',
        },
      }),
    ).rejects.toThrow()
    const response = (await createRouter().handle(
      { kind: 'request', id: 'probe', method: 'qq.plugin.hello', params: {} } as Request,
      { connectionId: 'control', log: logger },
    )) as Response
    expect(response.success).toBe(false)
  })
})
