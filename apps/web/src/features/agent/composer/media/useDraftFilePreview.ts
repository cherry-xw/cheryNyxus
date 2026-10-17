import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { fileApi } from '@/application/files/public'
import type { MediaAttachment } from '../../composables/useComposerMedia'

export function useDraftFilePreview(files: () => MediaAttachment[]) {
  const preview = ref<MediaAttachment>()
  const busy = ref(false)
  const error = ref('')
  const context = fileApi.contextKey()
  let generation = 0
  let ownedUrl = ''
  function close() {
    generation++
    if (ownedUrl) URL.revokeObjectURL(ownedUrl)
    ownedUrl = ''
    preview.value = undefined
    busy.value = false
  }
  async function open(file: MediaAttachment, adapted = false) {
    close(); error.value = ''
    if (!files().includes(file) || context !== fileApi.contextKey()) return
    if (!adapted || !file.compressed) { preview.value = file; return }
    const token = generation
    const selected = file.compressed
    busy.value = true
    try {
      const blob = await fileApi.read(selected.assetId, selected.assetVersionId)
      if (token !== generation || context !== fileApi.contextKey() || !files().includes(file)) return
      ownedUrl = URL.createObjectURL(blob)
      preview.value = { ...file, ...selected, previewUrl: ownedUrl, variant: 'adapted' }
    } catch (cause) { if (token === generation) error.value = cause instanceof Error ? cause.message : '适配版本暂时无法预览' }
    finally { if (token === generation) busy.value = false }
  }
  watch(() => [files().map(file => file.referenceId ?? file.previewUrl).join(','), fileApi.contextKey()], close)
  onBeforeUnmount(close)
  return { preview, imageUrls: computed(() => preview.value ? [preview.value.previewUrl] : []), busy, error, open, close }
}
