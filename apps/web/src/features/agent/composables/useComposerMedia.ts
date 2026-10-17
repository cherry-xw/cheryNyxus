/** Shared file upload flow. Original bytes are never transformed in the browser. */
import type { UploadFile } from 'element-plus'
import { reactive, watch, onBeforeUnmount } from 'vue'
import { fileApi } from '@/application/files/public'
import type { AssetRecord } from '@/application/files/public'

export type MediaKind = 'image' | 'video' | 'audio'
export interface MediaAttachment {
  assetId: string
  assetVersionId: string
  filename: string
  kind: AssetRecord['kind']
  mimeType: string
  size: number
  previewUrl: string
  referenceId?: string
  cancelled?: boolean
  usage?: 'content' | 'reference-only'
  variant?: 'original' | 'adapted'
  status?: 'uploading' | 'ready' | 'failed'
  error?: string
  retry?: () => Promise<void>
  adapt?: () => Promise<void>
  adapting?: boolean
  copy?: () => Promise<void>
  width?: number
  height?: number
  compressed?: { assetId: string; assetVersionId: string; filename: string; mimeType: string; size: number; width?: number; height?: number }
  useCompressed?: boolean
}
export function mediaKindOf(file: File): AssetRecord['kind'] {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  if (file.type.startsWith('audio/')) return 'audio'
  return file.type === 'application/pdf' || file.type.startsWith('text/') ? 'document' : 'file'
}

/** 每个引用单独保存所选版本，不改动历史或同文件的其他引用。 */
export function configureImageAdaptation(attachment: MediaAttachment, chatId?: string): void {
  if (attachment.kind !== 'image' || attachment.variant === 'adapted') return
  const context = fileApi.contextKey()
  attachment.adapt = async () => {
    if (attachment.cancelled || attachment.status !== 'ready' || attachment.adapting || context !== fileApi.contextKey()) return
    attachment.adapting = true
    attachment.error = undefined
    try {
      const adapted = await fileApi.adapt(attachment.assetId, chatId)
      if (attachment.cancelled || context !== fileApi.contextKey()) return
      attachment.compressed = { assetId: adapted.id, assetVersionId: adapted.versionId,
        filename: adapted.originalName, mimeType: adapted.mimeType, size: adapted.sizeBytes,
        width: adapted.transform?.width, height: adapted.transform?.height }
      attachment.useCompressed = true
    } catch (cause) {
      if (!attachment.cancelled && context === fileApi.contextKey()) attachment.error = `适配失败，原始文件仍可使用：${cause instanceof Error ? cause.message : '未知错误'}`
    } finally { attachment.adapting = false }
  }
}
export interface ComposerMediaOptions {
  defaultImageVariant?: () => 'original' | 'adapted'
  attachments: { value: MediaAttachment[] }
  uploading: { value: boolean }
  mediaHint: { value: string }
  sending: () => boolean
  hasCapability?: (category: MediaKind) => boolean
  generation: () => number
  isCurrent: (generation: number) => boolean
  prepare?: () => unknown
  inserted?: (attachment: MediaAttachment) => void
}
export function useComposerMedia(options: ComposerMediaOptions) {
  let draftId = crypto.randomUUID()
  let leaseContext = fileApi.contextKey()
  let disposed = false
  let leaseTimer: ReturnType<typeof setInterval> | undefined
  const retain = () => {
    if (disposed) return
    const contextKey = fileApi.contextKey()
    if (leaseContext !== contextKey) { draftId = crypto.randomUUID(); leaseContext = contextKey }
    const assets = options.attachments.value.filter(item => item.status !== 'failed' && item.assetVersionId).flatMap(item => [
      { assetId: item.assetId, assetVersionId: item.assetVersionId },
      ...(item.compressed ? [{ assetId: item.compressed.assetId, assetVersionId: item.compressed.assetVersionId }] : []),
    ])
    void fileApi.retainDraft(draftId, assets).catch(cause => { if (!disposed && contextKey === fileApi.contextKey()) options.mediaHint.value = `草稿文件保留失败：${cause instanceof Error ? cause.message : '请稍后重试'}` })
  }
  watch(() => options.attachments.value.map(item => `${item.assetVersionId}:${item.compressed?.assetVersionId ?? ''}`).join(','), () => {
    clearInterval(leaseTimer)
    retain()
    if (options.attachments.value.length) leaseTimer = setInterval(retain, 60_000)
  })
  onBeforeUnmount(() => { disposed = true; clearInterval(leaseTimer) })
  async function onMediaSelected(upload: UploadFile): Promise<void> {
    const file = upload.raw
    if (!file || options.sending()) return
    const generation = options.generation()
    const uploadContext = fileApi.contextKey()
    const attachment = reactive<MediaAttachment>({
      assetId: `upload-${crypto.randomUUID()}`, assetVersionId: '', filename: file.name,
      kind: mediaKindOf(file), mimeType: file.type || 'application/octet-stream', size: file.size,
      previewUrl: URL.createObjectURL(file), usage: 'content', status: 'uploading',
      referenceId: crypto.randomUUID(),
    })
    options.attachments.value.push(attachment)
    if (!options.inserted) attachment.referenceId = undefined
    options.inserted?.(attachment)
    let running = false
    const run = async () => {
      if (attachment.cancelled || running || uploadContext !== fileApi.contextKey()) return
      running = true
      options.uploading.value = true
      attachment.status = 'uploading'
      attachment.error = undefined
      try {
        const asset = await fileApi.upload(file)
        if (attachment.cancelled || uploadContext !== fileApi.contextKey()) return
        Object.assign(attachment, { assetId: asset.id, assetVersionId: asset.versionId,
          filename: asset.originalName, mimeType: asset.mimeType, kind: asset.kind, size: asset.sizeBytes,
          width: asset.transform?.width, height: asset.transform?.height, status: 'ready' })
        configureImageAdaptation(attachment)
        if (asset.kind === 'image' && (options.defaultImageVariant?.() ?? 'adapted') === 'adapted') await attachment.adapt?.()
        if (options.isCurrent(generation)) options.mediaHint.value = `${file.name} 已上传；发送后按所选方式使用`
      } catch (cause) {
        if (!attachment.cancelled && uploadContext === fileApi.contextKey()) {
          attachment.status = 'failed'
          attachment.error = cause instanceof Error ? cause.message : '文件上传失败'
          if (options.isCurrent(generation)) options.mediaHint.value = attachment.error
        }
      } finally {
        running = false
        if (options.isCurrent(generation)) options.uploading.value = options.attachments.value.some(a => a.status === 'uploading')
      }
    }
    attachment.retry = run
    await run()
  }
  return { onMediaSelected }
}
