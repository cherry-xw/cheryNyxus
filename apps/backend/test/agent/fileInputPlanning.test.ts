import sharp from 'sharp'
import { buildOpenAICompatibleMessages } from '@/agent/provider/openaiCompat.js'
import { createHash } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AssetRecord, MessageAssetPart, MessagePart } from '@chery/protocol'
import type { LLMResponse } from '@/core/message/adapter.js'
import { planFileInputs, supportsNativeFile } from '@/agent/middleware/fileInputPlanning.js'
import { SupervisionLevel } from '@/core/config.js'
import config from '@/utils/config.js'
import { createMockContext, createMockRuntime, createTestSense } from './helpers/fakeContext.js'

const mocks = vi.hoisted(() => ({ get: vi.fn(), read: vi.fn(), execute: vi.fn(), dispatch: vi.fn(), preset: vi.fn<() => string | undefined>() }))
const observations = vi.hoisted(() => new Map<string, unknown>())
let pngFixture: Buffer
const descriptions = vi.hoisted(() => new Map<string, { text: string; keywords: string[]; source: string; scope: string; createdAt: number }>())
vi.mock('@/service/fileServices/imageContext.js', () => ({
  imageKey: (ref: { assetId: string; assetVersionId: string }) => `${ref.assetId}:${ref.assetVersionId}`,
  imageTurnView: (_chatId: string, history: LLMResponse[]) => {
    const turns = history.filter(message => message.role === 'user' && !message.ephemeral && !message.revoked && !message.modelExcluded).map((message, index) => ({ id: message.id, ordinal: index + 1 }))
    return { ordinal: turns.length, turns, activeOrdinals: turns.map(turn => turn.ordinal), images: [], requested: [] }
  },
  commitImageInputs: vi.fn(),
  getImageDescription: (_chat: string, ref: { assetId: string }) => descriptions.get(ref.assetId),
  saveImageDescription: (_chat: string, ref: { assetId: string }, value: { text: string; source: string; scope: string }) => descriptions.set(ref.assetId, { ...value, keywords: ['已有关键词'], createdAt: 1 }),
  beginDescriptionAttempt: () => true,
  finishDescriptionAttempt: vi.fn(),
}))
vi.mock('@/service/fileServices/inputObservations.js', () => ({
  getFileInputObservation: (chatId: string, key: string) => observations.get(`${chatId}:${key}`),
  saveFileInputObservation: (chatId: string, key: string, output: unknown) => observations.set(`${chatId}:${key}`, output),
}))
vi.mock('@/service/media/store.js', () => ({ getAssetStore: () => ({ get: mocks.get, read: mocks.read }) }))
vi.mock('@/service/media/access.js', () => ({ fileAccessForChat: () => ({ ownerId: 'owner', chatId: 'test-chat' }) }))
vi.mock('@/db/chat.js', () => ({ getChatType: () => '__testHarness', getChatPreset: () => mocks.preset(), getChatWorkspace: () => undefined }))
vi.mock('@/agent/hooks/index.js', () => ({ dispatch: (...args: unknown[]) => mocks.dispatch(...args) }))

const initialFiles = config.files
const part = (id = 'image', overrides: Partial<MessageAssetPart> = {}): MessageAssetPart => ({
  type: 'asset', partId: `p-${id}`, assetId: id, assetVersionId: `v-${id}`, variant: 'original', usage: 'content', ...overrides,
})
const msg = (id: string, parts: MessagePart[] = [{ type: 'text', partId: `t-${id}`, text: '问题' }], role: LLMResponse['role'] = 'user'): LLMResponse => ({
  id, role, parts, content: '这不是权威文字', createdAt: 0, updateAt: 0,
})
const asset = (id: string, mimeType = 'image/png', sizeBytes = 10): AssetRecord => ({
  id, versionId: `v-${id}`, originalName: id, mimeType, sizeBytes,
  kind: mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('audio/') ? 'audio' : 'document',
  sha256: id.padEnd(64, '0'), createdAt: 0, source: 'upload', ownerId: 'owner', availability: 'available', transform: { variant: 'original' },
})
const nativeContext = () => createMockContext({ runtime: createMockRuntime({ brain: {
  provider: 'openai', capabilities: { imageInput: { formats: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], animation: 'unknown' }, input: { image: 'supported', audio: 'unsupported', pdf: 'unsupported' } },
} }) })
const understanding = (name = 'inspect', transferMode: 'asset-id' | 'base64' | 'data-url' = 'asset-id', level = SupervisionLevel.auto) => createTestSense(
  name, mocks.execute, level, undefined,
  { operations: ['image.inspect'], mappings: [{ operation: 'image.inspect', inputAssetField: 'files', questionField: 'question', transferMode, resultPath: 'answer', constantParams: { language: 'zh' } }] },
)

