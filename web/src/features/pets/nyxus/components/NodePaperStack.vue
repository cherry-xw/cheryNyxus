<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SenseToolInfo } from '@/services/agentApi'
import type { NodePopoverQuestion } from '../graph/nodePopoverModel'
import type { ExecutionEdge } from '../graph/executionGraph'
import { buildPaperGameCard } from '../paper/paperCardModel'
import type { PaperStackEntry } from '../paper/paperStackModel'
import {
  paperBundleJitter,
  paperChronologicalLayer,
  paperBundlePageOffset,
  paperPlacement,
  paperStackLayers,
  PAPER_TITLE_HEIGHT,
  paperTitleLayerPlacements,
  paperVisibleLimits,
} from '../paper/paperStackModel'
import PaperGameCard from './PaperGameCard.vue'

const props = defineProps<{
  entries: PaperStackEntry[]
  edges: ExecutionEdge[]
  currentIndex: number
  maxHeight: number
  hasNewTail?: boolean
  detailBranchAvailable?: boolean
  detailBranchUnavailableReason?: string
  senseTools?: SenseToolInfo[]
  chatId?: string
  question?: NodePopoverQuestion
  questionNodeId?: string
}>()

const emit = defineEmits<{
  select: [index: number]
  branch: [type: 'detail' | 'continuation', nodeId: string]
  latest: []
}>()

const selectedCalls = ref(new Map<string, string>())
const previewIndex = ref(props.currentIndex)
const committedIndex = ref(props.currentIndex)
const dragging = ref(false)
const keyboardNavigation = ref(false)
const canceledPointerChange = ref(false)
const selectionDirection = ref<'forward' | 'backward'>('forward')
const stackViewportRef = ref<HTMLElement>()
const currentPaperRef = ref<HTMLElement>()
const titleRail = ref({ top: 26, height: props.maxHeight })
let keyboardNavigationTimer: ReturnType<typeof setTimeout> | undefined
let titleRailRO: ResizeObserver | undefined

const visibleLimits = computed(() =>
  paperVisibleLimits(props.entries.length, props.currentIndex, titleRail.value.height),
)
const stackLayers = computed(() =>
  paperStackLayers(
    props.entries.length,
    props.currentIndex,
    visibleLimits.value.history,
    visibleLimits.value.future,
  ),
)
const titlePlacements = computed(() =>
  paperTitleLayerPlacements(stackLayers.value, titleRail.value.height),
)
const renderedEntries = computed(() =>
  stackLayers.value.flatMap((layer, stackPosition) =>
    layer.kind === 'node'
      ? [
          {
            layer,
            placement: titlePlacements.value[stackPosition]!,
            index: layer.index,
            entry: props.entries[layer.index]!,
          },
        ]
      : [],
  ),
)
const bundleLayers = computed(() =>
  stackLayers.value.flatMap((layer, stackPosition) =>
    layer.kind === 'bundle' ? [{ ...layer, placement: titlePlacements.value[stackPosition]! }] : [],
  ),
)
const currentEntry = computed(() => props.entries[props.currentIndex])
const currentRelatedEdges = computed(() => {
  const id = currentEntry.value?.id
  if (!id) return []
  return props.edges.filter((edge) => edge.from === id || edge.to === id)
})
const previewEntry = computed(() => props.entries[previewIndex.value])
const visibleScrubberIndex = computed(() =>
  dragging.value ? previewIndex.value : props.currentIndex,
)
const progress = computed(() =>
  props.entries.length <= 1 ? 0 : (visibleScrubberIndex.value / (props.entries.length - 1)) * 100,
)
const currentDisplayNode = computed(() => currentEntry.value?.node)
const currentCard = computed(() => {
  const entry = currentEntry.value
  const node = currentDisplayNode.value
  if (!entry || !node) return undefined
  return buildPaperGameCard(node, {
    title: entry.title,
    index: props.currentIndex,
    total: props.entries.length,
    relatedEdges: currentRelatedEdges.value,
    selectedCallId: selectedCalls.value.get(entry.id),
    ...(entry.node.kind === 'fold' ? { foldNode: entry.node } : {}),
    senseTools: props.senseTools,
  })
})

