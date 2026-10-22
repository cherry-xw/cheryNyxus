import { cpSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadModelCatalog,
  resetModelCatalogCache,
  resolveEffectiveBrainCapabilities,
  resolveModelCatalog,
  normalizeCapabilityState,
  isCapabilitySupported,
} from '@/utils/modelCatalog.js'
import {
  deriveTextContentFromParts,
  findFileServiceAdapterDefinition,
  MessagePartSchema,
  AssetRecordSchema,
  FileOperationRecordSchema,
} from '@chery/protocol'

const TEMPLATE_CATALOG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.chery.template/model-catalog.yaml',
)

describe('modelCatalog 三态能力与输出能力解析', () => {
  beforeEach(() => {
    const cheryDir = process.env.CHERY_DIR!
    cpSync(TEMPLATE_CATALOG, join(cheryDir, '.chery', 'model-catalog.yaml'))
    resetModelCatalogCache()
  })

  it('目录区分动画语义与字节计量，未知模型格式可覆盖但不从协议猜测', () => {
    const resolveImage = (model: string) => resolveEffectiveBrainCapabilities({ model, protocol: 'openai-chat-completions' }).imageInput
    expect(resolveImage('MiniMax-M3').animation).toBe('unknown')
    expect(resolveImage('MiniMax-M3.1-Flash-Preview').maxBytes).toBe(10000000)
    expect(resolveImage('gpt-5.6').animation).toBe('unsupported')
    expect(resolveEffectiveBrainCapabilities({ model: 'claude-opus-4.7', protocol: 'anthropic-messages' }).imageInput).toMatchObject({ animation: 'first-frame', maxBase64Bytes: 10000000 })
    expect(resolveImage('custom-not-known')).toEqual({})
    expect(resolveEffectiveBrainCapabilities({ model: 'custom-not-known', userCapabilities: { input: { image: 'supported' }, imageInput: { formats: ['image/png'], maxBytes: 1234 } } }).imageInput).toEqual({ formats: ['image/png'], maxBytes: 1234 })
  })

  it('normalize capability state helper', () => {
    expect(normalizeCapabilityState(true)).toBe('supported')
    expect(normalizeCapabilityState(false)).toBe('unsupported')
    expect(normalizeCapabilityState(undefined)).toBeUndefined()
    expect(normalizeCapabilityState('supported')).toBe('supported')
    expect(normalizeCapabilityState('unsupported')).toBe('unsupported')
    expect(normalizeCapabilityState('unknown')).toBe('unknown')
    expect(isCapabilitySupported(true)).toBe(true)
    expect(isCapabilitySupported('supported')).toBe(true)
    expect(isCapabilitySupported(false)).toBe(false)
    expect(isCapabilitySupported('unsupported')).toBe(false)
    expect(isCapabilitySupported('unknown')).toBe(false)
  })

  it('已收录 Gemini 生图模型具备 image 输入输出但 PDF 保持未知', () => {
    const entry = resolveModelCatalog({
      model: 'gemini-3-pro-image',
      provider: 'google',
    })
    expect(entry.matched).toBe(true)

    const resolved = resolveEffectiveBrainCapabilities({
      model: 'gemini-3-pro-image',
      provider: 'google',
    })
    expect(resolved.input.image).toEqual({ state: 'supported', source: 'catalog' })
    expect(resolved.input.pdf).toEqual({ state: 'unknown', source: 'catalog' })
    expect(resolved.output.image).toEqual({ state: 'supported', source: 'catalog' })
  })

  it('未收录模型且无用户覆盖时三态落入 unknown（fail-closed）', () => {
    const entry = resolveModelCatalog({
      model: 'custom-unlisted-model-xyz',
      provider: 'custom',
    })
    expect(entry.confidence).toBe('unknown')

    const resolved = resolveEffectiveBrainCapabilities({
      model: 'custom-unlisted-model-xyz',
      provider: 'custom',
    })
    expect(resolved.input.image.state).toBe('unknown')
    expect(resolved.input.pdf.state).toBe('unknown')
    expect(resolved.output.image.state).toBe('unknown')
    expect(isCapabilitySupported(resolved.input.image.state)).toBe(false)
    expect(isCapabilitySupported(resolved.output.image.state)).toBe(false)
  })

  it('用户显式配置覆盖目录推断', () => {
    const resolved = resolveEffectiveBrainCapabilities({
      model: 'custom-unlisted-model-xyz',
      userCapabilities: {
        toolCall: false,
        input: { image: 'supported', pdf: false },
        output: { image: true },
      },
    })
    expect(resolved.toolCall).toEqual({ enabled: false, source: 'user' })
    expect(resolved.input.image).toEqual({ state: 'supported', source: 'user' })
    expect(resolved.input.pdf).toEqual({ state: 'unsupported', source: 'user' })
    expect(resolved.output.image).toEqual({ state: 'supported', source: 'user' })
  })

  it('模型目录包含 OpenAI / Gemini / Imagen / Seedream / MiniMax 代表模型', () => {
    const catalog = loadModelCatalog()
    expect(catalog.models.length).toBeGreaterThan(0)
    for (const model of [
      'gpt-image-1.5',
      'gemini-2.5-flash-image',
      'imagen-4.0-generate-001',
      'doubao-seedream-5-0-pro-260628',
      'image-01',
    ]) {
      const m = resolveModelCatalog({ model })
      expect(m.matched, `model ${model} should match catalog`).toBe(true)
      expect(isCapabilitySupported(m.facts?.capabilities?.output?.image)).toBe(true)
    }
  })
})

