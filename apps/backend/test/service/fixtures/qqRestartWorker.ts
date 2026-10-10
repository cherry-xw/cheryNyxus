/** Synthetic subprocess fixture: no real QQ/model/service access. */
import fs from 'node:fs'
import path from 'node:path'
import { IngressHost } from '../../../src/service/ingress/host.js'
import { IngressStore } from '../../../src/service/ingress/store.js'
import { createRouter } from '../../../src/service/message/router.js'
import { registerAllHandlers } from '../../../src/service/index.js'
import { createWebSocketServer } from '../../../src/service/websocket/index.js'
import { createIngressConnections } from '../../../src/service/ingress/coreAdapter.js'
import { Adapter } from '../../../../../platform/napcat-plugin/src/adapter.js'
import { BackendWire } from '../../../../../platform/napcat-plugin/src/wire.js'
import { QQDefaultConfig } from '../../../../../packages/protocol/src/qq.js'

const root = process.env.CHERY_DIR!
const store = new IngressStore(root)
if (!store.readRegistry().plugins.length) {
  store.install(path.resolve('plugins/qq/dist'), false, undefined, {
    grantedCapabilities: ['ingress', 'rpc.business', 'rpc.management', 'tools', 'hooks', 'channel.identity', 'manager.ui'],
    channelGrants: [{ channel: 'qq', credentialKind: 'qq' }],
  })
  store.setEnabled('cherynyxus-qq-module', true)
  store.saveConfig(
    'cherynyxus-qq-module',
    { ...QQDefaultConfig, selfId: '123', users: ['789'], bindings: { 'private:user:789': 'p' } },
    0,
  )
}
const effectsFile = path.join(root, 'effects.json')
const effects = fs.existsSync(effectsFile)
  ? JSON.parse(fs.readFileSync(effectsFile, 'utf8'))
  : { sends: 0, submissions: 0 }
const persist = () => fs.writeFileSync(effectsFile, JSON.stringify(effects))
const router = createRouter()
registerAllHandlers(router)
const host = new IngressHost({
  store,
  router,
  connections: createIngressConnections(),
  core: {
    listPresets: () => [{ name: 'p', presetId: 'p' }],
    resolvePreset: () => ({
      name: 'p',
      presetId: 'p',
      leaderName: 'l',
      brain: 'b',
      senseGroup: 's',
      mcpServers: [],
    }),
    ensureConversation: async () => ({ chatId: 'synthetic' }),
    submit: async () => {
      effects.submissions++
      persist()
      return { runId: 'synthetic-run', chatId: 'synthetic', inputId: 'synthetic-input', messageId: 'synthetic-message', clientMessageId: 'synthetic-client', state: 'queued' } as any
    },
    abort: async () => {},
    onEvent: () => () => {},
  },
})
await host.start()
const server = createWebSocketServer({
  port: 0,
  host: '127.0.0.1',
  router,
  authToken: 'synthetic-control',
  channelAuth: { token: process.env.QQBOT_PLATFORM_TOKEN, credentialKind: 'qq', header: 'x-qqbot-token' },
  listener: 'local',
})
await new Promise<void>((resolve) => server.once('listening', resolve))
const port = (server.address() as { port: number }).port
const nativeDir = path.join(root, 'native')
fs.mkdirSync(nativeDir, { recursive: true })
const wire = new BackendWire(`ws://127.0.0.1:${port}`, process.env.QQBOT_PLATFORM_TOKEN!)
const originalRequest = wire.request.bind(wire)
wire.request = async (method, params) => {
  const response = await originalRequest(method, params)
  if (method === 'qq.plugin.hello') console.error('synthetic hello', JSON.stringify(response))
  return response
}
const adapter = new Adapter(
  {
    configPath: path.join(nativeDir, 'config.json'),
    dataPath: nativeDir,
    adapterName: 'restart-test',
    pluginManager: { config: {} },
    logger: { info() {}, warn(...args: unknown[]) { console.error(...args) } },
    actions: {
      call: async (action: string) => {
        if (action === 'get_login_info') return { user_id: '123' }
        if (action === 'get_status') return { online: true, good: true }
        effects.sends++
        persist()
        if (process.env.SYNTHETIC_UNKNOWN === '1') throw new Error('synthetic ambiguous send')
        return { message_id: String(900 + effects.sends) }
      },
    },
  },
  wire,
)
await adapter.start()
process.on('message', async (message: any) => {
  try {
    if (message.action === 'submit')
      await adapter.receive({
        post_type: 'message',
        self_id: 123,
        user_id: 789,
        message_type: 'private',
        message_id: 1,
        time: 1,
        sender: { nickname: 'synthetic' },
        message: [{ type: 'text', data: { text: 'synthetic' } }],
      })
    process.send?.({
      id: message.id,
      effects,
      status: adapter.status(),
      hostStatus: host.status(),
      state: JSON.parse(fs.readFileSync(store.safe('data/cherynyxus-qq-module/state.json'), 'utf8')),
    })
  } catch (error) {
    process.send?.({ id: message.id, error: String(error) })
  }
})
process.send?.({ ready: true, pid: process.pid })
