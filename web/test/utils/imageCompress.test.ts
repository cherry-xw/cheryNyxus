/**
 * 图片预压缩判定 + 前端 token 估算单测。
 *
 * 覆盖：
 * - shouldCompressImage：GIF 不压 / 非图片不压 / 超尺寸或超体积压 / 小图不压
 * - mediaKindOf：image/video/audio 归一
 * - estimateImageTokens：low/default/high 与后端公式一致
 */
import { describe, it, expect } from 'vitest'
import { shouldCompressImage, mediaKindOf, COMPRESS_MAX_EDGE, COMPRESS_MAX_BYTES } from '@/utils/imageCompress'
import { estimateImageTokens } from '@/utils/mediaTokens'

describe('shouldCompressImage', () => {
  const small = { type: 'image/png', size: 100 * 1024 }
  const bigFile = { type: 'image/png', size: 2 * 1024 * 1024 }

  it('GIF 动图不强制压缩', () => {
    expect(shouldCompressImage({ type: 'image/gif', size: 9 * 1024 * 1024 })).toBe(false)
  })

  it('非图片不压缩', () => {
    expect(shouldCompressImage({ type: 'video/mp4', size: 9 * 1024 * 1024 })).toBe(false)
    expect(shouldCompressImage({ type: 'text/plain', size: 9 * 1024 * 1024 })).toBe(false)
  })

  it('尺寸超阈值（>1280 最长边）→ 压缩', () => {
    expect(
      shouldCompressImage(small, { width: COMPRESS_MAX_EDGE + 1, height: 800 }),
    ).toBe(true)
  })

  it('体积超阈值（>1MB）→ 压缩（即使尺寸小）', () => {
    expect(shouldCompressImage(bigFile, { width: 800, height: 600 })).toBe(true)
    expect(shouldCompressImage(bigFile)).toBe(true)
  })

  it('小图（不超尺寸也不超体积）→ 不压缩', () => {
    expect(shouldCompressImage(small, { width: 800, height: 600 })).toBe(false)
    expect(shouldCompressImage({ type: 'image/jpeg', size: 512 * 1024 }, { width: 1000, height: 1000 })).toBe(false)
  })

  it('dims 缺失时仅按体积判定', () => {
    expect(shouldCompressImage(small)).toBe(false)
    expect(shouldCompressImage(bigFile)).toBe(true)
  })
})

describe('mediaKindOf', () => {
  it('按 MIME 前缀归一', () => {
    expect(mediaKindOf({ type: 'image/png' })).toBe('image')
    expect(mediaKindOf({ type: 'video/mp4' })).toBe('video')
    expect(mediaKindOf({ type: 'audio/wav' })).toBe('audio')
    expect(mediaKindOf({ type: 'application/pdf' })).toBeUndefined()
  })
})

describe('estimateImageTokens', () => {
  it('与后端公式一致：low=85 / default tile 上限 4 / high 无上限', () => {
    expect(estimateImageTokens(1024, 1024)).toBe(765) // 4 tiles
    expect(estimateImageTokens(1500, 1500)).toBe(765) // 9 tiles → clamp 4
    expect(estimateImageTokens(1500, 1500, 'high')).toBe(1615) // 9 tiles
    expect(estimateImageTokens(4096, 4096, 'low')).toBe(85)
    expect(estimateImageTokens(0, 100)).toBe(0)
  })
})
