import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQDefaultConfig, QQEntriesSchema, QQEntryDetailSchema, QQRequestSchemas } from '../../../packages/protocol/src/qq.js'
import { JobSchema, type Job, type Outbox } from '../src/state.js'
import { recordDetail, recordEntry } from '../src/managementRecords.js'
import { QQPlugin } from '../src/index.js'
import { deliverySummary, recordPage, taskLabel, recordKindLabel, participationLabel, filterRecordEntries, recordProcessingRows } from '../ui/qqPresentation.js'

function fixture() {
  const input = { eventId: 'qq:123:group:456:1', selfId: '123', targetId: '456', senderId: '789', senderName: '测试发送者', conversationType: 'group' as const, messageId: '1', content: '帮我整理今天的消息', mentionedBot: true, occurredAt: 1, sourceParts: [{ type: 'text' as const, partId: 'p0', text: '帮我整理今天的消息' }, { type: 'attachment' as const, partId: 'p1', attachmentId: 'att-1' }], attachments: [{ partId: 'p1', type: 'file', name: '资料.txt', url: 'https://example.com/private?signature=secret-attachment' }] }
  const job = JobSchema.parse({ requestId: 'request-1', queueSequence: 1, questionBatches: [], input, target: 'group:456', conversationKey: 'private-core-key', snapshot: { revision: 2, config: structuredClone(QQDefaultConfig), preset: '测试预设', brain: 'secret-brain', senseGroup: 'private-tools', presetId: 'private-preset-id' }, state: 'completed', acceptedAt: 123000, reply: '已经整理', toolIds: [], waits: 0 })
  const output = (id: string, type: Outbox['frame']['type'], status: Outbox['status']): Outbox => ({ status, confirmedAt: status === 'sent' ? 124000 : undefined, frame: { kind: 'notification', type, data: { eventId: id, requestId: job.requestId, selfId: '123', conversationType: 'group', targetId: '456', seq: 1, text: 'private-delivery-body', mediaFile: 'local-file.mp4' } } })
  const outbox = [output('video', 'qq.reply.video', 'unknown'), output('notice', 'qq.request.failed', 'sent'), output('ack', 'qq.message.ack', 'sent'), output('lookup', 'qq.lookup.request', 'pending')]
  return { job, outbox, output }
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('administrator QQ records', () => {
  it('explains observations using the task snapshot without claiming reply or learning success',()=>{
    const {job}=fixture();job.observe=true;job.participation='wait';job.contextReads=2;job.startedAt=job.acceptedAt+3500
    job.anchorRecord={recordId:'anchor',revision:1};job.snapshot.config.conversation.groups['456']={mode:'proactive'}
    const entry=QQEntryDetailSchema.parse(recordDetail(job,[]))
    expect(entry).toMatchObject({kind:'observation',participation:'wait',processing:{mode:'proactive',modeOrigin:'group',queueWaitMs:3500,contextReads:2}})
    expect(recordKindLabel(entry)).toBe('观察（不直接发送回复）');expect(participationLabel(entry.participation)).toBe('暂不参与')
    expect(recordProcessingRows(entry)).toContainEqual({label:'启动前排队',value:'3.5 秒'})
    expect(entry.processing?.learning).toBeUndefined()
    const normal=recordEntry({...job,observe:false,participation:undefined},[])
    expect(filterRecordEntries([entry,normal],'observation')).toEqual([entry]);expect(filterRecordEntries([entry,normal],'reply')).toEqual([normal])
    delete job.startedAt;expect(recordProcessingRows(recordDetail(job,[]))).toContainEqual({label:'启动前排队',value:'尚未启动或没有记录'})
  })
  it('counts learning only within the same source scope and labels it as scope-wide',async()=>{
    const {job}=fixture(),plugin=Object.create(QQPlugin.prototype) as any
    job.sourceScopeId='scope';plugin.state={jobs:[job],outbox:[],learning:{tasks:[{scopeId:'scope',state:'pending'},{scopeId:'other',state:'completed'}]}}
    plugin.readSourceDetail=vi.fn(async()=>({requestId:job.requestId,observedAt:1,availability:'legacy_unrecorded',items:[],associatedSummaryIds:[],nextCursor:null,reasonCode:'SOURCE_NOT_RECORDED'}))
    const detail=QQEntryDetailSchema.parse(await plugin.entryDetail(job.requestId))
    expect(detail.processing?.learning).toEqual({pending:1,failed:0,completed:0})
    expect(recordProcessingRows(detail).find(row=>row.label==='当前来源范围的学习任务')?.value).toContain('不表示这条消息已经学会')
    expect(recordProcessingRows({...detail,processing:undefined})).toEqual([{label:'处理说明',value:'这条记录未保存处理说明'}])
  })
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
    job.mergedInputs = [job.input, { ...job.input, eventId: 'qq:123:group:456:2', messageId: '2', senderId: '890', senderName: '另一位发送者', content: '长'.repeat(21000), sourceParts: [{ type: 'text', partId: 'p0', text: '长'.repeat(21000) }], attachments: [] }]
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
  it('degrades qq.entry.get sourceContext items to itemsDeferred when response exceeds 256 KiB', async () => {
    const { job } = fixture()
    job.sourceScopeId = 'scope-large'
    const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR || os.tmpdir(), 'qq-records-large-'))
    roots.push(root)
    const rpc: any[] = [], management: any[] = []
    const largePreview = '长'.repeat(1024)
    const makeItems = (kind: 'messages' | 'deliveries') => ({
      requestId: job.requestId,
      observedAt: 123000,
      kind,
      total: 120,
      nextCursor: null,
      items: Array.from({ length: 120 }, (_, i) =>
        kind === 'messages'
          ? {
              itemId: `msg-${i}`,
              type: 'message' as const,
              source: { recordId: `rec-${i}`, revision: 1 },
              origin: 'member' as const,
              sender: { id: '789', name: '测试发送者' },
              platformMessageIds: [`${i + 1}`],
              time: {
                at: 123000,
                basis: 'received' as const,
              },
              parts: [
                {
                  partId: 'p0',
                  type: 'text' as const,
                  body: {
                    state: 'available' as const,
                    text: {
                      textRefId: `ref-${i}`,
                      revision: 1,
                      preview: largePreview,
                      previewCodePoints: 1024,
                      totalCodePoints: 2048,
                      complete: false,
                      nextCursor: 'cursor-1',
                    },
                  },
                },
              ],
            }
          : {
              itemId: `del-${i}`,
              type: 'delivery' as const,
              purpose: 'reply',
              sequence: i + 1,
              status: 'sent' as const,
              confirmedAt: 124000,
              messageIds: [`${i + 1000}`],
              fileIds: [],
              body: {
                state: 'available' as const,
                text: {
                  textRefId: `dref-${i}`,
                  revision: 1,
                  preview: largePreview,
                  previewCodePoints: 1024,
                  totalCodePoints: 1024,
                  complete: true,
                  nextCursor: null,
                },
              },
            },
      ),
    })
    const context: any = {
      id: 'cherynyxus-qq-module',
      version: 'test',
      dataDir: root,
      runtimeOptions: {},
      config: { snapshot: () => ({ revision: 2, config: QQDefaultConfig }) },
      rpc: { register: vi.fn((input) => { rpc.push(input); return () => {} }) },
      management: {
        register: vi.fn((input) => management.push(input)),
        readSource: vi.fn(async (query: any) => {
          if (query.method === 'qq.context.index') {
            return {
              requestId: job.requestId,
              observedAt: 123000,
              availability: 'available',
              items: [],
              associatedSummaryIds: [],
              nextCursor: null,
            }
          }
          if (query.method === 'qq.entry.items') {
            return makeItems(query.params.kind)
          }
          throw new Error('Unexpected method')
        }),
      },
    }
    const plugin = new QQPlugin(context)
    ;(plugin as any).state.jobs = [job]
    plugin.prepareManagement()
    const method = rpc.find((item) => item.method === 'qq.entry.get')
    const detail = await method.handler({ connectionId: 'admin' }, { requestId: job.requestId })
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(256 * 1024)
    expect(detail.sourceContext?.itemsDeferred).toBe(true)
    expect(detail.sourceContext?.messages).toBeUndefined()
    expect(detail.sourceContext?.deliveries).toBeUndefined()
  })
})
