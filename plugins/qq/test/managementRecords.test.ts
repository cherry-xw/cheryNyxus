import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQDefaultConfig, QQEntriesSchema, QQEntryDetailSchema, QQRequestSchemas } from '../../../packages/protocol/src/qq.js'
import { JobSchema, type Job, type Outbox } from '../src/state.js'
import { recordDetail, recordEntry } from '../src/managementRecords.js'
import { QQPlugin } from '../src/index.js'
import { deliverySummary, recordPage, taskLabel } from '../ui/qqPresentation.js'

function fixture() {
  const input = { eventId: 'qq:123:group:456:1', selfId: '123', targetId: '456', senderId: '789', senderName: '测试发送者', conversationType: 'group' as const, messageId: '1', content: '帮我整理今天的消息', mentionedBot: true, occurredAt: 1, attachments: [{ type: 'file', name: '资料.txt', url: 'https://example.com/private?signature=secret-attachment' }] }
  const job = JobSchema.parse({ requestId: 'request-1', input, target: 'group:456', conversationKey: 'private-core-key', snapshot: { revision: 2, config: structuredClone(QQDefaultConfig), preset: '测试预设', brain: 'secret-brain', senseGroup: 'private-tools', presetId: 'private-preset-id' }, state: 'completed', acceptedAt: 123000, reply: '已经整理', toolIds: [], waits: 0 })
  const output = (id: string, type: Outbox['frame']['type'], status: Outbox['status']): Outbox => ({ status, confirmedAt: status === 'sent' ? 124000 : undefined, frame: { kind: 'notification', type, data: { eventId: id, requestId: job.requestId, selfId: '123', conversationType: 'group', targetId: '456', seq: 1, text: 'private-delivery-body', mediaFile: 'local-file.mp4' } } })
  const outbox = [output('video', 'qq.reply.video', 'unknown'), output('notice', 'qq.request.failed', 'sent'), output('ack', 'qq.message.ack', 'sent'), output('lookup', 'qq.lookup.request', 'pending')]
  return { job, outbox, output }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('administrator QQ records', () => {
  it('provides useful summaries but never exposes a whole configuration or attachment address', () => {
    const { job, outbox } = fixture()
    const value = recordEntry(job, outbox)
    expect(QQEntriesSchema.parse({ entries: [value] }).entries[0]).toMatchObject({ targetId: '456', senderId: '789', senderName: '测试发送者', preset: '测试预设', inputPreview: job.input.content, replyPreview: job.reply, attachmentCount: 1, messageCount: 1 })
    expect(value.delivery).toEqual({ pending: 0, inflight: 0, sent: 2, unknown: 1, failed: 0 })
    const text = JSON.stringify(value)
    for (const secret of ['secret-attachment', 'secret-brain', 'private-core-key', 'private-delivery-body', 'local-file.mp4']) expect(text).not.toContain(secret)
  })
  it('keeps merged inputs and attachment metadata, with explicit limits and no silent truncation', () => {
    const { job, outbox } = fixture()
    job.mergedInputs = [job.input, { ...job.input, eventId: 'qq:123:group:456:2', messageId: '2', senderId: '890', senderName: '另一位发送者', content: '长'.repeat(21000) }]
    job.reply = '答'.repeat(100001)
    const value = QQEntryDetailSchema.parse(recordDetail(job, outbox))
    expect(value.messageCount).toBe(2)
    expect(value.messages[1]).toMatchObject({ senderId: '890', contentTruncated: true })
    expect(value.messages[1].content).toHaveLength(20000)
    expect(value.reply).toHaveLength(100000)
    expect(value.replyTruncated).toBe(true)
    expect(value.messages[0].attachments).toEqual([{ type: 'file', name: '资料.txt' }])
    expect(JSON.stringify(value)).not.toContain('secret-attachment')
    expect(job.reply).toHaveLength(100001)
  })
  it('does not confuse a successfully sent failure notice with the video result', () => {
    const { job, outbox } = fixture()
    const value = QQEntryDetailSchema.parse(recordDetail(job, outbox))
    expect(taskLabel(value.state)).toBe('处理完成')
    expect(deliverySummary(value)).toContain('发送结果未知 1')
    expect(value.deliveries.map(item => [item.type, item.status])).toEqual([['qq.reply.video', 'unknown'], ['qq.request.failed', 'sent'], ['qq.message.ack', 'sent']])
  })
  it('bounds delivery details and ignores records belonging to another request', () => {
    const { job, outbox, output } = fixture()
    outbox.push({ ...output('foreign', 'qq.reply.part', 'sent'), frame: { ...output('foreign', 'qq.reply.part', 'sent').frame, data: { ...output('foreign', 'qq.reply.part', 'sent').frame.data, requestId: 'other-request' } } })
    outbox.push(...Array.from({ length: 205 }, (_, index) => output(`part-${index}`, 'qq.reply.part', 'sent')))
    const value = QQEntryDetailSchema.parse(recordDetail(job, outbox))
    expect(value.deliveries).toHaveLength(200)
    expect(value.deliveriesTruncated).toBe(true)
    expect(value.delivery.sent).toBe(207)
    expect(value.deliveries.some(item => item.eventId === 'foreign')).toBe(false)
  })
  it('registers details as a read-only administrator route and rejects QQ credentials', async () => {
    const { job } = fixture()
    const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR || os.tmpdir(), 'qq-records-'))
    roots.push(root)
    const rpc: any[] = [], management: any[] = []
    const context: any = { id: 'cherynyxus-qq-module', version: 'test', dataDir: root, runtimeOptions: {}, config: { snapshot: () => ({ revision: 2, config: QQDefaultConfig }) }, rpc: { register: vi.fn(input => { rpc.push(input); return () => {} }) }, management: { register: vi.fn(input => management.push(input)) } }
    const plugin = new QQPlugin(context)
    ;(plugin as any).state.jobs = [job]
    plugin.prepareManagement()
    const method = rpc.find(item => item.method === 'qq.entry.get')
    expect(method.scope).toBe('management')
    expect(method.authorize({ credentialKind: 'qq' })).toBe(false)
    expect(method.authorize({ credentialKind: 'control' })).toBe(true)
    expect(await method.handler({ connectionId: 'admin' }, { requestId: job.requestId })).toMatchObject({ requestId: job.requestId, messages: [{ content: job.input.content }] })
    const route = management[0].routes.find((item: any) => item.path === 'entry')
    expect(route.method).toBe('GET')
    expect(route.requestSchema.safeParse({ pathParams: {}, query: { requestId: job.requestId, method: 'chat.list' } }).success).toBe(false)
    expect(await route.handler({ query: { requestId: job.requestId } })).toMatchObject({ requestId: job.requestId })
    await expect(method.handler({ connectionId: 'admin' }, { requestId: 'missing' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect(QQRequestSchemas['qq.entry.get'].safeParse({ requestId: '' }).success).toBe(false)
  })
  it('paginates newest first without mutating stored order and clamps after records disappear', () => {
    const { job } = fixture()
    const entries = Array.from({ length: 61 }, (_, index) => recordEntry({ ...job, requestId: `r-${index}`, acceptedAt: index } as Job, []))
    expect(recordPage(entries, 1).entries[0].requestId).toBe('r-60')
    expect(recordPage(entries, 3).entries).toHaveLength(11)
    expect(recordPage(entries.slice(0, 3), 3)).toMatchObject({ page: 1, pages: 1, total: 3 })
    expect(recordPage([], 9)).toMatchObject({ page: 1, pages: 1, total: 0, entries: [] })
    expect(entries[0].requestId).toBe('r-0')
  })
})
