import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IngressContext } from '@chery/plugin-api'
import { QQDefaultConfig, QQEventSubmitRequestSchema } from '@chery/protocol'
import { QQPlugin } from '../src/index.js'
import { JobSchema } from '../src/state.js'
import { prepareQQFileInputs } from '../src/assetMessages.js'

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
    readFileChunk: vi.fn().mockResolvedValue({ asset, offset: 0, dataBase64: Buffer.from('fixture').toString('base64'), eof: true }) }
  const plugin = new QQPlugin({ dataDir: root, runtimeOptions: {}, core, identity: { bind: vi.fn().mockResolvedValue({}) }, log: vi.fn() } as unknown as IngressContext)
  const internal = plugin as any
  internal.stopped = false; internal.connection = 'connection'
  internal.state.identityBinding = { selfId:'999' }
  const job = JobSchema.parse({ requestId: 'request', input: { eventId: 'qq:999:private:123:1', selfId: '999', conversationType: 'private', targetId: '123', senderId: '123', senderName: 'user', messageId: '1', content: '前后', mentionedBot: false, occurredAt: 1,
    attachments: [{ type: 'file', name: 'fixture.txt', url: 'https://files.example/fixture' }],
    parts: [{ type: 'text', text: '前' }, { type: 'attachment', index: 0 }, { type: 'text', text: '后' }] },
    target: 'private:user:123', conversationKey: 'conversation', snapshot: { config, revision: 1, preset: 'p', presetId: 'p-id', brain: 'b', senseGroup: 's' }, state: 'queued', acceptedAt: 1, reply: '', toolIds: [], waits: 0 })
  internal.state.jobs.push(job)
  return { internal, core, job, asset }
}

describe('QQ 有序资产消息', () => {
  it('passive image does not wake AI; selected background image precedes arbitrary mention text', async () => {
    const { internal, core, job, asset } = setup()
    const now = Math.floor(Date.now() / 1000)
    internal.snapshot = structuredClone(job.snapshot)
    internal.snapshot.config.groups = ['456']; internal.snapshot.config.bindings = { 'group:456': 'p' }
    const source = { ...job.input, conversationType: 'group' as const, targetId: '456', messageId: 'passive', eventId: 'passive', mentionedBot: false, content: '', parts: undefined, occurredAt: now,
      attachments: [{ type: 'image', mimeType: 'image/png', url: 'https://files.example/?signature=secret' }] }
    internal.state.discussions['group:456'] = { active: true, lastActivity: Date.now(), startedAt: Date.now(), closedAt: 0, summary: '', summaryPending: false, summaryRetryAt: 0, messages: [] }
    const count = internal.state.jobs.length
    expect((await internal.submit(source)).accepted).toBe(false)
    expect(internal.state.jobs).toHaveLength(count)
    internal.paused = true
    expect((await internal.submit({ ...source, messageId: 'ask', eventId: 'ask', mentionedBot: true, content: '前面这图讲什么的？', attachments: undefined })).accepted).toBe(true)
    const accepted = internal.state.jobs.at(-1)
    internal.state.imageSources[accepted.conversationKey] = { [JSON.stringify(['999','group','456','passive',0])]: {type:'asset',partId:'image',assetId:asset.id,assetVersionId:asset.versionId,variant:'original',usage:'content',kind:'image'} }
    expect(accepted.background.map((message: any) => message.messageId)).toContain('passive')
    core.importFile.mockResolvedValue({ ...asset, kind: 'image', mimeType: 'image/png' })
    internal.paused = false
    await internal.execute(accepted)
    const submitted = core.submit.mock.calls.at(-1)![0]
    expect(submitted.parts.filter((part: any) => part.type === 'asset')).toHaveLength(1)
    expect(submitted.parts.findIndex((part: any) => part.type === 'asset')).toBeLessThan(submitted.parts.findIndex((part: any) => part.text === accepted.input.content))
    expect(core.importFile).not.toHaveBeenCalled()
    expect(JSON.stringify(submitted)).not.toContain('signature')
  })
  it('只有文件也可入站，越界附件位置仍拒绝', () => {
    const { job } = setup()
    expect(QQEventSubmitRequestSchema.safeParse({ ...job.input, content: '', parts: [{ type: 'attachment', index: 0 }] }).success).toBe(true)
    expect(QQEventSubmitRequestSchema.safeParse({ ...job.input, parts: [{ type: 'attachment', index: 1 }] }).success).toBe(false)
  })

  it('导入资产后按文字文件文字顺序提交，不把下载地址发送给模型', async () => {
    const { internal, core, job } = setup()
    await internal.execute(job)
    expect(core.importFile).toHaveBeenCalledTimes(1)
    const submitted = core.submit.mock.calls[0]![0]
    expect(submitted.parts.map((part: { type: string }) => part.type)).toEqual(['text', 'text', 'asset', 'text'])
    expect(submitted.parts[2]).toMatchObject({ assetId: 'asset', assetVersionId: 'version' })
    expect(JSON.stringify(submitted)).not.toContain('files.example')
  })

  it('群 A 图片进入核心，B 引用跨重启复用同一版本且不重复下载', async () => {
    const { internal, core, job, asset } = setup()
    job.input = { ...job.input, eventId: 'qq:999:group:456:1', conversationType: 'group', targetId: '456', senderId: '123', attachments: [{ type: 'image', mimeType: 'image/png', url: 'https://files.example/image' }] }
    job.target = 'group:456'
    const imageAsset = { ...asset, kind: 'image', mimeType: 'image/png' }
    core.importFile.mockResolvedValue(imageAsset)
    internal.state.imageSources[job.conversationKey] = { [JSON.stringify(['999','group','456','1',0])]: {type:'asset',partId:'image',assetId:asset.id,assetVersionId:asset.versionId,variant:'original',usage:'content',kind:'image'} }
    await internal.execute(job)
    const state = JSON.parse(JSON.stringify(internal.state))
    internal.state = state
    const b = JobSchema.parse({ ...job, requestId: 'request-b', state: 'queued', inputParts: undefined,
      input: { ...job.input, eventId: 'qq:999:group:456:2', messageId: '2', senderId: '789', senderName: 'B', replyToMessageId: '1', content: '引用原图', parts: undefined, attachments: undefined } })
    internal.state.jobs.push(b)
    await internal.execute(b)
    expect(core.importFile).not.toHaveBeenCalled()
    expect(core.readFileChunk).toHaveBeenCalledWith(expect.objectContaining({ assetId: asset.id, assetVersionId: asset.versionId, conversationKey: job.conversationKey }))
    const submitted = core.submit.mock.calls.at(-1)![0]
    expect(submitted.parts.filter((part: { type: string }) => part.type === 'asset')).toEqual([expect.objectContaining({ assetId: asset.id, assetVersionId: asset.versionId })])
    expect(JSON.stringify(submitted.parts)).toContain('引用原图')
    expect(JSON.stringify(submitted.parts)).toContain('789')
    expect(JSON.stringify(submitted.parts)).toContain('123')
  })

  it('导入失败保留不可读取说明，不编造资产', async () => {
    const { internal, core, job } = setup()
    core.importFile.mockRejectedValueOnce(new Error('unavailable'))
    await internal.execute(job)
    const parts = core.submit.mock.calls[0]![0].parts
    expect(parts.some((part: { type: string }) => part.type === 'asset')).toBe(false)
    expect(JSON.stringify(parts)).toContain('不能读取其内容')
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
