<script setup lang="ts">
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import { headerLayerColor } from './workflowVisuals'
import type { HeaderChildData, HeaderGroupToggleEvent } from './headerGraph'
type GroupData = Extract<HeaderChildData, { kind: 'header-group' }>
defineProps<NodeProps<GroupData>>()
const emit = defineEmits<{ toggle: [event: HeaderGroupToggleEvent] }>()
const positions = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
}
</script>

<template>
  <section
    class="workflow-header-group"
    :class="{
      'is-collapsed': data.collapsed,
      'is-active': data.collapsed && data.active,
      'is-own-active': data.collapsed && data.ownActive,
      [`state-${data.status}`]: data.collapsed,
    }"
    :style="{
      '--workflow-layer-color':
        headerLayerColor(data.groupId),
    }"
    :aria-label="`${data.title}，${data.summary}`"
    :data-board-chip="data.collapsed ? data.groupId : undefined"
    :data-workflow-layer="data.groupId"
    :data-workflow-group-id="id"
    :data-workflow-highlight-target="data.collapsed ? '' : undefined"
  >
    <Handle
      v-for="port in data.ports"
      :id="port.id"
      :key="port.id"
      :type="port.type"
      :position="positions[port.side]"
      :connectable="false"
      :style="
        port.side === 'left' || port.side === 'right'
          ? { top: `calc(50% + ${port.offset}px)` }
          : { left: `calc(50% + ${port.offset}px)` }
      "
    />
    <button
      type="button"
      class="workflow-header-group-toggle nodrag nopan"
      :aria-expanded="!data.collapsed"
      :aria-label="`${data.collapsed ? '展开' : '收起'}${data.title}内部电路，${data.summary}`"
      @pointerdown.stop
      @click.stop="emit('toggle', { headerId: data.headerId, groupId: data.groupId })"
    >
      <span class="workflow-layer-title">{{ data.title }}</span>
      <span class="workflow-layer-action">{{ data.collapsed ? '展开' : '收起' }}</span>
    </button>
  </section>
</template>

<style scoped lang="less">
.workflow-header-group {
  position: relative;
  isolation: isolate;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: 1px solid color-mix(in srgb, var(--workflow-layer-color) 65%, var(--border));
  border-radius: 0;
  background: color-mix(in srgb, var(--workflow-layer-color) 17%, var(--panel));
  color: var(--ink);
  pointer-events: none;
}
.workflow-header-group-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 40px;
  box-sizing: border-box;
  padding: 0 8px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  pointer-events: auto;
}
.workflow-layer-title {
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.workflow-layer-action {
  margin-left: auto;
  font-size: 14px;
  font-weight: 400;
  color: color-mix(in srgb, var(--ink) 72%, transparent);
}
.is-active {
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
}
.is-own-active {
  border-color: var(--accent);
}
.is-own-active .workflow-layer-title {
  color: var(--accent);
}
.is-collapsed {
  background: color-mix(in srgb, var(--workflow-layer-color) 17%, var(--surface));
  border-color: var(--workflow-layer-color);
}
.is-collapsed .workflow-header-group-toggle {
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 8px;
}
.is-collapsed .workflow-layer-action {
  margin-left: 0;
  color: var(--accent);
}
.state-waiting {
  border-color: var(--warning);
}
.state-failed,
.state-rejected {
  border-color: var(--danger);
}
.is-collapsed.is-active {
  border-color: var(--accent);

}
.workflow-header-group-toggle:hover {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
.workflow-header-group-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
</style>
