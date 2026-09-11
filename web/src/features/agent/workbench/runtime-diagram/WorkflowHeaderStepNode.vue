<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import {
  CircleCheck,
  CircleClose,
  Clock,
  InfoFilled,
  Loading,
  MoreFilled,
} from '@element-plus/icons-vue'
import type { HeaderChildData, HeaderSelection } from './headerGraph'
import { headerNodePorts } from './headerTemplate'

type StepData = Extract<HeaderChildData, { kind: 'header-step' }>
const props = defineProps<NodeProps<StepData>>()
const emit = defineEmits<{ selectStep: [event: HeaderSelection] }>()
function selectStep(): void {
  emit('selectStep', {
    headerId: props.data.headerId,
    chatId: props.data.chatId,
    templateNodeId: props.data.template.id,
    title: props.data.template.title,
    scope: props.data.scope,
    recorded: props.data.recorded,
    complete: props.data.complete,
    slot: props.data.slot,
    detail: props.data.template.detail,
  })
}
const positions = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
}
const ports = computed(() => headerNodePorts(props.data.template.id))
const icons = {
  running: Loading,
  waiting: Clock,
  succeeded: CircleCheck,
  failed: CircleClose,
  rejected: CircleClose,
  cancelled: CircleClose,
  interrupted: CircleClose,
  unknown: InfoFilled,
  idle: MoreFilled,
  unrecorded: InfoFilled,
}
</script>

<template>
  <div
    class="workflow-node-root workflow-step-root"
    :class="[`state-${data.slot.status}`, `shape-${data.template.shape}`]"
    data-workflow-highlight-target
  >
    <Handle
      v-for="port in ports"
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
      class="workflow-step-button nodrag nopan"
      :aria-expanded="data.selected"
      aria-controls="workflow-step-detail"
      :aria-label="`${data.template.title}，${data.slot.statusText}，查看步骤详情`"
      :data-workflow-header-id="data.headerId"
      :data-workflow-slot-kind="data.template.kinds[0]"
      :data-workflow-template-node="data.template.id"
      :data-workflow-occurrence-id="data.slot.occurrence?.occurrenceId"
      @pointerdown.stop
      @click.stop="selectStep"
    >
      <span class="workflow-step-visual">
        <span class="workflow-step-title">{{ data.template.title }}</span>
        <span class="workflow-step-state"
          ><component
            :is="icons[data.slot.status]"
            class="workflow-node-status-icon"
            aria-hidden="true"
          />{{ data.slot.statusText }}</span
        >
      </span>
      <InfoFilled class="workflow-step-detail-icon" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped lang="less">
.workflow-step-root {
  position: relative;
  width: 100%;
  height: 100%;
}
.workflow-step-button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--surface);
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 400;
  text-align: left;
}
.workflow-step-visual {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.workflow-step-title {
  font-size: 13px;
  font-weight: 400;
  white-space: nowrap;
}
.workflow-step-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
}
.workflow-step-state svg,
.workflow-step-detail-icon {
  width: 16px;
  height: 16px;
}
.shape-condition .workflow-step-button {
  border-inline-style: double;
  border-inline-width: 3px;
}
.shape-note .workflow-step-button {
  border-style: dashed;
  background: var(--panel);
}
.state-running .workflow-step-button {
  border-color: var(--accent);
}
.state-waiting .workflow-step-button {
  border-color: var(--warning);
}
.state-succeeded .workflow-step-button {
  border-color: var(--success);
}
.state-failed .workflow-step-button,
.state-rejected .workflow-step-button {
  border-color: var(--danger);
}
.state-unknown .workflow-step-button,
.state-interrupted .workflow-step-button,
.state-cancelled .workflow-step-button {
  border-style: dashed;
}
.workflow-step-root:is(:hover, :focus-within, .is-pointer-highlighted) .workflow-step-button {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 9%, var(--surface));
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
</style>
