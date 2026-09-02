<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type CSSProperties } from 'vue'
import { gsap } from 'gsap'
import { useGsap } from '@/composables/useGsap'
import { useNyxusHost } from '../application/host'
import type { ExecutionFoldMember } from '../graph/executionGraph'
import {
  FOLD_WHEEL_LAYER_CAPACITY,
  foldTabForMember,
  foldWheelView,
  type FoldWheelSlot,
} from '../graph/foldTabs'
import { toolBatchDetail } from '../graph/toolBatchDetails'

/**
 * 过程组左轮（弹链轮盘，2026-09-02 返工）：
 * 行为复用 143af38 之前的 fold-wheel（拖拽转轮 / 滚轮步进阈值 / 键盘三路导航 /
 * foldWheelView 8 槽位分层翻页），视觉按无圆角科幻风重做为类型化子弹芯片。
 * 动效走 useGsap scoped：步进/翻层只动 transform 与 autoAlpha（180-220ms
 * power2.out），hover 用 CSS ≤200ms，入场 stagger 总时长 ≤240ms，无常驻循环。
 */
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
const { agents, theme: themeStore } = useNyxusHost()

const WHEEL_THRESHOLD = 40
const STEP_MS = 0.2
const CHIP_WIDTH = 128
const CHIP_HEIGHT = 30
const ACTIVE_WIDTH = 148
const ACTIVE_HEIGHT = 36
const STAGE_WIDTH = 272
const STAGE_HEIGHT = 168

const root = ref<HTMLElement | null>(null)
let gsapContext: gsap.Context | undefined

useGsap(root, (context) => {
  gsapContext = context
  // 入场 stagger：芯片由 0 淡入就位，总时长 = stagger×7 + duration ≈ 224ms ≤ 240ms。
  context.add(() => {
    if (reducedMotion()) return
    const chips = root.value?.querySelectorAll('.fold-wheel-chip')
    if (chips?.length) {
      gsap.from(chips, { autoAlpha: 0, duration: 0.14, stagger: 0.012, ease: 'power2.out', clearProps: 'transform' })
    }
  })
})

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

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

interface RenderedWheelChip {
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
const renderedChips = computed<RenderedWheelChip[]>(() => {
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
    const slot = target ?? source
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
        interactive: realContent && slot.interactive,
      },
    ]
  })
})
/** rail 在节点右侧时水平取反，active 芯片仍落在贴节点一侧（与旧轮盘一致）。 */
const mirrorX = computed(() => (props.side === 'right' ? -1 : 1))
const navigationStyle = computed<CSSProperties>(() => ({
  left: `${
    props.side === 'right' ? props.anchorX + 18 : props.anchorX - STAGE_WIDTH - 18
  }px`,
  top: `${props.anchorY - STAGE_HEIGHT / 2}px`,
}))

let wheelAccumulator = 0
let wheelResetTimer: ReturnType<typeof setTimeout> | undefined
let finishTimer: ReturnType<typeof setTimeout> | undefined
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

function clearAnimationTimers(): void {
  if (finishTimer) clearTimeout(finishTimer)
  finishTimer = undefined
}

/** 槽位 → 芯片 transform 目标（translate3d + scale，全部走 GSAP 可动属性）。 */
function chipTransform(slot: MemberSlot, active: boolean): gsap.TweenVars {
  const width = active ? ACTIVE_WIDTH : CHIP_WIDTH
  const height = active ? ACTIVE_HEIGHT : CHIP_HEIGHT
  const depth = (slot.z + 112) / 224
  return {
    x: STAGE_WIDTH / 2 + slot.x * mirrorX.value - width / 2,
    y: STAGE_HEIGHT / 2 + slot.y - height / 2,
    scale: 0.78 + depth * 0.22,
    autoAlpha: slot.opacity,
  }
}

/** 新进入槽窗的芯片从垂直缝位淡入（旧轮盘 seam 行为）。 */
function seamTransform(direction: number): gsap.TweenVars {
  return {
    x: STAGE_WIDTH / 2 - CHIP_WIDTH / 2,
    y: STAGE_HEIGHT / 2 + (direction > 0 ? 16 : -16),
    scale: 0.78,
    autoAlpha: 0,
  }
}

function applyChipTransforms(leaving: boolean): void {
  const chips = root.value?.querySelectorAll<HTMLElement>('.fold-wheel-chip[data-key]')
  if (!chips?.length) return
  gsapContext?.add(() => {
    const duration = reducedMotion() ? 0 : animating.value ? STEP_MS : 0.16
    chips.forEach((element) => {
      const chip = renderedChips.value.find((entry) => entry.key === element.dataset.key)
      if (!chip) return
      const active = chip.slot.role === 'active'
      if (leaving && !chip.target) {
        gsap.to(element, { ...seamTransform(animationDirection.value), duration, ease: 'power2.out', overwrite: 'auto' })
        return
      }
      const initial = animating.value && !chip.source ? seamTransform(animationDirection.value) : undefined
      const target = chipTransform(chip.slot, active)
      if (initial) {
        gsap.fromTo(element, initial, { ...target, duration, ease: 'power2.out', overwrite: 'auto' })
      } else {
        gsap.to(element, { ...target, duration, ease: 'power2.out', overwrite: 'auto' })
      }
    })
  })
}

