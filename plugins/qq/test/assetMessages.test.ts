import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngressContext } from '@chery/plugin-api'
import { QQDefaultConfig, QQEventSubmitRequestSchema } from '@chery/protocol'
import { QQPlugin } from '../src/index.js'
import { JobSchema } from '../src/state.js'
import { prepareQQFileInputs } from '../src/assetMessages.js'
import { stageSourceZip, readSourceZipText, sourceDirectory } from '../src/sourceWorkspace.mjs'

let root: string
beforeEach(async () => { root = await mkdtemp('/tmp/opencode/qq-assets-') })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function setup() {
  const config = { ...QQDefaultConfig, memoryEnabled: false }
  const preset = { name: 'p', presetId: 'p-id', leaderName: 'l', brain: 'b', senseGroup: 's', mcpServers: [] }
  const asset = { id: 'asset', versionId: 'version', originalName: 'fixture.txt', mimeType: 'text/plain', kind: 'document', sizeBytes: 7,
    sha256: createHash('sha256').update('fixture').digest('hex'), source: 'upload', availability: 'available', createdAt: 1, ownerId: 'qq' }
  const core = { resolvePreset: () => preset, ensureConversation: vi.fn().mockResolvedValue({ chatId: 'chat' }),
    importFile: vi.fn().mockResolvedValue(asset), submit: vi.fn().mockResolvedValue({ runId: 'run' }),
    readFileChunk: vi.fn().mockResolvedValue({ asset, offset: 0, dataBase64: Buffer.from('fixture').toString('base64'), eof: true }),
    sourceConversations: {
      scope: vi.fn().mockResolvedValue({ scopeId: 'scope-1', selectionRevision: 1, permissionRevision: 1 }),
      freeze: vi.fn(async (req: any) => ({
        snapshotId: 'snap-1', scopeId: req.scopeId, requestId: req.requestId, turnId: req.requestId,
        createdAt: 1, reason: 'initial', qqConfigRevision: 1, permissionRevision: 1, selectionRevision: 1,
        actorRecord: req.actorRecord, inputRecords: req.inputRecords,
        orderedItems: req.inputRecords.map((r: any) => ({ type: 'message', recordId: r.recordId, revision: r.revision, selectionReasons: ['current'], parts: [] })),
      })),
      read: vi.fn(async (req: any) => ({
        items: req.selection.refs.map((r: any) => ({
          state: 'available',
          record: {
            recordId: r.recordId, revision: r.revision, scopeId: req.scopeId, origin: 'member',
            sender: { id: '123', name: 'user' }, platformMessageIds: ['1'], receivedAt: 1000,
            parts: [{ type: 'text', partId: 'p0', text: '前' }, { type: 'attachment', partId: 'p1', attachmentId: 'att-1' }, { type: 'text', partId: 'p2', text: '后' }],
          },
        })),
      })),
      attachment: vi.fn().mockResolvedValue({ attachmentId: 'att-1', version: 1, mediaKind: 'file', originalName: 'fixture.txt', declaredMimeType: 'text/plain', state: { kind: 'pending' }, source: { recordId: 'rec-1', revision: 1, partId: 'p1' } }),
      beginReceipt: vi.fn(async (req: any) => ({ state: 'pending', receiptId: `rcpt-${req.message.eventId}`, version: 1, record: { recordId: `rec-${req.message.eventId}`, revision: 1 } })),
      receiptAttachments: vi.fn().mockResolvedValue([]),
      completeReceipt: vi.fn(async (req: any) => ({ receiptId: req.receiptId, record: { recordId: `rec-${req.receiptId}`, revision: 1 }, handling: req.handling })),
      lookupReceipt: vi.fn().mockResolvedValue({ state: 'not_found' }),
      recordDelivery: vi.fn().mockResolvedValue(undefined),
    } }
  const plugin = new QQPlugin({ id: 'cherynyxus-qq-module', dataDir: root, runtimeOptions: {}, isEnabled: () => true, connections: { isOpen: () => false, send: () => false }, core, identity: { bind: vi.fn().mockResolvedValue({}) }, log: vi.fn() } as unknown as IngressContext)
  const internal = plugin as any
  internal.stopped = false; internal.connection = 'connection'; internal.verifiedConnection = 'connection'; internal.recovered = true
  internal.state.identityBinding = { selfId:'999' }
  internal.state.sourceScopes = {
    'private:user:123': { scopeId: 'scope-1', ownerId: 'qq', channel: 'qq', selfId: '999', conversationType: 'private', targetId: '123', presetId: 'p-id', qqContextEpoch: '', state: 'active', permissionRevision: 1, selectionRevision: 1, createdAt: 1, updatedAt: 1 },
    'group:456': { scopeId: 'scope-group', ownerId: 'qq', channel: 'qq', selfId: '999', conversationType: 'group', targetId: '456', presetId: 'p-id', qqContextEpoch: '', state: 'active', permissionRevision: 1, selectionRevision: 1, createdAt: 1, updatedAt: 1 },
  }
  const job = JobSchema.parse({ requestId: 'request', queueSequence: 1, questionBatches: [], sourceScopeId: 'scope-1', sourceRecords: [{ recordId: 'rec-1', revision: 1 }],
    input: { eventId: 'qq:999:private:123:1', selfId: '999', conversationType: 'private', targetId: '123', senderId: '123', senderName: 'user', messageId: '1', content: '前后', mentionedBot: false, occurredAt: 1,
      sourceParts: [{ type: 'text', partId: 'p0', text: '前' }, { type: 'attachment', partId: 'p1', attachmentId: 'att-1' }, { type: 'text', partId: 'p2', text: '后' }],
      attachments: [{ partId: 'p1', type: 'file', name: 'fixture.txt', url: 'https://files.example/fixture' }],
      parts: [{ type: 'text', text: '前' }, { type: 'attachment', index: 0 }, { type: 'text', text: '后' }] },
    target: 'private:user:123', conversationKey: 'conversation', snapshot: { config, revision: 1, preset: 'p', presetId: 'p-id', brain: 'b', senseGroup: 's' }, state: 'queued', acceptedAt: 1, reply: '', toolIds: [], waits: 0 })
  internal.state.jobs.push(job)
  return { internal, core, job, asset }
}

