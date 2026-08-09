<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import type { RunCrtModel } from '../graph/crtModel'

type CrtTab = 'output' | 'thinking'

const props = defineProps<{ card: RunCrtModel; pinned: boolean; maxHeight: number }>()
const emit = defineEmits<{ pin: []; unpin: []; close: [] }>()
const activeTab = ref<CrtTab>('output')
const bodyRef = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)
let seenThinking = false
let seenContent = false

const tabs = computed<Array<{ id: CrtTab; label: string }>>(() => [
  { id: 'output', label: 'OUTPUT' },
  ...(props.card.thinking ? [{ id: 'thinking' as const, label: 'THINKING' }] : []),
])

function followBottom(): void {
  if (userScrolledUp.value) return
  void nextTick(() => {
    const el = bodyRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function selectTab(tab: CrtTab): void {
  activeTab.value = tab
  userScrolledUp.value = false
  followBottom()
}

watch(
  () => props.card.id,
  () => {
    seenThinking = !!props.card.thinking
    seenContent = !!props.card.content
    activeTab.value = props.card.content ? 'output' : props.card.thinking ? 'thinking' : 'output'
    userScrolledUp.value = false
    followBottom()
  },
  { immediate: true },
)

watch(
  () => props.card.thinking,
  (thinking) => {
    if (thinking && !seenThinking) {
      seenThinking = true
      if (!seenContent) selectTab('thinking')
    } else followBottom()
  },
)

watch(
  () => props.card.content,
  (content) => {
    if (content && !seenContent) {
      seenContent = true
      selectTab('output')
    } else followBottom()
  },
)

function onBodyScroll(): void {
  const el = bodyRef.value
  if (!el) return
  userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight > 20
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.stopPropagation()
  if (props.pinned) emit('unpin')
  else emit('close')
}
</script>

<template>
  <article
    class="run-crt"
    :class="[
      `status-${card.status}`,
      { 'is-pinned': pinned },
    ]"
    :style="{ maxHeight: `${maxHeight}px` }"
    :role="pinned ? 'dialog' : 'status'"
    :aria-label="`${card.title} 运行信息`"
    :aria-modal="pinned ? 'false' : undefined"
    tabindex="-1"
    @keydown="onEscape"
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @click.stop
    @wheel.stop
  >
    <header class="crt-head">
      <div class="crt-title">
        <span aria-hidden="true">┌─</span>
        <strong>{{ card.title }}</strong>
        <small>{{ card.status }} · {{ card.runId }}</small>
      </div>
      <div class="crt-actions">
        <button
          type="button"
          :aria-label="pinned ? '取消固定运行卡片' : '固定运行卡片'"
          :aria-pressed="pinned"
          @click="pinned ? emit('unpin') : emit('pin')"
        >
          {{ pinned ? '◇' : '◆' }}
        </button>
        <button
          type="button"
          aria-label="关闭运行卡片"
          @click="emit('close')"
        >
          ×
        </button>
      </div>
    </header>

    <nav class="crt-tabs" role="tablist" aria-label="运行信息类型">
      <button
        v-for="tab in tabs"
        :id="`${card.id}:${tab.id}:tab`"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-controls="`${card.id}:${tab.id}:panel`"
        :aria-selected="activeTab === tab.id"
        :tabindex="activeTab === tab.id ? 0 : -1"
        :class="{ active: activeTab === tab.id }"
        @click="selectTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <section
      v-if="activeTab === 'output'"
      :id="`${card.id}:output:panel`"
      ref="bodyRef"
      class="crt-body markdown-body"
      role="tabpanel"
      :aria-labelledby="`${card.id}:output:tab`"
      @scroll="onBodyScroll"
      v-html="renderMarkdown(card.content || 'awaiting response…')"
    />
    <section
      v-else-if="activeTab === 'thinking'"
      :id="`${card.id}:thinking:panel`"
      ref="bodyRef"
      class="crt-body markdown-body is-thinking"
      role="tabpanel"
      :aria-labelledby="`${card.id}:thinking:tab`"
      @scroll="onBodyScroll"
      v-html="renderMarkdown(card.thinking || 'awaiting trace…')"
    />

    <footer class="crt-foot">
      <span>└─ {{ card.status === 'running' ? 'RECEIVING…' : card.status.toUpperCase() }}</span>
    </footer>
  </article>
</template>

<style scoped lang="less">
.run-crt {
  width: 340px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #b9f7d1;
  border: 1px solid rgba(111, 232, 155, 0.72);
  border-radius: 10px;
  background: rgba(5, 16, 13, 0.97);
  box-shadow:
    6px 7px 0 rgba(0, 0, 0, 0.24),
    0 18px 42px rgba(0, 0, 0, 0.34),
    inset 0 0 0 1px rgba(141, 255, 181, 0.08);
  font-family: ui-monospace, 'JetBrains Mono', monospace;
  user-select: text;
  -webkit-user-select: text;
}
.run-crt.is-pinned {
  border-color: #b5fff2;
  box-shadow:
    0 0 0 1px rgba(181, 255, 242, 0.22),
    0 18px 42px rgba(0, 0, 0, 0.4);
}
.run-crt:focus-visible {
  outline: 2px solid #b5fff2;
  outline-offset: 2px;
}
.crt-head,
.crt-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  background: rgba(79, 184, 112, 0.1);
  font-size: 9px;
  letter-spacing: 0.04em;
}
.crt-head {
  border-bottom: 1px solid rgba(101, 205, 132, 0.3);
}
.crt-title {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 5px;
}
.crt-title strong {
  flex: 0 0 auto;
  font-size: 11px;
}
.crt-title small {
  overflow: hidden;
  color: rgba(185, 247, 209, 0.56);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.crt-actions {
  display: flex;
  gap: 3px;
}
.crt-actions button,
.crt-tabs button {
  border: 0;
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.crt-actions button {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  font-size: 15px;
}
.crt-actions button:hover,
.crt-actions button:focus-visible {
  background: rgba(185, 247, 209, 0.12);
}
.crt-tabs {
  flex: 0 0 auto;
  display: flex;
  gap: 3px;
  padding: 6px 8px 0;
  overflow-x: auto;
  scrollbar-width: thin;
}
.crt-tabs button {
  flex: 0 0 auto;
  padding: 4px 7px;
  border: 1px solid rgba(111, 232, 155, 0.18);
  border-radius: 5px 5px 0 0;
  color: rgba(185, 247, 209, 0.55);
  font-size: 8px;
}
.crt-tabs button.active {
  color: #eafff1;
  border-color: rgba(111, 232, 155, 0.55);
  background: rgba(111, 232, 155, 0.1);
}
.crt-body {
  min-height: 86px;
  padding: 10px;
  overflow: auto;
  overscroll-behavior: contain;
  color: #d8fbe5;
  font-size: 10px;
  line-height: 1.55;
  scrollbar-width: thin;
}
.markdown-body :deep(p) {
  margin: 0 0 0.55em;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-body :deep(pre) {
  overflow: auto;
  padding: 7px;
  background: rgba(0, 0, 0, 0.35);
}
.is-thinking {
  color: rgba(185, 247, 209, 0.66);
}
.crt-foot {
  border-top: 1px solid rgba(101, 205, 132, 0.22);
  color: #70e89b;
}
.tone-danger {
  color: #ff9bb0;
}
.tone-warning {
  color: #ffcf7c;
}
@media (prefers-reduced-motion: no-preference) {
  .status-running:not(.is-pinned) {
    animation: crt-scan 2.4s ease-in-out infinite;
  }
}
@keyframes crt-scan {
  50% {
    border-color: rgba(181, 255, 242, 0.78);
  }
}
@media (prefers-reduced-motion: reduce) {
  .run-crt {
    animation: none;
  }
}
</style>
