<script setup lang="ts">
/**
 * WorkbenchSessionBar：标题栏会话状态条 + 会话下拉的组合容器。
 * 左侧 strip（活跃会话 icon 阵列，hover 提示，点击切换），右侧「☰」按钮打开
 * 当前预设分页下拉（含未运行会话，默认第一项）；strip 溢出「+N」同样打开下拉。
 * 下拉经 Teleport 挂 body + 锚点 fixed 定位 + OVERLAY_Z_INDEX.sessionMenu——
 * 标题栏/窗口内 absolute 弹层会被工作台 body 内更高 z-index（NYXUS_WORKBENCH_Z_INDEX chrome 60 等）
 * 盖住，必须脱离窗口 stacking context；且不能用 ownerOverlayZIndex（它返回窗口 zIndex+1=501，
 * 多窗口时聚焦窗口 500+2n ≥502 会盖住下拉），须用固定高位（< historyDrawer 10000）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { SenseToolInfo } from '@/application/backend/public'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'
import WorkbenchSessionStrip from './WorkbenchSessionStrip.vue'
import SessionDropdown from './SessionDropdown.vue'

// 模板直接解包使用（windowId/presetId/presetName/senseTool/activeChatId），脚本侧无需 props 变量。
withDefaults(
  defineProps<{
    windowId: string
    presetId?: string
    presetName?: string
    /** sense 图标查找（工具节点 icon 映射）；缺省时 strip 内部自拉 sense.tools。 */
    senseTool?: (name: string) => SenseToolInfo | undefined
    activeChatId?: string | null
  }>(),
  { presetId: undefined, presetName: undefined, senseTool: undefined, activeChatId: null },
)

const emit = defineEmits<{
  select: [chatId: string]
  create: []
  /** 当前会话被归档且无剩余：父级清空窗口当前会话。 */
  clear: []
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

function toggleDropdown(): void {
  if (dropdownOpen.value) dropdownOpen.value = false
  else openDropdown()
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
      :sense-tool="senseTool"
      :active-chat-id="activeChatId"
      @select="onSelect"
      @expand="openDropdown"
    />
    <button
      type="button"
      class="session-bar-all"
      :class="{ 'is-open': dropdownOpen }"
      :aria-label="dropdownOpen ? '关闭会话列表' : '打开会话列表'"
      :aria-expanded="dropdownOpen"
      @click="toggleDropdown"
    >
      ☰
    </button>
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
  align-items: center;
  gap: 6px;
  padding: 0 2px;
}
.session-bar-all {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 0;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--ink) 30%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--ink);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease,
    transform 120ms ease;
  &:hover {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    transform: translateY(-1px);
  }
  &:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  &.is-open {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 24%, transparent);
  }
}
</style>
