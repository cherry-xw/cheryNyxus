<script setup lang="ts">
/**
 * PetStatusBar：宠物头上状态条（emotion 条 + ContextBar + busy-indicator 三点脉冲）。
 * 从 PetBody 拆出（纯展示）。显隐守卫（v-if="!pet.isGhost"）由父组件承担。
 */
import ContextBar from '@/features/agent/toolbar/ContextBar.vue'
import type { ContextBreakdown } from '@/application/backend/public'

defineProps<{
  emotion: number
  contextUsage: number
  contextBreakdown?: ContextBreakdown
  isBusy: boolean
}>()
</script>

<template>
  <div
    class="status-stack"
    :aria-label="`情绪 ${Math.round(emotion)}，上下文 ${Math.round(contextUsage * 100)}%`"
  >
    <div class="status-row">
      <span class="stat emotion"><span class="fill" :style="{ width: `${emotion}%` }" /></span>
      <ContextBar :usage="contextUsage" :breakdown="contextBreakdown" />
    </div>
    <!-- busy-indicator：思考中三点脉冲；显隐走 isBusy（与气泡显示 hasStream 解耦）。 -->
    <span v-if="isBusy" class="busy-indicator" aria-label="思考中">
      <span class="thinking-dot" />
      <span class="thinking-dot" />
      <span class="thinking-dot" />
    </span>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.status-stack {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  margin-bottom: 2px; /* 原 .status-row 的 margin-bottom */
}

.status-row {
  isolation: isolate;
  display: flex;
  gap: 3px;
  width: 44px;
  position: relative;
  top: -4px; /* 上移避免与 .busy-indicator 绝对定位重叠 */

  /* 始终可见的轻量底板：不增加布局高度，因此不会改变脸部锚点。 */
  &::before {
    position: absolute;
    inset: -3px -4px;
    z-index: -1;
    border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    box-shadow:
      0 2px 7px rgba(15, 23, 42, 0.2),
      inset 0 1px 0 color-mix(in srgb, white 48%, transparent);
    backdrop-filter: blur(3px);
    content: '';
    pointer-events: none;
  }
}

.stat {
  position: relative;
  flex: 1;
  height: 2px;
  border-radius: 1px;
  // 不透明 track（取代 ink 14% 半透明）：深色桌面下淡条可见，fill 叠其上
  background: color-mix(in srgb, var(--ink) 24%, var(--surface));
  overflow: hidden;

  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 1px;
    transition: width 200ms ease;
  }

  &.emotion .fill {
    background: #f6b73c;
  }
}

.busy-indicator {
  /* 改为 .status-stack 的 flex 子项，与 .status-row 上下堆叠 */
  display: inline-flex;
  position: absolute;
  right: 0;
  align-items: center;
  gap: 3px;
  /* 去背景框：无 surface-soft 底 + 无紫虚线边框，只留三点紫脉冲（深色场景不再显突兀色块） */
  pointer-events: none;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.18));
  transform-origin: center center;

  .thinking-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #7c3aed; /* 思考紫 */
    animation: thinking-dot 1.2s ease-in-out infinite;

    &:nth-child(2) {
      animation-delay: 0.18s;
    }
    &:nth-child(3) {
      animation-delay: 0.36s;
    }
  }
}

@keyframes thinking-dot {
  0%,
  60%,
  100% {
    opacity: 0.28;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
}
</style>
