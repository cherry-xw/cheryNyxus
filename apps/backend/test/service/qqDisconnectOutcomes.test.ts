import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import { Adapter } from '../../../../platform/napcat-plugin/src/adapter.js'
import { BackendWire } from '../../../../platform/napcat-plugin/src/wire.js'
import { QQPlugin } from '../../../../plugins/qq/src/index.js'
import { QQDefaultConfig } from '../../../../packages/protocol/src/qq.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function root() { const dir = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'qq-disconnect-outcomes-')); roots.push(dir); return dir }
function frame(type = 'qq.reply.part', extra = {}) {
  return { kind: 'notification', type, data: { selfId: '123', conversationType: 'group', targetId: '456', requestId: 'r', eventId: type, seq: 1, text: 'reply', partIndex: 1, totalParts: 1, ...extra } }
}
function adapterFixture(dir = root()) {
  const call = vi.fn(async () => ({ message_id: 42 }))
  const request = vi.fn(async () => ({ success: true }))
  const adapter: any = new Adapter({ dataPath: dir, actions: { call }, logger: {}, pluginManager: { config: {} } } as any, { request } as any)
  adapter.selfId = '123'; adapter.authenticated = true
  return { adapter, call, request, dir }
}
function pluginFixture() {
  let close!: (id: string) => void
  const registrations: any[] = []
  const register = () => () => {}
  const context: any = { dataDir: root(), runtimeOptions: {}, id: 'cherynyxus-qq-module', version: 'test',
    ingress: { register }, identity: { registerChannel: register }, hooks: { register }, tools: { register },
    core: { onEvent: register }, connections: { onClose: (fn: any) => { close = fn; return () => {} }, isOpen: () => true, send: vi.fn(() => true) },
    rpc: { register: (input: any) => { registrations.push(input); return () => {} } }, log: vi.fn(),
  }
  const p: any = new QQPlugin(context)
  p.snapshot = { revision: 1, config: structuredClone(QQDefaultConfig) }
  p.start(); clearInterval(p.timer)
  p.paused = false
  p.connection = 'old'; p.verifiedConnection = 'old'; p.recovered = true
  p.reminderBusy = true; p.nextAppNotificationPoll = Infinity
  const job: any = { requestId: 'r', target: 'group:456', state: 'running', acceptedAt: Date.now(), input: { selfId: '123', conversationType: 'group', targetId: '456' }, snapshot: p.snapshot, toolIds: [], reply: '' }
  p.state.jobs.push(job)
  return { p, job, close, registrations }
}