describe('protocol 契约：适配器表、AssetRecord、有序 parts 与 FileOperationRecord', () => {
  it('官方文件服务适配器目录完整且支持查询', () => {
    for (const id of [
      'openai-images',
      'openai-responses-image',
      'google-gemini-image',
      'google-imagen',
      'doubao-seedream',
      'minimax-images',
      'vision-brain',
      'custom-sense-mcp',
    ] as const) {
      const def = findFileServiceAdapterDefinition(id)
      expect(def?.id).toBe(id)
      expect(def?.supportedOperations.length).toBeGreaterThan(0)
    }
  })

  it('有序 MessagePart 校验与纯文本投影', () => {
    const parts = [
      { partId: 'p1', type: 'text' as const, text: '请对比这两张图' },
      {
        partId: 'p2',
        type: 'asset' as const,
        assetId: 'asset_1',
        assetVersionId: 'ver_1',
        variant: 'adapted' as const,
        usage: 'content' as const,
        originalName: 'v1.png',
        kind: 'image' as const,
      },
      {
        partId: 'p3',
        type: 'asset' as const,
        assetId: 'asset_2',
        assetVersionId: 'ver_1',
        variant: 'original' as const,
        usage: 'reference-only' as const,
        originalName: 'raw.psd',
        caption: '仅附文件',
        kind: 'file' as const,
      },
    ]
    for (const p of parts) {
      expect(MessagePartSchema.safeParse(p).success).toBe(true)
    }
    const text = deriveTextContentFromParts(parts)
    expect(text).toContain('请对比这两张图')
    expect(text).toContain('[文件: v1.png]')
    expect(text).toContain('[文件: raw.psd (仅附文件)]')
  })

  it('AssetRecord 与 FileOperationRecord schema 校验', () => {
    const asset = AssetRecordSchema.safeParse({
      id: 'asset_abc',
      versionId: 'ver_1',
      originalName: 'out.png',
      mimeType: 'image/png',
      kind: 'image',
      sizeBytes: 10240,
      sha256: 'deadbeef',
      createdAt: Date.now(),
      source: 'tool',
      chatId: 'chat_1',
      transform: {
        variant: 'original',
        width: 1024,
        height: 1024,
        preservedTransparency: true,
      },
    })
    expect(asset.success).toBe(true)

    const op = FileOperationRecordSchema.safeParse({
      operationId: 'op_1',
      operation: 'image.generate',
      inputAssets: [],
      targetKind: 'tool',
      targetId: 'file_gemini_image_generate',
      executionStatus: 'succeeded',
      deliveryStatus: 'saved',
      inspectionStatus: 'not_requested',
      outputParts: [
        { partId: 'out_1', type: 'text', text: '已生成海报初稿' },
        {
          partId: 'out_2',
          type: 'asset',
          assetId: 'asset_abc',
          assetVersionId: 'ver_1',
          variant: 'original',
          usage: 'content',
        },
      ],
      outputAssetIds: ['asset_abc'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    expect(op.success).toBe(true)
  })
})
