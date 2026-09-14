<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import { InfoFilled } from '@element-plus/icons-vue'
import type { HeaderChildData } from './headerGraph'

import { statusIcon, visualStyle, headerLayerColor } from './workflowVisuals'
import WorkflowMorphIcon from './WorkflowMorphIcon.vue'

type StepData = Extract<HeaderChildData, { kind: 'header-step' }>
const props = defineProps<NodeProps<StepData> & { pendingCount?: number }>()
const emit = defineEmits<{ select: []; attention: [] }>()
const positions = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
}
const ports = computed(() => props.data.ports)
const stateIcon = computed(() =>
  props.data.liveTurn
    ? statusIcon('running')
    : props.data.slot.status === 'idle'
      ? undefined
      : statusIcon(props.data.slot.status),
)
const infoPosition = ref<{ left: number; top: number; below: boolean }>()
const infoId = computed(() => `workflow-step-info-${props.id}`)
function openInfo(event: PointerEvent | FocusEvent): void {
  if ('pointerType' in event && !['mouse', 'pen'].includes(event.pointerType)) return
  const target = event.currentTarget as HTMLElement
  if (event.type === 'focus' && !target.matches(':focus-visible')) return
  const rect = target.parentElement!.getBoundingClientRect()
  infoPosition.value = {
    left: Math.max(8, Math.min(rect.right - 248, window.innerWidth - 256)),
    top: rect.top < 200 ? rect.bottom + 8 : rect.top - 8,
    below: rect.top < 200,
  }
  window.addEventListener('resize', closeInfo)
  window.addEventListener('wheel', closeInfo, { capture: true, passive: true })
  document.addEventListener('visibilitychange', closeInfo)
}
function closeInfo(): void {
  infoPosition.value = undefined
  window.removeEventListener('resize', closeInfo)
  window.removeEventListener('wheel', closeInfo, true)
  document.removeEventListener('visibilitychange', closeInfo)
}
onBeforeUnmount(closeInfo)
</script>

<template>
  <div
    class="workflow-node-root workflow-step-root"
    :class="[
      `state-${pendingCount ? 'waiting' : data.liveTurn ? 'running' : data.slot.status}`,
      `shape-${data.template.shape}`,
      `capability-${data.visual.capability}`,
      `skin-${data.visual.shape}`,
      {
        'is-traced': data.participated,
        'is-unvisited': !data.participated && !data.slot.occurrence && !data.liveTurn,
      },
    ]"
    :style="{
      ...visualStyle(data.visual),
      '--workflow-capability':
        headerLayerColor(data.template.group),
    }"
    data-workflow-highlight-target
    :data-workflow-step-id="id"
    :data-workflow-occurrence-id="data.slot.occurrence?.occurrenceId"
    :data-iteration="data.iteration"
    :data-workflow-layer="data.template.group"
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
      <span
