<script setup lang="ts">
import { computed, ref } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import { InfoFilled } from '@element-plus/icons-vue'
import type { HeaderChildData, HeaderSelection } from './headerGraph'
import { headerNodePorts } from './headerTemplate'
import { statusIcon, visualStyle } from './workflowVisuals'
import WorkflowLiveCrt from './WorkflowLiveCrt.vue'
import WorkflowMorphIcon from './WorkflowMorphIcon.vue'

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
const stateIcon = computed(() =>
  props.data.slot.status === 'idle' ? undefined : statusIcon(props.data.slot.status),
)
const infoOpen = ref(false)
const infoFocused = ref(false)
const infoId = computed(() => `workflow-step-info-${props.id}`)
function openInfo(event: PointerEvent): void {
  if (event.pointerType === 'mouse' || event.pointerType === 'pen') infoOpen.value = true
}
function closeInfo(): void {
  if (!infoFocused.value) infoOpen.value = false
}
function focusInfo(): void { infoFocused.value = true; infoOpen.value = true }
function blurInfo(): void { infoFocused.value = false; infoOpen.value = false }
function activateInfo(): void { infoOpen.value = true }
</script>

<template>
  <div
    class="workflow-node-root workflow-step-root"
    :class="[
      `state-${data.slot.status}`,
      `shape-${data.template.shape}`,
      `capability-${data.visual.capability}`,
      `skin-${data.visual.shape}`,
    ]"
    :style="visualStyle(data.visual)"
    data-workflow-highlight-target
    :data-workflow-step-id="id"
    :data-workflow-occurrence-id="data.slot.occurrence?.occurrenceId"
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
      @pointerdown.stop
      @click.stop="selectStep"
    >
      <WorkflowMorphIcon
        class="workflow-step-capability-icon"
        :icon="data.visual.icon"
        :status-icon="stateIcon"
        :label="`${data.template.title}，${data.slot.statusText}`"
        :size="25"
      />
      <span class="workflow-step-visual" data-workflow-node-visual>
        <span class="workflow-step-title">{{ data.template.title }}</span>
        <span class="workflow-step-state">{{ data.slot.statusText }}</span>
      </span>
    </button>
    <button
      type="button"
      class="workflow-step-info-button nodrag nopan"
      aria-label="查看步骤说明"
      :aria-expanded="infoOpen"
      :aria-describedby="infoOpen ? infoId : undefined"
      @pointerdown.stop
      @pointerenter="openInfo"
      @pointerleave="closeInfo"
      @focus="focusInfo"
      @blur="blurInfo"
      @click.stop="activateInfo"
    >
      <InfoFilled aria-hidden="true" />
    </button>
    <aside v-if="infoOpen" :id="infoId" class="workflow-step-info" role="tooltip">
      <strong>{{ data.template.title }}</strong>
      <span>{{ data.template.detail }}</span>
    </aside>
    <WorkflowLiveCrt v-if="data.liveTurn" :turn="data.liveTurn" />
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
  justify-content: flex-start;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  gap: 10px;
  padding: 10px 34px 10px 10px;
  border: 1px solid color-mix(in srgb, var(--workflow-capability) 58%, var(--border-strong));
  border-radius: 0;
  background:
    linear-gradient(105deg, color-mix(in srgb, var(--workflow-capability) 10%, transparent), transparent 58%),
    var(--surface);
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 400;
  text-align: left;
}
.workflow-step-visual {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.workflow-step-capability-icon {
  flex: 0 0 32px;
  color: var(--workflow-capability);
}
.workflow-step-info-button {
  position: absolute;
  z-index: 4;
  top: 7px;
  right: 7px;
  display: grid;
  place-items: center;
  width: 24px;
  min-height: 24px;
  border: 0;
  background: transparent;
  padding: 0;
  color: color-mix(in srgb, var(--workflow-capability) 76%, var(--ink));
  cursor: help;
}
.workflow-step-info-button svg {
  width: 15px;
  height: 15px;
}
.workflow-step-info-button:is(:hover, :focus-visible) {
  color: var(--workflow-capability);
  background: color-mix(in srgb, var(--workflow-capability) 12%, var(--surface));
}
.workflow-step-info-button:focus-visible {
  outline: 2px solid var(--workflow-capability);
  outline-offset: 2px;
}
.workflow-step-info {
  position: absolute;
  z-index: 20;
  right: 0;
  bottom: calc(100% + 8px);
  display: grid;
  gap: 5px;
  width: 248px;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--workflow-capability) 62%, var(--border));
  background: var(--panel);
  box-shadow: 0 10px 28px color-mix(in srgb, #000 22%, transparent);
  padding: 9px 10px;
  color: var(--ink);
  line-height: 1.45;
  pointer-events: none;
}
.workflow-step-info strong {
  color: var(--workflow-capability);
  font-size: 12px;
}
.workflow-step-info span {
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font-size: 11px;
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
.skin-circuit .workflow-step-button {
  background-image: radial-gradient(
    circle at 4px 4px,
    color-mix(in srgb, var(--workflow-capability) 22%, transparent) 1px,
    transparent 1.25px
  );
  background-size: 12px 12px;
}
.skin-terminal .workflow-step-button {
  box-shadow: inset 0 -3px 0 color-mix(in srgb, var(--workflow-capability) 34%, transparent);
}
.skin-tool .workflow-step-button {
  border-style: double;
  border-width: 3px;
}
.skin-gate .workflow-step-button {
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
}
.skin-branch .workflow-step-button {
  border-block-style: double;
  border-block-width: 3px;
}
.skin-archive .workflow-step-button {
  background:
    repeating-linear-gradient(135deg, transparent 0 8px, color-mix(in srgb, var(--workflow-capability) 7%, transparent) 8px 9px),
    var(--surface);
}
.shape-note .workflow-step-button {
  border-style: dashed;
  background: var(--panel);
}
.state-running .workflow-step-button {
  border-color: var(--workflow-capability);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--workflow-capability) 26%, transparent);
}
.state-running [data-workflow-node-visual] {
  will-change: transform, opacity;
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