describe('actual disconnect and independent delivery outcomes', () => {
  it('rejects every old socket RPC on real WebSocket close without a deadline', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const wire = new BackendWire(`ws://127.0.0.1:${address.port}`, 'synthetic-token')
    try {
      await wire.connect()
      const socket = [...server.clients][0]
      const received = once(socket, 'message')
      const result = wire.request('qq.delivery.result', {}).catch(error => error)
      await received
      socket.terminate()
      expect(await result).toMatchObject({ code: 'DISCONNECTED' })
      expect((wire as any).pending.size).toBe(0)
    } finally { wire.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it.each(['qq.reply.part', 'qq.message.ack'])('settles an interrupted %s locally and only reports unknown after reconnect', async type => {
    const f = adapterFixture()
    let resolve!: (value: any) => void
    f.call.mockImplementationOnce(() => new Promise(r => { resolve = r }))
    const event = frame(type, type === 'qq.message.ack' ? { messageId: '11', emojiId: '4' } : {})
    const work = f.adapter.enqueueNotification(event)
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledTimes(1))
    expect(f.adapter.journal.outputs[type].confirmation.status).toBe('unknown')
    await f.adapter.retryAcknowledgements()
    expect(f.request).not.toHaveBeenCalled()
    await f.adapter.notification({ type: 'qq.connection.state', data: { state: 'disconnected' } })
    await work
    expect(f.adapter.queues.size).toBe(0)
    f.adapter.authenticated = true
    await f.adapter.retryAcknowledgements()
    expect(f.request).toHaveBeenCalledWith('qq.delivery.result', expect.objectContaining({ eventId: type, status: 'unknown' }))
    await f.adapter.enqueueNotification(event)
    resolve({ message_id: 999 })
    await Promise.resolve()
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.adapter.journal.outputs[type].status).toBe('unknown')
    const restored = adapterFixture(f.dir)
    await restored.adapter.enqueueNotification(event)
    expect(restored.call).not.toHaveBeenCalled()
    expect(restored.request).toHaveBeenCalledWith('qq.delivery.result', expect.objectContaining({ status: 'unknown' }))
  })

  it.each(['sent', 'failed'])('keeps the known %s receipt when its reporting connection closes', async status => {
    const f = adapterFixture()
    if (status === 'failed') f.call.mockResolvedValue({ retcode: 1400 } as any)
    f.request.mockImplementationOnce(async () => {
      await f.adapter.notification({ type: 'qq.connection.state', data: { state: 'disconnected' } })
      throw new Error('disconnected')
    })
    const event = frame()
    await f.adapter.enqueueNotification(event)
    expect(f.adapter.journal.outputs[event.type].status).toBe(status)
    f.adapter.authenticated = true
    await f.adapter.enqueueNotification(event)
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(f.request).toHaveBeenLastCalledWith('qq.delivery.result', expect.objectContaining({ status }))
  })

  it('does not replay an unknown ACK including a legacy persisted retryEvent', async () => {
    const f = adapterFixture()
    f.call.mockRejectedValue(new Error('native result unavailable'))
    const event = frame('qq.message.ack', { messageId: '11', emojiId: '4' })
    await f.adapter.enqueueNotification(event)
    const output = f.adapter.journal.outputs[event.type]
    output.retryEvent = event; output.retryAt = 0
    await f.adapter.retryAcknowledgements()
    await f.adapter.enqueueNotification(event)
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(output.status).toBe('unknown')
    expect(f.request.mock.calls.every((args: any) => args[1].status === 'unknown')).toBe(true)
  })

  it('retains safe retries only for explicitly rejected group ACKs', async () => {
    const f = adapterFixture()
    f.call.mockResolvedValueOnce({ result: false } as any)
    const event = frame('qq.message.ack', { messageId: '11', emojiId: '4' })
    await f.adapter.enqueueNotification(event)
    expect(f.adapter.journal.outputs[event.type]).toMatchObject({ status: 'failed', retryEvent: event })
    f.adapter.journal.outputs[event.type].retryAt = 0
    await f.adapter.retryAcknowledgements()
    expect(f.call).toHaveBeenCalledTimes(2)
    expect(f.adapter.journal.outputs[event.type].status).toBe('sent')
  })

  it('unblocks deferred final preparation after actual disconnect without stopping a running computation', async () => {
    const { p, job, close } = pluginFixture()
    job.reply = 'public text'; job.snapshot.config.maxMessageChars = 1000
    p.output(job, 'qq.waiting', { text: job.reply })
    p.state.outbox[0].status = 'inflight'; p.state.outbox[0].activityReplyThrough = job.reply.length
    close('old')
    expect(job.state).toBe('running')
    expect(p.state.outbox[0].status).toBe('unknown')
    await p.finishWithFiles(job, 'completed')
    expect(job.filePreparationPending).toBeFalsy()
    expect(p.state.outbox.some((o: any) => o.frame.type === 'qq.reply.part')).toBe(true)
    p.stopped = true
  })

  it('releases both old backend lanes and ACK, preserves known records, and advances pending content', async () => {
    const { p, job, close, registrations } = pluginFixture()
    job.state = 'sending'; job.outcome = 'completed'
    for (const type of ['qq.reply.part', 'qq.waiting', 'qq.message.ack']) { p.output(job, type, { text: 'old', partIndex: 1, totalParts: 1 }); p.state.outbox.at(-1).status = 'inflight' }
    p.output(job, 'qq.reply.action', {}); p.state.outbox.at(-1).status = 'sent'
    p.output(job, 'qq.reply.action', {}); p.state.outbox.at(-1).status = 'failed'
    const known = p.state.outbox.slice(-2).map((o: any) => structuredClone(o))
    close('unrelated'); expect(p.state.outbox[0].status).toBe('inflight')
    close('old')
    expect(p.state.outbox.slice(0, 3).map((o: any) => o.status)).toEqual(['unknown', 'unknown', 'unknown'])
    expect(p.state.outbox.slice(3, 5)).toEqual(known)
    expect(job).toMatchObject({ state: 'completed', outcome: 'completed' })
    p.connection = 'new'; p.verifiedConnection = 'new'; p.assertChannel = vi.fn(); p.assertBusiness = vi.fn()
    const recovered = await registrations.find(r => r.method === 'qq.request.recover').handler({ connectionId: 'new' }, { selfId: '123' })
    expect(recovered.events.some((e: any) => e.type === 'qq.message.ack')).toBe(false)
    p.output(job, 'qq.reply.part', { text: 'new', partIndex: 1, totalParts: 1 })
    // The earlier disconnect notice takes the first scheduling turn; the
    // independent content lane must advance on the following turn.
    p.tick()
    p.tick()
    expect(p.state.outbox.at(-1).status).toBe('inflight')
    expect(p.context.connections.send).toHaveBeenCalledWith('new', expect.objectContaining({ type: 'qq.reply.part', data: expect.objectContaining({ text: 'new' }) }))
    p.stopped = true
  })

  it.each(['unknown', 'failed'])('does not turn completed computation into failed for an earlier %s complete action', async status => {
    const { p, job } = pluginFixture()
    job.replyActionComplete = true
    p.output(job, 'qq.reply.action', { actionKind: 'voice', completeReply: true }); p.state.outbox.at(-1).status = status
    await p.finishWithFiles(job, 'completed')
    expect(job).toMatchObject({ state: 'completed', outcome: 'completed', reason: status === 'unknown' ? 'DELIVERY_UNKNOWN' : 'DELIVERY_FAILED' })
    expect(p.state.outbox[0].status).toBe(status)
    p.stopped = true
  })

  it('keeps completed computation when startup settles an interrupted sending record', () => {
    const { p, job } = pluginFixture()
    job.state = 'sending'; job.outcome = 'completed'
    p.output(job, 'qq.reply.part', { text: 'done', partIndex: 1, totalParts: 1 })
    p.state.outbox[0].status = 'inflight'
    p.start(); clearInterval(p.timer)
    expect(job).toMatchObject({ state: 'completed', outcome: 'completed', reason: 'DELIVERY_UNKNOWN' })
    expect(p.state.outbox[0].status).toBe('unknown')
    expect(p.state.outbox.some((o: any) => o.frame.type === 'qq.request.failed')).toBe(false)
    p.stopped = true
  })

  it('accepts a successful safe ACK retry after an explicit failed receipt', async () => {
    const { p, job } = pluginFixture()
    p.tick = vi.fn()
    p.output(job, 'qq.message.ack', { messageId: '11', emojiId: '4' })
    const output = p.state.outbox[0]; output.status = 'inflight'
    const receipt = { ...output.frame.data, status: 'failed', messageIds: [], activity: false, terminal: false }
    await p.confirm(receipt)
    expect(output.status).toBe('failed')
    await p.confirm({ ...receipt, status: 'sent', activity: true, sentAt: Date.now() })
    expect(output.status).toBe('sent')
    expect(job.state).toBe('running')
    p.stopped = true
  })
})
