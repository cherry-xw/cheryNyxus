<script setup lang="ts">
import { computed } from 'vue'
import type { NodeProps } from '@vue-flow/core'
import type { HeaderChildData, HeaderGroupToggleEvent } from './headerGraph'

type GroupData = Extract<HeaderChildData, { kind: 'header-group' }>
const props = defineProps<NodeProps<GroupData>>()
const emit = defineEmits<{ toggle: [event: HeaderGroupToggleEvent] }>()

const summaryText = computed(() => {
  const s = props.data.summary
  const parts: string[] = []
  if (s.running) parts.push(`运行 ${s.running}`)
  if (s.waiting) parts.push(`等待 ${s.waiting}`)
  if (s.succeeded) parts.push(`完成 ${s.succeeded}`)
  if (s.failed) parts.push(`失败 ${s.failed}`)
  if (s.rejected) parts.push(`拒绝 ${s.rejected}`)
  return parts.length ? parts.join(' · ') : '尚无步骤'
})

function toggle(): void {
  emit('toggle', { headerId: props.data.headerId, groupId: props.data.groupId })
}
</script>

<template>
  <section
    class="workflow-header-group"
    :class="{ 'is-collapsed': data.collapsed, 'is-active': data.active }"
    :aria-label="data.title"
    role="region"
  >
    <button
      type="button"
      class="workflow-header-group-toggle nodrag nopan"
      :aria-expanded="!data.collapsed"
      :title="data.collapsed ? '展开详情' : '收起详情'"
      @pointerdown.stop
      @click.stop="toggle"
    >
      <span class="workflow-header-group-chevron" aria-hidden="true">{{
        data.collapsed ? '▸' : '▾'
      }}</span>
      <h3>{{ data.title }}</h3>
      <span class="workflow-header-group-summary">{{ summaryText }}</span>
    </button>
  </section>
</template>

<style scoped lang="less">
.workflow-header-group {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  transition:
    background 200ms ease-out,
    box-shadow 200ms ease-out;
  pointer-events: none;
}
.workflow-header-group-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  padding: 12px 20px;
  color: var(--ink);
  font: inherit;
  text-align: left;
  pointer-events: auto;
  cursor: pointer;
}
.workflow-header-group-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.workflow-header-group-chevron {
  display: inline-grid;
  place-items: center;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  font-size: 12px;
  line-height: 1;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  transition:
    transform 200ms ease-out,
    color 200ms ease-out;
}
.workflow-header-group.is-collapsed .workflow-header-group-chevron {
  color: var(--ink);
}
.workflow-header-group h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  transition:
    font-weight 200ms ease-out,
    color 200ms ease-out;
}
.workflow-header-group-summary {
  margin-left: auto;
  color: color-mix(in srgb, var(--ink) 58%, transparent);
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
  transition: opacity 200ms ease-out;
}
.workflow-header-group.is-collapsed .workflow-header-group-summary {
  opacity: 0.72;
}
.workflow-header-group.is-active {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
}
.workflow-header-group.is-active h3 {
  color: var(--accent);
}
.workflow-header-group.is-collapsed {
  background: color-mix(in srgb, var(--ink) 2%, transparent);
}
.workflow-header-group.is-collapsed h3 {
  font-weight: 500;
}
.workflow-header-group.is-collapsed.is-active h3 {
  font-weight: 600;
}
</style>
