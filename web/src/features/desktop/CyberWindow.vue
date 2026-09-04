<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorkspaceWindowGeometry, WorkspaceWindowState } from '@/application/shell/public'
import { useQuickSetter } from '@/composables/useGsap'
import { WORKSPACE_WINDOW_Z_INDEX_BASE } from '@/styles/overlayLayers'
import { useCyberWindowMotion } from './useCyberWindowMotion'

const props = defineProps<{ window: WorkspaceWindowState }>()
const emit = defineEmits<{
  focus: [id: string]
  opened: [id: string]
  minimize: [id: string]
  requestClose: [id: string]
  closed: [id: string]
  geometry: [id: string, geometry: WorkspaceWindowGeometry]
  toggleMaximize: [id: string]
}>()

const root = ref<HTMLElement | null>(null)
const motion = useCyberWindowMotion(root, () => emit('opened', props.window.id))
const setX = useQuickSetter(() => root.value!, 'x', 'px')
const setY = useQuickSetter(() => root.value!, 'y', 'px')
const setWidth = useQuickSetter(() => root.value!, 'width', 'px')
const setHeight = useQuickSetter(() => root.value!, 'height', 'px')
const drag = ref<{
  mode: 'move' | 'resize'
  pointerId: number
  startX: number
  startY: number
  geometry: WorkspaceWindowGeometry
} | null>(null)

const style = computed(() => ({
  left: `${props.window.geometry.x}px`,
  top: `${props.window.geometry.y}px`,
  width: `${props.window.geometry.width}px`,
  height: `${props.window.geometry.height}px`,
  zIndex: WORKSPACE_WINDOW_Z_INDEX_BASE + props.window.zOrder,
}))

watch(
  () => props.window.lifecycle,
  (lifecycle) => {
    if (lifecycle === 'closing') motion.close(() => emit('closed', props.window.id))
  },
)
watch(
  () => props.window.focused,
  (focused) => {
    if (focused) motion.focus()
  },
)
watch(
  () => props.window.attention,
  (attention) => {
    if (attention) motion.glitch()
  },
)

