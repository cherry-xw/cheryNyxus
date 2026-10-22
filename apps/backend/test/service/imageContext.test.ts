import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
let pngFixture: Buffer
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetRecord, MessageAssetPart } from '@chery/protocol'
import type { LLMResponse } from '@/core/message/adapter.js'
import { createChat, deleteChat } from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import { getChatMonthlyDb } from '@/db/chatStorage.js'
import { addMessage } from '@/db/message.js'
import config from '@/utils/config.js'
import { planFileInputs } from '@/agent/middleware/fileInputPlanning.js'
import { imageTurnView, requestImageRead, getImageDescription, saveImageDescription, listImageDescriptions, beginDescriptionAttempt, finishDescriptionAttempt, imageDescriptionIssue } from '@/service/fileServices/imageContext.js'
import { saveFileRequestPlan, patchFileRequestPlan, getFileRequestPlan } from '@/service/fileServices/inputObservations.js'
import { createMockContext, createMockRuntime, createTestSense, mockLLMAdapter, mockMessageAdapter, mockSenseAdapter, makeNext } from '../agent/helpers/fakeContext.js'
import { chatMiddleware } from '@/agent/middleware/chat.js'
import { collectChunks } from '../agent/helpers/chunkAssert.js'
import { z } from 'zod'
import { buildFileServiceToolName } from '@chery/protocol'
import { SupervisionLevel } from '@/core/config.js'
import { buildOpenAICompatibleMessages } from '@/agent/provider/openaiCompat.js'

const mocks = vi.hoisted(() => ({ read: vi.fn(), get: vi.fn(), blocked: new Set<string>() }))
vi.mock('@/service/media/store.js', () => ({ getAssetStore: () => ({ get: mocks.get, read: mocks.read }) }))

const part = (id = 'photo', version = `v-${id}`): MessageAssetPart => ({ type: 'asset', partId: `p-${id}`, assetId: id, assetVersionId: version, variant: 'original', usage: 'content', mimeType: 'image/png' })
const msg = (id: string, parts: LLMResponse['parts'] = [], role: LLMResponse['role'] = 'user'): LLMResponse => ({ id, role, parts, content: role === 'sense' ? '{"status":"image_read_prepared"}' : '继续', createdAt: 1, updateAt: 1 })
const previousFiles = structuredClone(config.files)
let chatId: string
function ctx() {
  const context = createMockContext({ runtime: createMockRuntime({ brain: { provider: 'openai', protocol: 'openai-chat-completions', capabilities: { imageInput: { formats: ['image/png'] }, input: { image: 'supported' } } } }) })
  context.soul.chatId = chatId
  return context
}
beforeEach(async () => {
  pngFixture = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#246898' } }).png().toBuffer()
  chatId = randomUUID()
  createChat(chatId, { fileOwnerId: 'image-owner' })
  config.files = { context: { maxAssets: 10 }, imageContext: { mode: 'recent', recentUserTurns: 3 } }
  mocks.blocked.clear()
  mocks.get.mockImplementation((id: string, _access: unknown, version = `v-${id}`): AssetRecord => {
    if (mocks.blocked.has(id)) throw new Error('无权访问')
    return { id, versionId: version, originalName: `${id}.png`, kind: 'image', mimeType: 'image/png', sizeBytes: pngFixture.length, sha256: id.padEnd(64, '0'), createdAt: 1, source: 'upload', ownerId: 'image-owner', availability: 'available', transform: { variant: 'original' } } as AssetRecord
  })
  mocks.read.mockImplementation(async (id: string, access: unknown, version: string) => ({ asset: mocks.get(id, access, version), data: id === 'photo' ? pngFixture : await sharp({ create: { width: 10 + id.length, height: 8, channels: 3, background: id === 'first' ? '#ff0000' : '#0000ff' } }).png().toBuffer() }))
})
afterEach(() => { deleteChat(chatId); config.files = structuredClone(previousFiles); vi.clearAllMocks() })

