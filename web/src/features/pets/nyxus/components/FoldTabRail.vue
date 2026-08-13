<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from 'vue'
import { useAgentsStore, useThemeStore } from '@/stores'
import type { ExecutionFoldMember } from '../graph/executionGraph'
import {
  FOLD_WHEEL_LAYER_CAPACITY,
  foldTabForMember,
  foldWheelView,
  type FoldWheelSlot,
} from '../graph/foldTabs'
import { toolBatchDetail } from '../graph/toolBatchDetails'

const props = defineProps<{
  members: ExecutionFoldMember[]
  selectedMemberId?: string
  unreadCount?: number
  anchorX: number
  anchorY: number
  side?: 'left' | 'right'
}>()
const emit = defineEmits<{
  select: [memberId: string]
  interaction: [active: boolean]
}>()
const agents = useAgentsStore()
const themeStore = useThemeStore()

const WHEEL_THRESHOLD = 46
const ANIMATION_MS = 220
const LAYER_SWITCH_MS = 110
const CARD_WIDTH = 144
const CARD_HEIGHT = 38
const STAGE_WIDTH = 216
const STAGE_HEIGHT = 180
const NODE_GAP = 18

type MemberSlot = FoldWheelSlot<ExecutionFoldMember>
type FoldTab = ReturnType<typeof foldTabForMember>

function displayTab(member: ExecutionFoldMember): FoldTab {
  const tab = foldTabForMember(member, themeStore.theme)
  const call = toolBatchDetail(member.displayNode)?.calls[0]
  if (!call) return tab
  const meta = agents.senseTools.find((tool) => tool.name === call.name)
  return {
    ...tab,
    glyph: meta?.icon || tab.glyph,
    label: meta?.label?.trim() || call.name,
  }
}

interface RenderedWheelCard {
  key: string
  item: ExecutionFoldMember
  itemIndex: number
  source?: MemberSlot
  target?: MemberSlot
  slot: MemberSlot
  tab?: FoldTab
  interactive: boolean
}

const dragging = ref(false)
const animating = ref(false)
const motionAtTarget = ref(false)
const layersAtTarget = ref(false)
const selectedIndex = computed(() => {
  const index = props.members.findIndex((member) => member.id === props.selectedMemberId)
  return index >= 0 ? index : Math.max(0, props.members.length - 1)
})
const visualIndex = ref(selectedIndex.value)
const animationFromIndex = ref(visualIndex.value)
const animationToIndex = ref(visualIndex.value)
const animationDirection = ref<1 | -1>(1)
const wheel = computed(() =>
  foldWheelView(props.members, animating.value ? animationToIndex.value : visualIndex.value),
)
const renderedCards = computed<RenderedWheelCard[]>(() => {
  const from = foldWheelView(
    props.members,
    animating.value ? animationFromIndex.value : visualIndex.value,
  )
  const to = foldWheelView(
    props.members,
    animating.value ? animationToIndex.value : visualIndex.value,
  )
  const sourceById = new Map(from.slots.map((slot) => [slot.item.id, slot]))
  const targetById = new Map(to.slots.map((slot) => [slot.item.id, slot]))
  const itemIds = [...sourceById.keys()]
  for (const id of targetById.keys()) if (!sourceById.has(id)) itemIds.push(id)

  return itemIds.flatMap((id) => {
    const source = sourceById.get(id)
    const target = targetById.get(id)
    const slot = animating.value
      ? layersAtTarget.value
        ? (target ?? source)
        : (source ?? target)
      : target
    const item = target?.item ?? source?.item
    if (!slot || !item) return []
    const realContent = slot.realContent && !!source && !!target
    return [
      {
        key: id,
        item,
        itemIndex: target?.itemIndex ?? source?.itemIndex ?? 0,
        source,
        target,
        slot,
        tab: realContent ? displayTab(item) : undefined,
        interactive: !animating.value && realContent && slot.interactive,
      },
    ]
  })
})
const navigationStyle = computed<CSSProperties>(() => ({
  left: `${
    props.side === 'right' ? props.anchorX + NODE_GAP : props.anchorX - STAGE_WIDTH - NODE_GAP
  }px`,
  top: `${props.anchorY - STAGE_HEIGHT / 2}px`,
}))
// rail 在节点右侧时，stage 左缘朝向节点，active 卡仍落在 +x（右缘）会背对节点；
// 水平取反后 active 落左缘贴节点，上方按钮随之到最左，与左侧渲染对称。
const mirrorX = computed(() => (props.side === 'right' ? -1 : 1))