watch(
  () => props.currentIndex,
  (index, previous) => {
    if (index !== previous) selectionDirection.value = index > previous ? 'forward' : 'backward'
    committedIndex.value = clampIndex(index)
    if (!dragging.value) previewIndex.value = committedIndex.value
  },
)

watch(
  () => props.entries.length,
  () => {
    committedIndex.value = clampIndex(props.currentIndex)
    if (!dragging.value) previewIndex.value = committedIndex.value
  },
)

watch(currentCard, () => void nextTick(observeTitleRail))

onMounted(() => {
  titleRailRO = new ResizeObserver(measureTitleRail)
  void nextTick(observeTitleRail)
})

onBeforeUnmount(() => {
  if (keyboardNavigationTimer) clearTimeout(keyboardNavigationTimer)
  titleRailRO?.disconnect()
})

function observeTitleRail(): void {
  titleRailRO?.disconnect()
  if (stackViewportRef.value) titleRailRO?.observe(stackViewportRef.value)
  if (currentPaperRef.value) titleRailRO?.observe(currentPaperRef.value)
  measureTitleRail()
}

function measureTitleRail(): void {
  const viewport = stackViewportRef.value
  const paper = currentPaperRef.value
  if (!viewport || !paper) return
  const top = Math.max(0, paper.offsetTop - paper.offsetHeight / 2)
  titleRail.value = {
    top: Math.round(top),
    height: Math.min(paper.offsetHeight, Math.max(0, viewport.clientHeight - top)),
  }
}

function clampIndex(index: number): number {
  if (!props.entries.length) return 0
  return Math.min(props.entries.length - 1, Math.max(0, index))
}

function markKeyboardNavigation(): void {
  keyboardNavigation.value = true
  if (keyboardNavigationTimer) clearTimeout(keyboardNavigationTimer)
  keyboardNavigationTimer = setTimeout(() => {
    keyboardNavigation.value = false
  }, 220)
}

function selectIndex(index: number, source: 'pointer' | 'keyboard' = 'pointer'): void {
  if (!props.entries.length) return
  if (source === 'keyboard') markKeyboardNavigation()
  else keyboardNavigation.value = false
  emit('select', clampIndex(index))
}

function keyboardTarget(event: KeyboardEvent, baseIndex: number): number | undefined {
  if (event.key === 'Home') return 0
  if (event.key === 'End') return props.entries.length - 1
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return baseIndex - 1
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return baseIndex + 1
  return undefined
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.target as Element | null)?.closest('.paper-current')) return
  const next = keyboardTarget(event, props.currentIndex)
  if (next === undefined) return
  event.preventDefault()
  selectIndex(next, 'keyboard')
}

function stripTransform(
  entry: PaperStackEntry,
  layer: { role: 'history' | 'current' | 'future'; distance: number },
  offset: number,
): string {
  const placement = paperPlacement(entry.scatter)
  const selectedX = layer.role === 'current' ? -20 : 0
  const scale = layer.role === 'current' ? 1.035 : placement.scale
  const y = Math.min(
    Math.max(0, titleRail.value.height - PAPER_TITLE_HEIGHT),
    Math.max(0, offset + placement.y),
  )
  return `translate3d(calc(-50% + ${placement.x + selectedX}px), ${y}px, 0) rotate(${placement.rotation}deg) scale(${scale})`
}

function bundleTransform(offset: number): string {
  return `translate3d(-50%, ${offset}px, 0)`
}

function bundleLayer(layer: { role: 'history' | 'future'; distance: number }): number {
  const representativeIndex =
    layer.role === 'history'
      ? props.currentIndex - layer.distance
      : props.currentIndex + layer.distance
  return paperChronologicalLayer(representativeIndex)
}