v-if="!pendingCount && (data.liveTurn || data.slot.status === 'running')"
        class="workflow-step-beacon" data-workflow-beacon aria-hidden="true" />
    <button
      type="button"
      class="workflow-step-button nodrag nopan"
      :aria-label="`${data.template.title}，${data.slot.statusText}`"
      :aria-busy="data.slot.status === 'running' || !!data.liveTurn"
      :data-workflow-header-id="data.headerId"
      :data-workflow-slot-kind="data.template.kinds[0]"
      :data-workflow-template-node="data.template.id"
      @pointerdown.stop
      @click.stop="data.template.id === 'approval' ? emit('attention') : emit('select')"
    >
      <span
        v-if="data.slot.status === 'running' || data.liveTurn"
        class="workflow-step-loading"
        data-workflow-loading
        aria-label="正在运行"
      />
      <WorkflowMorphIcon
        class="workflow-step-capability-icon"
        :icon="data.visual.icon"
        :status-icon="stateIcon"
        :label="`${data.template.title}，${data.slot.statusText}`"
        :size="25"
      />
      <span class="workflow-step-visual" data-workflow-node-visual>
        <span class="workflow-step-title">
          {{ data.template.title }}
        </span>
        <span
          v-if="data.call"
          class="workflow-step-call"
          :aria-label="`${data.call.name}，${data.slot.statusText}`"
          >{{ data.call.name }} · {{ data.slot.statusText }}</span
        >
      </span>
    </button>
    <button
      type="button"
      class="workflow-step-info-button nodrag nopan"
      :aria-label="`${data.template.title}说明`"
      :aria-describedby="infoPosition ? infoId : undefined"
      @pointerdown.stop
      @pointerenter="openInfo"
      @pointerleave="closeInfo"
      @focus="openInfo"
      @blur="closeInfo"
      @click.stop
      @keydown.esc.stop="closeInfo"
    >
      <InfoFilled aria-hidden="true" />
    </button>
    <Teleport to="body">
      <aside
        v-if="infoPosition"
        :id="infoId"
        class="workflow-step-info"
        role="tooltip"
        :style="{
          left: `${infoPosition.left}px`,
          top: `${infoPosition.top}px`,
          transform: infoPosition.below ? undefined : 'translateY(-100%)',
          zIndex: OVERLAY_Z_INDEX.tooltip,
          '--workflow-capability':
            headerLayerColor(data.template.group),
        }"
      >
        <strong>{{ data.template.title }}</strong>
        <span>{{ data.template.detail }}</span>
        <template v-if="data.call">
          <span>{{ data.call.name }} · {{ data.slot.statusText }}</span>
          <span v-if="data.slot.occurrence?.label">{{ data.slot.occurrence.label }}</span>
        </template>
      </aside>
    </Teleport>
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
  gap: 6px;
  padding: 6px 30px 6px 6px;
  border: 1px solid color-mix(in srgb, var(--workflow-capability) 58%, var(--border-strong));
  border-radius: 0;
  background:
    linear-gradient(
      105deg,
      color-mix(in srgb, var(--workflow-capability) 10%, transparent),
      transparent 58%
    ),
    color-mix(in srgb, var(--workflow-capability) 14%, var(--surface));
  color: var(--ink);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 400;
  text-align: left;
}
.workflow-step-visual {
  display: grid;
  gap: 2px;
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
  position: fixed;
  display: grid;
  gap: 5px;
  width: 248px;
  max-width: calc(100vw - 16px);
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--workflow-capability) 62%, var(--border));
  background: var(--panel);
  box-shadow: 0 10px 28px color-mix(in srgb, var(--ink) 16%, transparent);
  padding: 9px 10px;
  color: var(--ink);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  pointer-events: none;
}
.workflow-step-info strong {
  color: var(--workflow-capability);
  font-size: 12px;
  font-weight: 400;
}
.workflow-step-info span {
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font-size: 12px;
}
.workflow-step-title {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
  line-height: 1.4;
}
.workflow-step-button:has(.workflow-step-call) .workflow-step-title {
  white-space: nowrap;
}
.workflow-step-call {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
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
    repeating-linear-gradient(
      135deg,
      transparent 0 8px,
      color-mix(in srgb, var(--workflow-capability) 7%, transparent) 8px 9px
    ),
    var(--surface);
}
.shape-note .workflow-step-button {
  border-style: dashed;
  background: var(--panel);
}
/* 灰色静止态：尚未运行 / 上一 loop 的旧链在新 loop 开始时安全回到灰色 */
.state-idle .workflow-step-button {
  border-color: color-mix(in srgb, var(--workflow-capability) 26%, var(--border-strong));
  background: color-mix(in srgb, var(--workflow-capability) 5%, var(--surface));
}
.state-idle .workflow-step-capability-icon {
  color: color-mix(in srgb, var(--workflow-capability) 34%, var(--workflow-muted));
}
.state-idle .workflow-step-title,
.state-idle .workflow-step-call {
  color: var(--workflow-muted);
}
.state-idle .workflow-step-beacon {
  display: none;
}
.state-running .workflow-step-button {
  border-color: var(--accent);
  box-shadow:
    inset 0 0 0 1px var(--accent),
    0 0 20px color-mix(in srgb, var(--accent) 55%, transparent);
}
.state-running [data-workflow-node-visual] {
  will-change: transform, opacity;
}
.state-waiting .workflow-step-button {
  border-color: var(--warning);
  box-shadow: inset 0 0 0 1px var(--warning);
}
.state-waiting .workflow-step-capability-icon {
  color: var(--warning);
}
.state-succeeded .workflow-step-capability-icon,
.state-running .workflow-step-capability-icon {
  color: var(--accent);
}
.is-traced .workflow-step-title {
  color: var(--accent);
}
.is-traced :deep(.vue-flow__handle) {
  border-color: var(--accent);
  background: var(--accent);
}
.state-failed .workflow-step-capability-icon,
.state-rejected .workflow-step-capability-icon {
  color: var(--danger);
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

}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.workflow-step-loading {
  position: absolute;
  left: 7px;
  bottom: 5px;
  width: 10px;
  height: 10px;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-top-color: var(--accent);
  border-radius: 50%;
}

.is-traced:not(.state-waiting):not(.state-failed):not(.state-rejected) .workflow-step-button { border-color: var(--accent); }
.workflow-step-beacon {
  position: absolute;
  inset: -5px;
  border: 2px solid var(--accent);
  box-shadow: 0 0 16px color-mix(in srgb, var(--accent) 45%, transparent);
  opacity: 0;
  pointer-events: none;
}
.state-waiting .workflow-step-beacon { border-color: var(--warning); }
</style>