let wheelAccumulator = 0
let wheelResetTimer: ReturnType<typeof setTimeout> | undefined
let layerTimer: ReturnType<typeof setTimeout> | undefined
let finishTimer: ReturnType<typeof setTimeout> | undefined
let animationFrame: number | undefined
let dragStartY = 0
let emitSelectionAtFinish = true
let queuedTarget: { index: number; emitSelection: boolean } | undefined
const queuedSteps: Array<1 | -1> = []

function circularIndex(index: number): number {
  const length = props.members.length
  return length ? ((index % length) + length) % length : 0
}

function normalizedIndex(index: number, wrap: boolean): number {
  if (props.members.length === 0) return 0
  return wrap ? circularIndex(index) : Math.max(0, Math.min(index, props.members.length - 1))
}

function transitionDuration(): number {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : ANIMATION_MS
}

function clearAnimationTimers(): void {
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
  if (layerTimer) clearTimeout(layerTimer)
  if (finishTimer) clearTimeout(finishTimer)
  animationFrame = undefined
  layerTimer = undefined
  finishTimer = undefined
}

function processQueue(): void {
  if (animating.value || props.members.length === 0) return
  if (queuedTarget) {
    const target = queuedTarget
    queuedTarget = undefined
    beginTransition(target.index, target.index >= visualIndex.value ? 1 : -1, target.emitSelection)
    return
  }
  const delta = queuedSteps.shift()
  if (delta) beginTransition(circularIndex(visualIndex.value + delta), delta, true)
}

function finishTransition(): void {
  clearAnimationTimers()
  visualIndex.value = normalizedIndex(animationToIndex.value, false)
  animationFromIndex.value = visualIndex.value
  animating.value = false
  motionAtTarget.value = false
  layersAtTarget.value = false
  const member = props.members[visualIndex.value]
  if (emitSelectionAtFinish && member) emit('select', member.id)
  void nextTick(processQueue)
}

function beginTransition(targetIndex: number, direction: 1 | -1, shouldEmit: boolean): void {
  const target = normalizedIndex(targetIndex, false)
  if (target === visualIndex.value) {
    const member = props.members[target]
    if (shouldEmit && member) emit('select', member.id)
    void nextTick(processQueue)
    return
  }
  clearAnimationTimers()
  animationFromIndex.value = visualIndex.value
  animationToIndex.value = target
  animationDirection.value = direction
  emitSelectionAtFinish = shouldEmit
  motionAtTarget.value = false
  layersAtTarget.value = false
  animating.value = true

  void nextTick(() => {
    const duration = transitionDuration()
    if (duration === 0) {
      motionAtTarget.value = true
      layersAtTarget.value = true
      finishTransition()
      return
    }
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined
      motionAtTarget.value = true
      layerTimer = setTimeout(() => {
        layerTimer = undefined
        layersAtTarget.value = true
      }, LAYER_SWITCH_MS)
      finishTimer = setTimeout(finishTransition, duration)
    })
  })
}

function enqueueStep(delta: 1 | -1): void {
  if (!animating.value) {
    beginTransition(circularIndex(visualIndex.value + delta), delta, true)
    return
  }
  const previous = queuedSteps.at(-1)
  if (previous === -delta) queuedSteps.pop()
  else queuedSteps.push(delta)
}

function requestIndex(index: number, wrap = true): void {
  const target = normalizedIndex(index, wrap)
  queuedSteps.splice(0)
  if (animating.value) {
    queuedTarget = { index: target, emitSelection: true }
    return
  }
  beginTransition(target, target >= visualIndex.value ? 1 : -1, true)
}