function startPointer(event: PointerEvent, mode: 'move' | 'resize'): void {
  if (
    event.button !== 0 ||
    props.window.maximized ||
    (event.target as HTMLElement | null)?.closest(
      '[data-window-interactive],button,input,select,textarea,a,[role="button"],[role="switch"]',
    )
  ) {
    return
  }
  emit('focus', props.window.id)
  drag.value = {
    mode,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    geometry: { ...props.window.geometry },
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function toggleMaximize(): void {
  emit('toggleMaximize', props.window.id)
}

function onTitleDoubleClick(event: MouseEvent): void {
  if ((event.target as HTMLElement | null)?.closest('[data-window-interactive]')) return
  toggleMaximize()
}

function movePointer(event: PointerEvent): void {
  const active = drag.value
  if (!active || active.pointerId !== event.pointerId) return
  const dx = event.clientX - active.startX
  const dy = event.clientY - active.startY
  if (active.mode === 'move') {
    setX(dx)
    setY(dy)
  } else {
    setWidth(Math.max(360, active.geometry.width + dx))
    setHeight(Math.max(260, active.geometry.height + dy))
  }
}

function endPointer(event: PointerEvent): void {
  const active = drag.value
  if (!active || active.pointerId !== event.pointerId) return
  const dx = event.clientX - active.startX
  const dy = event.clientY - active.startY
  const geometry =
    active.mode === 'move'
      ? { ...active.geometry, x: active.geometry.x + dx, y: active.geometry.y + dy }
      : {
          ...active.geometry,
          width: Math.max(360, active.geometry.width + dx),
          height: Math.max(260, active.geometry.height + dy),
        }
  setX(0)
  setY(0)
  emit('geometry', props.window.id, geometry)
  drag.value = null
}
</script>

<template>
  <section
    v-show="window.lifecycle !== 'minimized'"
    ref="root"
    class="cyber-window"
    :class="[
      `is-${window.kind}`,
      {
        'is-focused': window.focused,
        'has-attention': window.attention,
        'is-maximized': window.maximized,
      },
    ]"
    :style="style"
    @pointerdown="emit('focus', window.id)"
  >
    <div class="cyber-window-corners" aria-hidden="true" />
    <div class="cyber-window-scan" aria-hidden="true" />
    <header
      class="cyber-window-titlebar"
      @pointerdown.stop="startPointer($event, 'move')"
      @dblclick="onTitleDoubleClick"
      @pointermove="movePointer"
      @pointerup="endPointer"
      @pointercancel="endPointer"
    >
      <span class="cyber-window-channel">{{ window.kind.toUpperCase() }}</span>
      <strong>{{ window.title }}</strong>
      <div
        v-if="$slots['title-actions']"
        class="cyber-window-title-actions"
        data-window-interactive
        @dblclick.stop
      >
        <slot name="title-actions" />
      </div>
      <span class="cyber-window-signal" aria-hidden="true">01 ▰▰▰</span>
      <div class="cyber-window-actions" data-window-interactive @pointerdown.stop @dblclick.stop>
        <button type="button" aria-label="最小化" @click="emit('minimize', window.id)">_</button>
        <button
          type="button"
          :aria-label="window.maximized ? '还原窗口' : '最大化窗口'"
          :title="window.maximized ? '还原' : '最大化'"
          @click="toggleMaximize"
        >
          {{ window.maximized ? '❐' : '□' }}
        </button>
        <button type="button" aria-label="关闭" @click="emit('requestClose', window.id)">×</button>
      </div>
    </header>
    <div class="cyber-window-body"><slot /></div>
    <button
      v-if="!window.maximized"
      type="button"
      class="cyber-window-resize"
      aria-label="调整窗口大小"
      @pointerdown.stop="startPointer($event, 'resize')"
      @pointermove="movePointer"
      @pointerup="endPointer"
      @pointercancel="endPointer"
    />
  </section>
</template>

<style scoped lang="less">
.cyber-window {
  --cyber-focus: 0;
  position: absolute;
  overflow: hidden;
  min-width: 360px;
  min-height: 260px;
  border: 1px solid color-mix(in srgb, var(--cyber-line) 76%, transparent);
  border-radius: 0;
  background: var(--cyber-window-bg);
  color: var(--ink);
  box-shadow:
    0 20px 64px rgba(0, 0, 0, 0.34),
    0 0 calc(22px * var(--cyber-focus)) var(--accent-glow),
    inset 0 0 0 1px
      color-mix(in srgb, var(--accent) calc(18% + var(--cyber-focus) * 42%), transparent);
  isolation: isolate;
  will-change: transform, opacity;
  pointer-events: auto;
}

.cyber-window.is-focused {
  border-color: color-mix(in srgb, var(--accent) 76%, var(--cyber-line));
}

.cyber-window.has-attention {
  border-color: var(--warning);
}

.cyber-window-corners {
  position: absolute;
  inset: 5px;
  z-index: 3;
  pointer-events: none;
  background:
    linear-gradient(var(--accent), var(--accent)) left top / 18px 1px no-repeat,
    linear-gradient(var(--accent), var(--accent)) left top / 1px 18px no-repeat,
    linear-gradient(var(--accent), var(--accent)) right bottom / 18px 1px no-repeat,
    linear-gradient(var(--accent), var(--accent)) right bottom / 1px 18px no-repeat;
  opacity: 0.62;
}

.cyber-window-scan {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 4;
  width: 22%;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--accent) 22%, transparent),
    transparent
  );
  pointer-events: none;
}

.cyber-window-titlebar {
  position: relative;
  z-index: 5;
  height: 38px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--cyber-line) 64%, transparent);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 15%, transparent), transparent 42%),
    var(--cyber-title-bg);
  cursor: move;
  user-select: none;
}

.cyber-window-channel,
.cyber-window-signal {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
}

.cyber-window-channel {
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--accent) 46%, transparent);
}

.cyber-window-titlebar strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.cyber-window-title-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  cursor: default;
}

.cyber-window-title-actions :deep(*) {
  pointer-events: auto;
}

.cyber-window-signal {
  margin-left: auto;
  opacity: 0.64;
}

.cyber-window-actions {
  align-self: stretch;
  display: flex;
}

.cyber-window-actions button {
  width: 38px;
  border: 0;
  border-left: 1px solid color-mix(in srgb, var(--cyber-line) 44%, transparent);
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font: 400 15px/1 var(--font-mono);
  cursor: pointer;
}

.cyber-window-actions button:hover,
.cyber-window-actions button:focus-visible {
  background: var(--accent-soft);
  color: var(--accent);
}

.cyber-window-actions button:last-child:hover,
.cyber-window-actions button:last-child:focus-visible {
  background: color-mix(in srgb, var(--danger) 76%, transparent);
  color: white;
}

.cyber-window.is-maximized {
  border-color: color-mix(in srgb, var(--accent) 82%, var(--cyber-line));
}

.cyber-window-body {
  position: absolute;
  inset: 38px 0 0;
  display: flex;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.cyber-window-body > :deep(*) {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.cyber-window-resize {
  position: absolute;
  z-index: 8;
  right: 0;
  bottom: 0;
  width: 20px;
  height: 20px;
  border: 0;
  border-radius: 0;
  background:
    linear-gradient(135deg, transparent 48%, var(--cyber-line) 49% 54%, transparent 55%),
    linear-gradient(135deg, transparent 68%, var(--accent) 69% 74%, transparent 75%);
  cursor: nwse-resize;
}
</style>
