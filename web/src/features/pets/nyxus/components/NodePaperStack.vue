<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SenseToolInfo } from '@/application/backend/public'
import type { NodePopoverQuestion } from '../graph/nodePopoverModel'
import type { ApprovalState } from '@/domain/chat/projectionTypes'
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
  approval?: ApprovalState
  approvalNodeId?: string
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
let scrubberFrame = 0
let pendingScrubberIndex: number | undefined

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
let cachedCurrentCard:
  | {
      entry: PaperStackEntry
      index: number
      total: number
      edgeKey: string
      selectedCallId?: string
      senseTools?: SenseToolInfo[]
      model: ReturnType<typeof buildPaperGameCard>
    }
  | undefined
const currentCard = computed(() => {
  const entry = currentEntry.value
  const node = currentDisplayNode.value
  if (!entry || !node) return undefined
  const selectedCallId = selectedCalls.value.get(entry.id)
  const edgeKey = currentRelatedEdges.value.map((edge) => edge.id).join('\u0001')
  if (
    cachedCurrentCard?.entry === entry &&
    cachedCurrentCard.index === props.currentIndex &&
    cachedCurrentCard.total === props.entries.length &&
    cachedCurrentCard.edgeKey === edgeKey &&
    cachedCurrentCard.selectedCallId === selectedCallId &&
    cachedCurrentCard.senseTools === props.senseTools
  ) {
    return cachedCurrentCard.model
  }
  const model = buildPaperGameCard(node, {
    title: entry.title,
    index: props.currentIndex,
    total: props.entries.length,
    relatedEdges: currentRelatedEdges.value,
    selectedCallId,
    ...(entry.node.kind === 'fold' ? { foldNode: entry.node } : {}),
    senseTools: props.senseTools,
  })
  cachedCurrentCard = {
    entry,
    index: props.currentIndex,
    total: props.entries.length,
    edgeKey,
    selectedCallId,
    senseTools: props.senseTools,
    model,
  }
  return model
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

watch(
  () => currentEntry.value?.id,
  () => void nextTick(observeTitleRail),
)

onMounted(() => {
  titleRailRO = new ResizeObserver(measureTitleRail)
  void nextTick(observeTitleRail)
})

onBeforeUnmount(() => {
  if (keyboardNavigationTimer) clearTimeout(keyboardNavigationTimer)
  if (scrubberFrame) cancelAnimationFrame(scrubberFrame)
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
  const nextTop = Math.round(top)
  const nextHeight = Math.min(paper.offsetHeight, Math.max(0, viewport.clientHeight - top))
  if (titleRail.value.top === nextTop && titleRail.value.height === nextHeight) return
  titleRail.value = { top: nextTop, height: nextHeight }
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
  pendingScrubberIndex = undefined
  dragging.value = true
}

function flushScrubberPreview(): void {
  scrubberFrame = 0
  if (pendingScrubberIndex === undefined) return
  previewIndex.value = pendingScrubberIndex
  pendingScrubberIndex = undefined
}

function onScrubberInput(event: Event): void {
  const next = rangeIndex(event)
  if (dragging.value) {
    pendingScrubberIndex = next
    if (!scrubberFrame) scrubberFrame = requestAnimationFrame(flushScrubberPreview)
    return
  }

  // Assistive technology may update a range without dispatching a keyboard event.
  previewIndex.value = next
  committedIndex.value = next
  selectIndex(next, 'keyboard')
}

function commitScrubber(event?: Event): void {
  if (scrubberFrame) {
    cancelAnimationFrame(scrubberFrame)
    flushScrubberPreview()
  }
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
  if (scrubberFrame) cancelAnimationFrame(scrubberFrame)
  scrubberFrame = 0
  pendingScrubberIndex = undefined
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
          v-memo="[
            entry,
            index === currentIndex,
            layer.role,
            layer.opacity,
            placement.offset,
            titleRail.height,
          ]"
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
            :quiet-motion="true"
            :chat-id="chatId"
            :approval="approval"
            :approval-node-id="approvalNodeId"
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

      <div
        class="paper-scrubber-track"
        :style="{
          '--paper-progress': `${progress}%`,
          '--paper-tick-step': entries.length <= 1 ? '100%' : `${100 / (entries.length - 1)}%`,
        }"
      >
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

<style scoped lang="less" src="./NodePaperStack.styles.less"></style>