function selectCard(card: RenderedWheelCard): void {
  if (!card.interactive || card.slot.role === 'active') return
  enqueueStep(card.slot.id === 'C' ? -1 : 1)
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
  wheelAccumulator += event.deltaY * unit
  if (wheelResetTimer) clearTimeout(wheelResetTimer)
  wheelResetTimer = setTimeout(() => (wheelAccumulator = 0), 160)
  if (Math.abs(wheelAccumulator) < WHEEL_THRESHOLD) return
  const direction = wheelAccumulator > 0 ? 1 : -1
  wheelAccumulator = 0
  enqueueStep(direction)
}

function onKeydown(event: KeyboardEvent): void {
  const base = animating.value ? animationToIndex.value : visualIndex.value
  const actions: Partial<Record<string, () => void>> = {
    ArrowUp: () => enqueueStep(-1),
    ArrowLeft: () => enqueueStep(-1),
    ArrowDown: () => enqueueStep(1),
    ArrowRight: () => enqueueStep(1),
    PageUp: () => requestIndex(base - FOLD_WHEEL_LAYER_CAPACITY, false),
    PageDown: () => requestIndex(base + FOLD_WHEEL_LAYER_CAPACITY, false),
    Home: () => requestIndex(0, false),
    End: () => requestIndex(props.members.length - 1, false),
  }
  const action = actions[event.key]
  if (!action) return
  event.preventDefault()
  action()
}

function startDrag(event: PointerEvent): void {
  if (event.button !== 0) return
  dragging.value = true
  dragStartY = event.clientY
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  emit('interaction', true)
}

function drag(event: PointerEvent): void {
  if (!dragging.value) return
  const delta = event.clientY - dragStartY
  if (Math.abs(delta) < 28) return
  enqueueStep(delta < 0 ? 1 : -1)
  dragStartY = event.clientY
}

function endDrag(event: PointerEvent): void {
  dragging.value = false
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId)
  emit('interaction', false)
}

function leaveWheel(): void {
  if (!dragging.value) emit('interaction', false)
}

function onFocusOut(event: FocusEvent): void {
  const current = event.currentTarget as HTMLElement
  if (event.relatedTarget instanceof Node && current.contains(event.relatedTarget)) return
  emit('interaction', false)
}

function seamPoint(): { x: number; y: number } {
  return { x: -42 * mirrorX.value, y: animationDirection.value > 0 ? 16 : -16 }
}

function cardPoint(card: RenderedWheelCard): { x: number; y: number; opacity: number } {
  const slot = motionAtTarget.value ? card.target : card.source
  if (slot) return { x: slot.x * mirrorX.value, y: slot.y, opacity: slot.opacity }
  return { ...seamPoint(), opacity: 0 }
}

function cardStyle(card: RenderedWheelCard): CSSProperties {
  const point = cardPoint(card)
  return {
    left: `${STAGE_WIDTH / 2 + point.x - CARD_WIDTH / 2}px`,
    top: `${STAGE_HEIGHT / 2 + point.y - CARD_HEIGHT / 2}px`,
    zIndex: card.slot.zIndex,
    opacity: point.opacity,
  }
}

watch(selectedIndex, (index) => {
  if (index === visualIndex.value || (animating.value && index === animationToIndex.value)) return
  if (animating.value) {
    queuedSteps.splice(0)
    queuedTarget = { index, emitSelection: false }
    return
  }
  beginTransition(index, index >= visualIndex.value ? 1 : -1, false)
})

watch(
  () => props.members.length,
  () => {
    visualIndex.value = normalizedIndex(visualIndex.value, false)
    animationFromIndex.value = normalizedIndex(animationFromIndex.value, false)
    animationToIndex.value = normalizedIndex(animationToIndex.value, false)
  },
)

onBeforeUnmount(() => {
  if (wheelResetTimer) clearTimeout(wheelResetTimer)
  clearAnimationTimers()
})
</script>

