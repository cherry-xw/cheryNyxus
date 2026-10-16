// Verify the installable bundle with synthetic ctx and local wire only.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import AdmZip from 'adm-zip'
import { WebSocketServer } from 'ws'
const root = new URL('../', import.meta.url)
const zip = new AdmZip(new URL('artifacts/napcat-plugin-cheryclaw-0.1.0.zip', root).pathname)
assert.deepEqual(zip.getEntries().map(e => e.entryName).sort(), ['index.mjs', 'package.json'])
const dir = await mkdtemp(join(tmpdir(), 'napcat-package-'))
zip.extractAllTo(dir)
const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'napcat-plugin-cheryclaw'); assert.equal(pkg.main, 'index.mjs')
const plugin = await import(pathToFileURL(join(dir, pkg.main)).href)
for (const name of ['plugin_init', 'plugin_onmessage', 'plugin_cleanup']) assert.equal(typeof plugin[name], 'function')
const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening')
const calls = []; const requests = []
server.on('connection', socket => socket.on('message', raw => {
  const frame = JSON.parse(raw.toString()); requests.push(frame.method)
  const data = frame.method === 'qq.plugin.hello' ? { protocolVersion: 1, backendVersion: 'synthetic', selfId: '123', authenticated: true, capabilities: frame.params.capabilities }
    : frame.method === 'qq.identity.bind' ? { bound: true, selfId: frame.params.selfId, sourceType: 'napcat-action', validation: 'accepted' }
    : frame.method === 'qq.request.recover' ? { events: [] }
      : frame.method === 'qq.event.submit' ? { eventId: frame.params.eventId, accepted: true } : { eventId: frame.params.eventId, recorded: true }
  socket.send(JSON.stringify({ kind: 'response', requestId: frame.id, success: true, data }))
  if (frame.method === 'qq.event.submit') socket.send(JSON.stringify({ kind: 'notification', type: 'qq.message.ack', data: { selfId: '123', conversationType: 'private', targetId: '789', requestId: 'synthetic-r', eventId: 'synthetic-ack', seq: 1, text: '收到' } }))
}))
const configPath = join(dir, 'config.json')
await writeFile(configPath, JSON.stringify({ backendUrl: `ws://127.0.0.1:${server.address().port}`, backendToken: 'synthetic-token-123' }))
const ctx = { configPath, dataPath: dir, adapterName: 'synthetic', pluginManager: { config: {} }, logger: { warn() {}, info() {} }, actions: { async call(...args) { calls.push(args); return args[0] === 'get_login_info' ? { user_id: '123' } : args[0] === 'get_status' ? { online: true, good: true } : { message_id: '1' } } } }
const wait = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)) }; throw new Error('synthetic verification timeout') }
try {
  plugin.plugin_init(ctx)
  await wait(() => plugin.plugin_status(ctx).ready)
  await plugin.plugin_onmessage(ctx, { post_type: 'message', message_type: 'private', self_id: 123, user_id: 789, message_id: 1, time: 10, sender: { user_id: 789 }, message: [{ type: 'text', data: { text: 'synthetic' } }] })
  await wait(() => requests.includes('qq.delivery.result'))
  assert.equal(calls.at(-1)[0], 'send_msg'); assert.equal(calls.at(-1)[1].message[0].data.text, '收到'); assert.equal(calls.at(-1).length, 4)
  plugin.plugin_cleanup(ctx)
  assert.equal(plugin.plugin_status(ctx).ready, false)
  console.log('PASS: ZIP metadata, dynamic import, 3 hooks, synthetic private input/ACK, four-argument send and cleanup. Not real NapCat/backend/QQ validation.')
} finally {
  plugin.plugin_cleanup(ctx)
  for (const socket of server.clients) socket.terminate()
  await new Promise(resolve => server.close(resolve))
}
