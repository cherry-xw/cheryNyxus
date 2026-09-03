<script setup lang="ts">
/**
 * PendingQueueStrip —— 待操作面板底部的队列缩略带（纯展示）。
 *
 * 横向 chips 一览全部待操作任务：kind 徽记 + 标题 + 倒计时/状态点。
 * 点击 chip 或 ←/→ 键盘循环切换聚焦任务（roving tabindex），emit 交回父级；
 * active chip 变化时 scrollIntoView 跟随，防窄面板下滚出可视区。
 * 无 drafts / store / gsap 依赖；入场 stagger 由父级 useGsap scope 驱动。
 */
import { nextTick, ref, watch } from 'vue'

export interface QueueChipItem {
  interactionId: string
  kind: 'approval' | 'question_batch'
  title: string
  /** 倒计时文案（如「剩余 12s」）；空则不显示。 */
  countdownText?: string
  isExpired?: boolean
  status: string
}

const props = defineProps<{
  items: QueueChipItem[]
  activeId?: string
  /** 树侧聚焦（focusedInteraction 命中）的任务 id：非 active 时以描边提示。 */
  focusedId?: string
}>()

const emit = defineEmits<{
  select: [interactionId: string]
}>()

const stripEl = ref<HTMLElement | null>(null)

/** ←/→ 键盘循环切换（到边回绕）。 */
function stepBy(delta: number): void {
  if (props.items.length === 0) return
  const index = props.items.findIndex((item) => item.interactionId === props.activeId)
  const next = index < 0 ? 0 : (index + delta + props.items.length) % props.items.length
  const target = props.items[next]
  if (target) emit('select', target.interactionId)
}

// active chip 跟随滚动：切换（点击含键盘）后保证可视，block/inline 都取 nearest 不产生页面级滚动。
watch(
  () => props.activeId,
  async (id) => {
    if (!id || !stripEl.value) return
    await nextTick()
    stripEl.value
      .querySelector<HTMLElement>(`[data-interaction-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  },
  { immediate: true },
)
</script>

<template>
  <nav
    ref="stripEl"
    class="queue-strip"
    aria-label="待操作队列"
    @keydown.left.prevent="stepBy(-1)"
    @keydown.right.prevent="stepBy(1)"
  >
    <div class="queue-chips">
      <button
        v-for="item in items"
        :key="item.interactionId"
        type="button"
        class="queue-chip"
        :class="[
          `is-${item.kind}`,
          {
            'is-active': item.interactionId === activeId,
            'is-focused': item.interactionId === focusedId,
            'is-expired': item.isExpired,
          },
        ]"
        :data-interaction-id="item.interactionId"
        :tabindex="item.interactionId === activeId ? 0 : -1"
        :aria-current="item.interactionId === activeId ? 'true' : undefined"
        @click="emit('select', item.interactionId)"
      >
        <span class="chip-kind" :class="`is-${item.kind}`">{{
          item.kind === 'approval' ? '确认' : '回答'
        }}</span>
        <span class="chip-title">{{ item.title }}</span>
        <span
          v-if="item.countdownText"
          class="chip-countdown"
          :class="{ 'is-expired': item.isExpired }"
          >{{ item.countdownText }}</span
        >
      </button>
    </div>
  </nav>
</template>

<style scoped lang="less">
// 定高 + flex-shrink: 0：防被上方聚焦卡挤压塌陷（workbench-multi-window.md 2026-08-24 塌陷教训）。
.queue-strip {
  flex-shrink: 0;
  margin-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
}

.queue-chips {
  display: flex;
  flex-wrap: nowrap; // chips 不换行，超宽横向滚动（取代旧 ▲/▼ 分页）
  align-items: center;
  gap: 6px;
  padding: 8px 2px 2px;
  overflow-x: auto;
  min-height: 40px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--nx-text) 30%, transparent) transparent;
}

.queue-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  max-width: 220px;
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
  border-radius: 0;
  background: color-mix(in srgb, var(--nx-bg) 90%, var(--nx-text) 6%);
  color: var(--nx-text);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease;
  &:hover {
    background: color-mix(in srgb, var(--nx-text) 7%, transparent);
  }
  &.is-active {
    border-color: color-mix(in srgb, var(--nx-green) 66%, transparent);
    background: color-mix(in srgb, var(--nx-green) 16%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--nx-green) 30%, transparent);
  }
  &.is-focused:not(.is-active) {
    border-color: color-mix(in srgb, var(--nx-green) 55%, transparent);
  }
}

.chip-kind {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 0;
  font-size: 12px;
  line-height: 1.4;
  &.is-approval {
    background: var(--accent-soft);
    color: var(--accent);
  }
  &.is-question {
    background: color-mix(in srgb, var(--nx-purple) 20%, transparent);
    color: var(--nx-purple);
  }
}

.chip-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  // 与 chip-kind / chip-countdown 统一行高：center 对齐下三者文本基线才能齐平
  line-height: 1.4;
  font-size: 12px;
}

.chip-countdown {
  flex-shrink: 0;
  // 同上：统一行高保证与徽记/标题文本基线齐平
  line-height: 1.4;
  color: var(--nx-green);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  &.is-expired {
    color: var(--nx-red);
  }
}

:global(html[data-theme='light'] .queue-chip.is-active) {
  border-color: color-mix(in srgb, var(--nx-cyan) 70%, transparent);
  background: color-mix(in srgb, var(--nx-cyan) 9%, var(--nx-bg));
  box-shadow: 0 0 12px color-mix(in srgb, var(--nx-cyan) 10%, transparent);
}
</style>
