import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Adapter, normalize, type PluginContext } from '../src/adapter.js'
import { QQCapabilities as capabilities } from '@chery/protocol'
import type { BackendChannel } from '../src/wire.js'
import { serviceFixture } from './serviceFixture.js'

class Mock implements BackendChannel {
  connected = true
  listener?: (f: any) => void
  ready?: () => void
  disconnect?: () => void
  request = vi.fn(async (method: string, params: any): Promise<any> => {
    const data = method === 'qq.plugin.hello' ? { protocolVersion: 1, backendVersion: 'mock', selfId: '123', authenticated: true, capabilities }
      : method === 'qq.identity.bind' ? { bound: true, selfId: params.selfId, sourceType: 'napcat-action', validation: 'accepted' }
      : method === 'qq.image.scope.get' ? {schemaVersion:1,backendEpoch:'epoch',connectionGeneration:'generation',sessionId:'session',selfId:'123',appliedRevision:0,scopeDigest:'0'.repeat(64),enabled:true,allowedTargets:[{conversationType:'group',targetId:'456'},{conversationType:'private',targetId:'789'},{conversationType:'private',targetId:'999'}],targets:[],limits:{}}
      : method === 'qq.request.recover' ? { events: [], service: serviceFixture() }
      : method === 'qq.event.submit' ? { eventId: params.eventId, accepted: true } : { eventId: params.eventId, recorded: true }
    return { success: true, data }
  })
  async connect() {}
  close = vi.fn(() => { this.listener = undefined })
  onMessage(f: (v: any) => void) { this.listener = f; this.ready = () => f({ kind: 'notification', type: 'qq.connection.state', data: { state: 'connected' } }); this.disconnect = () => f({ kind: 'notification', type: 'qq.connection.state', data: { state: 'disconnected' } }); return () => { this.listener = undefined } }
  emit(type: string, seq: number, extra: any = {}) { this.listener?.({ kind: 'notification', type, data: { selfId: '123', conversationType: 'group', targetId: '456', requestId: 'r1', eventId: `e${seq}`, seq, ...extra } }) }
}
const live: Adapter[] = []
const dirs: string[] = []
afterEach(() => { for (const a of live.splice(0)) a.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.useRealTimers() })
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
function fixture(path?: string) {
  const dir = path ?? mkdtempSync('/tmp/opencode/native-qq-')
  if (!path) dirs.push(dir)
  const ctx: PluginContext = { dataPath: dir, configPath: join(dir, 'config.json'), adapterName: 'test', pluginManager: { config: { test: true } }, logger: { info: vi.fn(), warn: vi.fn() }, actions: { call: vi.fn(async (name: string) => name === 'get_login_info' ? { user_id: '123' } : name === 'get_status' ? { online: true, good: true } : { message_id: '789' }) } }
  const wire = new Mock(); const adapter = new Adapter(ctx, wire); live.push(adapter)
  return { dir, ctx, wire, adapter }
}
const input = (extra = {}) => ({ post_type: 'message', self_id: 123, user_id: 789, group_id: 456, message_type: 'group', message_id: -42, time: 10, sender: { user_id: 789, nickname: 'synthetic' }, message: [{ type: 'text', data: { text: 'hello' } }, { type: 'at', data: { qq: '123' } }], ...extra })