<template>
  <nav
    class="fold-wheel-navigation"
    :class="{ 'is-dragging': dragging, 'is-animating': animating }"
    :style="navigationStyle"
    aria-label="过程组页签轮盘"
    tabindex="0"
    @pointerenter="emit('interaction', true)"
    @pointerleave="leaveWheel"
    @focusin="emit('interaction', true)"
    @focusout="onFocusOut"
    @keydown="onKeydown"
    @wheel.stop="onWheel"
  >
    <div
      class="fold-wheel-stage"
      @pointerdown="startDrag"
      @pointermove="drag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    >
      <button
        v-for="card in renderedCards"
        :key="card.key"
        type="button"
        class="fold-wheel-card"
        :class="[
          `slot-${card.slot.id}`,
          `role-${card.slot.role}`,
          card.tab ? `kind-${card.tab.kind}` : undefined,
          {
            'is-real': !!card.tab,
            'is-ghost': !card.tab,
            'is-selected': card.slot.role === 'active',
          },
        ]"
        :style="cardStyle(card)"
        :disabled="!card.interactive"
        :aria-hidden="card.tab ? undefined : true"
        :aria-current="card.slot.role === 'active' ? 'page' : undefined"
        :title="card.tab ? `${card.tab.label} · ${card.tab.status}` : undefined"
        @pointerdown.stop
        @click.stop="selectCard(card)"
      >
        <template v-if="card.tab">
          <span class="wheel-card-glyph" :style="{ color: card.tab.accent }">
            {{ card.tab.glyph }}
          </span>
          <span class="wheel-card-copy">
            <strong>{{ card.tab.label }}</strong>
            <small>{{ card.tab.status }}</small>
          </span>
          <span class="wheel-card-status" :style="{ background: card.tab.accent }" />
          <span v-if="card.slot.role === 'active' && unreadCount" class="wheel-card-unread">
            +{{ unreadCount }}
          </span>
        </template>
        <template v-else>
          <span class="ghost-index">{{ card.itemIndex + 1 }}</span>
          <span class="ghost-line" />
        </template>
      </button>
    </div>
    <div class="fold-wheel-position" aria-live="polite">
      <span>{{ wheel.selectedIndex + 1 }}/{{ wheel.itemCount }}</span>
      <span v-if="wheel.layerCount > 1">
        层 {{ wheel.layerIndex + 1 }}/{{ wheel.layerCount }}
      </span>
    </div>
  </nav>
</template>