function selectCall(nodeId: string, callId: string): void {
  const next = new Map(selectedCalls.value)
  next.set(nodeId, callId)
  selectedCalls.value = next
}

function requestBranch(type: 'detail' | 'continuation', nodeId: string): void {
  emit('branch', type, nodeId)
}

function requestCurrentBranch(type: 'detail' | 'continuation'): void {
  const node = currentDisplayNode.value
  const nodeId = node?.sourceFact?.id ?? node?.id
  if (nodeId) requestBranch(type, nodeId)
}

function rangeIndex(event: Event): number {
  return clampIndex(Number((event.target as HTMLInputElement).value))
}

function onScrubberPointerDown(): void {
  keyboardNavigation.value = false
  canceledPointerChange.value = false
  previewIndex.value = committedIndex.value
  dragging.value = true
}

function onScrubberInput(event: Event): void {
  const next = rangeIndex(event)
  previewIndex.value = next
  if (dragging.value) return

  // Assistive technology may update a range without dispatching a keyboard event.
  committedIndex.value = next
  selectIndex(next, 'keyboard')
}

function commitScrubber(event?: Event): void {
  if (canceledPointerChange.value) {
    canceledPointerChange.value = false
    previewIndex.value = committedIndex.value
    return
  }
  if (event) previewIndex.value = rangeIndex(event)
  const next = clampIndex(previewIndex.value)
  dragging.value = false
  if (next === committedIndex.value) return
  committedIndex.value = next
  selectIndex(next, 'pointer')
}

function cancelScrubber(): void {
  dragging.value = false
  canceledPointerChange.value = true
  previewIndex.value = committedIndex.value
}

function onScrubberKeydown(event: KeyboardEvent): void {
  const next = keyboardTarget(event, committedIndex.value)
  if (next === undefined) return
  event.preventDefault()
  const clamped = clampIndex(next)
  previewIndex.value = clamped
  committedIndex.value = clamped
  selectIndex(clamped, 'keyboard')
}
</script>

