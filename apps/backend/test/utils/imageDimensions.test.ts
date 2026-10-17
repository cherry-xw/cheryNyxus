/**
 * 已读取字节的宽高解析；不访问旧媒体目录。
 *
 * 覆盖：
 * - imageDimensions：PNG/JPEG/GIF/WebP(VP8X/VP8L/VP8) 文件头解析与无效字节容错
 */
import { describe, it, expect } from 'vitest'
import { imageDimensions } from '@/service/media/imageDimensions.js'

describe('imageDimensions', () => {

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
    expect(imageDimensions(png(1280, 720))).toEqual({ width: 1280, height: 720 })
  })

  it('JPEG 解析宽高', () => {
    expect(imageDimensions(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it('GIF 解析宽高', () => {
    expect(imageDimensions(gif(320, 240))).toEqual({ width: 320, height: 240 })
  })

  it('WebP VP8X / VP8L / VP8 解析宽高', () => {
    expect(imageDimensions(webpX(800, 600))).toEqual({ width: 800, height: 600 })
    expect(imageDimensions(webpL(900, 700))).toEqual({ width: 900, height: 700 })
    expect(imageDimensions(webpV(640, 480))).toEqual({ width: 640, height: 480 })
  })

  it('空数据 / 不完整文件头 / 不支持格式返回 undefined', () => {
    expect(imageDimensions(Buffer.alloc(0))).toBeUndefined()
    expect(imageDimensions(Buffer.from('GIF89a'))).toBeUndefined()
    const bogus = Buffer.alloc(64)
    bogus.fill(0x41)
    expect(imageDimensions(bogus)).toBeUndefined()
  })
})
