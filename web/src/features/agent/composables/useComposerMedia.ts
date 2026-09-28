/**
 * 媒体上传编排（AgentDialog 与 Lite 视图共用）。
 *
 * 职责：能力门控 → 预览 → 图片双版本压缩 → 并行上传 → 附件对象落列。
 * 两端差异通过钩子注入：
 * - 能力探测（Agent 用主角色 selection；Lite 用会话历史回扫）；
 * - 过期守卫（Agent 的 draftGeneration；Lite 无此概念传恒真）；
 * - 前置准备（Agent 清空上传队列；Lite ensureConfig）。
 */
import type { UploadFile } from 'element-plus'
import {
  COMPRESS_MAX_EDGE,
  COMPRESS_QUALITY,
  ORIGINAL_MAX_EDGE,
  ORIGINAL_QUALITY,
  compressImage,
  loadImageDims,
  shouldCompressImage,
} from '@/utils/imageCompress'
import { agentApi } from '@/services/agentApi'

export type MediaKind = 'image' | 'video' | 'audio'

export interface MediaAttachment {
  assetId: string
  filename: string
  kind: MediaKind
  mimeType: string
  size: number
  previewUrl: string
  width?: number
  height?: number
  compressed?: {
    assetId: string
    filename: string
    mimeType: string
    size: number
    width: number
    height: number
  }
  useCompressed?: boolean
}

/** 媒体类型判定（按 MIME 前缀；不识别 → undefined）。 */
export function mediaKindOf(file: File): MediaKind | undefined {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return undefined
}

export interface ComposerMediaOptions {
  /** 附件目标列表（响应式引用，由调用方持有）。 */
  attachments: { value: MediaAttachment[] }
  /** 上传中状态（由调用方持有；守卫放行时才置 true/复位）。 */
  uploading: { value: boolean }
  /** 提示文案（由调用方持有）。 */
  mediaHint: { value: string }
  /** 发送中标志（忙时不接受新上传）。 */
  sending: () => boolean
  /** 能力门控：当前类别是否可上传（工具命中或模型原生）。 */
  hasCapability: (category: MediaKind) => boolean
  /** 过期守卫：返回当前代序；上传各阶段比对代序决定是否继续/回写（不需要时传恒等函数）。 */
  generation: () => number
  /** 过期判断：代序是否仍是当前。 */
  isCurrent: (generation: number) => boolean
  /** 前置准备（进入上传前的钩子；返回值会被等待，内容忽略）。 */
  prepare?: () => unknown
}

export function useComposerMedia(options: ComposerMediaOptions) {
  const {
    attachments,
    uploading,
    mediaHint,
    sending,
    hasCapability,
    generation,
    isCurrent,
    prepare,
  } = options

  async function onMediaSelected(uploadFile: UploadFile): Promise<void> {
    const file = uploadFile.raw
    if (!file || uploading.value || sending()) return
    if (prepare) await prepare()
    const category = mediaKindOf(file)
    if (!category) return
    if (!hasCapability(category)) {
      const typeLabel = category === 'image' ? '图片' : category === 'video' ? '视频' : '音频'
      mediaHint.value = `当前感官组无处理${typeLabel}的工具，且模型不支持原生${typeLabel}`
      return
    }
    const currentGeneration = generation()
    uploading.value = true
    mediaHint.value = '上传媒体中…'
    try {
      const previewUrl = URL.createObjectURL(file)
      const dims = category === 'image' ? await loadImageDims(file) : null
      if (!isCurrent(currentGeneration)) return
      // 图片预压缩：超阈值（最长边>1280 或 >1MB）→ 上传「原图版(2048/90) + 压缩版(1280/85)」双版本，
      // 默认发压缩版；「原图」tag 开启时发原图版（已基本压缩，非原始大图）。压缩失败回退原始文件。
      if (category === 'image' && shouldCompressImage(file, dims)) {
        const [origTier, compTier] = await Promise.all([
          compressImage(file, { maxEdge: ORIGINAL_MAX_EDGE, quality: ORIGINAL_QUALITY }),
          compressImage(file, { maxEdge: COMPRESS_MAX_EDGE, quality: COMPRESS_QUALITY }),
        ])
        if (!isCurrent(currentGeneration)) return
        if (origTier && compTier) {
          const [origAsset, compAsset] = await Promise.all([
            agentApi.uploadMedia(
              new File([origTier.blob], `original-${file.name}`, { type: origTier.blob.type }),
            ),
            agentApi.uploadMedia(
              new File([compTier.blob], `compressed-${file.name}`, { type: compTier.blob.type }),
            ),
          ])
          if (!isCurrent(currentGeneration)) return
          attachments.value.push({
            assetId: origAsset.id,
            filename: origAsset.filename,
            kind: 'image',
            mimeType: origAsset.mimeType,
            size: origAsset.size,
            previewUrl,
            width: origTier.dims.width,
            height: origTier.dims.height,
            useCompressed: true,
            compressed: {
              assetId: compAsset.id,
              filename: compAsset.filename,
              mimeType: compAsset.mimeType,
              size: compAsset.size,
              width: compTier.dims.width,
              height: compTier.dims.height,
            },
          })
          mediaHint.value = `${file.name} 已附加`
          return
        }
      }
      // 小图 / 非图片 / 压缩失败 → 上传原始文件
      const asset = await agentApi.uploadMedia(file)
      if (!isCurrent(currentGeneration)) return
      const base: MediaAttachment = {
        assetId: asset.id,
        filename: asset.filename,
        kind: asset.kind,
        mimeType: asset.mimeType,
        size: asset.size,
        previewUrl,
        useCompressed: false,
      }
      if (category === 'image' && dims) {
        base.width = dims.width
        base.height = dims.height
      }
      attachments.value.push(base)
      mediaHint.value = `${file.name} 已附加`
    } catch (err) {
      if (isCurrent(currentGeneration)) mediaHint.value = (err as Error).message
    } finally {
      if (isCurrent(currentGeneration)) uploading.value = false
    }
  }

  return { onMediaSelected }
}
