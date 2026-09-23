<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { currentTaskPlanItem, taskPlanItemLabel, taskPlanProgress, type TaskPlan } from './model'

const props = withDefaults(
  defineProps<{
    plan: TaskPlan
    compact?: boolean
    variant?: 'conversation' | 'lite'
  }>(),
  { compact: false, variant: 'conversation' },
)

const expanded = ref(false)
let collapseTimer: ReturnType<typeof setTimeout> | undefined
function open(): void {
  if (props.compact && props.variant !== 'lite') return
  if (collapseTimer) clearTimeout(collapseTimer)
  collapseTimer = undefined
  expanded.value = true
}
function close(): void {
  if (collapseTimer) clearTimeout(collapseTimer)
  collapseTimer = setTimeout(() => {
    expanded.value = false
    collapseTimer = undefined
  }, 120)
}
function focusIn(): void {
  open()
}
function focusOut(event: FocusEvent): void {
  const next = event.relatedTarget
  if (next instanceof Node && (event.currentTarget as HTMLElement).contains(next)) return
  close()
}
onBeforeUnmount(() => {
  if (collapseTimer) clearTimeout(collapseTimer)
})

const current = computed(() => currentTaskPlanItem(props.plan))
</script>

<template>
  <div
    v-if="current && taskPlanProgress(plan)"
    class="task-plan-marker"
    :class="[`is-${variant}`, { 'is-expanded': expanded, 'is-compact': compact }]"
    tabindex="0"
    role="status"
    :aria-label="`任务进度 ${taskPlanProgress(plan)}`"
    @mouseenter="open"
    @mouseleave="close"
    @focusin="focusIn"
    @focusout="focusOut"
  >
    <div class="task-plan-marker__collapsed">
      <span class="task-plan-marker__check" aria-hidden="true" />
      <span v-if="current && variant !== 'lite' && !compact" class="task-plan-marker__spinner" aria-hidden="true" />
      <span class="task-plan-marker__collapsed-text">{{ variant === 'lite' || compact ? taskPlanProgress(plan) : taskPlanItemLabel(current, plan) }}</span>
    </div>
    <TransitionGroup
      v-if="expanded && (!compact || variant === 'lite')"
      tag="div"
      name="task-plan-row"
      class="task-plan-marker__list"
    >
      <div
        v-for="item in plan.items"
        :key="item.itemId"
        class="task-plan-marker__row"
        :class="{
          'is-current': item.itemId === current.itemId,
          'is-completed': item.status === 'completed',
        }"
        :style="{ '--task-plan-index': item.index }"
      >
        <span class="task-plan-marker__check" :class="{ 'is-checked': item.status === 'completed' }" aria-hidden="true" />
        <span v-if="item.itemId === current.itemId" class="task-plan-marker__spinner" aria-hidden="true" />
        <span class="task-plan-marker__text">{{ taskPlanItemLabel(item, plan) }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.task-plan-marker {
  --task-plan-bg: color-mix(in srgb, var(--el-bg-color, #111827) 92%, transparent);
  --task-plan-fg: var(--el-text-color-primary, #f3f4f6);
  position: relative;
  z-index: 4;
  width: 120px;
  max-width: calc(100vw - 32px);
  overflow: visible;
  border: 1px solid color-mix(in srgb, var(--task-plan-fg) 20%, transparent);
  border-radius: 7px;
  background: var(--task-plan-bg);
  color: var(--task-plan-fg);
  box-shadow: 0 5px 18px rgb(0 0 0 / 22%);
  font-size: 11px;
  line-height: 1.35;
  pointer-events: auto;
  outline: none;
}
.task-plan-marker__collapsed,
.task-plan-marker__row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 24px;
  padding: 3px 7px;
  white-space: nowrap;
}
.task-plan-marker__collapsed-text,
.task-plan-marker__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-plan-marker__collapsed-text { flex: 1; }
.task-plan-marker__row { min-height: 22px; }
.task-plan-marker__row.is-current { font-weight: 700; }
.task-plan-marker__row.is-completed .task-plan-marker__text {
  opacity: 0.62;
  text-decoration: line-through;
}
.task-plan-marker__check {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border: 1px solid currentColor;
  border-radius: 2px;
}
.task-plan-marker__check.is-checked {
  background: currentColor;
  box-shadow: inset 0 0 0 2px var(--task-plan-bg);
}
.task-plan-marker__spinner {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: task-plan-spin 0.8s linear infinite;
}
.task-plan-row-move,
.task-plan-row-enter-active,
.task-plan-row-leave-active { transition: transform 180ms ease, opacity 140ms ease; }
.task-plan-row-enter-from,
.task-plan-row-leave-to { opacity: 0; transform: translateY(8px); }
.task-plan-row-leave-active { position: absolute; width: 100%; }
.task-plan-marker.is-conversation {
  width: 120px;
  overflow: visible;
}
.task-plan-marker.is-conversation .task-plan-marker__list {
  position: absolute;
  z-index: 20;
  top: calc(100% + 5px);
  left: 0;
  width: min(360px, calc(100vw - 32px));
  border: 1px solid color-mix(in srgb, var(--task-plan-fg) 20%, transparent);
  border-radius: 7px;
  background: var(--task-plan-bg);
  box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
}
.task-plan-marker.is-lite {
  width: auto;
  min-width: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  font-variant-numeric: tabular-nums;
}
.task-plan-marker.is-lite .task-plan-marker__collapsed { padding: 0 2px; }
.task-plan-marker.is-lite .task-plan-marker__list {
  position: absolute;
  z-index: 20;
  top: calc(100% + 5px);
  left: 0;
  width: min(320px, calc(100vw - 32px));
  border: 1px solid color-mix(in srgb, var(--task-plan-fg) 20%, transparent);
  border-radius: 7px;
  background: var(--task-plan-bg);
  box-shadow: 0 8px 24px rgb(0 0 0 / 25%);
}
@keyframes task-plan-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .task-plan-marker__spinner { animation: none; }
  .task-plan-row-move,
  .task-plan-row-enter-active,
  .task-plan-row-leave-active { transition: none; }
}
</style>