function finishTransition(): void {
  clearAnimationTimers()
  visualIndex.value = normalizedIndex(animationToIndex.value, false)
  animationFromIndex.value = visualIndex.value
  animating.value = false
  const member = props.members[visualIndex.value]
  if (emitSelectionAtFinish && member) emit('select', member.id)
  void nextTick(() => {
    applyChipTransforms(false)
    processQueue()
  })
}

function beginTransition(targetIndex: number, direction: 1 | -1, shouldEmit: boolean): void {
  const target = normalizedIndex(targetIndex, false)
  if (target === visualIndex.value) {
    const member = props.members[target]
    if (shouldEmit && member) emit('select', member.id)
    return
  }
  clearAnimationTimers()
  animationFromIndex.value = visualIndex.value
  animationToIndex.value = target
  animationDirection.value = direction
  emitSelectionAtFinish = shouldEmit
  animating.value = true
  void nextTick(() => applyChipTransforms(true))
  finishTimer = setTimeout(finishTransition, reducedMotion() ? 0 : 220)
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

function selectChip(chip: RenderedWheelChip): void {
  if (!chip.interactive || chip.slot.role === 'active') return
  enqueueStep(chip.slot.id === 'C' ? -1 : 1)
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

function chipInlineStyle(chip: RenderedWheelChip): CSSProperties {
  const active = chip.slot.role === 'active'
  return {
    width: `${active ? ACTIVE_WIDTH : CHIP_WIDTH}px`,
    height: `${active ? ACTIVE_HEIGHT : CHIP_HEIGHT}px`,
    zIndex: chip.slot.zIndex,
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

// 静止态槽位漂移（成员增减 / mirror 变化）也走 GSAP，保持 transform 单一动效通道。
watch(
  () => [renderedChips.value.length, mirrorX.value] as const,
  () => {
    if (!animating.value) void nextTick(() => applyChipTransforms(false))
  },
)

onBeforeUnmount(() => {
  if (wheelResetTimer) clearTimeout(wheelResetTimer)
  clearAnimationTimers()
})
</script>

<template>
  <nav
    ref="root"
    class="fold-wheel-navigation"
    :class="{ 'is-dragging': dragging, 'is-animating': animating }"
    :style="navigationStyle"
    aria-label="过程组弹链轮盘"
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
        v-for="chip in renderedChips"
        :key="chip.key"
        type="button"
        class="fold-wheel-chip"
        :class="[
          `slot-${chip.slot.id}`,
          `role-${chip.slot.role}`,
          chip.tab ? `kind-${chip.tab.bulletKind}` : undefined,
          {
            'is-real': !!chip.tab,
            'is-ghost': !chip.tab,
            'is-active': chip.slot.role === 'active',
          },
        ]"
        :data-key="chip.key"
        :style="chipInlineStyle(chip)"
        :disabled="!chip.interactive"
        :aria-hidden="chip.tab ? undefined : true"
        :aria-current="chip.slot.role === 'active' ? 'page' : undefined"
        :title="chip.tab ? `${chip.tab.label} · ${chip.tab.status}` : undefined"
        @pointerdown.stop
        @click.stop="selectChip(chip)"
      >
        <template v-if="chip.tab">
          <span class="chip-band" :style="{ background: chip.tab.accent }" />
          <span class="chip-bullet" :style="{ background: chip.tab.accent }" aria-hidden="true" />
          <span class="chip-copy">
            <strong>{{ chip.tab.label }}</strong>
            <small>{{ chip.tab.status }}</small>
          </span>
          <span v-if="chip.slot.role === 'active' && unreadCount" class="chip-unread">
            +{{ unreadCount }}
          </span>
        </template>
        <template v-else>
          <span class="ghost-index">{{ chip.itemIndex + 1 }}</span>
          <span class="ghost-line" />
        </template>
      </button>
    </div>
    <div class="fold-wheel-position" aria-live="polite">
      <span>过程 {{ wheel.selectedIndex + 1 }}/{{ wheel.itemCount }}</span>
      <span v-if="wheel.layerCount > 1">层 {{ wheel.layerIndex + 1 }}/{{ wheel.layerCount }}</span>
      <span v-if="unreadCount" class="position-unread">新动态</span>
    </div>
  </nav>
</template>

<style scoped lang="less">
.fold-wheel-navigation {
  position: absolute;
  z-index: 3;
  width: 272px;
  height: 192px;
  outline: none;
  user-select: none;
}
.fold-wheel-navigation:focus-visible .fold-wheel-stage {
  filter: drop-shadow(0 0 6px var(--accent-glow));
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

/* 弹壳芯片：全直角、1px token 描边 + nx-bg 底；位移动效全部走 GSAP transform。 */
.fold-wheel-chip {
  position: absolute;
  left: 0;
  top: 0;
  box-sizing: border-box;
  margin: 0;
  appearance: none;
  display: grid;
  grid-template-columns: 4px 12px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 0;
  border: 1px solid var(--nx-border);
  border-radius: 0;
  background: var(--nx-bg);
  color: var(--nx-text);
  font-family: var(--font-mono);
  text-align: left;
  will-change: transform, opacity;
}
.fold-wheel-chip.is-real {
  cursor: pointer;
}
.fold-wheel-chip.is-ghost {
  grid-template-columns: 4px 12px minmax(0, 1fr);
  color: color-mix(in srgb, var(--nx-text) 42%, transparent);
  background: color-mix(in srgb, var(--nx-bg) 74%, transparent);
  border-color: color-mix(in srgb, var(--nx-border) 36%, transparent);
  pointer-events: none;
}
.fold-wheel-chip.is-active {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--nx-bg) 82%, var(--accent) 18%);
}
.fold-wheel-chip.is-real:hover {
  border-color: var(--accent);
  filter: brightness(1.08);
  /* hover 反馈 ≤200ms（motion-standard §5） */
  transition: border-color 160ms ease, filter 160ms ease;
}
.fold-wheel-chip.is-active:hover {
  cursor: default;
}

/* 左 4px 色带：与弹形双编码（色弱可辨） */
.chip-band {
  width: 4px;
  height: 100%;
  align-self: stretch;
}
/* 12×16 弹头图标：形状 = 直角多边形 clip-path（弹头朝右），颜色同色带 */
.chip-bullet {
  width: 12px;
  height: 16px;
  justify-self: center;
}
.kind-tool .chip-bullet {
  /* 尖头弹 */
  clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%);
}
.kind-file .chip-bullet {
  /* 双切角平头弹：平头 + 上下 6px 对称切角 */
  clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%);
}
.kind-skill .chip-bullet {
  /* 阶梯尾弹：尾部两级台阶 */
  clip-path: polygon(4px 0, 100% 0, 100% 100%, 4px 100%, 4px 62%, 0 62%, 0 38%, 4px 38%);
}
.kind-question .chip-bullet {
  /* 空尖弹：弹体中部 6px 开槽 */
  clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 4px 62%, 38% 62%, 38% 38%, 4px 38%);
}
.kind-interaction .chip-bullet {
  /* 半芯弹：描边壳 + 半透明内芯 */
  clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%);
  background: transparent !important;
  box-shadow: inset 0 0 0 1px var(--warning);
}
.kind-interaction .chip-bullet::after {
  content: '';
  display: block;
  width: 100%;
  height: 100%;
  clip-path: polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%);
  background: color-mix(in srgb, var(--warning) 42%, transparent);
}
.kind-error .chip-bullet {
  /* 断壳曳光弹：尾部 V 缺口 */
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 6px 50%);
}
.kind-error .chip-bullet::after {
  /* 1px 裂纹线 */
  content: '';
  display: block;
  width: 100%;
  height: 1px;
  margin-top: 7px;
  background: color-mix(in srgb, var(--nx-bg) 72%, transparent);
}
.kind-agent .chip-bullet {
  /* 平头凹槽弹：尾部 6px 凹槽 */
  clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 38%, 6px 38%, 6px 62%, 0 62%);
}

