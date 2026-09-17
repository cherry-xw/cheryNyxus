<script setup lang="ts">
/**
 * WorkbenchSessionBar：稳定任务快捷位与全部任务入口的组合容器。
 * 小任务 11 先发出全部任务页请求，同时保留旧下拉作为任务 13 接入覆盖页前的可用降级。
 * 下拉经 Teleport 挂 body + 锚点 fixed 定位 + OVERLAY_Z_INDEX.sessionMenu——
 * 标题栏/窗口内 absolute 弹层会被工作台 body 内更高 z-index（NYXUS_WORKBENCH_Z_INDEX chrome 60 等）
 * 盖住，必须脱离窗口 stacking context；且不能用 ownerOverlayZIndex（它返回窗口 zIndex+1=501，
 * 多窗口时聚焦窗口 500+2n ≥502 会盖住下拉），须用固定高位（< historyDrawer 10000）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'
import WorkbenchSessionStrip from './WorkbenchSessionStrip.vue'
import SessionDropdown from './SessionDropdown.vue'
import type { TaskBrowserOpenRequest } from './useSessionStripTasks'

// 模板直接解包使用，脚本侧无需 props 变量。
withDefaults(
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
  create: []
  /** 当前会话被归档且无剩余：父级清空窗口当前会话。 */
  clear: []
  openTasks: [request: TaskBrowserOpenRequest]
}>()

const barEl = ref<HTMLElement | null>(null)
const dropdownOpen = ref(false)
/** 下拉 fixed 定位（锚点 = bar 右下，右侧对齐）。 */
const dropdownStyle = ref<{ top: number; left: number; zIndex: number }>()

function openDropdown(): void {
  const el = barEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const width = 280
  dropdownStyle.value = {
    top: rect.bottom + 4,
    left: Math.max(8, rect.right - width),
    zIndex: OVERLAY_Z_INDEX.sessionMenu,
  }
  dropdownOpen.value = true
}

function onOpenTasks(request: TaskBrowserOpenRequest): void {
  // 任务 13 接入覆盖页前保留旧列表，避免阶段实施期间入口失效。
  if (dropdownOpen.value) {
    dropdownOpen.value = false
    return
  }
  emit('openTasks', request)
  openDropdown()
}

function onSelect(chatId: string): void {
  dropdownOpen.value = false
  emit('select', chatId)
}

/** 点击 bar/下拉之外 → 关闭（捕获阶段，防止弹层自身点击先被消费）。 */
function onDocPointerDown(e: PointerEvent): void {
  if (!dropdownOpen.value) return
  const target = e.target as HTMLElement | null
  if (barEl.value?.contains(target)) return
  if (target?.closest('.session-dropdown')) return
  dropdownOpen.value = false
}

onMounted(() => document.addEventListener('pointerdown', onDocPointerDown, true))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown, true))
</script>

<template>
  <div ref="barEl" class="session-bar" role="group" aria-label="会话切换">
    <WorkbenchSessionStrip
      :window-id="windowId"
      :preset-id="presetId"
      :preset-name="presetName"
      :active-chat-id="activeChatId"
      :foreground="foreground"
      :all-tasks-expanded="dropdownOpen"
      @select="onSelect"
      @expand="onOpenTasks"
    />
    <Teleport to="body">
      <SessionDropdown
        v-if="dropdownOpen"
        :style="dropdownStyle"
        :window-id="windowId"
        :preset-id="presetId"
        :preset-name="presetName"
        :active-chat-id="activeChatId"
        @select="onSelect"
        @create="emit('create')"
        @clear="emit('clear')"
        @close="dropdownOpen = false"
      />
    </Teleport>
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