describe('QQ 有序资产消息与来源提交', () => {
  it.each(['preset', 'reset', 'removed'])('配置 %s 立即撤销旧 ZIP 读取和进行中命令的取消信号', async change => {
    const { internal, core, job } = setup()
    internal.snapshot = structuredClone(job.snapshot)
    Object.assign(internal.snapshot.config, { selfId:'999', users:['123'], bindings:{'private:user:123':'p'} })
    job.state = 'running'
    const running = new AbortController()
    internal.aborters.set(job.requestId, running)
    const access = await internal.sourceAccess(job, running.signal)
    const body = Buffer.alloc(22);body.writeUInt32LE(0x06054b50)
    const mount = await stageSourceZip({ ...access, source:{recordId:'record',revision:1,partId:'p1'}, senderId:'123',originalName:'in.zip',body,
      asset:{assetId:'zip',assetVersionId:'v1',sizeBytes:body.length,sha256:createHash('sha256').update(body).digest('hex')} })
    await writeFile(path.join(access.sourceRoot,sourceDirectory(access.scope),'incoming-zips',mount.slotKey,'extracted','text'),'allowed before change')
    expect((await readSourceZipText({...access,slotKey:mount.slotKey,path:'text'})).text).toBe('allowed before change')
    const next = structuredClone(internal.snapshot.config)
    if (change==='removed') { next.users=[];next.bindings={} }
    if (change==='preset') {
      next.bindings['private:user:123']='new'
      vi.spyOn(core,'resolvePreset').mockImplementation(()=>({name:'new',presetId:'new-preset',leaderName:'l',brain:'b',senseGroup:'s',mcpServers:[]}))
    }
    if (change==='reset') internal.state.contextEpoch='new-context'
    ;(core.sourceConversations as any).configure=vi.fn(async()=>change==='removed'?[]:[{
      ...internal.state.sourceScopes['private:user:123'],scopeId:'replacement-scope',permissionRevision:2,
      presetId:change==='preset'?'new-preset':'p-id',qqContextEpoch:internal.state.contextEpoch,
    }])
    vi.spyOn(internal.nativeImages,'refresh').mockImplementation(()=>{})
    vi.spyOn(internal,'publishServiceState').mockImplementation(()=>{})
    await internal.applyConfig({revision:2,config:next})
    expect(running.signal.aborted).toBe(true)
    expect(access.signal.aborted).toBe(true)
    await expect(access.validate()).rejects.toThrow()
    await expect(readSourceZipText({...access,slotKey:mount.slotKey,path:'text'})).rejects.toThrow()
  })

  it('passive image does not wake AI; selected background image is retained in source snapshot without URL leakage', async () => {
    const { internal, core, job } = setup()
    const now = Math.floor(Date.now() / 1000)
    internal.snapshot = structuredClone(job.snapshot)
    internal.snapshot.config.groups = ['456']; internal.snapshot.config.bindings = { 'group:456': 'p' }
    const source = { ...job.input, conversationType: 'group' as const, targetId: '456', messageId: 'passive', eventId: 'passive', mentionedBot: false, content: '', parts: undefined, occurredAt: now,
      sourceParts: [{ type: 'attachment' as const, partId: 'p0', attachmentId: 'img-1' }],
      attachments: [{ partId: 'p0', type: 'image' as const, mimeType: 'image/png', url: 'https://files.example/?signature=secret' }] }
    internal.state.discussions['group:456'] = { active: true, lastActivity: Date.now(), startedAt: Date.now(), closedAt: 0, sourceScopeId: 'scope-group', summaryPending: false, summaryRetryAt: 0 }
    const count = internal.state.jobs.length
    expect((await internal.submit(source)).accepted).toBe(false)
    expect(internal.state.jobs).toHaveLength(count)
    expect((await internal.submit({ ...source, messageId: 'ask', eventId: 'ask', mentionedBot: true, content: '前面这图讲什么的？',
      sourceParts: [{ type: 'text', partId: 'p0', text: '前面这图讲什么的？' }], attachments: undefined })).accepted).toBe(true)
    const accepted = internal.state.jobs.at(-1)
    await internal.execute(accepted)
    const submitted = core.submit.mock.calls.at(-1)![0]
    expect(submitted.sourceInput).toMatchObject({ kind: 'source_snapshot', requestId: accepted.requestId, scopeId: 'scope-group' })
    expect(core.importFile).not.toHaveBeenCalled()
    expect(JSON.stringify(submitted)).not.toContain('signature')
  })

  it('只有文件也可入站，越界附件位置或缺失 sourceParts 仍拒绝', () => {
    const { job } = setup()
    expect(QQEventSubmitRequestSchema.safeParse({ ...job.input, content: '', sourceParts: [{ type: 'attachment', partId: 'p1', attachmentId: 'att-1' }], parts: [{ type: 'attachment', index: 0 }] }).success).toBe(true)
    expect(QQEventSubmitRequestSchema.safeParse({ ...job.input, parts: [{ type: 'attachment', index: 1 }] }).success).toBe(false)
    expect(QQEventSubmitRequestSchema.safeParse({ ...job.input, sourceParts: [] }).success).toBe(false)
  })

  it('执行时通过 sourceInput 提交固定来源快照，不把下载地址发送给模型', async () => {
    const { internal, core, job } = setup()
    internal.snapshot = structuredClone(job.snapshot)
    internal.snapshot.config.users = ['123']; internal.snapshot.config.bindings = { 'private:user:123': 'p' }
    await internal.execute(job)
    const submitted = core.submit.mock.calls[0]![0]
    expect(submitted.sourceInput).toMatchObject({
      kind: 'source_snapshot',
      requestId: job.requestId,
      turnId: job.requestId,
      scopeId: 'scope-1',
      snapshotId: 'snap-1',
    })
    expect(JSON.stringify(submitted)).not.toContain('files.example')
  })

  it.each(['download', 'invalid', 'permission', 'unknown'])('附件 %s 诊断不泄漏错误、cause、下载地址或正文', async stage => {
    const { job } = setup()
    const diagnostic = vi.fn()
    const failure = Object.assign(new Error('https://files.example/?token=secret body-secret'), { stage, code: stage === 'download' ? 'FILE_DOWNLOAD_FAILED' : 'arbitrary-secret', cause: new Error('cause-secret') })
    const parts = await prepareQQFileInputs([job.input], async () => { throw failure }, new AbortController().signal, { known: {}, messages: [], validate: async () => {}, save() {}, diagnostic })
    expect(diagnostic).toHaveBeenCalledWith({ stage: stage === 'unknown' ? 'import' : stage, code: stage === 'download' ? 'FILE_DOWNLOAD_FAILED' : 'UNAVAILABLE', messageId: job.input.messageId, attachmentIndex: 0 })
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(parts)).not.toContain('secret')
    expect(JSON.stringify(parts)).toContain(stage === 'download' ? '下载失败' : stage === 'invalid' ? '格式或大小无效' : stage === 'permission' ? '无权读取' : '不可用')
  })

  it('工具文件与最终正文分别入发送队列，未取得回执不标发送成功', async () => {
    const { internal, core, job } = setup()
    job.state = 'running'; job.coreRunId = 'run'; job.reply = '完成'
    internal.coreEvent('conversation', { type: 'accept', data: { runId: 'run', parts: [{ type: 'asset', partId: 'file', assetId: 'asset', assetVersionId: 'version', variant: 'original', usage: 'content' }] } })
    await internal.finishWithFiles(job, 'completed')
    expect(core.readFileChunk).toHaveBeenCalledTimes(1)
    const outputs = internal.state.outbox
    expect(outputs.map((item: any) => item.frame.type)).toEqual(['qq.reply.file', 'qq.reply.part'])
    expect(outputs[0].frame.data.asset).toMatchObject({ assetId: 'asset', assetVersionId: 'version' })
    expect(outputs.every((item: any) => item.status === 'pending')).toBe(true)
    expect(job.state).toBe('sending')
  })

  it('恢复发送准备时沿用已登记文件通知，不重复生成或重复排队文件', async () => {
    const { internal, core, job, asset } = setup()
    job.state = 'sending'; job.outcome = 'completed'; job.filePreparationPending = true; job.reply = '完成'
    job.outputParts = [{ type: 'asset', partId: 'file', assetId: asset.id, assetVersionId: asset.versionId, variant: 'original', usage: 'content' }]
    internal.output(job, 'qq.reply.file', { asset: { assetId: asset.id, assetVersionId: asset.versionId, originalName: asset.originalName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256 }, completeReply: false })
    await internal.finishWithFiles(job, 'completed')
    expect(core.submit).not.toHaveBeenCalled()
    expect(core.readFileChunk).not.toHaveBeenCalled()
    expect(internal.state.outbox.map((item: any) => item.frame.type)).toEqual(['qq.reply.file', 'qq.reply.part'])
    expect(job.filePreparationPending).toBe(false)
  })

  it('合并的群消息保留各自语境、附件顺序和唯一位置', async () => {
    const { job, core } = setup()
    const other = { ...job.input, messageId: '2', content: '第三条', parts: undefined }
    const parts = await prepareQQFileInputs([job.input, other], core.importFile, new AbortController().signal)
    expect(parts?.map(part => part.type)).toEqual(['text', 'text', 'asset', 'text', 'text', 'text', 'asset'])
    expect(new Set(parts?.map(part => part.partId)).size).toBe(parts?.length)
    expect(parts?.[5]).toMatchObject({ text: '第三条' })
    expect(core.importFile).toHaveBeenCalledTimes(2)
  })

  it('终态先到也从其最终消息收集文件，不依赖后到的 done', async () => {
    const { internal, job } = setup()
    job.state = 'running'; job.coreRunId = 'run'
    internal.coreEvent('conversation', { type: 'run.outcome', data: { runId: 'run', status: 'completed', finalMessage: { parts: [
      { type: 'asset', partId: 'file', assetId: 'asset', assetVersionId: 'version', variant: 'original', usage: 'content' },
    ] } } })
    await Promise.all([...internal.operations])
    expect(internal.state.outbox[0]?.frame.type).toBe('qq.reply.file')
    expect(internal.state.outbox).toHaveLength(1)
    expect(internal.state.outbox[0]?.frame.data.completeReply).toBe(true)
    expect(job.state).toBe('sending')
  })

  it('只发送同一处理链最后一批文件，不把中间原稿重复发给 QQ', async () => {
    const { internal, core, job, asset } = setup()
    job.state = 'running'; job.coreRunId = 'run'; job.reply = '完成'
    const part = (id: string) => ({ type: 'asset' as const, partId: id, assetId: id, assetVersionId: 'version', variant: 'original' as const, usage: 'content' as const })
    job.outputParts = [part('draft'), part('final-one'), part('final-two')]
    const common = { operation: 'image.generate' as const, targetKind: 'tool' as const, targetId: 'generate', executionStatus: 'succeeded' as const,
      deliveryStatus: 'saved' as const, inspectionStatus: 'not_requested' as const, updatedAt: 2 }
    job.outputOperations = [
      { ...common, operationId: 'first', inputAssets: [], outputAssetIds: ['draft'], createdAt: 1 },
      { ...common, operationId: 'second', inputAssets: [{ assetId: 'draft', assetVersionId: 'version', variant: 'original' }], outputParts: [part('final-one'), part('final-two')], createdAt: 2 },
    ]
    core.readFileChunk.mockImplementation(async (input: any) => ({ asset: { ...asset, id: input.assetId }, offset: 0,
      dataBase64: Buffer.from('fixture').toString('base64'), eof: true }))
    await internal.finishWithFiles(job, 'completed')
    expect(core.readFileChunk.mock.calls.map(([input]) => (input as any).assetId)).toEqual(['final-one', 'final-two'])
    expect(internal.state.outbox.filter((output: any) => output.frame.type === 'qq.reply.file').map((output: any) => output.frame.data.asset.assetId)).toEqual(['final-one', 'final-two'])
  })
})