describe('native adapter (mock consumers only, no backend business proof)', () => {
  it('replies closed only to authorized targets after explicit state, not ordinary disconnect', async () => {
    const { adapter, wire, ctx } = fixture()
    await adapter.start(); await settle()
    wire.disconnect?.(); await settle()
    expect((ctx.actions.call as any).mock.calls.some(([name, params]: any[]) => name === 'send_msg' && params.message?.[0]?.data?.text === '服务已关闭')).toBe(false)
    await adapter.start(); await settle()
    wire.listener?.({ kind: 'notification', type: 'qq.service.state', data: serviceFixture({ phase: 'closing', operationId: 'stop', version: 2 }) })
    await settle()
    const submitted = wire.request.mock.calls.filter(([method]) => method === 'qq.event.submit').length
    await adapter.receive(input())
    await adapter.receive(input({ group_id: 999, message_id: -43 }))
    expect(wire.request.mock.calls.filter(([method]) => method === 'qq.event.submit')).toHaveLength(submitted)
    expect((ctx.actions.call as any).mock.calls.filter(([name, params]: any[]) => name === 'send_msg' && params.message?.[0]?.data?.text === '服务已关闭')).toHaveLength(1)
  })
  it('fences queued sends at shutdown and rejects stale or unauthenticated instance changes', async () => {
    const { adapter, wire, ctx } = fixture()
    await adapter.start(); await settle()
    let finish!: (result: unknown) => void
    const original = ctx.actions.call
    ctx.actions.call = vi.fn((name, params, a, c) => name === 'send_msg' && (params as any).message?.[0]?.data?.text === 'slow'
      ? new Promise(resolve => { finish = resolve }) : original(name, params, a, c))
    wire.emit('qq.reply.part', 1, { text: 'slow', partIndex: 1, totalParts: 1 }); await settle()
    wire.emit('qq.reply.part', 2, { text: 'must not send', partIndex: 1, totalParts: 1 })
    wire.listener?.({ kind: 'notification', type: 'qq.service.state', data: serviceFixture({ phase: 'closing', operationId: 'stop', version: 3 }) })
    wire.listener?.({ kind: 'notification', type: 'qq.service.state', data: serviceFixture({ version: 2 }) })
    wire.listener?.({ kind: 'notification', type: 'qq.service.state', data: serviceFixture({ backendInstanceId: 'untrusted', version: 100 }) })
    await settle(); finish({ message_id: '900' }); await settle()
    expect((adapter as any).journal.service.phase).toBe('closing')
    expect((adapter as any).journal.service.backendInstanceId).toBe('backend-fixture')
    expect((ctx.actions.call as any).mock.calls.some(([name, params]: any[]) => name === 'send_msg' && params.message?.[0]?.data?.text === 'must not send')).toBe(false)
    expect((adapter as any).journal.outputs.e1.status).toBe('unknown')
  })
  it('accepts a late native result after a month and lets progress pass a slow content send', async () => {
    vi.useFakeTimers();const {adapter,wire,ctx}=fixture();await adapter.start();await settle()
    const original=ctx.actions.call;let resolve!: (value:any)=>void
    ctx.actions.call=vi.fn((name,params,a,c)=> name==='send_msg' && (params as any).message?.[0]?.data?.text==='slow' ? new Promise(r=>{resolve=r}) : original(name,params,a,c))
    wire.emit('qq.reply.part',1,{text:'slow',partIndex:1,totalParts:1});await settle()
    await vi.advanceTimersByTimeAsync(32*86400000);await settle()
    expect(wire.request.mock.calls.filter(c=>c[0]==='qq.delivery.result')).toHaveLength(0)
    wire.emit('qq.waiting',2,{text:'still running'});await settle()
    expect(wire.request.mock.calls.some(c=>c[0]==='qq.delivery.result' && c[1].eventId==='e2' && c[1].status==='sent')).toBe(true)
    resolve({message_id:'900'});await settle()
    expect(wire.request.mock.calls.some(c=>c[0]==='qq.delivery.result' && c[1].eventId==='e1' && c[1].status==='sent')).toBe(true)
  })
  it('bounds confirmed progress history and does not replay compacted progress', async () => {
    const {adapter,wire,ctx,dir}=fixture();await adapter.start();await settle()
    for(let seq=1;seq<=270;seq++){wire.emit('qq.waiting',seq,{text:'working'});await settle()}
    const journal=JSON.parse(readFileSync(join(dir,'delivery-journal.json'),'utf8'))
    expect(Object.keys(journal.outputs).length).toBeLessThanOrEqual(256)
    const before=(ctx.actions.call as any).mock.calls.length
    wire.emit('qq.waiting',1,{text:'working'});await settle()
    expect((ctx.actions.call as any).mock.calls.length).toBe(before)
  })
  it('persists failed reactions, continues replies, and retries the same reaction after reload', async () => {
    const f=fixture();await f.adapter.start();await settle()
    const original=f.ctx.actions.call
    f.ctx.actions.call=vi.fn(async(name,params,adapterName,config)=>name==='set_msg_emoji_like'?{retcode:1}:original(name,params,adapterName,config))
    f.wire.emit('qq.message.ack',1,{messageId:'100',emojiId:'178'});await settle()
    f.wire.emit('qq.reply.part',2,{text:'still replies',partIndex:1,totalParts:1});await settle()
    const journal=JSON.parse(readFileSync(join(f.dir,'delivery-journal.json'),'utf8'))
    expect(journal.outputs.e1.status).toBe('failed');expect(journal.outputs.e1.retryEvent).toBeDefined()
    expect(journal.outputs.e2.status).toBe('sent');expect(f.adapter.status().blockedTargets).toBe(0)
    f.adapter.close();const next=fixture(f.dir);await next.adapter.start();await settle()
    ;(next.adapter as any).journal.outputs.e1.retryAt=0
    await (next.adapter as any).retryAcknowledgements();await settle()
    const restored=JSON.parse(readFileSync(join(f.dir,'delivery-journal.json'),'utf8'))
    expect(restored.outputs.e1.status).toBe('sent');expect(restored.outputs.e1.retryEvent).toBeUndefined()
    expect(next.ctx.actions.call).toHaveBeenCalledWith('set_msg_emoji_like',{message_id:'100',emoji_id:'178',set:true},'test',next.ctx.pluginManager.config)
    expect((next.ctx.actions.call as any).mock.calls.filter((c:any)=>c[0]==='send_msg')).toHaveLength(0)
  })
  it('allows a new request after a recorded unknown without replaying the old event', async () => {
    const {adapter,wire}=fixture();await adapter.start();await settle()
    const a=adapter as any,key='123:group:456'
    a.journal.seq[key]=1;a.journal.blocked[key]=true
    a.journal.outputs.old={status:'unknown',confirmation:{selfId:'123',conversationType:'group',targetId:'456',seq:1,status:'unknown',requestId:'old'}}
    wire.emit('qq.reply.part',2,{requestId:'new',text:'test',partIndex:1,totalParts:1})
    await settle();await settle()
    expect(a.journal.outputs.old.status).toBe('unknown')
    expect(a.journal.outputs.e2.status).toBe('sent')
  })
  it('submits a bare bot mention but ignores empty messages without a mention', async () => {
    const {adapter,wire}=fixture();await adapter.start();await settle()
    await adapter.receive(input({message:[{type:'at',data:{qq:'123'}}]}))
    await adapter.receive(input({message_id:51,message:[{type:'text',data:{text:' '}}]}))
    expect(wire.request.mock.calls.filter(c=>c[0]==='qq.event.submit')).toHaveLength(1)
    expect(wire.request.mock.calls.find(c=>c[0]==='qq.event.submit')?.[1]).toMatchObject({content:'',mentionedBot:true})
  })
  it('normalizes group/private and rejects forged identity and private group fields', () => {
    expect(normalize(input(), '123')).toMatchObject({ selfId: '123', targetId: '456', senderId: '789', messageId: '-42', content: 'hello', mentionedBot: true, occurredAt: 10 })
    const privateEvent = input({ group_id: undefined, message_type: 'private' })
    expect(normalize(privateEvent, '123')).toMatchObject({ conversationType: 'private', targetId: '789' })
    expect(normalize(privateEvent, '123')).not.toHaveProperty('groupId')
    for (const e of [input({ self_id: 124 }), input({ sender: { user_id: 2 } }), input({ message_type: 'private' }), input({ user_id: Number.MAX_SAFE_INTEGER + 1 }), input({ message: 'raw' })]) expect(normalize(e, '123')).toBeUndefined()
  })
  it('discovers identity with four arguments and submits once without local allowlists or @ filtering', async () => {
    const { adapter, ctx, wire } = fixture(); await adapter.start(); await settle()
    expect(adapter.status().ready).toBe(true)
    expect(adapter.status().identity).toEqual({ state: 'discovered', sourceType: 'napcat-action', validation: 'accepted', diagnostic: 'none' })
    expect(ctx.actions.call).toHaveBeenCalledWith('get_login_info', {}, 'test', ctx.pluginManager.config)
    await adapter.receive(input()); await adapter.receive(input())
    await adapter.receive(input({ group_id: undefined, message_type: 'private', message_id: 50, message: [{ type: 'text', data: { text: 'no mention' } }] }))
    expect(wire.request.mock.calls.filter(c => c[0] === 'qq.event.submit')).toHaveLength(2)
    expect(ctx.actions.call).toHaveBeenCalledTimes(2)
  })
  it('returns redacted structured diagnostics when identity discovery fails', async () => {
    for (const [login, status, diagnostic] of [
      [{}, { online: true, good: true }, 'invalid-self-id'],
      [{ user_id: '123' }, { online: false, good: true }, 'offline'],
    ] as const) {
      const { adapter, ctx } = fixture()
      ;(ctx.actions.call as any).mockImplementation(async (name: string) => name === 'get_login_info' ? login : status)
      await adapter.start(); await settle()
      expect(adapter.status()).toMatchObject({ state: 'identity-unavailable', ready: false, identity: { state: 'unavailable', sourceType: 'napcat-action', validation: 'rejected', diagnostic } })
      expect(ctx.logger.warn).toHaveBeenCalledWith('cheryNyxus: identity-unavailable')
    }
    const { adapter } = fixture()
    ;(adapter as any).ctx.actions.call = vi.fn().mockRejectedValue(new Error('secret credential payload'))
    await adapter.start(); await settle()
    expect(adapter.status().identity).toEqual({ state: 'unavailable', sourceType: 'none', validation: 'rejected', diagnostic: 'action-error' })
    expect(JSON.stringify(adapter.status())).not.toMatch(/secret|credential|payload/i)
  })
  it('fails closed for missing handshake or capabilities and ignores stale handshake after disconnect', async () => {
    for (const unsupported of [new Error('METHOD_NOT_FOUND'), { protocolVersion: 1, capabilities: [] }]) {
      const { adapter, wire, ctx } = fixture()
      wire.request.mockImplementation(async () => { if (unsupported instanceof Error) throw unsupported; return unsupported })
      await adapter.start(); await settle(); await adapter.receive(input()); wire.emit('qq.message.ack', 1, { text: '收到' }); await settle()
      expect(adapter.status().state).toBe('backend-unsupported'); expect(ctx.actions.call).toHaveBeenCalledTimes(2)
      expect(wire.request).toHaveBeenCalledTimes(1)
    }
    const { adapter, wire } = fixture(); let resolve!: (v: any) => void
    wire.request.mockImplementation(() => new Promise(r => { resolve = r }))
    const starting = adapter.start(); await settle(); wire.disconnect?.(); resolve({ success: true, data: { protocolVersion: 1, backendVersion: 'mock', selfId: '123', authenticated: true, capabilities } }); await starting; await settle()
    expect(adapter.status().ready).toBe(false)
  })
  it('sends exact ACK, one icon per event, waiting, unicode parts and fixed failure in order', async () => {
    const { adapter, wire, ctx } = fixture(); await adapter.start(); await settle()
    wire.emit('qq.message.ack', 1, { text: '收到', messageId: '1', emojiId: '268' }); wire.emit('qq.tool.icon', 2, { icon: '🔎' }); wire.emit('qq.tool.icon', 2, { icon: '🔎' }); wire.emit('qq.tool.icon', 3, { icon: '[unsafe]' })
    wire.emit('qq.waiting', 4, { text: '合成等待' }); wire.emit('qq.reply.part', 5, { text: '😀'.repeat(4001), partIndex: 1, totalParts: 1 }); wire.emit('qq.request.failed', 6, { text: '上游图片审核拒绝，追踪码：1234abcd' })
    for (let i = 0; i < 8; i++) await settle()
    const calls = (ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'send_msg')
    const texts = calls.map((c: any) => c[1].message[0].data.text)
    expect(texts.filter((text: string) => ['🔎','🔧','合成等待'].includes(text))).toEqual(['🔎','🔧','合成等待'])
    expect(texts.filter((text: string) => !['🔎','🔧','合成等待'].includes(text))).toEqual(['😀'.repeat(4000),'😀','上游图片审核拒绝，追踪码：1234abcd'])
    expect((ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'set_msg_emoji_like')).toHaveLength(1)
    expect(calls.every((c: any) => c[1].group_id === '456' && !('user_id' in c[1]) && c[2] === ctx.adapterName && c[3] === ctx.pluginManager.config)).toBe(true)
    const reports = wire.request.mock.calls.filter(c => c[0] === 'qq.delivery.result').map(c => c[1] as any)
    const uniqueReports = [...new Map(reports.map(report => [report.eventId, report])).values()]
    expect(uniqueReports.filter(r => r.activity)).toHaveLength(4)
    expect(uniqueReports.find(r => r.eventId === 'e5').terminal).toBe(true)
    expect(readFileSync(join(ctx.dataPath, 'delivery-journal.json'), 'utf8')).not.toContain('合成等待')
  })
  it('continues a reconciled durable sequence without replaying historical unknown ACKs after reload', async () => {
    const initial = fixture(); initial.adapter.close()
    writeFileSync(join(initial.dir, 'delivery-journal.json'), JSON.stringify({ events: {}, outputs: { oldAck: { status: 'unknown' } }, seq: { '123:group:456': 42 }, blocked: {} }))
    const f = fixture(initial.dir)
    await f.adapter.start(); await settle()
    f.wire.emit('qq.message.ack', 43, { messageId: '100', emojiId: '271' }); await settle()
    expect(f.ctx.actions.call).toHaveBeenCalledWith('set_msg_emoji_like', { message_id: '100', emoji_id: '271', set: true }, 'test', f.ctx.pluginManager.config)
    expect(f.wire.request.mock.calls.filter(c => c[0] === 'qq.delivery.result').map(c => c[1])).toContainEqual(expect.objectContaining({ seq: 43, status: 'sent', activity: true }))
    f.adapter.close()
    const next = fixture(f.dir); await next.adapter.start(); await settle()
    next.wire.emit('qq.message.ack', 43, { messageId: '100', emojiId: '271' }); await settle()
    expect(next.ctx.actions.call).toHaveBeenCalledTimes(2)
    next.wire.emit('qq.message.ack', 44, { messageId: '101', emojiId: '272' }); await settle()
    expect(next.ctx.actions.call).toHaveBeenCalledWith('set_msg_emoji_like', { message_id: '101', emoji_id: '272', set: true }, 'test', next.ctx.pluginManager.config)
    const journal = JSON.parse(readFileSync(join(f.dir, 'delivery-journal.json'), 'utf8'))
    expect(journal.seq['123:group:456']).toBe(44)
    expect(journal.outputs.oldAck).toEqual({ status: 'unknown' })
    expect(next.adapter.status().blockedTargets).toBe(0)
  })
  it('rejects malformed ACK without blocking later valid traffic', async () => {
    const { adapter, wire, ctx } = fixture(); await adapter.start(); await settle()
    wire.emit('qq.message.ack', 1, { text: '收到！' }); await settle(); wire.emit('qq.tool.icon', 2, { icon: '🔎' })
    wire.emit('qq.message.ack', 1, { conversationType: 'private', targetId: '789', eventId: 'private1', text: '收到' }); await settle()
    expect((ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'send_msg')).toHaveLength(2)
    expect((ctx.actions.call as any).mock.calls.at(-1)[1]).toHaveProperty('user_id', '789')
  })
  it('reconnect and reload replay never resends; lost result is re-reported before recovery', async () => {
    const { adapter, wire, ctx, dir } = fixture(); await adapter.start(); await settle()
    const original = wire.request.getMockImplementation()!
    let lost = true
    wire.request.mockImplementation(async (m, p) => { if (m === 'qq.delivery.result' && lost) throw new Error(); return original(m, p) })
    wire.emit('qq.message.ack', 1, { text: '收到', conversationType: 'private', targetId: '789' }); await settle()
    expect(wire.request.mock.calls.filter(c => c[0] === 'qq.delivery.result')).toHaveLength(3)
    lost = false; wire.disconnect?.(); wire.ready?.(); await settle()
    wire.emit('qq.message.ack', 1, { text: '收到' }); await settle()
    expect((ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'send_msg')).toHaveLength(1)
    expect(adapter.status().blockedTargets).toBe(0)
    adapter.close(); const next = fixture(dir); await next.adapter.start(); await settle(); next.wire.emit('qq.message.ack', 1, { text: '收到' }); await settle()
    expect(next.ctx.actions.call).toHaveBeenCalledTimes(2)
  })
  it('unknown sends are not replayed and later events proceed after reconnect', async () => {
    vi.useFakeTimers(); const { adapter, wire, ctx } = fixture(); await adapter.start(); await settle()
    const original = ctx.actions.call
    ctx.actions.call = vi.fn((name, params, adapterName, config) => name === 'send_msg' && (params as any).user_id === '789' ? new Promise(() => {}) : original(name, params, adapterName, config))
    wire.emit('qq.message.ack', 1, { text: '收到', conversationType: 'private', targetId: '789' }); await settle(); await vi.advanceTimersByTimeAsync(60000); await settle()
    expect(wire.request.mock.calls.filter(c => c[0] === 'qq.delivery.result')).toHaveLength(0)
    wire.disconnect?.(); wire.ready?.(); await settle()
    wire.emit('qq.tool.icon', 2, { icon: '🔧', conversationType: 'private', targetId: '789' })
    wire.emit('qq.tool.icon', 1, { icon: '🔧', eventId: 'other-target' }); await settle()
    expect((ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'send_msg' && c[1].user_id === '789')).toHaveLength(2); expect(adapter.status().blockedTargets).toBe(0)
    expect((ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'send_msg' && c[1].group_id === '456')).toHaveLength(1)
  })
  it('unload cancels action deadlines, drops queued sends and prevents late report', async () => {
    vi.useFakeTimers(); const { adapter, wire, ctx } = fixture(); await adapter.start(); await settle()
    let resolve!: (v: any) => void
    ctx.actions.call = vi.fn(() => new Promise(r => { resolve = r }))
    wire.emit('qq.message.ack', 1, { text: '收到', conversationType: 'private', targetId: '789' }); wire.emit('qq.reply.part', 2, { text: 'queued', partIndex: 1, totalParts: 1, conversationType: 'private', targetId: '789' }); await settle()
    adapter.close(); resolve({ message_id: 1 }); await settle()
    expect(wire.close).toHaveBeenCalled(); expect(ctx.actions.call).toHaveBeenCalledTimes(1)
    expect(wire.request.mock.calls.filter(c => c[0] === 'qq.delivery.result')).toHaveLength(0); expect(vi.getTimerCount()).toBe(0)
  })
  it('retains unknown inputs across reload and refuses corrupt journal', async () => {
    const f = fixture(); await f.adapter.start(); await settle()
    const original = f.wire.request.getMockImplementation()!
    f.wire.request.mockImplementation(async (m, p) => { if (m === 'qq.event.submit') throw new Error(); return original(m, p) })
    await f.adapter.receive(input()); f.adapter.close()
    const next = fixture(f.dir); await next.adapter.start(); await settle(); await next.adapter.receive(input())
    expect(next.wire.request.mock.calls.filter(c => c[0] === 'qq.event.submit')).toHaveLength(0)
    writeFileSync(join(f.dir, 'delivery-journal.json'), 'invalid')
    const corrupt = fixture(f.dir); await corrupt.adapter.start(); expect(corrupt.adapter.status().state).toBe('journal-invalid'); expect(corrupt.ctx.actions.call).not.toHaveBeenCalled()
  })
  it('does not run local 30-second business timers', async () => {
    vi.useFakeTimers(); const { adapter, wire, ctx } = fixture(); await adapter.start(); await settle()
    wire.emit('qq.tool.icon', 1, { icon: '🔧' }); await settle(); await vi.advanceTimersByTimeAsync(90000)
    expect((ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'send_msg')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1) // durable acknowledgement maintenance only
  })

  it('reconnect reports known delivery before recovery and never trusts notifications before authentication', async () => {
    const { adapter, wire, ctx } = fixture()
    await adapter.start()
    wire.emit('qq.reply.part', 1, { text: 'answer', partIndex: 1, totalParts: 1 })
    await settle()
    const before = wire.request.mock.calls.length
    wire.disconnect?.()
    wire.emit('qq.reply.part', 2, { text: 'untrusted', partIndex: 1, totalParts: 1 })
    await settle()
    expect((ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'send_msg')).toHaveLength(1)
    wire.ready?.(); await settle()
    const reconnect = wire.request.mock.calls.slice(before).map(([method]) => method)
    expect(reconnect).toEqual(['qq.plugin.hello', 'qq.identity.bind', 'qq.image.scope.get', 'qq.image.scope.ack', 'qq.request.recover']) // confirmed receipts already durably reported
    expect(adapter.status().ready).toBe(true)
  })

  it('same output identity with altered content neither resends nor reports the old receipt for new content', async () => {
    const { adapter, wire, ctx } = fixture()
    await adapter.start()
    wire.emit('qq.reply.part', 1, { text: 'original', partIndex: 1, totalParts: 1 })
    await settle()
    wire.emit('qq.reply.part', 1, { text: 'changed', partIndex: 1, totalParts: 1 })
    await settle()
    expect((ctx.actions.call as any).mock.calls.filter((c: any) => c[0] === 'send_msg')).toHaveLength(1)
    expect(wire.request.mock.calls.filter(([method]) => method === 'qq.delivery.result')).toHaveLength(1)
  })

  it('closing during identity discovery prevents late handshake and does not expose Action errors', async () => {
    const { adapter, wire, ctx } = fixture()
    let complete!: (value: unknown) => void
    ctx.actions.call = vi.fn(() => new Promise(resolve => { complete = resolve }))
    const starting = adapter.start()
    await settle(); adapter.close(); complete({ user_id: '123' })
    await starting
    expect(adapter.status().state).toBe('stopped')
    expect(wire.request).not.toHaveBeenCalled()
  })

  it('classifies explicit native video failure as failed and unconfirmed send as unknown', async () => {
    const { adapter, wire, ctx } = fixture()
    await adapter.start(); await settle()
    ctx.actions.call = vi.fn().mockRejectedValueOnce(new Error('Action send_msg failed: Native message send failed: correlationId=1'))
      .mockRejectedValueOnce(new Error('Action send_msg failed: Native message unconfirmed: SUCCESS_NOSEQ correlationId=2'))
    wire.emit('qq.reply.video', 1, { mediaFile: '100.mp4' }); await settle()
    wire.emit('qq.reply.video', 2, { mediaFile: '200.mp4' }); await settle()
    const results = wire.request.mock.calls.filter(([m]) => m === 'qq.delivery.result').map(([, p]) => p)
    expect(results).toContainEqual(expect.objectContaining({ eventId: 'e1', status: 'failed', terminal: true }))
    expect(results).toContainEqual(expect.objectContaining({ eventId: 'e2', status: 'unknown', terminal: true }))
  })
})