.chip-copy {
  min-width: 0;
  display: grid;
  gap: 1px;
}
.chip-copy strong,
.chip-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-copy strong {
  font: 600 10px/1.1 var(--font-mono);
}
.chip-copy small {
  color: color-mix(in srgb, var(--nx-text) 58%, transparent);
  font: 400 8px/1 var(--font-mono);
}
.chip-unread {
  position: absolute;
  right: -6px;
  top: -7px;
  padding: 2px 4px;
  border-radius: 0;
  color: var(--nx-bg);
  background: var(--warning);
  font: 600 8px/1 var(--font-mono);
}
.ghost-index {
  font: 400 8px/1 var(--font-mono);
  text-align: center;
}
.ghost-line {
  height: 2px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--nx-border) 40%, transparent), transparent);
}
.fold-wheel-position {
  position: absolute;
  right: 3px;
  bottom: 0;
  display: flex;
  gap: 8px;
  color: color-mix(in srgb, var(--nx-text) 56%, transparent);
  font: 400 9px/1 var(--font-mono);
}
.position-unread {
  color: var(--warning);
  text-shadow: 0 0 8px currentcolor;
}

@media (prefers-reduced-motion: reduce) {
  .fold-wheel-chip.is-real:hover {
    transition: none;
  }
}
</style>
