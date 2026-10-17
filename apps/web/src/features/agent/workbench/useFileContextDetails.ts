import { onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { fileApi, type FileRequestPlan } from '@/application/files/public'

export function useFileContextDetails(chatId: MaybeRefOrGetter<string>) {
  const data = ref<FileRequestPlan>()
  const error = ref('')
  const loading = ref(false)
  let generation = 0
  async function load() {
    const id = toValue(chatId)
    const current = ++generation
    const context = fileApi.contextKey()
    data.value = undefined
    error.value = ''
    loading.value = false
    if (!id) return
    loading.value = true
    error.value = ''
    try {
      const result = await fileApi.requestPlan(id)
      if (generation === current && context === fileApi.contextKey()) data.value = result
    } catch (cause) {
      if (generation === current && context === fileApi.contextKey()) error.value = cause instanceof Error ? cause.message : '文件请求详情读取失败'
    } finally { if (generation === current && context === fileApi.contextKey()) loading.value = false }
  }
  watch(() => [toValue(chatId), fileApi.contextKey()], () => { void load() }, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => { generation++ })
  return { data, error, loading, load }
}
