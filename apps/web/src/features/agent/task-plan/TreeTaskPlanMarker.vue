<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  currentTaskPlanItem,
  taskPlanItemLabel,
  taskPlanProgress,
  type TaskPlan,
  type TaskPlanItem,
} from './model'

const props = withDefaults(
  defineProps<{
    plan: TaskPlan
    agentLabel?: string
  }>(),
  { agentLabel: '' },
)

const expanded = ref(false)
let collapseTimer: ReturnType<typeof setTimeout> | undefined
function open(): void {
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
/** 展开行只显示运行态/内容文本；X/Y 由头部承担，避免每个行重复前缀。 */
function itemText(item: TaskPlanItem): string {
  const runtime = item.activeForm?.trim()
  const detail = [runtime, item.content].filter(
    (value, index, values) => !!value && values.indexOf(value) === index,
  )
  return detail.join(' · ')
}
const donePercent = computed(() => {
  const total = props.plan.items.length
  if (!total) return 0
  const done = props.plan.items.filter((item) => item.status === 'completed').length
  return Math.round((done / total) * 100)
})
</script>

<template>
  <div
    v-if="current && taskPlanProgress(plan)"
    class="tree-plan-marker"
    :class="{ 'is-expanded': expanded }"
    tabindex="0"
    role="status"
    :aria-label="`任务进度 ${taskPlanProgress(plan)}`"
    @mouseenter="open"
    @mouseleave="close"
    @focusin="focusIn"
    @focusout="focusOut"
  >
    <div class="tree-plan-marker__collapsed">
      <span class="tree-plan-marker__check" aria-hidden="true" />
      <span class="tree-plan-marker__spinner" aria-hidden="true" />
      <span class="tree-plan-marker__collapsed-text">{{ taskPlanItemLabel(current, plan) }}</span>
    </div>
    <div v-if="expanded" class="tree-plan-marker__panel">
      <div class="tree-plan-marker__head">
        <span class="tree-plan-marker__head-title">
          <span class="tree-plan-marker__plan-label">计划</span>
          <span class="tree-plan-marker__plan-progress">{{ taskPlanProgress(plan) }}</span>
        </span>
        <span v-if="agentLabel" class="tree-plan-marker__agent" :title="agentLabel">{{ agentLabel }}</span>
        <span class="tree-plan-marker__bar" aria-hidden="true">
          <i :style="{ width: `${donePercent}%` }" />
        </span>
      </div>
      <TransitionGroup tag="div" name="tree-plan-row" class="tree-plan-marker__rows">
        <div
          v-for="item in plan.items"
          :key="item.itemId"
          class="tree-plan-marker__row"
          :class="{
            'is-current': item.itemId === current.itemId,
            'is-completed': item.status === 'completed',
          }"
          :style="{ '--tree-plan-index': item.index }"
        >
          <span
            class="tree-plan-marker__check"
            :class="{ 'is-checked': item.status === 'completed' }"
            aria-hidden="true"
          />
          <span v-if="item.itemId === current.itemId" class="tree-plan-marker__spinner" aria-hidden="true" />
          <span class="tree-plan-marker__text">{{ itemText(item) }}</span>
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
/* 树模式待办标记：独立于对话/精简的专用 UI。
 * 定位由外层 .tree-task-plan-marker 提供（absolute + translateY(-100%) + left bottom），
 * 本组件不声明 position/transform，避免覆盖外层锚定。 */
