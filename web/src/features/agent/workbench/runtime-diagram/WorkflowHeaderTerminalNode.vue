<script setup lang="ts">
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import type { HeaderChildData, HeaderTerminalEvent } from './headerGraph'
defineProps<NodeProps<Extract<HeaderChildData, { kind: 'header-terminal' }>>>()
const emit = defineEmits<{ trace: [event: HeaderTerminalEvent] }>()
</script>

<template>
  <div class="workflow-terminal" :class="{ 'is-boundary': data.terminal.boundary }">
    <Handle
      v-for="port in data.ports"
      :id="port.id"
      :key="port.id"
      :type="port.type"
      :position="
        { left: Position.Left, right: Position.Right, top: Position.Top, bottom: Position.Bottom }[
          port.side
        ]
      "
      :connectable="false"
    />
    <button
      type="button"
      class="nodrag nopan nowheel"
      :aria-label="`${data.terminal.code}，${data.terminal.label}，追踪另一端`"
      @pointerdown.stop
      @wheel.stop
      @click.stop="emit('trace', { headerId: data.headerId, terminal: data.terminal })"
    >
      {{ data.terminal.code }}
    </button>
  </div>
</template>

<style scoped lang="less">
.workflow-terminal {
  width: 100%;
  height: 100%;
  background: var(--surface);
  color: var(--ink);
  border: 1px solid var(--border-strong);
  box-sizing: border-box;
}
.workflow-terminal.is-boundary {
  border-color: var(--accent);
  border: 0;
  background: var(--accent);
}
.is-boundary button {
  position: absolute;
  width: 16px;
  height: 20px;
  left: -4px;
  top: -6px;
  font-size: 0;
}
button {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  font: inherit;
  font-size: 12px;
  font-weight: 400;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
button:hover {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
</style>
