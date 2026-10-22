import { onBeforeUnmount, ref, watch } from 'vue'
import type { DrawingTask } from '@chery/protocol'
import { fileApi } from '@/application/files/public'

export function useDrawingRecords(chatId: () => string) {
  const tasks = ref<DrawingTask[]>([])
  const error = ref('')
  const busy = ref(false)
  let sequence = 0
  let disposed = false
  async function refresh() {
    const token = ++sequence, target = chatId(), context = fileApi.contextKey()
    busy.value = true; error.value = ''
    try {
      const response = await fileApi.drawings(target)
      if (!disposed && token === sequence && target === chatId() && context === fileApi.contextKey()) tasks.value = response.tasks
    } catch (cause) {
      if (!disposed && token === sequence && context === fileApi.contextKey()) error.value = cause instanceof Error ? cause.message : '绘图记录读取失败'
    } finally { if (!disposed && token === sequence) busy.value = false }
  }
  watch(() => [chatId(), fileApi.contextKey()], () => { tasks.value = []; void refresh() }, { immediate: true })
  onBeforeUnmount(() => { disposed = true; sequence++ })
  return { tasks, error, busy, refresh }
}