<template>
  <section
    class="node-paper-stage"
    :class="{
      'is-dragging': dragging,
      'is-keyboard-navigation': keyboardNavigation,
      'is-moving-forward': selectionDirection === 'forward',
      'is-moving-backward': selectionDirection === 'backward',
    }"
    aria-label="节点卡牌阅读器"
    tabindex="0"
    @keydown="onKeydown"
    @wheel.stop
  >
    <div v-if="entries.length" ref="stackViewportRef" class="paper-stack-viewport">
      <div
        class="paper-title-stack"
        :style="{ transform: `translate3d(0, ${titleRail.top}px, 0)` }"
        aria-label="按时间排列的卡牌"
      >
        <div
          v-for="bundle in bundleLayers"
          :key="`bundle-${bundle.role}`"
          class="paper-bundle"
          :class="`is-${bundle.role}`"
          :style="{
            '--bundle-depth': String(bundle.depth),
            '--bundle-opacity': bundle.role === 'future' ? '0.2' : '1',
            '--bundle-direction': '1',
            zIndex: String(bundleLayer(bundle)),
            transform: bundleTransform(bundle.placement.offset),
          }"
          aria-hidden="true"
        >
          <i
            v-for="depth in bundle.depth"
            :key="depth"
            :style="{
              '--depth': String(depth),
              '--page-jitter': `${paperBundleJitter(depth - 1)}px`,
              '--page-offset': `${paperBundlePageOffset(
                depth - 1,
                bundle.depth,
                bundle.placement.bundlePageSpan,
              )}px`,
            }"
          />
          <span>+{{ bundle.hiddenCount }}</span>
        </div>
        <button
          v-for="{ entry, index, layer, placement } in renderedEntries"
          :key="entry.id"
          type="button"
          class="paper-title-strip"
          :class="[
            `is-${entry.skin}`,
            `is-${layer.role}`,
            { 'is-current': index === currentIndex },
          ]"
          :style="{
            zIndex: String(
              index === currentIndex ? entries.length + 50 : paperChronologicalLayer(index),
            ),
            opacity: String(layer.opacity),
            transform: stripTransform(entry, layer, placement.offset),
          }"
          :aria-label="`阅读第 ${index + 1} 张：${entry.title}`"
          :aria-current="index === currentIndex ? 'true' : undefined"
          @click="selectIndex(index)"
        >
          <span class="paper-title-strip-content">
            <span class="paper-type-glyph" aria-hidden="true">{{
              String(index + 1).padStart(2, '0')
            }}</span>
            <strong>{{ entry.title }}</strong>
            <span class="paper-sequence">{{
              layer.role === 'history' ? '旧' : layer.role === 'future' ? '新' : '读'
            }}</span>
          </span>
        </button>
      </div>

      <Transition name="paper-reader">
        <article
          v-if="currentEntry && currentCard"
          :key="currentEntry.id"
          ref="currentPaperRef"
          class="paper-current"
          :class="`is-${currentEntry.skin}`"
          :style="{ zIndex: String(entries.length + 100) }"
          :aria-label="`当前卡牌：${currentEntry.title}`"
        >
          <PaperGameCard
            :model="currentCard"
            :node="currentDisplayNode"
            :fold-node="currentEntry.node.kind === 'fold' ? currentEntry.node : undefined"
            :max-height="maxHeight"
            :quiet-motion="keyboardNavigation"
            :chat-id="chatId"
            :question="question"
            :question-node-id="questionNodeId"
            :detail-branch-available="detailBranchAvailable"
            :detail-branch-unavailable-reason="detailBranchUnavailableReason"
            @select-call="selectCall(currentEntry.id, $event)"
            @branch="requestCurrentBranch"
          />
        </article>
      </Transition>
    </div>

    <div v-else class="paper-empty">
      <span aria-hidden="true">◇</span>
      <p>当前节点树还没有可阅读的内容</p>
    </div>

    <footer v-if="entries.length" class="paper-scrubber">
      <button v-if="hasNewTail" type="button" class="paper-latest" @click="emit('latest')">
        有新内容 · 回到最新
      </button>

      <div class="paper-scrubber-meta">
        <span>久远</span>
        <strong>{{ visibleScrubberIndex + 1 }} / {{ entries.length }}</strong>
        <span>最新</span>
      </div>

      <div class="paper-scrubber-track" :style="{ '--paper-progress': `${progress}%` }">
        <span
          v-for="(_, index) in entries"
          :key="index"
          class="paper-scrubber-tick"
          :style="{
            left: entries.length <= 1 ? '50%' : `${(index / (entries.length - 1)) * 100}%`,
          }"
          aria-hidden="true"
        />

        <div v-if="dragging && previewEntry" class="paper-scrubber-preview" aria-live="polite">
          <span>{{ previewIndex + 1 }} / {{ entries.length }}</span>
          <strong>{{ previewEntry.title }}</strong>
        </div>

        <span class="paper-scrubber-thumb-position" aria-hidden="true">
          <svg class="paper-scrubber-thumb" viewBox="0 0 20 34" shape-rendering="crispEdges">
            <path class="thumb-shadow" d="M8 2h5v18h3v4h-3v7H8v-7H5v-4h3z" />
            <path class="thumb-metal" d="M9 1h3v19H9zM6 20h9v3H6zM9 23h3v8H9z" />
            <path class="thumb-glint" d="M9 2h1v16H9z" />
            <path class="thumb-gem" d="M9 25h3v4H9z" />
          </svg>
        </span>

        <input
          type="range"
          min="0"
          :max="Math.max(0, entries.length - 1)"
          step="1"
          :value="previewIndex"
          aria-label="选择节点卡牌"
          :aria-valuetext="`第 ${previewIndex + 1} 张，共 ${entries.length} 张：${previewEntry?.title ?? ''}`"
          @pointerdown="onScrubberPointerDown"
          @pointerup="commitScrubber"
          @pointercancel="cancelScrubber"
          @lostpointercapture="dragging && commitScrubber($event)"
          @input="onScrubberInput"
          @change="commitScrubber"
          @keydown.stop="onScrubberKeydown"
        />
      </div>
    </footer>
  </section>
