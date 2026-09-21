/**
 * 图片预压缩工具（上传前客户端压缩）。
 *
 * 规则（分情况）：
 * - 非图片 / GIF（动图）/ 未知格式 → 不压缩
 * - 小图（最长边 ≤ COMPRESS_MAX_EDGE 且体积 ≤ COMPRESS_MAX_BYTES）→ 原图直接上传（无压缩版）
 * - 超阈值（最长边 > COMPRESS_MAX_EDGE 或体积 > COMPRESS_MAX_BYTES）→ 上传两个版本：
 *   - 「原图」版（最长边 ORIGINAL_MAX_EDGE、质量 ORIGINAL_QUALITY）：做基本压缩到合理范围，
 *     并非未压缩的原始大图（开启「原图」tag 时发送此版）
 *   - 「压缩」版（最长边 COMPRESS_MAX_EDGE、质量 COMPRESS_QUALITY）：默认发送此版
 * - 透明 PNG 理论上不该强压；无像素级检测的轻量实现下，仅 PNG 且体积超限才压（体积足够大时才压，
 *   小体积透明 PNG 不压），作为近似（详见手动验收项）
 *
 * 依赖浏览器 canvas / URL；node 单测环境仅覆盖判定规则与尺寸换算，canvas 路径由手动验收覆盖。
 */
import type { MediaKind } from '@/features/agent/composer/useAgentDialogOptions'

/** 压缩版最长边阈值（px，默认发送）。 */
export const COMPRESS_MAX_EDGE = 1280
/** 体积阈值（字节）。 */
export const COMPRESS_MAX_BYTES = 1024 * 1024
/** 压缩版 JPEG/WebP 压缩质量。 */
export const COMPRESS_QUALITY = 0.85
/** 「原图」版最长边阈值（px）：基本压缩到合理范围，非原始大图。 */
export const ORIGINAL_MAX_EDGE = 2048
/** 「原图」版 JPEG/WebP 压缩质量。 */
export const ORIGINAL_QUALITY = 0.9

export interface ImageDims {
  width: number
  height: number
}

/** 是否需要压缩：非 GIF、已知尺寸、超尺寸或超体积阈值。dims 缺失时按体积判定。 */
export function shouldCompressImage(
  file: {
    type: string
    size: number
  },
  dims?: ImageDims | null,
): boolean {
  const type = file.type.toLowerCase()
  if (!type.startsWith('image/') || type === 'image/gif') return false
  if (dims) {
    if (dims.width <= 0 || dims.height <= 0) return file.size > COMPRESS_MAX_BYTES
    return Math.max(dims.width, dims.height) > COMPRESS_MAX_EDGE || file.size > COMPRESS_MAX_BYTES
  }
  return file.size > COMPRESS_MAX_BYTES
}

/** 读取图片实际尺寸（Image + URL.createObjectURL）。失败 → null。 */
export function loadImageDims(file: Blob): Promise<ImageDims | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null)
      return
    }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight }
      URL.revokeObjectURL(url)
      resolve(dims)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

/**
 * 压缩图片（最长边 maxEdge、质量 quality）。返回压缩后的 Blob 与尺寸；canvas 不可用/失败 → null。
 * 透明 PNG 压缩会丢失透明度（转 JPEG），故调用方对 PNG 应谨慎选择输出格式。
 */
export async function compressImage(
  file: Blob,
  options: { maxEdge?: number; quality?: number; mimeType?: string } = {},
): Promise<{ blob: Blob; dims: ImageDims } | null> {
  if (typeof HTMLCanvasElement === 'undefined' || typeof Image === 'undefined') return null
  const maxEdge = options.maxEdge ?? COMPRESS_MAX_EDGE
  const quality = options.quality ?? COMPRESS_QUALITY
  const dims = await loadImageDims(file)
  if (!dims || dims.width <= 0 || dims.height <= 0) return null
  const scale = Math.min(1, maxEdge / Math.max(dims.width, dims.height))
  const outW = Math.max(1, Math.round(dims.width * scale))
  const outH = Math.max(1, Math.round(dims.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('图片解码失败'))
      img.src = url
    })
    ctx.drawImage(img, 0, 0, outW, outH)
    // PNG 保持 PNG 输出（保留透明），其余转 JPEG/WebP（压缩质量生效）
    const outType =
      options.mimeType ??
      (file.type === 'image/png'
        ? 'image/png'
        : file.type === 'image/webp'
          ? 'image/webp'
          : 'image/jpeg')
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), outType, quality)
    })
    if (!blob) return null
    return { blob, dims: { width: outW, height: outH } }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 前端媒体 kind 归一（file.type → image/video/audio/undefined）。 */
export function mediaKindOf(file: { type: string }): MediaKind | undefined {
  const t = file.type.toLowerCase()
  if (t.startsWith('image/')) return 'image'
  if (t.startsWith('video/')) return 'video'
  if (t.startsWith('audio/')) return 'audio'
  return undefined
}
