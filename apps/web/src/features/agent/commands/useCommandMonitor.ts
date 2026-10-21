import { computed, onUnmounted, ref, watch } from 'vue'
import { useAgentCommandsStore } from '@/application/commands/public'

export function useCommandMonitor(chatId: () => string | undefined) {
  const commands = useAgentCommandsStore()
  const viewId = ref('')
  const selected = ref<string>()
  watch(() => commands.targetRevision, () => { selected.value = undefined })
  const stopWatch = watch(chatId, id => {
    if (viewId.value) commands.releaseView(viewId.value)
    selected.value = undefined
    viewId.value = commands.createView(id)
  }, { immediate: true })
  const view = computed(() => commands.views[viewId.value])
  const items = computed(() => view.value?.ids.flatMap(id => commands.records[id] ? [commands.records[id]!] : []) ?? [])
  function scope(value: 'active' | 'history' | 'all') {
    if (!view.value) return
    view.value.query.scope = value
    view.value.cursor = null
    void commands.load(viewId.value)
  }
  onUnmounted(() => { stopWatch(); commands.releaseView(viewId.value) })
  return { commands, view, items, selected, scope, refresh: () => commands.load(viewId.value), more: () => commands.load(viewId.value, true) }
}
