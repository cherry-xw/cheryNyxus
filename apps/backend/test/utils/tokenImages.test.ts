/**
 * 本地图片 token 估算 + 媒体文件宽高同步解析单测。
 *
 * 覆盖：
 * - estimateImageTokens：low/default/high 三档、tile 计算、default 4-tile 上限、非法尺寸兜底
 * - readImageDimensionsSync：PNG/JPEG/GIF/WebP(VP8X/VP8L/VP8) 头部解析、非法文件名/文件缺失容错
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateImageTokens } from '@/utils/token.js'
import { readImageDimensionsSync } from '@/service/media/index.js'

describe('estimateImageTokens', () => {
  it('low 固定 85', () => {
    expect(estimateImageTokens({ width: 4096, height: 4096, detail: 'low' })).toBe(85)
  })

  it('default：512 以内 1 tile = 255；tile 上限 4（765）', () => {
    expect(estimateImageTokens({ width: 100, height: 100 })).toBe(255)
    expect(estimateImageTokens({ width: 512, height: 512 })).toBe(255)
    expect(estimateImageTokens({ width: 1024, height: 1024 })).toBe(765) // 4 tiles
    expect(estimateImageTokens({ width: 1500, height: 1500 })).toBe(765) // 9 tiles → clamp 4
  })

  it('high：不设 tile 上限', () => {
    expect(estimateImageTokens({ width: 1024, height: 1024, detail: 'high' })).toBe(765) // 4 tiles
    expect(estimateImageTokens({ width: 1500, height: 1500, detail: 'high' })).toBe(1615) // 9 tiles
  })

  it('非法/零尺寸兜底 0', () => {
    expect(estimateImageTokens({ width: 0, height: 100 })).toBe(0)
    expect(estimateImageTokens({ width: -1, height: 100 })).toBe(0)
    expect(estimateImageTokens({ width: NaN, height: 100 })).toBe(0)
  })
})

describe('readImageDimensionsSync', () => {
  let dir: string
  let mediaDir: string
  const put = (filename: string, buf: Buffer) => {
    writeFileSync(join(mediaDir, filename), buf)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chery-media-test-'))
    mediaDir = join(dir, '.chery', 'media')
    mkdirSync(mediaDir, { recursive: true })
    process.env.CHERY_DIR = dir
  })

  afterEach(() => {
    delete process.env.CHERY_DIR
    rmSync(dir, { recursive: true, force: true })
  })

  // 各格式最小头部构造（解析器不校验 CRC/校验和）
  const png = (w: number, h: number) => {
    const buf = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
    buf.writeUInt32BE(13, 8)
    buf.write('IHDR', 12, 'latin1')
    buf.writeUInt32BE(w, 16)
    buf.writeUInt32BE(h, 20)
    buf[24] = 8
    buf[25] = 2
    return buf
  }
  const jpeg = (w: number, h: number) => {
    const buf = Buffer.alloc(20)
    buf[0] = 0xff
    buf[1] = 0xd8
    buf[2] = 0xff
    buf[3] = 0xc0
    buf.writeUInt16BE(17, 4)
    buf[6] = 8
    buf.writeUInt16BE(h, 7)
    buf.writeUInt16BE(w, 9)
    buf[11] = 3
    return buf
  }
  const gif = (w: number, h: number) => {
    const buf = Buffer.alloc(16)
    buf.write('GIF89a', 0, 'latin1')
    buf.writeUInt16LE(w, 6)
    buf.writeUInt16LE(h, 8)
    return buf
  }
  const webpX = (w: number, h: number) => {
    const buf = Buffer.alloc(30)
    buf.write('RIFF', 0, 'latin1')
    buf.writeUInt32LE(22, 4)
    buf.write('WEBP', 8, 'latin1')
    buf.write('VP8X', 12, 'latin1')
    const w24 = w - 1
    const h24 = h - 1
    buf[24] = w24 & 0xff
    buf[25] = (w24 >> 8) & 0xff
    buf[26] = (w24 >> 16) & 0xff
    buf[27] = h24 & 0xff
    buf[28] = (h24 >> 8) & 0xff
    buf[29] = (h24 >> 16) & 0xff
    return buf
  }
  const webpL = (w: number, h: number) => {
    const buf = Buffer.alloc(21)
    buf.write('RIFF', 0, 'latin1')
    buf.writeUInt32LE(13, 4)
    buf.write('WEBP', 8, 'latin1')
    buf.write('VP8L', 12, 'latin1')
    buf[16] = 0x2f
    buf.writeUInt32LE(w - 1 | ((h - 1) << 14), 17)
    return buf
  }
  const webpV = (w: number, h: number) => {
    const buf = Buffer.alloc(26)
    buf.write('RIFF', 0, 'latin1')
    buf.writeUInt32LE(18, 4)
    buf.write('WEBP', 8, 'latin1')
    buf.write('VP8 ', 12, 'latin1')
    buf[19] = 0x9d
    buf[20] = 0x01
    buf[21] = 0x2a
    buf.writeUInt16LE(w & 0x3fff, 22)
    buf.writeUInt16LE(h & 0x3fff, 24)
    return buf
  }

  it('PNG 解析宽高', () => {
    put('aaa.png', png(1280, 720))
    expect(readImageDimensionsSync('aaa.png')).toEqual({ width: 1280, height: 720 })
  })

  it('JPEG 解析宽高', () => {
    put('bbb.jpg', jpeg(1920, 1080))
    expect(readImageDimensionsSync('bbb.jpg')).toEqual({ width: 1920, height: 1080 })
  })

  it('GIF 解析宽高', () => {
    put('ccc.gif', gif(320, 240))
    expect(readImageDimensionsSync('ccc.gif')).toEqual({ width: 320, height: 240 })
  })

  it('WebP VP8X / VP8L / VP8 解析宽高', () => {
    put('a1b2.webp', webpX(800, 600))
    expect(readImageDimensionsSync('a1b2.webp')).toEqual({ width: 800, height: 600 })
    put('c3d4.webp', webpL(900, 700))
    expect(readImageDimensionsSync('c3d4.webp')).toEqual({ width: 900, height: 700 })
    put('e5f6.webp', webpV(640, 480))
    expect(readImageDimensionsSync('e5f6.webp')).toEqual({ width: 640, height: 480 })
  })

  it('文件缺失 / 非法文件名 / 不支持格式 → undefined（不抛）', () => {
    expect(readImageDimensionsSync('no-such-file.png')).toBeUndefined()
    expect(readImageDimensionsSync('not hex name.png')).toBeUndefined()
    const bogus = Buffer.alloc(64)
    bogus.fill(0x41)
    put('bogus.png', bogus)
    expect(readImageDimensionsSync('bogus.png')).toBeUndefined()
  })
})
