import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { fileApi, type AssetRecord, type MessagePart } from '@/application/files/public'
import { FILE_REFERENCE_TARGET, useFileReferenceTargets } from '../composer/fileReferenceTarget'

export function useAssetCard(props: { part: Extract<MessagePart, { type: 'asset' }>; chatId?: string }) {
  const asset = ref<AssetRecord>()
  const error = ref('')
  const busy = ref(false)
  const previewOpen = ref(false)
  const previewUrl = ref('')
  const previewText = ref('')
  const target = inject(FILE_REFERENCE_TARGET, undefined)
  const referenceTargets = useFileReferenceTargets()
  const referenceTargetOpen = ref(false)
  const selectedTargetId = ref('')
  const descriptionOpen = ref(false)
  const description = ref<NonNullable<Awaited<ReturnType<typeof fileApi.imageDescription>>['descriptions'][number]['description']>>()
  const descriptionError = ref('')
  const descriptionLoading = ref(false)
  let descriptionGeneration = 0
  let generation = 0
  let disposed = false
  const filename = computed(() => asset.value?.originalName ?? props.part.originalName ?? '文件')
  const isImage = computed(() => asset.value?.kind === 'image' || (asset.value?.mimeType ?? props.part.mimeType ?? '').startsWith('image/'))
  const previewKind = computed(() => {
    const mime = asset.value?.mimeType ?? props.part.mimeType ?? ''
    if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'].includes(mime)) return 'image'
    if (mime.startsWith('audio/')) return 'audio'
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('text/') || mime === 'application/json') return 'text'
    return 'unsupported'
  })
  function clearPreview() {
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
    previewUrl.value = ''; previewText.value = ''
  }
  async function loadDescription() {
    if (!descriptionOpen.value) return
    const token = ++descriptionGeneration
    const context = fileApi.contextKey()
    const current = generation
    const isCurrent = () => !disposed && token === descriptionGeneration && current === generation && context === fileApi.contextKey()
    description.value = undefined; descriptionError.value = ''; descriptionLoading.value = false
    if (!props.chatId) return
    descriptionLoading.value = true
    try {
      const result = await fileApi.imageDescription([{ assetId: props.part.assetId, assetVersionId: props.part.assetVersionId }], props.chatId)
      if (!isCurrent()) return
      const record = result.descriptions.find(item => item.assetId === props.part.assetId && item.assetVersionId === props.part.assetVersionId)
      if (record?.error) throw new Error(record.error)
      description.value = record?.description
    } catch (cause) { if (isCurrent()) descriptionError.value = cause instanceof Error ? cause.message : '文字说明查询失败' }
    finally { if (isCurrent()) descriptionLoading.value = false }
  }
  function toggleDescription(open: boolean) {
    if (descriptionOpen.value === open) return
    descriptionOpen.value = open
    if (open) void loadDescription()
    else { descriptionGeneration++; descriptionLoading.value = false }
  }
  async function load() {
    const token = ++generation
    descriptionGeneration++; descriptionOpen.value = false; description.value = undefined; descriptionError.value = ''; descriptionLoading.value = false
    error.value = ''; asset.value = undefined
    try {
      const result = await fileApi.get([{ assetId: props.part.assetId, assetVersionId: props.part.assetVersionId }], props.chatId)
      if (disposed || token !== generation) return
      const record = result.assets[0]
      if (!record || 'missing' in record) throw new Error('此文件缺失或无权读取；请重新上传。')
      asset.value = record
    } catch (e) { if (!disposed && token === generation) error.value = e instanceof Error ? e.message : '文件信息无法读取' }
  }
  async function action(kind: 'preview' | 'download' | 'reference') {
    if (busy.value || !asset.value) return
    const token = generation
    busy.value = true; error.value = ''
    try {
      if (kind === 'reference') {
        if (target) await target(asset.value)
        else { selectedTargetId.value = ''; referenceTargetOpen.value = true }
        return
      }
      if (kind === 'preview' && previewKind.value === 'unsupported') { previewOpen.value = true; return }
      const blob = await fileApi.read(props.part.assetId, props.part.assetVersionId, props.chatId, kind === 'download')
      if (disposed || token !== generation) return
      if (kind === 'download') {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a'); link.href = url; link.download = filename.value; link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } else {
        clearPreview()
        if (previewKind.value === 'text') {
          const text = await blob.slice(0, 256 * 1024).text()
          if (disposed || token !== generation) return
          previewText.value = text
        }
        else previewUrl.value = URL.createObjectURL(blob)
        previewOpen.value = true
      }
    } catch (e) { if (!disposed && token === generation) error.value = e instanceof Error ? e.message : '文件操作失败' }
    finally { if (!disposed && token === generation) busy.value = false }
  }
  async function confirmReference() {
    if (busy.value || !asset.value) return
    const chosen = referenceTargets.value.find(item => item.id === selectedTargetId.value)
    if (!chosen) { error.value = '请选择仍然打开的目标会话'; return }
    const token = generation
    const file = asset.value
    busy.value = true; error.value = ''
    try {
      await chosen.reference(file)
      if (!disposed && token === generation) referenceTargetOpen.value = false
    } catch (cause) { if (!disposed && token === generation) error.value = cause instanceof Error ? cause.message : '文件引用失败' }
    finally { if (!disposed && token === generation) busy.value = false }
  }
  watch(() => [props.part.assetId, props.part.assetVersionId, props.chatId, fileApi.contextKey()], () => {
    clearPreview(); previewOpen.value = false; referenceTargetOpen.value = false; selectedTargetId.value = ''; busy.value = false
    void load()
  }, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => { disposed = true; generation++; descriptionGeneration++; clearPreview() })
  return { asset, filename, error, busy, previewOpen, previewUrl, previewText, previewKind, canReference: computed(() => !!target || referenceTargets.value.length > 0), action, load, clearPreview,
    referenceTargets, referenceTargetOpen, selectedTargetId, confirmReference,
    isImage, descriptionOpen, description, descriptionError, descriptionLoading, loadDescription, toggleDescription }
}
