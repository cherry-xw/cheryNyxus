<script setup lang="ts">
/**
 * HistoryDrawer：右侧抽屉栈容器（CP4 栈化重构）。
 *
 * 栈驱动：manager.stack（store uiState historyDrawerStack）非空时滑入；空时滑出。
 * - PetStage openRoot / SpawnRenderer drillChild / jumpToSpawn 等经 manager 改栈
 * - 内容：v-for HistoryDrawerPanel（每层一个 chatId，绝对定位叠加，z-index 递增）
 * - 关闭：✕（panel 内，仅栈顶）/ 点遮罩 / ESC → manager.closeTop（逐层返回）
 * motion-v：AnimatePresence + MotionDiv overlay 控制进出（inline 字面量，同 AgentDialog 风格）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { useHistoryDrawerManager } from './useHistoryDrawerManager'
import { useAgentsStore } from '@/stores'
import HistoryDrawerPanel from './HistoryDrawerPanel.vue'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

const MotionDiv = motion.div

const manager = useHistoryDrawerManager()
const agents = useAgentsStore()

// 栈底=根抽屉，栈顶=当前可见层
const stack = computed(() => manager.stack.value)

// 共用单蒙层：仅当 HistoryDrawer 是栈顶 overlay 时其蒙层带 blur，否则透明（避免多层 blur 叠加）
const isTopMask = computed(() => agents.topOverlay === 'historyDrawer')
const drawerMode = computed(() => agents.historyDrawerMode)
const drawerVisible = computed(
  () => !(drawerMode.value === 'workbench-docked' && agents.workbenchMinimized),
)
const overlayStyle = computed(() => {
  const anchor = agents.historyDrawerAnchor
  if (drawerMode.value !== 'workbench-docked' || !anchor) return { zIndex: BASE_Z }
  return {
    zIndex: BASE_Z,
    top: `${anchor.top}px`,
    left: `${anchor.left}px`,
    width: `${anchor.width}px`,
    height: `${anchor.height}px`,
    right: 'auto',
    bottom: 'auto',
  }
})

function closeTop(): void {
  manager.closeTop()
}

function onOverlayClick(e: MouseEvent): void {
  // 点遮罩本身（非冒泡自面板内元素）→ 关栈顶
  if (e.target === e.currentTarget) closeTop()
}

// 历史抽屉由当前 Nyxus 对话框主动打开时，必须盖在输入弹窗上方；审批层仍保持更高优先级。
const BASE_Z = OVERLAY_Z_INDEX.historyDrawer
const overlayRef = ref<HTMLElement | null>(null)

// 全局 ESC 关栈顶（栈非空时生效；topOverlay 守卫避免与 AgentDialog 等同开时双重关闭）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (stack.value.length === 0 || agents.topOverlay !== 'historyDrawer') return
  const insideDrawer = e.target instanceof Element && Boolean(e.target.closest('.drawer-overlay'))
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopImmediatePropagation()
    closeTop()
  } else if (!insideDrawer) {
    // Focus can still point at the composer that opened the drawer. Capture the
    // event before that input receives it so background shortcuts/text cannot run.
    e.preventDefault()
    e.stopImmediatePropagation()
  }
}
window.addEventListener('keydown', onGlobalKeydown, true)
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown, true))
watch(
  () => stack.value.length,
  (length) => {
    if (length > 0) void nextTick(() => overlayRef.value?.focus({ preventScroll: true }))
  },
)
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="stack.length > 0"
      v-show="drawerVisible"
      key="history-overlay"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <!-- ref 绑在原生 div 上（MotionDiv 是组件，ref 拿不到 DOM，.focus 不存在）。 -->
      <div
        ref="overlayRef"
        class="drawer-overlay"
        data-desktop-hit
        :class="{
          'is-top-mask': isTopMask,
          'is-workbench-docked': drawerMode === 'workbench-docked',
        }"
        :style="overlayStyle"
        tabindex="-1"
        @pointerdown="onOverlayClick"
      >
        <HistoryDrawerPanel
          v-for="(cid, i) in stack"
          :key="i"
          :chat-id="cid"
          :is-top="i === stack.length - 1"
          :z-index="BASE_Z + i * 10 + 1"
        />
      </div>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
// 遮罩容器：fixed 全屏。默认透明（非栈顶），仅 .is-top-mask 纯半透明盖住下层（共用单蒙层）。
// 面板绝对定位其内右侧（见 HistoryDrawerPanel）。
// 注意：禁用 backdrop-filter blur——桌面 pet/Nyxus 持续 rAF 动画下，blur 每帧重采样底层导致整屏持续重绘闪烁（见 docs/web/renderer.md 遮罩实现约束）
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: transparent;
  backdrop-filter: none;
}
.drawer-overlay.is-top-mask {
  background: var(--scrim);
}
.drawer-overlay.is-workbench-docked {
  overflow: hidden;
  border-radius: inherit;
}
</style>
