import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import config, { type MediaServiceConfig } from '@/utils/config.js'

export type MediaKind = 'image' | 'video' | 'audio'

export interface MediaAsset {
  id: string
  kind: MediaKind
  mimeType: string
  filename: string
  path: string
  size: number
}

const MIME_KIND: Record<string, MediaKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
  'audio/mp4': 'audio',
  'audio/webm': 'audio',
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
}

function mediaRoot(): string {
  return resolve(process.env.CHERY_DIR || process.cwd(), '.chery', 'media')
}

export function mediaKindForMime(mimeType: string): MediaKind | undefined {
  return MIME_KIND[mimeType.toLowerCase()]
}

/** 按 kind 查找第一个已启用的命名媒体服务。旧 config.media[kind] 直查改为遍历命名服务集合。 */
function findMediaService(kind: MediaKind): (MediaServiceConfig & { name: string }) | undefined {
  if (!config.media) return undefined
  for (const [name, svc] of Object.entries(config.media)) {
    if (svc.type === kind && svc.enabled && svc.url) return { ...svc, name }
  }
  return undefined
}

/**
 * 同步读取图片宽高（只读文件头，不加载全图）。PNG/JPEG/GIF/WebP（VP8/VP8L/VP8X）。
 * 供 token 估算等不需要完整解码的场景使用；文件缺失/格式不支持/解析失败 → undefined（容错不抛）。
 */
export function readImageDimensionsSync(
  filename: string,
): { width: number; height: number } | undefined {
  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(filename)) return undefined
  let buf: Buffer
  try {
    buf = readFileSync(join(mediaRoot(), filename))
  } catch {
    return undefined
  }
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

const DEFAULT_MAX_UPLOAD_MB = 100

export async function saveMediaAsset(
  body: Buffer,
  mimeType: string,
  originalName = 'upload',
): Promise<MediaAsset> {
  const kind = mediaKindForMime(mimeType)
  if (!kind) throw new Error('暂不支持这种媒体类型')
  const svc = findMediaService(kind)
  const maxMb = svc?.maxUploadMb ?? DEFAULT_MAX_UPLOAD_MB
  const maxBytes = maxMb * 1024 * 1024
  if (body.length === 0 || body.length > maxBytes) throw new Error(`媒体太大了（上限 ${maxMb}MiB）`)
  const id = randomUUID()
  const extension =
    extname(basename(originalName)).replace(/[^.a-z0-9]/gi, '') ||
    { image: '.bin', video: '.bin', audio: '.bin' }[kind]
  const filename = `${id}${extension}`
  const root = mediaRoot()
  await mkdir(root, { recursive: true })
  const path = join(root, filename)
  await writeFile(path, body)
  return { id, kind, mimeType, filename, path, size: body.length }
}

export async function readMediaAsset(
  filename: string,
): Promise<{ data: Buffer; mimeType: string } | undefined> {
  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(filename)) return undefined
  const path = join(mediaRoot(), filename)
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return undefined
  const mimeByExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  }
  return {
    data: await readFile(path),
    mimeType: mimeByExtension[extname(filename).toLowerCase()] ?? 'application/octet-stream',
  }
}

/**
 * 按 filename 解析完整 MediaAsset（含 path），供生成参考图（图生图）等场景传给 callMediaService。
 * 文件缺失/非法名/类型未知 → undefined（容错不抛）。
 */
export async function resolveMediaAsset(filename: string): Promise<MediaAsset | undefined> {
  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(filename)) return undefined
  const path = join(mediaRoot(), filename)
  const info = await stat(path).catch(() => undefined)
  if (!info?.isFile()) return undefined
  const mimeType = MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream'
  const kind = mediaKindForMime(mimeType)
  if (!kind) return undefined
  return {
    id: filename.slice(0, filename.indexOf('.')),
    kind,
    mimeType,
    filename,
    path,
    size: info.size,
  }
}

/** 媒体网关统一协议：网关接收 JSON，媒体二进制以 base64 编码，返回文本和/或 base64 资产。 */
export async function callMediaService(
  kind: MediaKind,
  operation: 'understand' | 'generate' | 'edit',
  input: { prompt?: string; assets?: MediaAsset[] },
): Promise<{
  text?: string
  assets?: Array<{ data: string; mimeType: string; filename?: string }>
}> {
  const service = findMediaService(kind)
  if (!service) throw new Error(`媒体服务 "${kind}" 没开启，请在设置里检查`)
  const assets = await Promise.all(
    (input.assets ?? []).map(async (asset) => ({
      id: asset.id,
      mimeType: asset.mimeType,
      filename: asset.filename,
      data: (await readFile(asset.path)).toString('base64'),
    })),
  )
  const response = await fetch(service.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(service.key ? { Authorization: `Bearer ${service.key}` } : {}),
    },
    body: JSON.stringify({ operation, model: service.model, prompt: input.prompt, assets }),
  })
  if (!response.ok) throw new Error(`媒体服务 "${kind}" 暂时用不了`)
  return (await response.json()) as {
    text?: string
    assets?: Array<{ data: string; mimeType: string; filename?: string }>
  }
}

/** 从本地受控资产生成理解结果，供聊天中间件在 LLM 调用前注入文本上下文。 */
export async function understandMediaReference(
  filename: string,
): Promise<{ kind: MediaKind; text: string }> {
  const asset = await readMediaAsset(filename)
  if (!asset) throw new Error('媒体文件不存在')
  const kind = mediaKindForMime(asset.mimeType)
  if (!kind) throw new Error('媒体类型不支持')
  const service = findMediaService(kind)
  if (!service) throw new Error(`媒体服务 "${kind}" 没开启，请在设置里检查`)
  const response = await fetch(service.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(service.key ? { Authorization: `Bearer ${service.key}` } : {}),
    },
    body: JSON.stringify({
      operation: 'understand',
      model: service.model,
      assets: [{ filename, mimeType: asset.mimeType, data: asset.data.toString('base64') }],
    }),
  })
  if (!response.ok) throw new Error(`媒体服务 "${kind}" 暂时用不了`)
  const result = (await response.json()) as { text?: string }
  if (!result.text) throw new Error(`媒体服务 "${kind}" 没返回结果`)
  return { kind, text: result.text }
}
