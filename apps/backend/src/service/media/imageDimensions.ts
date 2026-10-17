/**
 * 从调用方已获授权的字节读取宽高；不访问文件系统，不解码图像。
 * 不支持或不完整的文件头返回 undefined。
 */
export function imageDimensions(
  buf: Buffer,
): { width: number; height: number } | undefined {
  if (buf.length < 16) return undefined

  // PNG: 签名 89 50 4E 47；IHDR width/height（大端）位于 offset 16/20
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return undefined
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }

  // JPEG: FF D8 起，扫到 SOF0-15 段（除 C4/C8/CC）取 height/width
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buf[offset + 1]!
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01
      ) {
        offset += 2
        continue
      }
      const len = buf.readUInt16BE(offset + 2)
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof && offset + 9 <= buf.length) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        }
      }
      offset += 2 + len
    }
    return undefined
  }

  // GIF: 签名 GIF；逻辑屏宽高（小端）位于 offset 6/8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }

  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
      const fourcc = buf.toString('latin1', 12, 16)
      if (fourcc === 'VP8X' && buf.length >= 30) {
        const width = 1 + buf[24]! + (buf[25]! << 8) + (buf[26]! << 16)
        const height = 1 + buf[27]! + (buf[28]! << 8) + (buf[29]! << 16)
        return { width, height }
      }
      if (fourcc === 'VP8 ' && buf.length >= 26) {
        // lossy：chunk 数据内 offset 22 起两个 14-bit 小端宽高
        return {
          width: buf.readUInt16LE(22) & 0x3fff,
          height: buf.readUInt16LE(24) & 0x3fff,
        }
      }
      if (fourcc === 'VP8L' && buf.length >= 21) {
        // lossless：offset 17 起 4 字节：bits0-13=width-1, bits14-27=height-1
        const bits = buf.readUInt32LE(17)
        return {
          width: (bits & 0x3fff) + 1,
          height: ((bits >> 14) & 0x3fff) + 1,
        }
      }
    }
    return undefined
  }

  return undefined
}
