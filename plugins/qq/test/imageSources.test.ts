import { describe, expect, it, vi } from 'vitest'
import type { AssetRecord, QQEventSubmitRequest } from '@chery/protocol'
import { prepareQQFileInputs, qqModelContext, type QQFileSources } from '../src/assetMessages.js'
import { emptyState, StateSchema } from '../src/state.js'
const message = (id: string, extra: Partial<QQEventSubmitRequest> = {}): QQEventSubmitRequest => ({ eventId: `event-${id}`, selfId: '123', targetId: '456', conversationType: 'group', senderId: '111', senderName: 'A', messageId: id, content: '说明', mentionedBot: true, occurredAt: 1, ...extra })
const image = { type: 'image', mimeType: 'image/png', url: 'https://example.com/synthetic.png' }
const asset = { id: 'fixed-image', versionId: 'fixed-version', mimeType: 'image/png', kind: 'image', originalName: 'synthetic.png' } as AssetRecord
const setup = (messages: QQEventSubmitRequest[]) => {
  const state = emptyState()
  const sources: QQFileSources = { messages, known: state.imageSources.conversation ??= {}, validate: vi.fn(async () => {}), save: vi.fn() }
  for(const m of messages) for(const [index,file] of (m.attachments??[]).entries()) if(file.type==='image') sources.known[JSON.stringify([m.selfId,m.conversationType,m.targetId,m.messageId,index])]={type:'asset',partId:'source',assetId:asset.id,assetVersionId:asset.versionId,variant:'original',usage:'content',kind:'image'}
  return { sources, state, importer: vi.fn(async () => asset) }
}
describe('QQ accepted image and direct quote sources', () => {
  it.each(['前面这图讲什么的？', '上面这图是什么', '刚才的图片呢', '这是什么？', '任意措辞'])('carries all selected background images independently of wording: %s', async (content) => {
    const { sources, importer } = setup([message('1', { attachments: [image] }), message('2', { attachments: [image] })])
    sources.background = sources.messages
    const parts = await prepareQQFileInputs([message('3', { content })], importer, new AbortController().signal, sources)
    expect(parts?.filter(part => part.type === 'asset')).toHaveLength(2)
    expect(importer).not.toHaveBeenCalled()
    expect(parts?.at(-1)).toMatchObject({ type: 'text', text: content })
    expect(parts?.filter(part => part.type === 'asset').every(part => part.inputOrigin === 'history')).toBe(true)
  })
  it('model context strips signed URL and all transport fields without mutating stored metadata', () => {
    const original = { messages: [message('1', { attachments: [{ ...image, url: 'https://example.com/?secret=signed' }] })] }
    const serialized = JSON.stringify(original, qqModelContext)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('https://')
    expect(serialized).toContain('metadata_only')
    expect(original.messages[0]!.attachments![0]!.url).toContain('secret')
  })
  it('imports accepted image with sender and ordered text then reuses original version for B quote without download', async () => {
    const a = message('1', { attachments: [image] })
    const { sources, state, importer } = setup([a])
    const first = await prepareQQFileInputs([a], importer, new AbortController().signal, sources)
    const restored = StateSchema.parse(JSON.parse(JSON.stringify(state)))
    sources.known = restored.imageSources.conversation!
    const second = await prepareQQFileInputs([message('2', { senderId: '222', senderName: 'B', replyToMessageId: '1', content: '这张图呢' })], importer, new AbortController().signal, sources)
    expect(importer).not.toHaveBeenCalled()
    expect(sources.validate).toHaveBeenCalledTimes(2)
    expect(first?.find(p => p.type === 'asset')).toMatchObject({ assetId: asset.id, assetVersionId: asset.versionId })
    expect(second?.find(p => p.type === 'asset')).toMatchObject({ assetId: asset.id, assetVersionId: asset.versionId })
    expect(JSON.stringify(second)).toContain('B')
    expect(JSON.stringify(second)).toContain('A')
    expect(JSON.stringify(second)).toContain('这张图呢')
  })
  it('only imports direct quoted background image, never unrelated background or recursive quote', async () => {
    const a = message('1', { attachments: [image], replyToMessageId: '3' })
    const { sources, importer } = setup([a, message('3', { attachments: [image] })])
    await prepareQQFileInputs([message('2', { replyToMessageId: '1' })], importer, new AbortController().signal, sources)
    expect(importer).not.toHaveBeenCalled()
  })
  it('same message ID in other group is not eligible; fresh context without known source cannot restore', async () => {
    const { sources, importer } = setup([message('1', { targetId: '999', attachments: [image] })])
    const parts = await prepareQQFileInputs([message('2', { replyToMessageId: '1' })], importer, new AbortController().signal, sources)
    expect(importer).not.toHaveBeenCalled()
    expect(JSON.stringify(parts)).toContain('无法读取原图')
  })
  it('permission denial preserves ordinary text, does not redownload or silently replace fixed ID', async () => {
    const a = message('1', { attachments: [image] })
    const { sources, importer } = setup([a])
    await prepareQQFileInputs([a], importer, new AbortController().signal, sources)
    sources.validate = async () => { throw Object.assign(Error('revoked'), { stage: 'permission', code: 'FILE_PERMISSION_DENIED' }) }
    const parts = await prepareQQFileInputs([message('2', { replyToMessageId: '1' })], importer, new AbortController().signal, sources)
    expect(importer).not.toHaveBeenCalled()
    expect(parts?.some(p => p.type === 'asset')).toBe(false)
    expect(JSON.stringify(parts)).toContain('无权读取')
    expect(JSON.stringify(parts)).toContain('说明')
  })
  it('ordinary text with unreferenced background does not import anything', async () => {
    const { sources, importer } = setup([message('1', { attachments: [image] })])
    expect(await prepareQQFileInputs([message('2')], importer, new AbortController().signal, sources)).toBeUndefined()
    expect(importer).not.toHaveBeenCalled()
  })
})
