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
import { computed, onBeforeUnmount } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { useHistoryDrawerManager } from "./useHistoryDrawerManager";
import HistoryDrawerPanel from "./HistoryDrawerPanel.vue";

const MotionDiv = motion.div;

const manager = useHistoryDrawerManager();

// 栈底=根抽屉，栈顶=当前可见层
const stack = computed(() => manager.stack.value);

function closeTop(): void {
  manager.closeTop();
}

function onOverlayClick(e: MouseEvent): void {
  // 点遮罩本身（非冒泡自面板内元素）→ 关栈顶
  if (e.target === e.currentTarget) closeTop();
}

// 基础 z-index（与原 HistoryDrawer 一致，低于审批 400 / AgentDialog 300）
const BASE_Z = 280;

// 全局 ESC 关栈顶（栈非空时生效；匹配 AgentDialog 模式）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && stack.value.length > 0) {
    e.preventDefault();
    closeTop();
  }
}
window.addEventListener("keydown", onGlobalKeydown);
onBeforeUnmount(() => window.removeEventListener("keydown", onGlobalKeydown));
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="stack.length > 0"
      key="history-overlay"
      class="drawer-overlay"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
      @pointerdown="onOverlayClick"
    >
      <HistoryDrawerPanel
        v-for="(cid, i) in stack"
        :key="cid"
        :chat-id="cid"
        :is-top="i === stack.length - 1"
        :z-index="BASE_Z + i * 10 + 1"
      />
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
// 遮罩容器：fixed 全屏，半透明 + 模糊；面板绝对定位其内右侧（见 HistoryDrawerPanel）
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 280;
  background: rgba(15, 17, 22, 0.36);
  backdrop-filter: blur(2px);
}
</style>