</template>

<style scoped lang="less">
@font-face {
  font-family: 'HYPixel Paper';
  src: url('@/assets/fonts/HYPixel11pxU-2.ttf') format('truetype');
  font-style: normal;
  font-weight: normal;
  font-display: swap;
}

.node-paper-stage {
  --paper-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --paper-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --paper-ink: color-mix(in srgb, var(--nx-text) 86%, #382a1c 14%);
  position: absolute;
  inset: 18px 52% 22px 18px;
  z-index: calc(var(--nx-z-node-overlay) + 1);
  min-width: 280px;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 14px;
  outline: none;
  pointer-events: auto;
  font-family: 'HYPixel Paper', system-ui, sans-serif;
  font-synthesis: none;
}

.paper-stack-viewport {
  position: relative;
  min-height: 0;
  margin: 8px 18px 6px 4px;
  isolation: isolate;
}

.paper-title-stack {
  position: absolute;
  inset: 0;
  z-index: 1;
  will-change: transform;
}

.paper-title-strip {
  --paper-accent: #bb8d48;
  --paper-surface: color-mix(in srgb, var(--nx-bg) 72%, #c9aa72 28%);
  --paper-surface-deep: color-mix(in srgb, var(--nx-bg) 82%, #664727 18%);
  border: 2px solid color-mix(in srgb, var(--paper-accent) 64%, var(--nx-border));
  border-radius: 0;
  color: var(--paper-ink);
  background:
    linear-gradient(
      90deg,
      transparent 0 6px,
      color-mix(in srgb, white 7%, transparent) 6px 8px,
      transparent 8px
    ),
    repeating-linear-gradient(
      0deg,
      transparent 0 7px,
      color-mix(in srgb, var(--paper-accent) 7%, transparent) 7px 8px
    ),
    var(--paper-surface);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--nx-bg) 78%, #1d140c 22%),
    0 0 0 3px color-mix(in srgb, var(--paper-accent) 50%, #1d140c),
    5px 7px 0 color-mix(in srgb, #000 30%, transparent);
  clip-path: polygon(
    4px 0,
    calc(100% - 4px) 0,
    calc(100% - 4px) 2px,
    100% 2px,
    100% calc(100% - 4px),
    calc(100% - 4px) calc(100% - 4px),
    calc(100% - 4px) 100%,
    4px 100%,
    4px calc(100% - 2px),
    0 calc(100% - 2px),
    0 4px,
    4px 4px
  );
}

.paper-title-strip.is-user,
.paper-title-strip.is-input,
.paper-current.is-user,
.paper-current.is-input {
  --paper-accent: #c98b4a;
  --paper-surface: color-mix(in srgb, var(--nx-bg) 66%, #dfc28c 34%);
}

.paper-title-strip.is-root-agent,
.paper-current.is-root-agent {
  --paper-accent: #758cc8;
  --paper-surface: color-mix(in srgb, var(--nx-bg) 72%, #6c668c 28%);
}

.paper-title-strip.is-child-agent,
.paper-current.is-child-agent,
.paper-title-strip.is-dispatch,
.paper-current.is-dispatch,
.paper-title-strip.is-spawn,
.paper-current.is-spawn {
  --paper-accent: #ae6c99;
  --paper-surface: color-mix(in srgb, var(--nx-bg) 72%, #76506a 28%);
}

.paper-title-strip.is-tool-batch,
.paper-current.is-tool-batch {
  --paper-accent: #bd9960;
  --paper-surface: color-mix(in srgb, var(--nx-bg) 72%, #77736c 28%);
  background-image:
    linear-gradient(
      90deg,
      color-mix(in srgb, white 8%, transparent),
      transparent 28%,
      color-mix(in srgb, black 10%, transparent)
    ),
    repeating-linear-gradient(
      0deg,
      transparent 0 6px,
      color-mix(in srgb, var(--paper-accent) 9%, transparent) 6px 8px
    );
}

.paper-title-strip.is-return,
.paper-current.is-return {
  --paper-accent: #75a479;
  --paper-surface: color-mix(in srgb, var(--nx-bg) 70%, #9a895b 30%);
}

.paper-title-strip.is-system,
.paper-current.is-system {
  --paper-accent: #9c6754;
  --paper-surface: color-mix(in srgb, var(--nx-bg) 72%, #6d4938 28%);
}

.paper-title-strip.is-fold,
.paper-current.is-fold {
  --paper-accent: #6e9ba8;
  --paper-surface: color-mix(in srgb, var(--nx-bg) 74%, #718c8d 26%);
}

.paper-title-strip {
  position: absolute;
  top: 0;
  left: 23%;
  width: min(54%, 278px);
  height: 43px;
  padding: 0;
  overflow: hidden;
  text-align: left;
  transform-origin: top center;
  cursor: pointer;
  will-change: transform, opacity;
  transition:
    transform 220ms var(--paper-ease-in-out),
    opacity 220ms var(--paper-ease-out);
}

.paper-bundle {
  position: absolute;
  top: 0;
  left: 23%;
  width: min(54%, 278px);
  height: 30px;
  opacity: var(--bundle-opacity);
  transform-origin: top center;
  pointer-events: none;
  transition:
    transform 220ms var(--paper-ease-in-out),
    opacity 220ms var(--paper-ease-out);
}

.paper-bundle i {
  position: absolute;
  inset: 0;
  border: 2px solid #3a2819;
  background: repeating-linear-gradient(90deg, #b8955e 0 6px, #d0ae70 6px 8px), #c7a368;
  box-shadow: 2px 3px 0 rgba(20, 12, 7, 0.24);
  z-index: calc(var(--bundle-depth) - var(--depth));
  transform: translate3d(var(--page-jitter), calc(var(--bundle-direction) * var(--page-offset)), 0);
}

.paper-bundle.is-future i {
  border-color: color-mix(in srgb, #66594d 68%, transparent);
  filter: saturate(0.55) brightness(0.72);
}

.paper-bundle span {
  position: absolute;
  z-index: calc(var(--bundle-depth) + 1);
  top: 6px;
  right: 8px;
  padding: 3px 5px;
  border: 2px solid #4b2b1c;
  color: #6e3027;
  background: #d7ba7e;
  font:
    900 11px/1 ui-monospace,
    monospace;
  transform: rotate(-3deg);
}

.paper-title-strip::after {
  content: '';
  position: absolute;
  right: 9px;
  bottom: 4px;
  left: 9px;
  height: 2px;
  background: repeating-linear-gradient(90deg, var(--paper-accent) 0 7px, transparent 7px 10px);
  opacity: 0.34;
}

.paper-title-strip.is-current {
  filter: brightness(1.18) saturate(1.22);
  box-shadow:
    0 0 0 2px #2c1b0f,
    0 0 0 5px var(--paper-accent),
    8px 9px 0 rgba(0, 0, 0, 0.42),
    0 0 18px color-mix(in srgb, var(--paper-accent) 42%, transparent);
}

.paper-title-strip.is-current::before {
  content: '';
  position: absolute;
  z-index: 2;
  top: 5px;
  left: 5px;
  width: 4px;
  height: 28px;
  background: var(--paper-accent);
  box-shadow:
    4px 0 var(--paper-accent),
    0 4px var(--paper-accent-bright, #f2d27b);
}

.paper-title-strip.is-future {
  filter: saturate(0.52) brightness(0.72);
}

.paper-title-strip-content {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 0 9px 5px 8px;
  transition: transform 160ms var(--paper-ease-out);
}

.paper-type-glyph {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 2px solid color-mix(in srgb, var(--paper-accent) 70%, #20160d);
  color: var(--paper-accent);
  background: var(--paper-surface-deep);
  font-size: 14px;
  line-height: 1;
}

.paper-title-strip strong {
  min-width: 0;
  overflow: hidden;
  font:
    700 13px/1.25 ui-monospace,
    'Cascadia Mono',
    'Noto Sans Mono CJK SC',
    monospace;
  letter-spacing: 0.04em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.paper-sequence {
  color: color-mix(in srgb, var(--paper-accent) 72%, var(--nx-text));
  font:
    700 11px/1 ui-monospace,
    monospace;
  font-variant-numeric: tabular-nums;
}

.paper-current {
  position: absolute;
  top: 50%;
  left: 60%;
  width: min(72%, 440px);
  height: min(84%, 560px);
  min-height: 0;
  overflow: visible;
  transform: translate3d(-50%, -50%, 0);
  transform-origin: center;
  will-change: transform, opacity;
}

.paper-reader-enter-active,
.paper-reader-leave-active {
  transition:
    opacity 200ms var(--paper-ease-out),
    transform 260ms var(--paper-ease-in-out);
}

.paper-reader-leave-active {
  pointer-events: none;
}

/* 固定方向：切出右移淡出，切入从右向左滑入到位。 */
.paper-reader-enter-from,
.paper-reader-leave-to {
  opacity: 0;
  transform: translate3d(calc(-50% + 40px), -50%, 0);
}

.node-paper-stage.is-keyboard-navigation .paper-title-strip {
  transition: opacity 100ms linear;
}

.paper-empty {
  display: grid;
  place-content: center;
  color: var(--nx-text-dim);
  text-align: center;
}

.paper-empty span {
  font-size: 30px;
}

.paper-scrubber {
  position: relative;
  display: grid;
  gap: 7px;
  padding: 0 14px 5px;
}

.paper-scrubber-meta {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  color: var(--nx-text-dim);
  font:
    700 11px/1 ui-monospace,
    'Cascadia Mono',
    monospace;
  letter-spacing: 0.08em;
}

.paper-scrubber-meta strong {
  color: var(--nx-text);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.paper-scrubber-meta span:last-child {
  text-align: right;
}

.paper-scrubber-track {
  position: relative;
  height: 30px;
  border: 2px solid color-mix(in srgb, #b78a4f 50%, var(--nx-border));
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.08), transparent 35%, rgba(0, 0, 0, 0.16)),
    repeating-linear-gradient(90deg, #684725 0 10px, #75512b 10px 20px);
  box-shadow:
    inset 0 0 0 2px color-mix(in srgb, var(--nx-bg) 58%, #1d140c 42%),
    3px 4px 0 rgba(0, 0, 0, 0.26);
}

.paper-scrubber-track::before {
  content: '';
  position: absolute;
  top: 13px;
  right: 8px;
  left: 8px;
  height: 4px;
  background: linear-gradient(
    90deg,
    #c9a45e 0 var(--paper-progress),
    #33281e var(--paper-progress)
  );
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.14);
}

.paper-scrubber-tick {
  position: absolute;
  z-index: 1;
  top: 10px;
  width: 2px;
  height: 10px;
  background: color-mix(in srgb, #e5c278 64%, #25170d);
  transform: translateX(-50%);
  pointer-events: none;
}

.paper-scrubber-thumb-position {
  position: absolute;
  z-index: 3;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: translateX(var(--paper-progress));
  pointer-events: none;
  transition: transform 220ms var(--paper-ease-in-out);
}

.paper-scrubber-thumb {
  position: absolute;
  top: -2px;
  left: 0;
  width: 20px;
  height: 34px;
  color: #d5b76d;
  filter: drop-shadow(2px 3px 0 rgba(0, 0, 0, 0.36));
  transform: translateX(-50%);
  pointer-events: none;
}

.thumb-shadow {
  fill: #21170f;
}
.thumb-metal {
  fill: currentcolor;
}
.thumb-glint {
  fill: #f3df9c;
}
.thumb-gem {
  fill: #9f493d;
}

.node-paper-stage.is-dragging .paper-scrubber-thumb-position,
.node-paper-stage.is-keyboard-navigation .paper-scrubber-thumb-position {
  transition-duration: 0ms;
}

.paper-scrubber-preview {
  position: absolute;
  z-index: 5;
  bottom: calc(100% + 10px);
  left: clamp(64px, var(--paper-progress), calc(100% - 64px));
  width: 128px;
  padding: 6px 8px;
  border: 2px solid color-mix(in srgb, #c9a45e 58%, var(--nx-border));
  color: var(--nx-text);
  background: color-mix(in srgb, var(--nx-bg) 90%, #4e351f 10%);
  box-shadow: 4px 5px 0 rgba(0, 0, 0, 0.3);
  transform: translateX(-50%);
  pointer-events: none;
}

.paper-scrubber-preview::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  width: 8px;
  height: 8px;
  border-right: 2px solid #c9a45e;
  border-bottom: 2px solid #c9a45e;
  background: inherit;
  transform: translate(-50%, -4px) rotate(45deg);
}

.paper-scrubber-preview span {
  display: block;
  margin-bottom: 3px;
  color: #c9a45e;
  font:
    700 10px/1 ui-monospace,
    monospace;
}

.paper-scrubber-preview strong {
  display: block;
  overflow: hidden;
  font:
    700 12px/1.35 ui-monospace,
    'Cascadia Mono',
    monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.paper-scrubber input {
  position: absolute;
  z-index: 4;
  inset: -4px 0;
  width: 100%;
  height: 38px;
  margin: 0;
  opacity: 0;
  cursor: ew-resize;
}

.paper-scrubber-track:focus-within {
  outline: 2px solid var(--nx-cyan);
  outline-offset: 3px;
}

.paper-latest {
  position: absolute;
  right: 14px;
  bottom: 48px;
  z-index: 6;
  padding: 6px 9px;
  border: 2px solid color-mix(in srgb, #c9a45e 58%, var(--nx-border));
  border-radius: 0;
  color: #d4b66e;
  background: color-mix(in srgb, var(--nx-bg) 90%, #4e351f 10%);
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.26);
  font:
    700 11px/1 ui-monospace,
    monospace;
  cursor: pointer;
  transition: transform 160ms var(--paper-ease-out);
}

@media (hover: hover) and (pointer: fine) {
  .paper-title-strip:hover .paper-title-strip-content {
    transform: translateX(3px);
  }

  .paper-latest:hover {
    transform: translateY(-2px);
  }
}

.paper-title-strip:active .paper-title-strip-content,
.paper-latest:active {
  transform: translateY(1px) scale(0.99);
}

@media (max-width: 1024px) {
  .paper-stack-viewport {
    margin-right: 8px;
  }

  .paper-current {
    left: 61%;
    width: min(76%, 390px);
  }

  .paper-title-strip {
    left: 20%;
    width: min(52%, 230px);
  }

  .paper-bundle {
    left: 20%;
    width: min(52%, 230px);
  }
}

@media (prefers-contrast: more) {
  .paper-title-strip,
  .paper-current,
  .paper-scrubber-track {
    border-color: var(--paper-accent, currentcolor);
  }
}

@media (prefers-reduced-transparency: reduce) {
  .paper-latest,
  .paper-scrubber-preview {
    background: var(--nx-bg);
  }
}
</style>
