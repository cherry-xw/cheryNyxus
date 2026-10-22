import sharp from 'sharp'
import type { BrainCapabilities, FilesImageAdaptationConfig } from '@chery/plugin-api'

export interface PreparedImage {
  data: Buffer
  mimeType: string
  width: number
  height: number
  preservedTransparency: boolean
  preservedAnimation: boolean
}
const decoders = { limitInputPixels: 268_402_689, animated: true, failOn: 'warning' as const }
const mime = (format?: string) => format === 'jpg' ? 'image/jpeg' : `image/${format}`
function reject(message: string): never {
  throw Object.assign(new Error(message), { code: 'image.input_unavailable' })
}
/** Encode in memory; publish only a verified, bounded result. No pixel-based target-size policy. */
export async function prepareImage(data: Buffer, options: FilesImageAdaptationConfig = {},
  capability?: BrainCapabilities['imageInput']): Promise<PreparedImage> {
  const maxEdge = options.maxEdge ?? 2048
  const quality = options.quality ?? 85 // Encoding ceiling only; never estimate or reduce an original's quality.
  const maxBytes = options.maxBytes ?? 5_000_000
  if (!Number.isInteger(maxEdge) || maxEdge < 1 || maxEdge > 16384 || !Number.isInteger(quality) || quality < 1 || quality > 100 || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    reject('图片适配参数无效')
  const meta = await sharp(data, decoders).metadata()
  if (!meta.width || !meta.height) reject('图片尺寸无效')
  // Sharp's PNG reader does not expose APNG frames on every build. Never silently flatten them.
  if (meta.format === 'png') {
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset)
      if (data.toString('ascii', offset + 4, offset + 8) === 'acTL') reject('PNG 动图暂不能保证保留全部动画，未携带；原件保留')
      offset += 12 + length
    }
  }
  const animated = (meta.pages ?? 1) > 1
  if (animated && capability && capability.animation !== 'supported')
    reject(`模型动画能力为 ${capability.animation ?? 'unknown'}，不能保证读取完整动画，未携带；原件保留`)
  const formats = capability ? capability.formats ?? [] : ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  const supported = formats.filter(f => ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(f))
  const originalMime = mime(meta.format)
  const accepted = supported.includes(originalMime as typeof supported[number])
  const target = accepted ? originalMime : (animated ? ['image/webp', 'image/gif'] : meta.hasAlpha ? ['image/png', 'image/webp'] : ['image/png', 'image/webp', 'image/jpeg', 'image/gif']).find(f => supported.includes(f as typeof supported[number]))
  if (!target) reject('当前模型未声明可保留透明通道的可用图片格式，未携带；原件保留')
  if (animated && !['image/webp', 'image/gif'].includes(target)) reject('目标格式不能保留全部动画，未携带；原件保留')
  const bound = Math.min(maxBytes, capability?.maxBytes ?? Infinity, capability?.maxBase64Bytes === undefined ? Infinity : Math.floor(capability.maxBase64Bytes / 4) * 3)
  const fits = (bytes: number) => bytes <= bound && (capability?.maxBase64Bytes === undefined || 4 * Math.ceil(bytes / 3) <= capability.maxBase64Bytes)
  const frameHeight = meta.pageHeight ?? meta.height
  // Validate even when bytes can pass through unchanged.
  if (accepted && fits(data.length) && Math.max(meta.width, frameHeight) <= maxEdge) {
    await sharp(data, decoders).timeout({ seconds: 30 }).stats()
    return { data, mimeType: originalMime, width: meta.width, height: frameHeight, preservedTransparency: !!meta.hasAlpha, preservedAnimation: animated }
  }
  let edge = Math.min(maxEdge, Math.max(meta.width, frameHeight))
  // Each step is bounded. Reduce quality only to meet a hard limit, never merely because an image is small.
  for (let attempt = 0; attempt < 24; attempt++) {
    const q = Math.max(1, quality - (attempt % 3) * 20)
    let pipeline = sharp(data, decoders)
    if (!animated) pipeline = pipeline.autoOrient()
    pipeline = pipeline.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    switch (target) {
      case 'image/jpeg': pipeline = pipeline.jpeg({ quality: q }); break
      case 'image/png': pipeline = pipeline.png({ compressionLevel: 9 }); break
      case 'image/webp': pipeline = pipeline.webp({ quality: q, alphaQuality: 100 }); break
      case 'image/gif': pipeline = pipeline.gif({ keepDuplicateFrames: true, effort: 7 }); break
    }
    const result = await pipeline.timeout({ seconds: 30 }).toBuffer({ resolveWithObject: true })
    if (fits(result.data.length)) {
      const out = await sharp(result.data, decoders).metadata()
      if (animated && (out.pages !== meta.pages || JSON.stringify(out.delay) !== JSON.stringify(meta.delay) || out.loop !== meta.loop))
        reject('编码结果未保留全部动画帧及时间，未携带；原件保留')
      if (meta.hasAlpha && !out.hasAlpha) reject('编码结果未保留透明通道，未携带；原件保留')
      return { data: result.data, mimeType: mime(out.format), width: out.width!, height: out.pageHeight ?? out.height!, preservedTransparency: !!out.hasAlpha, preservedAnimation: animated }
    }
    if (attempt % 3 === 2) {
      if (edge === 1) break
      edge = Math.max(1, Math.floor(edge / 2))
    }
  }
  reject('图片无法在有限处理次数内满足单图字节硬上限，未携带；原件保留')
}
