<script setup lang="ts">
/** WorkbenchSessionBar：稳定任务快捷位与所属工作台的全部任务入口。 */
import WorkbenchSessionStrip from './WorkbenchSessionStrip.vue'
import type { TaskBrowserOpenRequest } from './useSessionStripTasks'
import { useTaskBrowserOverlay } from './useTaskBrowserOverlay'

const props = withDefaults(
  defineProps<{
    windowId: string
    presetId?: string
    presetName?: string
    activeChatId?: string | null
    foreground?: boolean
  }>(),
  { presetId: undefined, presetName: undefined, activeChatId: null, foreground: undefined },
)

const emit = defineEmits<{
  select: [chatId: string]
  beforeExpand: []
}>()

const taskBrowser = useTaskBrowserOverlay(props.windowId)

function onOpenTasks(request: TaskBrowserOpenRequest): void {
  emit('beforeExpand')
  taskBrowser.toggle(request)
}

function onSelect(chatId: string): void {
  taskBrowser.close()
  emit('select', chatId)
}
</script>

<template>
  <div class="session-bar" role="group" aria-label="任务切换">
    <WorkbenchSessionStrip
      :window-id="windowId"
      :preset-id="presetId"
      :preset-name="presetName"
      :active-chat-id="activeChatId"
      :foreground="foreground"
      :all-tasks-expanded="taskBrowser.state.value.open"
      @select="onSelect"
      @expand="onOpenTasks"
    />
  </div>
</template>

<style scoped lang="less">
// 容器 relative 承载 strip + ☰；全直角 + token 色。
.session-bar {
  position: relative;
  display: flex;
  flex: 1 1 218px;
  align-items: center;
  min-width: 58px;
  max-width: 218px;
  padding: 0 2px;
}
</style>
