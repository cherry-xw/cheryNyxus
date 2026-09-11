<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Close, Document } from '@element-plus/icons-vue'
import type { RootTimelineSnapshot, SenseToolInfo } from '@/application/backend/public'
import {
  buildNyxusReaderEntries,
  projectNyxusReaderGraph,
  resolveNyxusReaderSelection,
  type NyxusContentSelection,
  type NyxusReaderFoldMode,
} from '../paper/readerProjection'
import NodePaperStack from './NodePaperStack.vue'

const props = defineProps<{
  rootChatId: string
  timeline?: RootTimelineSnapshot
  foldMode: NyxusReaderFoldMode
  selection?: NyxusContentSelection
  detailBranchAvailable?: boolean
  detailBranchUnavailableReason?: string
  senseTools?: SenseToolInfo[]
}>()

const emit = defineEmits<{
  close: []
  select: [selection: NyxusContentSelection]
  branch: [
    payload: {
      type: 'detail' | 'continuation'
      nodeId: string
      sourceRootChatId: string
    },
  ]
  generation: [generationIndex: number]
}>()

const readerRef = ref<HTMLElement>()
const readerHeight = ref(560)
const activeEntryId = ref<string>()
const hasNewTail = ref(false)
let resizeObserver: ResizeObserver | undefined

const graph = computed(() =>
  projectNyxusReaderGraph(props.timeline, props.foldMode, props.rootChatId),
)
const entries = computed(() => buildNyxusReaderEntries(graph.value, props.senseTools ?? []))
const resolvedSelection = computed(() =>
  resolveNyxusReaderSelection(entries.value, props.selection),
)
const currentIndex = computed(() => {
  const index = entries.value.findIndex((entry) => entry.id === activeEntryId.value)
  return index >= 0 ? index : Math.max(0, entries.value.length - 1)
})
const currentEntry = computed(() => entries.value[currentIndex.value])
const selectionMissing = computed(() => !!props.selection && !resolvedSelection.value)
const maxCardHeight = computed(() => Math.min(640, Math.max(160, readerHeight.value - 136)))
const generations = computed(() =>
  [...(props.timeline?.generations ?? [])].sort((a, b) => b.index - a.index),
)

watch(
  resolvedSelection,
  (selection) => {
    if (!selection) return
    activeEntryId.value = selection.entryId
    hasNewTail.value = selection.index < entries.value.length - 1
  },
  { immediate: true },
)

watch(
  entries,
  (nextEntries, previousEntries) => {
    if (!nextEntries.length) {
      activeEntryId.value = undefined
      hasNewTail.value = false
      return
    }
    if (resolvedSelection.value) return
    const current = activeEntryId.value
    const stillPresent = current && nextEntries.some((entry) => entry.id === current)
    if (!stillPresent) {
      activeEntryId.value = nextEntries.at(-1)!.id
      hasNewTail.value = false
      return
    }
    const wasAtTail = !previousEntries?.length || previousEntries.at(-1)?.id === current
    if (wasAtTail) activeEntryId.value = nextEntries.at(-1)!.id
    else {
      const previousIds = new Set(previousEntries.map((entry) => entry.id))
      if (nextEntries.some((entry) => !previousIds.has(entry.id))) hasNewTail.value = true
    }
  },
  { immediate: true },
)

function selectIndex(index: number): void {
  const entry = entries.value[index]
  if (!entry) return
  activeEntryId.value = entry.id
  if (index === entries.value.length - 1) hasNewTail.value = false
  emit('select', { nodeId: entry.id, sourceChatId: entry.node.sourceChatId })
}

function returnLatest(): void {
  selectIndex(entries.value.length - 1)
}

function requestBranch(type: 'detail' | 'continuation', nodeId: string): void {
  emit('branch', {
    type,
    nodeId,
    sourceRootChatId: props.timeline?.rootChatId ?? props.rootChatId,
  })
}

function openGeneration(event: Event): void {
  const generationIndex = Number((event.target as HTMLSelectElement).value)
  if (Number.isInteger(generationIndex) && generationIndex > 0) emit('generation', generationIndex)
  ;(event.target as HTMLSelectElement).value = ''
}

function measure(): void {
  if (readerRef.value) readerHeight.value = readerRef.value.clientHeight
}

onMounted(() => {
  resizeObserver = new ResizeObserver(measure)
  if (readerRef.value) resizeObserver.observe(readerRef.value)
  void nextTick(measure)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <aside ref="readerRef" class="nyxus-content-reader" aria-label="所选内容阅读器">
    <header class="content-reader-toolbar">
      <span class="content-reader-title">
        <Document aria-hidden="true" />
        <span>
          <strong>内容阅读</strong>
          <small>{{ currentEntry?.title ?? '尚未选择内容' }}</small>
        </span>
      </span>
      <select
        v-if="generations.length"
        class="generation-select"
        aria-label="打开历史代际"
        value=""
        @change="openGeneration"
      >
        <option value="" disabled>历史代际</option>
        <option v-for="generation in generations" :key="generation.index" :value="generation.index">
          第 {{ generation.index }} 代 ·
          {{ generation.trigger === 'auto' ? '自动压缩' : '手动压缩' }}
        </option>
      </select>
      <el-tooltip content="关闭内容阅读" placement="bottom">
        <button
          type="button"
          class="content-reader-close"
          aria-label="关闭内容阅读"
          @click="emit('close')"
        >
          <Close aria-hidden="true" />
        </button>
      </el-tooltip>
    </header>

    <p v-if="selectionMissing" class="content-reader-notice" role="status">
      所选内容尚未同步，已保留选择；内容到达后会自动打开。
    </p>

    <div class="content-reader-body">
      <NodePaperStack
        :entries="entries"
        :edges="graph.edges"
        :current-index="currentIndex"
        :max-height="maxCardHeight"
        :has-new-tail="hasNewTail"
        :detail-branch-available="detailBranchAvailable"
        :detail-branch-unavailable-reason="detailBranchUnavailableReason"
        :sense-tools="senseTools"
        :selected-call-id="resolvedSelection?.callId"
        @select="selectIndex"
        @latest="returnLatest"
        @branch="requestBranch"
      />
    </div>
  </aside>
</template>

<style scoped lang="less">
.nyxus-content-reader {
  position: relative;
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: 44px auto minmax(0, 1fr);
  overflow: hidden;
  border-left: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
}

.content-reader-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.content-reader-title {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
}

.content-reader-title > svg,
.content-reader-close svg {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
}

.content-reader-title > span {
  min-width: 0;
  display: grid;
  line-height: 1.2;
}

.content-reader-title strong,
.content-reader-title small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-reader-title strong {
  font-size: 13px;
  font-weight: 600;
}

.content-reader-title small {
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font-size: 12px;
  font-weight: 400;
}

.generation-select {
  min-width: 112px;
  max-width: 148px;
  height: 30px;
  margin-left: auto;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface);
  color: inherit;
  padding: 3px 6px;
  font: inherit;
  font-size: 12px;
}

.content-reader-close {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface);
  color: inherit;
  cursor: pointer;
}

.generation-select:focus-visible,
.content-reader-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.content-reader-notice {
  margin: 0;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--warning) 10%, var(--panel));
  color: color-mix(in srgb, var(--warning) 78%, var(--ink));
  font-size: 12px;
  line-height: 1.45;
}

.content-reader-body {
  grid-row: 3;
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

:deep(.node-paper-stage) {
  inset: 0;
  min-width: 0;
}

@media (max-width: 760px) {
  .generation-select {
    max-width: 126px;
  }
}
</style>