describe('图片轮数与描述持久记录', () => {
  it('selected QQ history precedes current text, is adopted once and cannot refresh on rebuild or restart', async () => {
    const { prepareQQFileInputs } = await import('../../../../plugins/qq/src/assetMessages.js')
    config.files!.imageContext = {}
    const background = [{ eventId: 'passive', selfId: '123', targetId: '456', conversationType: 'group' as const, senderId: '111', senderName: 'A', messageId: '1691784683', content: '原文字', mentionedBot: false, occurredAt: 1, attachments: [{ type: 'image', mimeType: 'image/png', url: 'https://example.com/synthetic.png' }] }]
    const known = { [JSON.stringify(['123','group','456','1691784683',0])]:part() }
    const current = { ...background[0]!, eventId: 'mention', senderId: '222', messageId: '426449310', content: '任意措辞', mentionedBot: true, occurredAt: 9001, attachments: [] }
    const importer = vi.fn(async () => mocks.get('photo', null))
    const prepare = () => prepareQQFileInputs([current], importer, new AbortController().signal, { messages: background, background, known, validate: async () => {}, save() {} })
    const parts = await prepare()
    const first = msg('qq-accepted-1', parts)
    const one = await planFileInputs(ctx(), [first])
    const payload = buildOpenAICompatibleMessages(one.history, one.attachments)
    const content = payload[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(content.filter(p => p.type === 'image_url')).toHaveLength(1)
    const { registerOpenAIAdapter } = await import('@/agent/provider/openai.js')
    const { getLLMAdapter } = await import('@/core/llm/adapter.js')
    registerOpenAIAdapter()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'offline' } }] }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await getLLMAdapter('openai')!.chat(payload, [], { model: 'MiniMax-M3.1-Flash-Preview', url: 'https://offline.invalid/v1', key: 'synthetic', continuous: true, skipHooks: true, thinkingParams: { reasoning_effort: 'low' } })
      const body = JSON.parse((fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1].body as string)
      expect(body.messages[0].content.filter((part: { type: string }) => part.type === 'image_url')).toHaveLength(1)
      expect(body.reasoning_effort).toBe('low')
      expect(body.messages[0].content.findIndex((p: { type: string }) => p.type === 'image_url')).toBeLessThan(body.messages[0].content.findIndex((p: { text?: string }) => p.text === '任意措辞'))
    } finally { vi.unstubAllGlobals() }
    expect(content.findIndex(p => p.type === 'image_url')).toBeLessThan(content.findIndex(p => p.text === '任意措辞'))
    one.commit?.()
    ;(await planFileInputs(ctx(), [first, msg('tool', [], 'sense')])).commit?.()
    const rebuilt = msg('qq-accepted-2', await prepare())
    const next = await planFileInputs(ctx(), [first, rebuilt])
    expect(next.attachments).toBeUndefined()
    expect(next.capabilitiesHint).toContain('固定资产引用表示文件已保存')
    expect(next.capabilitiesHint).toContain('file_image_read')
    next.commit?.()
    expect((await planFileInputs(ctx(), [msg('qq-accepted-3', await prepare())])).attachments).toBeUndefined()
    expect(imageTurnView(chatId, []).images[0]!.ordinal).toBe(1)
    expect(importer).not.toHaveBeenCalled()
  })

  it.each(['role', 'tool', 'unknown', 'requires_approval', 'unavailable'] as const)('QQ history %s keeps a fixed reference without native payload or automatic execution', async mode => {
    const context = ctx()
    context.requestView = { identity: { channel: 'qq' }, fileCapabilities: [{ operation: 'image.inspect', mode: mode === 'role' || mode === 'tool' ? mode : 'native', availability: mode === 'role' || mode === 'tool' ? 'available' : mode, reason: 'test', reasonCode: 'test', configRevision: 'snapshot', inputConstraints: {} }] } as typeof context.requestView
    const result = await planFileInputs(context, [msg('qq-history', [{ ...part(), inputOrigin: 'history' }])])
    expect(result.attachments).toBeUndefined()
    expect(JSON.stringify(result.history)).toContain('assetVersionId=v-photo')
    expect(result.plan?.[0]?.action).not.toBe('tool')
  })

  it('two distinct background images both enter the native payload in order without forced clarification', async () => {
    const result = await planFileInputs(ctx(), [msg('qq-two', [
      { type: 'text', partId: 'a', text: 'A 在先' }, { ...part('first'), inputOrigin: 'history' },
      { type: 'text', partId: 'b', text: 'B 在后' }, { ...part('second'), inputOrigin: 'history' },
      { type: 'text', partId: 'now', text: '任意问题' },
    ])])
    expect(result.attachments).toHaveLength(2)
    const wire = buildOpenAICompatibleMessages(result.history, result.attachments)[0]!.content as Array<{ type: string; text?: string }>
    expect(wire.map(part => part.type)).toEqual(['text', 'image_url', 'text', 'image_url', 'text'])
    expect(wire.at(-1)?.text).toBe('任意问题')
  })

  it('默认一轮持久计数、重建上下文不返老，删除会话清理图片轮数', async () => {
    config.files!.imageContext = {}
    const first = msg(randomUUID(), [part()])
    const one = await planFileInputs(ctx(), [first])
    expect(one.attachments).toHaveLength(1)
    one.commit?.()
    const toolLoop = await planFileInputs(ctx(), [first, msg(randomUUID(), [], 'sense')])
    expect(toolLoop.attachments).toHaveLength(1)
    toolLoop.commit?.()
    const next = await planFileInputs(ctx(), [first, msg(randomUUID())])
    expect(next.attachments).toBeUndefined()
    expect(next.capabilitiesHint).toContain('固定资产引用表示文件已保存')
    expect(next.capabilitiesHint).toContain('file_image_read')
    next.commit?.()
    // A fresh history projection still uses the database's adopted turn ordinal.
    expect((await planFileInputs(ctx(), [msg(randomUUID())])).attachments).toBeUndefined()
    deleteChat(chatId)
    expect(getSoulDb().prepare('SELECT count(*) AS n FROM image_context_turns WHERE chat_id=?').get(chatId)).toEqual({ n: 0 })
  })

  it('补描述返回前请求已取消时，晚到文字不保存为新描述，也不重置轮数', async () => {
    config.files!.imageContext = { mode: 'current', missingDescription: 'inspect', serviceId: 'late-description' }
    const controller = new AbortController()
    const tool = createTestSense(buildFileServiceToolName('late-description', 'image.inspect'), async () => {
      controller.abort()
      return { content: '取消后的晚到观察' }
    }, SupervisionLevel.auto, z.object({ assets: z.array(z.object({ assetId: z.string(), assetVersionId: z.string() })), prompt: z.string() }), { operations: ['image.inspect'], mappings: [{ operation: 'image.inspect', inputAssetField: 'assets', questionField: 'prompt', transferMode: 'asset-id' }] })
    const context = ctx()
    context.runtime = createMockRuntime({ brain: { provider: 'openai', protocol: 'openai-chat-completions', capabilities: { imageInput: { formats: ['image/png'] }, input: { image: 'supported' } } }, senses: [tool] })
    context.requestExecution = { execution: { toolHistory: 'request', retry: 'never' }, signal: controller.signal, validate() {} }
    const history = [msg(randomUUID(), [part()])]
    ;(await planFileInputs(context, history)).commit?.()
    history.push(msg(randomUUID()))
    await expect(planFileInputs(context, history)).rejects.toThrow()
    expect(getImageDescription(chatId, part())).toBeUndefined()
    expect(imageTurnView(chatId, history).images[0]?.ordinal).toBe(1)
  })

  it('请求内工具循环重新准备原始文件，第二次模型请求实际取得图片而非只有成功文字', async () => {
    config.files!.imageContext = { mode: 'current' }
    const history = [msg(randomUUID(), [part()]), msg(randomUUID())]
    const context = ctx()
    ;(await planFileInputs(context, history.slice(0, 1))).commit?.()
    const read = createTestSense('file_image_read', async () => {
      requestImageRead(chatId, 'read-loop', [part()])
      return { content: '{"status":"image_read_prepared"}' }
    }, SupervisionLevel.auto)
    let call = 0
    const chat = vi.fn(async (_messages, _senses, options) => {
      options?.observation?.start()
      return ++call === 1 ? { content: '', calls: [{ id: 'read-loop', name: 'file_image_read', arguments: '{}' }] } : { content: '完成', calls: [] }
    })
    const adapter = mockMessageAdapter({ content: (response: { content: string }) => response.content })
    const build = vi.spyOn(adapter, 'buildMessages')
    context.runtime = createMockRuntime({ brain: { provider: 'openai', protocol: 'openai-chat-completions', capabilities: { imageInput: { formats: ['image/png'] }, input: { image: 'supported' } } }, senses: [read], adapters: {
      llmAdapter: mockLLMAdapter({ chat }), messageAdapter: adapter, senseAdapter: mockSenseAdapter({ senseCalls: (response: { calls: [] }) => response.calls }),
    } })
    context.soul.messages = history
    context.global.stream = false
    context.global.supervision = SupervisionLevel.auto
    context.requestExecution = { execution: { toolHistory: 'request', retry: 'never' }, validate() {} }
    await collectChunks(chatMiddleware(context, makeNext([])))
    expect(chat).toHaveBeenCalledTimes(2)
    expect(build.mock.calls[0]?.[1]).toBeUndefined()
    expect(build.mock.calls.at(-1)?.[1]?.[0]).toMatchObject({ assetId: 'photo', assetVersionId: 'v-photo', data: pngFixture })
    const firstHints = build.mock.calls[0]![0].filter(m => m.id === 'file-input-capabilities')
    expect(firstHints).toHaveLength(1)
    expect(firstHints[0]!.content).toContain('本次请求没有原生图片输入')
    const rereadHints = build.mock.calls.at(-1)![0].filter(m => m.id === 'file-input-capabilities')
    expect(rereadHints).toHaveLength(1)
    expect(rereadHints[0]!.content).toContain('本次请求已附以下原生图片输入')
    expect(rereadHints[0]!.content).toContain('"assetVersionId":"v-photo"')
    expect(rereadHints[0]!.content).not.toContain('本次请求没有原生图片输入')
    expect(imageTurnView(chatId, history).images[0]?.ordinal).toBe(2)
    expect(history).toHaveLength(2)
  })

  it.each(['success', 'failure', 'cancel'] as const)('可选补描述 %s：只调用一次且不改变图片轮数', async outcome => {
    config.files!.imageContext = { mode: 'current', missingDescription: 'inspect', serviceId: 'description-test' }
    const execute = vi.fn(async () => {
      if (outcome === 'failure') throw new Error('模拟失败')
      if (outcome === 'cancel') throw new Error('模拟取消')
      return { content: '一张合成测试图片的说明' }
    })
    const name = buildFileServiceToolName('description-test', 'image.inspect')
    const tool = createTestSense(name, execute, SupervisionLevel.auto, z.object({ assets: z.array(z.object({ assetId: z.string(), assetVersionId: z.string() })), prompt: z.string() }), { operations: ['image.inspect'], mappings: [{ operation: 'image.inspect', inputAssetField: 'assets', questionField: 'prompt', transferMode: 'asset-id' }] })
    const context = ctx()
    context.runtime = createMockRuntime({ brain: { provider: 'openai', protocol: 'openai-chat-completions', capabilities: { imageInput: { formats: ['image/png'] }, input: { image: 'supported' } } }, senses: [tool] })
    const history = [msg(randomUUID(), [part()])]
    ;(await planFileInputs(context, history)).commit?.()
    history.push(msg(randomUUID()))
    const result = await planFileInputs(context, history)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.attachments).toBeUndefined()
    expect(result.plan?.[0]?.action).toBe('describe')
    expect(getImageDescription(chatId, part())?.source).toBe(outcome === 'success' ? 'observation' : undefined)
    await planFileInputs(context, history)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(imageTurnView(chatId, history).images[0]?.ordinal).toBe(1)
  })

  it.each([3, 5])('%i 轮含首次采用，不修改历史，不因工具循环或重试变年轻', async n => {
    config.files!.imageContext!.recentUserTurns = n
    const context = ctx()
    const history = [msg(randomUUID(), [part()])]
    for (let turn = 1; turn <= n + 1; turn++) {
      if (turn > 1) history.push(msg(randomUUID()))
      const result = await planFileInputs(context, history)
      expect(result.attachments?.length ?? 0).toBe(turn <= n ? 1 : 0)
      expect(result.capabilitiesHint).toContain(turn <= n ? '本次请求已附以下原生图片输入' : '本次请求没有原生图片输入')
      expect(result.capabilitiesHint).toContain('实际附在较早用户消息中的图片也是本次图片输入')
      expect(result.capabilitiesHint).toContain('只有旧文字描述而没有实际图片时，仍不算本次看图')
      if (turn > n) {
        expect(result.plan?.[0]?.action).toBe('describe')
        expect(result.history[0]?.content).toContain('暂无视觉描述')
        expect(result.history[0]?.content).toContain('assetVersionId=v-photo')
      }
      result.commit?.()
      result.commit?.()
      expect(imageTurnView(chatId, [...history, msg('assistant', [], 'assistant'), msg('tool', [], 'sense')]).ordinal).toBe(turn)
    }
    expect(history[0]?.parts?.[0]?.type).toBe('asset')
  })

  it('压缩后的新上下文使用持久轮数，不从零开始；准备不提交轮数', async () => {
    const context = ctx()
    const first = msg(randomUUID(), [part()])
    const prepared = await planFileInputs(context, [first])
    expect(getSoulDb().prepare('SELECT COUNT(*) n FROM image_context_turns WHERE chat_id=?').get(chatId)).toEqual({ n: 0 })
    prepared.commit?.()
    for (let turn = 2; turn <= 4; turn++) {
      const compacted = [msg(randomUUID())]
      const result = await planFileInputs(ctx(), compacted)
      expect(result.attachments?.length ?? 0).toBe(turn <= 3 ? 1 : 0)
      result.commit?.()
    }
    expect(imageTurnView(chatId, []).ordinal).toBe(4)
    expect(imageTurnView(chatId, []).images[0]?.ordinal).toBe(1)
  })

  it('重新读图只有实际采用才重置；保存、查询及草稿不改变计数', async () => {
    const first = msg(randomUUID(), [part()])
    const history = [first, msg(randomUUID()), msg(randomUUID()), msg(randomUUID())]
    for (let count = 1; count <= history.length; count++) (await planFileInputs(ctx(), history.slice(0, count))).commit?.()
    requestImageRead(chatId, 'read-call', [{ assetId: 'photo', assetVersionId: 'v-photo' }])
    expect(imageTurnView(chatId, history).images[0]?.ordinal).toBe(1)
    const reading = [...history, { ...msg('assistant-call', [], 'assistant'), senseCalls: [{ id: 'read-call', name: 'file_image_read', arguments: '{}' }] }, msg('read-call', [], 'sense')]
    const result = await planFileInputs(ctx(), reading)
    expect(result.attachments).toHaveLength(1)
    const wire = JSON.stringify(buildOpenAICompatibleMessages(result.history, result.attachments))
    expect(wire).toContain(`data:image/png;base64,${pngFixture.toString('base64')}`)
    expect(wire).toContain('image_url')
    expect(imageTurnView(chatId, reading).images[0]?.ordinal).toBe(1)
    result.commit?.()
    expect(imageTurnView(chatId, reading).images[0]?.ordinal).toBe(4)
    expect(imageTurnView(chatId, reading).requested).toHaveLength(0)
    getImageDescription(chatId, part())
    expect(imageTurnView(chatId, reading).images[0]?.ordinal).toBe(4)
  })

  it('读取失败不消费明确请求，多个明确固定版本按所选顺序处理', async () => {
    requestImageRead(chatId, 'read-call', [part('second'), part('first')])
    const history = [msg(randomUUID()), msg('read-call', [], 'sense')]
    mocks.blocked.add('first')
    await expect(planFileInputs(ctx(), history)).rejects.toThrow('无权访问')
    expect(imageTurnView(chatId, history).requested).toHaveLength(2)
    mocks.blocked.clear()
    const result = await planFileInputs(ctx(), history)
    expect(result.attachments?.map(item => item.assetId)).toEqual(['second', 'first'])
    result.commit?.()
    expect(imageTurnView(chatId, history).requested).toHaveLength(0)
  })

  it('仅当前轮与无限过滤都不突破预算，同版本字节只算一次', async () => {
    config.files!.imageContext = { mode: 'current' }
    const history = [msg(randomUUID(), [part(), { ...part(), partId: 'duplicate' }])]
    const first = await planFileInputs(ctx(), history)
    expect(first.attachments).toHaveLength(1)
    expect(first.usage?.binaryBytes).toBe(pngFixture.length)
    first.commit?.()
    history.push(msg(randomUUID()))
    expect((await planFileInputs(ctx(), history)).attachments).toBeUndefined()
    config.files!.imageContext = { mode: 'unlimited' }
    history.push(msg(randomUUID(), [part('new')]))
    config.files!.context = { maxAssets: 1 }
    const result = await planFileInputs(ctx(), history)
    expect(result.attachments?.map(item => item.assetId)).toEqual(['new'])
    expect(result.plan?.some(item => item.assetId === 'photo' && item.action === 'describe')).toBe(true)
  })

  it('已采用消息后来撤回不让其他图片变年轻，未采用的撤回不计数', async () => {
    const history = [msg(randomUUID(), [part()]), msg(randomUUID()), msg(randomUUID())]
    for (let i = 1; i <= 3; i++) (await planFileInputs(ctx(), history.slice(0, i))).commit?.()
    history[1]!.revoked = true
    history.push({ ...msg(randomUUID()), revoked: true }, msg(randomUUID()))
    const result = await planFileInputs(ctx(), history)
    expect(result.attachments).toBeUndefined()
    expect(result.plan?.[0]?.ageUserTurns).toBe(3)
  })

  it('说明标来源、问题范围与规则版本，不跨版本或会话，不靠文件哈希共享', () => {
    saveImageDescription(chatId, part(), { text: '用户要求一辆红车', source: 'user', scope: '用户说明，未经核实' })
    expect(getImageDescription(chatId, part())).toMatchObject({ source: 'user', ruleVersion: 1 })
    saveImageDescription(chatId, part(), { text: '只核对到招牌第一行', source: 'observation', scope: '局部问答', operationId: 'op' })
    saveImageDescription(chatId, part(), { text: '不得覆盖真实观察', source: 'user', scope: '用户说明' })
    expect(getImageDescription(chatId, part())?.text).toBe('只核对到招牌第一行')
    expect(getImageDescription(chatId, part('photo', 'edited'))).toBeUndefined()
    const other = randomUUID()
    createChat(other, { fileOwnerId: 'image-owner' })
    try { expect(getImageDescription(other, part())).toBeUndefined() } finally { deleteChat(other) }
    expect(() => getImageDescription(chatId, part(), 'other-owner')).toThrow('无权访问')
    mocks.blocked.add('photo')
    expect(listImageDescriptions(chatId)).toEqual([])
  })

  it('撤回来源或撤销文件授权后，说明和最近请求详情均不泄漏缓存', () => {
    const source = randomUUID()
    addMessage(source, chatId, { role: 'user', content: 'private' })
    saveImageDescription(chatId, part(), { text: 'private description', source: 'user', sourceMessageId: source, scope: '用户说明' })
    saveFileRequestPlan(chatId, { requestId: 'r', plan: [{ ...part(), action: 'describe', description: getImageDescription(chatId, part()) }] })
    patchFileRequestPlan(chatId, 'older', { phase: 'sent' })
    expect(getFileRequestPlan(chatId, 'image-owner')).not.toHaveProperty('phase')
    getChatMonthlyDb(chatId)!.prepare('UPDATE messages SET revoked=1 WHERE id=?').run(source)
    expect(getImageDescription(chatId, part())).toBeUndefined()
    saveImageDescription(chatId, part(), { text: '可访问的新观察', source: 'observation', scope: '其他有效来源' })
    expect(JSON.stringify(getFileRequestPlan(chatId, 'image-owner'))).not.toContain('private description')
    mocks.blocked.add('photo')
    expect(JSON.stringify(getFileRequestPlan(chatId, 'image-owner'))).not.toContain('private description')
  })

  it('补描述未知/失败记录持久去重，文件详情可查失败，不发起新操作', () => {
    const key = 'photo:v-photo:rule-1'
    expect(beginDescriptionAttempt(chatId, key)).toBe(true)
    expect(beginDescriptionAttempt(chatId, key)).toBe(false)
    expect(imageDescriptionIssue(chatId, part())).toContain('不会自动重试')
    finishDescriptionAttempt(chatId, key, 'failed')
    expect(beginDescriptionAttempt(chatId, key)).toBe(false)
    expect(imageDescriptionIssue(chatId, part())).toContain('不会自动重试')
    finishDescriptionAttempt(chatId, key)
    expect(imageDescriptionIssue(chatId, part())).toBeUndefined()
  })
})