<style scoped lang="less">
.fold-wheel-navigation {
  position: absolute;
  z-index: 3;
  width: 216px;
  height: 204px;
  outline: none;
  user-select: none;
}
.fold-wheel-navigation:focus-visible .fold-wheel-stage {
  filter: drop-shadow(0 0 6px rgba(246, 183, 60, 0.32));
}
.fold-wheel-stage {
  position: absolute;
  inset: 0 0 24px;
  cursor: ns-resize;
  touch-action: none;
}
.fold-wheel-navigation.is-dragging .fold-wheel-stage {
  cursor: grabbing;
}
.fold-wheel-card {
  position: absolute;
  width: 144px;
  height: 38px;
  box-sizing: border-box;
  margin: 0;
  appearance: none;
  border: 1px solid rgba(60, 68, 64, 0.18);
  border-radius: 7px;
  transition:
    left 340ms cubic-bezier(0.22, 0.68, 0.2, 1),
    top 340ms cubic-bezier(0.22, 0.68, 0.2, 1),
    opacity 260ms ease,
    border-color 160ms ease,
    filter 160ms ease;
}
.fold-wheel-card.is-real {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 5px;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  color: #1f2328;
  background: linear-gradient(100deg, rgba(255, 255, 255, 0.98), rgba(247, 244, 237, 0.96));
  box-shadow: 0 7px 16px rgba(31, 35, 40, 0.12);
  text-align: left;
  cursor: pointer;
}
.fold-wheel-card.is-real:hover {
  color: #000;
  border-color: rgba(246, 183, 60, 0.9);
  filter: brightness(1.02);
}
.fold-wheel-card.is-selected {
  cursor: default;
  border-color: #f6b73c;
  box-shadow:
    0 9px 22px rgba(31, 35, 40, 0.14),
    0 0 0 1px rgba(246, 183, 60, 0.18),
    0 0 16px rgba(246, 183, 60, 0.12);
}
.fold-wheel-card.is-ghost {
  display: grid;
  grid-template-columns: 22px 1fr;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  color: rgba(31, 35, 40, 0.42);
  background: linear-gradient(100deg, rgba(255, 255, 255, 0.9), rgba(247, 244, 237, 0.74));
  box-shadow: 0 5px 12px rgba(31, 35, 40, 0.1);
  pointer-events: none;
}
.fold-wheel-card.role-transition {
  border-color: rgba(60, 68, 64, 0.12);
}
.fold-wheel-card.role-back {
  border-color: rgba(60, 68, 64, 0.08);
}
.wheel-card-glyph {
  font:
    700 13px/1 ui-monospace,
    monospace;
  text-align: center;
}
.wheel-card-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.wheel-card-copy strong,
.wheel-card-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wheel-card-copy strong {
  font:
    700 9px/1.1 system-ui,
    sans-serif;
}
.wheel-card-copy small {
  color: rgba(31, 35, 40, 0.55);
  font:
    8px/1 ui-monospace,
    monospace;
}
.wheel-card-status {
  width: 4px;
  height: 4px;
  border-radius: 50%;
}
.wheel-card-unread {
  position: absolute;
  right: -5px;
  top: -6px;
  padding: 2px 4px;
  color: #fff;
  border-radius: 5px;
  background: #d85b27;
  font:
    700 8px/1 ui-monospace,
    monospace;
}
.ghost-index {
  font:
    700 8px/1 ui-monospace,
    monospace;
  text-align: center;
}
.ghost-line {
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(31, 35, 40, 0.28), transparent);
}
.fold-wheel-position {
  position: absolute;
  right: 3px;
  bottom: 0;
  display: flex;
  gap: 8px;
  color: rgba(31, 35, 40, 0.56);
  font:
    700 8px/1 ui-monospace,
    monospace;
}

// 深色主题：沿用现行深蓝青轮盘（浅色默认已用白底深字）。
[data-theme='dark'] {
  .fold-wheel-navigation:focus-visible .fold-wheel-stage {
    filter: drop-shadow(0 0 6px rgba(181, 255, 242, 0.32));
  }
  .fold-wheel-card {
    border-color: rgba(107, 207, 247, 0.28);
  }
  .fold-wheel-card.is-real {
    color: rgba(221, 244, 252, 0.82);
    background: linear-gradient(100deg, rgba(8, 26, 39, 0.99), rgba(12, 38, 52, 0.96));
    box-shadow: 0 7px 16px rgba(0, 0, 0, 0.3);
  }
  .fold-wheel-card.is-real:hover {
    color: #fff;
    border-color: rgba(181, 255, 242, 0.82);
    filter: brightness(1.14);
  }
  .fold-wheel-card.is-selected {
    border-color: #b5fff2;
    box-shadow:
      0 9px 22px rgba(0, 0, 0, 0.4),
      0 0 0 1px rgba(181, 255, 242, 0.18),
      0 0 16px rgba(107, 207, 247, 0.2);
  }
  .fold-wheel-card.is-ghost {
    color: rgba(157, 216, 238, 0.44);
    background: linear-gradient(100deg, rgba(6, 18, 29, 0.88), rgba(12, 31, 43, 0.72));
    box-shadow: 0 5px 12px rgba(0, 0, 0, 0.22);
  }
  .fold-wheel-card.role-transition {
    border-color: rgba(107, 207, 247, 0.2);
  }
  .fold-wheel-card.role-back {
    border-color: rgba(107, 207, 247, 0.12);
  }
  .wheel-card-copy small {
    color: rgba(202, 231, 244, 0.52);
  }
  .wheel-card-unread {
    color: #07131e;
    background: #ffca73;
  }
  .ghost-line {
    background: linear-gradient(90deg, rgba(157, 216, 238, 0.35), transparent);
  }
  .fold-wheel-position {
    color: rgba(157, 216, 238, 0.56);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fold-wheel-card {
    transition: none;
  }
}
</style>
