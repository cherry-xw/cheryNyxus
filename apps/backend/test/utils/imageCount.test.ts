import { describe, expect, it } from 'vitest'
import { calculateImageCount, ImageOutputCapabilitySchema, requestedImageCount, withoutImageCountParams, imageParameterFields } from '@chery/protocol'
import config from '@/utils/config.js'
import { resolveImageOutput, imageCountParams } from '@/service/fileServices/imageOutput.js'
import { migrateLegacyFileConfig } from '@/utils/fileConfigMigration.js'
import type { FileServiceConfig } from '@chery/plugin-api'

const multi = { nativeMultiImage: 'supported' as const, countControl: 'requested' as const, maxImagesPerRequest: 4 }
describe('绘图数量与配置', () => {
  it('保留原期望，按模型与输入合计上限计算；未知不伪装固定单图', () => {
    expect(calculateImageCount(6, multi)).toMatchObject({ desiredCount: 6, effectiveCount: 4 })
    expect(calculateImageCount(6, { ...multi, maxImagesPerRequest: 9 }).effectiveCount).toBe(6)
    expect(calculateImageCount(6, { ...multi, maxInputAndOutputImages: 5 }, 3).effectiveCount).toBe(2)
    expect(() => calculateImageCount(1, { ...multi, maxInputAndOutputImages: 5 }, 5)).toThrow('合计上限')
    expect(calculateImageCount(6, { nativeMultiImage: 'unsupported', countControl: 'unknown' }).effectiveCount).toBe(1)
    expect(calculateImageCount(6, { nativeMultiImage: 'unknown', countControl: 'unknown' }).effectiveCount).toBeUndefined()
    expect(calculateImageCount(6, { nativeMultiImage: 'unknown', countControl: 'uncontrolled' }).effectiveCount).toBeUndefined()
    for (const invalid of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => calculateImageCount(invalid, multi)).toThrow()
  })
  it('矛盾能力保存拒绝，厂商当次数量只接受一个一致值', () => {
    expect(ImageOutputCapabilitySchema.safeParse({ ...multi, maxImagesPerRequest: 1 }).success).toBe(false)
    expect(ImageOutputCapabilitySchema.safeParse({ nativeMultiImage: 'unsupported', countControl: 'requested', maxImagesPerRequest: 9 }).success).toBe(false)
    expect(() => requestedImageCount({ n: 3 }, 4)).toThrow('冲突')
    expect(requestedImageCount({ sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 3 } })).toBe(3)
    expect(withoutImageCountParams({ n: 4, quality: 'high', seed: 23 })).toEqual({ quality: 'high', seed: 23 })
  })
  it('纯迁移只移除服务数量默认，保留显式全局默认、凭据及历史快照', () => {
    const raw = { files: { imageGeneration: { defaultCount: 6 } }, file_services: { svc: { defaults: { n: 4, sampleCount: 2, sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 5 }, quality: 'high' }, connection: { keyRef: 'keep' } } },
      history: { params: { n: 8 }, outputs: ['keep-file'] } }
    const before = JSON.stringify(raw)
    const result = migrateLegacyFileConfig(raw)
    expect(result.config.file_services.svc.defaults).toEqual({ quality: 'high' })
    expect(result.config.files.imageGeneration.defaultCount).toBe(6)
    expect(result.config.history).toEqual(raw.history)
    expect(result.config.file_services.svc.connection.keyRef).toBe('keep')
    expect(JSON.stringify(raw)).toBe(before)
    expect(migrateLegacyFileConfig(result.config).changed).toBe(false)
    expect((migrateLegacyFileConfig({ file_services: {} }).config as any).files.imageGeneration.defaultCount).toBe(1)
  })
  it('接口隔离、固定单图无数量参数，maximum 不被手动声明变成按张数承诺', () => {
    const service: FileServiceConfig = { name: '测试', adapter: 'doubao-seedream', operations: ['image.generate'],
      connection: { baseUrl: 'https://example.test', model: 'doubao-seedream-5-0-pro', keyRef: 'test-key', capabilities: { imageOutput: { 'image.generate': { ...multi, maxImagesPerRequest: 15 } } } } }
    const single = resolveImageOutput({ service, operation: 'image.generate', desiredCount: 6, config })
    expect(single.count.effectiveCount).toBe(1)
    expect(imageCountParams(service, single, { prompt: 'test', n: 1 })).toEqual({ prompt: 'test' })
    service.connection.model = 'doubao-seedream-4-5'
    const maximum = resolveImageOutput({ service, operation: 'image.generate', desiredCount: 6, config })
    expect(maximum.count.countControl).toBe('maximum')
    expect(imageCountParams(service, maximum, {})).toEqual({ sequential_image_generation: 'auto', sequential_image_generation_options: { max_images: 6 } })
    service.adapter = 'openai-responses-image'; service.connection.model = 'chat-model'
    expect(resolveImageOutput({ service, operation: 'image.generate', desiredCount: 6, params: { image_model: 'gpt-image-1' }, config }).count).toMatchObject({ countControl: 'uncontrolled', nativeMultiImage: 'unknown' })
    service.adapter = 'openai-images'; service.connection.capabilities = undefined; service.connection.model = 'unverified-endpoint'
    expect(resolveImageOutput({ service, operation: 'image.generate', config }).availability).toBe('unknown')
  })
  it('字段按实际型号显示，数量不再出现在服务默认字段中', () => {
    expect(imageParameterFields('minimax-images', 'image-01')).not.toHaveProperty('n')
    expect(imageParameterFields('openai-images', 'gpt-image-1').size!.enum).toEqual(['auto', '1024x1024', '1536x1024', '1024x1536'])
    expect(imageParameterFields('doubao-seedream', 'doubao-seedream-5-0-pro')).not.toHaveProperty('seed')
    expect(imageParameterFields('google-gemini-image', 'gemini-2.5-flash-image').imageConfig!.properties).not.toHaveProperty('imageSize')
  })
})