.tree-plan-marker {
  --tpm-fg: var(--nx-text);
  --tpm-muted: var(--nx-text-dim);
  --tpm-accent: var(--nx-cyan);
  --tpm-ok: var(--nx-green);
  --tpm-surface: var(--nx-bg);
  --tpm-line: var(--nx-border-soft);
  z-index: 4;
  width: 132px;
  max-width: calc(100vw - 32px);
  color: var(--tpm-fg);
  font-size: 12px;
  line-height: 1.3;
  background: var(--tpm-surface);
  border: 1px solid var(--tpm-line);
  border-radius: 4px;
  box-shadow: 0 6px 18px rgb(0 0 0 / 24%);
  pointer-events: auto;
  outline: none;
  transition: width 260ms ease;
}
.tree-plan-marker:focus-visible {
  box-shadow:
    0 6px 18px rgb(0 0 0 / 24%),
    0 0 0 2px color-mix(in srgb, var(--tpm-accent) 55%, transparent);
}
/* 指向下方节点的尾标，与节点左缘对齐。 */
.tree-plan-marker::after {
  content: '';
  position: absolute;
  left: 12px;
  bottom: -6px;
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid var(--tpm-line);
}
.tree-plan-marker.is-expanded {
  width: min(360px, calc(100vw - 32px));
  border-color: var(--nx-border);
}
.tree-plan-marker__collapsed {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 26px;
  padding: 4px 8px;
  white-space: nowrap;
}
.tree-plan-marker.is-expanded .tree-plan-marker__collapsed {
  display: none;
}
.tree-plan-marker__collapsed-text,
.tree-plan-marker__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-plan-marker__collapsed-text {
  flex: 1;
}
/* 展开后的计划面板 */
.tree-plan-marker__panel {
  display: flex;
  flex-direction: column;
}
.tree-plan-marker__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  padding: 7px 9px 5px;
}
.tree-plan-marker__head-title {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.tree-plan-marker__plan-label {
  color: var(--tpm-muted);
  font-size: 11px;
}
.tree-plan-marker__plan-progress {
  color: var(--tpm-accent);
  font-weight: 700;
  font-size: 12px;
}
.tree-plan-marker__agent {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--tpm-muted);
  font-size: 11px;
}
.tree-plan-marker__bar {
  flex: 1 1 100%;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: color-mix(in srgb, var(--tpm-accent) 16%, transparent);
}
.tree-plan-marker__bar > i {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--nx-cyan), var(--nx-purple));
  transition: width 240ms ease;
}
/* 清单行 */
.tree-plan-marker__rows {
  display: flex;
  flex-direction: column;
}
.tree-plan-marker__row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  padding: 3px 9px;
  white-space: nowrap;
}
.tree-plan-marker__row.is-current {
  color: var(--tpm-accent);
  font-weight: 700;
}
.tree-plan-marker__row.is-current .tree-plan-marker__check {
  border-color: var(--tpm-accent);
}
.tree-plan-marker__row.is-completed .tree-plan-marker__text {
  color: var(--tpm-muted);
  text-decoration: line-through;
  opacity: 0.72;
}
.tree-plan-marker__check {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border: 1px solid currentColor;
  border-radius: 2px;
}
.tree-plan-marker__check.is-checked {
  background: var(--tpm-ok);
  border-color: var(--tpm-ok);
  box-shadow: inset 0 0 0 2px var(--tpm-surface);
}
.tree-plan-marker__spinner {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: tree-plan-spin 0.8s linear infinite;
}
/* 展开动效：行按序号错峰出现，当前项保持身份原位。 */
.tree-plan-row-move,
.tree-plan-row-enter-active,
.tree-plan-row-leave-active {
  transition: transform 180ms ease, opacity 140ms ease;
}
.tree-plan-row-enter-from,
.tree-plan-row-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
.tree-plan-row-leave-active {
  position: absolute;
  width: 100%;
}
.tree-plan-marker.is-expanded .tree-plan-marker__row {
  animation: tree-plan-row-in 900ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: calc(var(--tree-plan-index) * 70ms);
}
@keyframes tree-plan-row-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes tree-plan-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .tree-plan-marker__spinner {
    animation: none;
  }
  .tree-plan-row-move,
  .tree-plan-row-enter-active,
  .tree-plan-row-leave-active {
    transition: none;
  }
  .tree-plan-marker.is-expanded .tree-plan-marker__row {
    animation: none;
  }
}
</style>