beforeEach(async () => {
  pngFixture = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } }).png().toBuffer()
  vi.clearAllMocks()
  observations.clear()
  descriptions.clear()
  mocks.preset.mockReturnValue(undefined)
  config.files = { ...initialFiles, context: {}, imageContext: { recentUserTurns: 3 } }
  delete config.roles!.__testHarness!.fileCapabilities
  mocks.get.mockImplementation((id: string) => asset(id))
  mocks.read.mockImplementation(async (id: string) => ({ asset: asset(id), data: await sharp({ create: { width: 8 + id.length, height: 8, channels: 3, background: `#${createHash('sha256').update(id).digest('hex').slice(0, 6)}` } }).png().toBuffer() }))
  mocks.execute.mockResolvedValue({ content: JSON.stringify({ answer: '联合观察' }) })
  mocks.dispatch.mockResolvedValue(undefined)
})
afterEach(() => { config.files = initialFiles; delete config.roles!.__testHarness!.fileCapabilities })

describe('结构化文件请求计划', () => {
  it('合规原图以原始字节和固定版本进入原生请求，不因质量上限重编码', async () => {
    config.files!.imageAdaptation = { quality: 1 }
    mocks.read.mockResolvedValue({ asset: asset('a'), data: pngFixture })
    const history = [msg('reuse', [part('a')])]
    const result = await planFileInputs(nativeContext(), history)
    expect(result.attachments![0]!.data).toBe(pngFixture)
    expect(result.attachments![0]).toMatchObject({ assetId: 'a', assetVersionId: 'v-a', variant: 'original' })
    expect(result.usage!.binaryBytes).toBe(pngFixture.length)
    expect(JSON.stringify(buildOpenAICompatibleMessages(result.history, result.attachments))).toContain(`data:image/png;base64,${pngFixture.toString('base64')}`)
    expect(history[0]!.parts).toEqual([part('a')])
  })
  it('格式转换后的真实字节用于预算，重复图片只带一个，原固定引用不变', async () => {
    const data = await sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } } }).tiff().toBuffer()
    mocks.get.mockImplementation((id: string) => ({ ...asset(id, 'image/tiff', 9000000), sha256: createHash('sha256').update(data).digest('hex') }))
    mocks.read.mockImplementation(async (id: string) => ({ asset: mocks.get(id), data }))
    const ctx = nativeContext()
    ctx.runtime!.brain.capabilities!.imageInput = { formats: ['image/png'] }
    config.files!.context = { maxBinaryBytes: 2000, maxAssets: 1 }
    const history = [msg('converted', [part('a'), part('b')])]
    const result = await planFileInputs(ctx, history)
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments![0]!.mimeType).toBe('image/png')
    expect(result.usage!.binaryBytes).toBe(result.attachments![0]!.data.length)
    expect(result.usage!.binaryBytes).toBeLessThanOrEqual(2000)
    expect(JSON.stringify(buildOpenAICompatibleMessages(result.history, result.attachments))).toContain(`data:image/png;base64,${result.attachments![0]!.data.toString('base64')}`)
    expect(history[0]!.parts).toEqual([part('a'), part('b')])
  })
  it('不可达图片只报告未携带原因，不携带超限原件', async () => {
    config.files!.imageAdaptation = { maxBytes: 1 }
    const result = await planFileInputs(nativeContext(), [msg('tiny', [part('a')])])
    expect(result.attachments).toBeUndefined()
    expect(result.plan![0]!.binaryBytes).toBe(0)
    expect(result.history[0]!.content).toContain('硬上限')
  })
  it('默认一轮，工具消息不推进，下一用户轮用占位且无收费理解', async () => {
    config.files!.imageContext = {}
    const input = msg('image-turn', [part('image')])
    expect((await planFileInputs(nativeContext(), [input, msg('tool', [], 'sense')])).attachments).toHaveLength(1)
    const next = await planFileInputs(nativeContext(), [input, msg('next')])
    expect(next.attachments).toBeUndefined()
    expect(next.history[0]!.content).toContain('暂无视觉描述')
    expect(mocks.execute).not.toHaveBeenCalled()
    const again = await planFileInputs(nativeContext(), [input, msg('next', [part('image')])])
    expect(again.attachments).toHaveLength(1)
  })

  it('不同上传的压缩缩放同图预算后仅一个payload，保留三人文字和固定版本关联', async () => {
    config.files!.context = { maxAssets: 1 }
    const original = await sharp({ create: { width: 512, height: 384, channels: 3, background: '#246898' } }).png().toBuffer()
    const bytes: Record<string, Buffer> = { a: original, b: await sharp(original).jpeg({ quality: 85 }).toBuffer(), c: await sharp(original).resize(256).webp().toBuffer() }
    mocks.get.mockImplementation((id: string) => ({ ...asset(id), sha256: createHash('sha256').update(bytes[id]!).digest('hex'), sizeBytes: bytes[id]!.length }))
    mocks.read.mockImplementation(async (id: string) => ({ asset: mocks.get(id), data: bytes[id]! }))
    const history = [msg('merged', [
      { type: 'text', partId: 'a-text', text: 'A说原图' }, part('a'),
      { type: 'text', partId: 'b-text', text: 'B说压缩' }, part('b'),
      { type: 'text', partId: 'c-text', text: 'C说缩放' }, part('c'),
    ])]
    const result = await planFileInputs(nativeContext(), history)
    expect(result.attachments).toHaveLength(1)
    expect(result.usage?.binaryBytes).toBe(original.length)
    expect(result.history[0]!.content).toContain('A说原图')
    expect(result.history[0]!.content).toContain('B说压缩')
    expect(result.history[0]!.content).toContain('C说缩放')
    expect(result.history[0]!.content).toContain('a:v-a')
    expect(history[0]!.parts?.filter(p => p.type === 'asset')).toHaveLength(3)
  })

  it('仅附文件不查询资产，也不调用工具；保持原始历史不变', async () => {
    const history = [msg('u', [part('a', { usage: 'reference-only' })])]
    const original = structuredClone(history)
    const result = await planFileInputs(nativeContext(), history)
    expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(result.plan?.[0]?.action).toBe('omit')
    expect(history).toEqual(original)
    expect(result.capabilitiesHint).toContain('本次请求没有原生图片输入')
    expect(result.capabilitiesHint).not.toContain('本次请求已附以下原生图片输入')
  })

  it('普通用户轮推进窗口，角色回复不推进', async () => {
    const history = [msg('old', [part()]), msg('one'), msg('two'), msg('child', [], 'role'), msg('three')]
    const result = await planFileInputs(nativeContext(), history)
    expect(result.attachments).toBeUndefined()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(result.plan?.[0]?.reason).toContain('用户轮')
  })

  it('0 轮仍保留本次明确引用，不带旧输入或生成成果', async () => {
    config.files!.context = { recentUserTurns: 0 }
    config.files!.imageContext = { mode: 'current' }
    const result = await planFileInputs(nativeContext(), [msg('old', [part('old')]), msg('output', [part('output')], 'assistant'), msg('current', [part('new')])])
    expect(result.attachments?.map((a) => a.assetId)).toEqual(['new'])
  })

  it('原生附件保留固定版本、消息与部分位置；不限制新增五项', async () => {
    const history = [msg('u', Array.from({ length: 6 }, (_, i) => part(`${i}`)))]
    const result = await planFileInputs(nativeContext(), history)
    expect(result.attachments).toHaveLength(6)
    expect(result.attachments?.[0]).toMatchObject({ assetId: '0', assetVersionId: 'v-0', variant: 'original', messageId: 'u', partId: 'p-0' })
    expect(mocks.read).toHaveBeenCalledWith('0', { ownerId: 'owner', chatId: 'test-chat' }, 'v-0')
    expect(result.history[0]?.parts).toEqual(history[0]?.parts)
    expect(result.capabilitiesHint).toContain('发送给模型的整组消息，不只是最后一条用户消息')
    expect(result.capabilitiesHint).toContain('本次请求已附以下原生图片输入')
    expect(result.capabilitiesHint).toContain('"assetId":"0","assetVersionId":"v-0"')
  })

  it('当前显式文件超预算在任何读取及工具调用前报错', async () => {
    config.files!.context = { maxAssets: 1 }
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [understanding()] }) })
    await expect(planFileInputs(ctx, [msg('u', [part('a'), part('b')])])).rejects.toMatchObject({ code: 'asset.too_large' })
    expect(mocks.execute).not.toHaveBeenCalled()
    // Visual grouping reads eligible bytes before the post-dedupe budget is calculated.
    expect(mocks.read).toHaveBeenCalled()
  })

  it('历史预算不足只裁掉旧内容，保留原因', async () => {
    config.files!.context = { maxAssets: 1 }
    const result = await planFileInputs(nativeContext(), [msg('old', [part('old')]), msg('now', [part('new')])])
    expect(result.attachments?.map((a) => a.assetId)).toEqual(['new'])
    expect(result.plan?.find((p) => p.assetId === 'old')).toMatchObject({ action: 'describe', reason: expect.stringContaining('预算') })
    const nativeStatus = result.capabilitiesHint!.split('\n').find(line => line.startsWith('本次请求已附'))!
    expect(nativeStatus).toContain('"assetId":"new"')
    expect(nativeStatus).not.toContain('"assetId":"old"')
  })

  it('混合输入按文件选择，文本提取不执行代码', async () => {
    mocks.get.mockImplementation((id: string) => asset(id, id === 'code' ? 'text/javascript' : 'image/png'))
    mocks.read.mockImplementation(async (id: string) => ({ asset: mocks.get(id), data: id === 'code' ? Buffer.from('process.exit(1)') : pngFixture }))
    const result = await planFileInputs(nativeContext(), [msg('u', [part('image'), part('code')])])
    expect(result.attachments).toHaveLength(1)
    expect(result.plan?.map((p) => p.action)).toEqual(['native', 'extract'])
    expect(result.history[0]?.content).toContain('process.exit(1)')
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('不把 PDF 布尔声明当作聊天接口可用证明', () => {
    expect(supportsNativeFile('openai-chat-completions', 'application/pdf')).toBe(false)
    expect(supportsNativeFile('anthropic-messages', 'application/pdf')).toBe(true)
    expect(supportsNativeFile('anthropic-messages', 'image/svg+xml')).toBe(false)
  })

  it('同一个问题的相关文件一次映射并联合理解', async () => {
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [understanding()] }) })
    const history = [msg('u', [{ type: 'text', partId: 'question', text: '比较这两份内容' }, part('a'), part('b')])]
    const result = await planFileInputs(ctx, history)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.execute.mock.calls[0]?.[0]).toEqual({ language: 'zh', question: '比较这两份内容', files: [
      { assetId: 'a', assetVersionId: 'v-a' }, { assetId: 'b', assetVersionId: 'v-b' },
    ] })
    expect(result.history[0]?.content.match(/联合观察/g)).toHaveLength(1)
    expect(result.attachments).toBeUndefined()
    expect(result.capabilitiesHint).toContain('本次请求没有原生图片输入')
    expect(result.capabilitiesHint).toContain('本次已提供以下图片的理解工具文字观察')
    expect(result.capabilitiesHint).not.toContain('本次请求已附以下原生图片输入')
    expect(history[0]?.content).toBe('这不是权威文字')
  })

  it('多个候选不按注册顺序选第一个', async () => {
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [understanding('a'), understanding('b')] }) })
    await expect(planFileInputs(ctx, [msg('u', [part()])])).rejects.toMatchObject({ code: 'capability.selection_required' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('无工具调用模型只执行显式绑定的理解工具', async () => {
    const ctx = createMockContext({ runtime: createMockRuntime({ brain: { capabilities: { toolCall: false } }, senses: [understanding()] }) })
    await expect(planFileInputs(ctx, [msg('u', [part()])])).rejects.toMatchObject({ code: 'capability.unavailable' })
    config.roles!.__testHarness!.fileCapabilities = { 'image.inspect': { mode: 'tool', targetId: 'inspect' } }
    expect((await planFileInputs(ctx, [msg('u', [part()])])).plan?.[0]?.action).toBe('tool')
  })

  it('disabled 阻止原生输入及工具绕过', async () => {
    config.roles!.__testHarness!.fileCapabilities = { 'image.inspect': { mode: 'disabled' } }
    await expect(planFileInputs(nativeContext(), [msg('u', [part()])])).rejects.toMatchObject({ code: 'capability.unavailable' })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('预设覆盖不能取消角色默认的文件操作禁用', async () => {
    const name = '__fileInputDisabledPreset'
    const previous = config.presets?.[name]
    config.roles!.__testHarness!.fileCapabilities = { 'image.inspect': { mode: 'disabled' } }
    config.presets![name] = { leader: '__testHarness', roles: ['__testHarness'], roleOverrides: { __testHarness: { fileCapabilities: { 'image.inspect': { mode: 'native' } } } } }
    mocks.preset.mockReturnValue(name)
    try {
      await expect(planFileInputs(nativeContext(), [msg('u', [part()])])).rejects.toMatchObject({ code: 'capability.unavailable' })
      expect(mocks.read).not.toHaveBeenCalled()
    } finally {
      if (previous) config.presets![name] = previous
      else delete config.presets![name]
    }
  })

  it.each([SupervisionLevel.manual, SupervisionLevel.smart])('监管等级 %s 不自动审批', async (level) => {
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [understanding('inspect', 'asset-id', level)] }) })
    await expect(planFileInputs(ctx, [msg('u', [part()])])).rejects.toMatchObject({ code: 'capability.requires_approval' })
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('只复用同问题、同版本、同处理对象的成功观察', async () => {
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [understanding()] }) })
    const history = [msg('u', [{ type: 'text', partId: 'q', text: '第一个问题' }, part()])]
    await planFileInputs(ctx, history)
    await planFileInputs(ctx, history)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    const next = [msg('u', [{ type: 'text', partId: 'q', text: '另一个问题' }, part()])]
    await planFileInputs(ctx, next)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
  })

  it('远程 MCP 用受控字节映射，不泄露本地路径', async () => {
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [understanding('mcp__vision__inspect', 'data-url')] }) })
    const result = await planFileInputs(ctx, [msg('u', [part()])])
    expect(result.plan?.[0]?.action).toBe('tool')
    expect(mocks.execute.mock.calls[0]?.[0]?.files).toEqual([`data:image/png;base64,${(await mocks.read.mock.results[0]!.value).data.toString('base64')}`])
  })

  it('同一用户问题的工具循环不重复理解，新用户问题重新理解', async () => {
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [understanding()] }) })
    const history = [msg('u', [{ type: 'text', partId: 'q', text: '图片上有什么？' }, part()])]
    await planFileInputs(ctx, history)
    const withToolLoop = [...history, msg('assistant', [{ type: 'text', partId: 'a', text: '正在处理' }], 'assistant'), msg('tool', [], 'sense')]
    await planFileInputs(ctx, withToolLoop)
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    await planFileInputs(ctx, [...withToolLoop, msg('followup', [{ type: 'text', partId: 'followup-q', text: '招牌的第二行写了什么？' }])])
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    expect(mocks.execute.mock.calls[1]?.[0]?.question).toContain('招牌的第二行')
  })

  it('同一理解工具联合读取不同用户轮中仍在范围内的文件', async () => {
    const ctx = createMockContext({ runtime: createMockRuntime({ senses: [understanding()] }) })
    await planFileInputs(ctx, [msg('first', [part('a')]), msg('second', [part('b')]),
      msg('compare', [{ type: 'text', partId: 'q', text: '比较前面两张图片的区别' }])])
    expect(mocks.execute).toHaveBeenCalledTimes(1)
    expect(mocks.execute.mock.calls[0]?.[0]?.files).toEqual([
      { assetId: 'a', assetVersionId: 'v-a' }, { assetId: 'b', assetVersionId: 'v-b' },
    ])
    expect(mocks.execute.mock.calls[0]?.[0]?.question).toContain('比较前面两张图片')
  })
})
