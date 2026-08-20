<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import type { RunCrtModel } from '../graph/crtModel'

type CrtTab = 'output' | 'thinking'

const props = defineProps<{ card: RunCrtModel; pinned: boolean; maxHeight: number }>()
const emit = defineEmits<{
  pin: []
  unpin: []
  close: []
  focus: []
  drag: [delta: { x: number; y: number }]
}>()
const activeTab = ref<CrtTab>('output')
const bodyRef = ref<HTMLElement | null>(null)
const userScrolledUp = ref(false)
let seenThinking = false
let seenContent = false
let dragPointerId = -1
let dragX = 0
let dragY = 0

function onHeaderPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || (event.target as Element | null)?.closest('button')) return
  event.preventDefault()
  emit('focus')
  dragPointerId = event.pointerId
  dragX = event.clientX
  dragY = event.clientY
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
}

function onHeaderPointerMove(event: PointerEvent): void {
  if (event.pointerId !== dragPointerId) return
  emit('drag', { x: event.clientX - dragX, y: event.clientY - dragY })
  dragX = event.clientX
  dragY = event.clientY
}

function onHeaderPointerUp(event: PointerEvent): void {
  if (event.pointerId !== dragPointerId) return
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId)
  dragPointerId = -1
}

const tabs = computed<Array<{ id: CrtTab; label: string }>>(() => [
  { id: 'output', label: '正文' },
  ...(props.card.thinking ? [{ id: 'thinking' as const, label: '思考' }] : []),
])
const statusLabel = computed(() => {
  const labels: Record<RunCrtModel['status'], string> = {
    completed: '已完成',
    running: '正在接收',
    waiting: '等待中',
    paused: '已暂停',
    failed: '执行失败',
  }
  return labels[props.card.status]
})

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
    :class="[`status-${card.status}`, { 'is-pinned': pinned }]"
    :style="{ maxHeight: `${maxHeight}px` }"
    :role="pinned ? 'dialog' : 'status'"
    :aria-label="`${card.title}运行信息`"
    :aria-modal="pinned ? 'false' : undefined"
    tabindex="-1"
    @keydown="onEscape"
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @click.stop
    @pointerdown="emit('focus')"
    @wheel.stop
  >
    <header
      class="crt-head"
      @pointerdown.stop="onHeaderPointerDown"
      @pointermove.stop="onHeaderPointerMove"
      @pointerup.stop="onHeaderPointerUp"
      @pointercancel.stop="onHeaderPointerUp"
    >
      <span class="live-dot" aria-hidden="true" />
      <strong>{{ card.title }}</strong>
      <span class="status-copy">{{ statusLabel }}</span>
      <div class="crt-actions">
        <button
          type="button"
          :aria-label="pinned ? '取消固定运行卡片' : '固定运行卡片'"
          :aria-pressed="pinned"
          @click="pinned ? emit('unpin') : emit('pin')"
        >
          {{ pinned ? '◇' : '◆' }}
        </button>
        <button type="button" aria-label="关闭运行卡片" @click="emit('close')">×</button>
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

    <Transition name="crt-content" mode="out-in">
      <section
        v-if="activeTab === 'output'"
        :id="`${card.id}:output:panel`"
        ref="bodyRef"
        key="output"
        class="crt-body markdown-body"
        role="tabpanel"
        :aria-labelledby="`${card.id}:output:tab`"
        @scroll="onBodyScroll"
        v-html="renderMarkdown(card.content || '等待响应…')"
      />
      <section
        v-else
        :id="`${card.id}:thinking:panel`"
        ref="bodyRef"
        key="thinking"
        class="crt-body markdown-body is-thinking"
        role="tabpanel"
        :aria-labelledby="`${card.id}:thinking:tab`"
        @scroll="onBodyScroll"
        v-html="renderMarkdown(card.thinking || '等待思考内容…')"
      />
    </Transition>

    <footer class="crt-foot">
      <span>{{ userScrolledUp ? '已暂停自动跟随' : statusLabel }}</span>
    </footer>
  </article>
</template>

<style scoped lang="less">
@bg: #0b1116;
@surface: #101820;
@ink: #d9e4e8;
@muted: #84949b;
@accent: #57c7d4;
@line: rgba(150, 180, 190, 0.18);
@ease-out: cubic-bezier(0.23, 1, 0.32, 1);

.run-crt {
  width: 360px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: @ink;
  border: 1px solid rgba(121, 165, 176, 0.42);
  border-radius: 4px;
  background: @bg;
  box-shadow: 0 18px 42px rgba(0, 0, 0, 0.4);
  font-family: ui-monospace, 'JetBrains Mono', monospace;
  user-select: text;
  -webkit-user-select: text;
}
.run-crt.is-pinned {
  border-color: rgba(87, 199, 212, 0.7);
}
.run-crt:focus-visible {
  outline: 2px solid @accent;
  outline-offset: 2px;
}
.crt-head {
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 8px;
  border-bottom: 1px solid @line;
  background: @surface;
  cursor: grab;
  touch-action: none;
}
.crt-head:active { cursor: grabbing; }
.crt-head strong {
  min-width: 0;
  overflow: hidden;
    color: #edf5f7;
      font:
    650 10px/1.2 system-ui,
    sans-serif;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-dot {
  flex: 0 0 auto;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: @accent;
  box-shadow: 0 0 0 2px rgba(87, 199, 212, 0.11);
}
.status-running .live-dot {
  background: #69c995;
}
.status-waiting .live-dot {
  background: #e7b76b;
}
.status-paused .live-dot {
  background: @muted;
}
.status-completed .live-dot {
  background: #69c995;
}
.status-failed .live-dot {
  background: #ef7185;
}
.status-copy {
  flex: 0 0 auto;
  color: @muted;
  font:
    8px/1.2 system-ui,
    sans-serif;
}
.crt-actions {
  display: flex;
  gap: 2px;
  margin-left: auto;
}
.crt-actions button,
.crt-tabs button {
  border: 0;
  color: @muted;
  background: transparent;
  cursor: pointer;
}
.crt-actions button {
  width: 21px;
  height: 21px;
  border-radius: 3px;
  font:
    12px/1 ui-monospace,
    monospace;
  transition:
    transform 120ms @ease-out,
    color 120ms ease,
    background-color 120ms ease;
}
.crt-actions button:active,
.crt-tabs button:active {
  transform: scale(0.97);
}
.crt-tabs {
  flex: 0 0 26px;
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 0 7px;
  border-bottom: 1px solid @line;
  background: @surface;
}
.crt-tabs button {
  position: relative;
  padding: 0 8px;
  font:
    9px/1.2 system-ui,
    sans-serif;
  transition:
    transform 120ms @ease-out,
    color 120ms ease,
    background-color 120ms ease;
}
.crt-tabs button::after {
  content: '';
  position: absolute;
  right: 9px;
  bottom: -1px;
  left: 9px;
  height: 2px;
  background: @accent;
  opacity: 0;
  transform: scaleX(0.6);
  transition:
    opacity 140ms ease,
    transform 140ms @ease-out;
}
.crt-tabs button.active {
  color: var(--ink);
  color: #edf5f7;
}
.crt-tabs button.active::after {
  opacity: 1;
  transform: scaleX(1);
}
.crt-body {
  min-height: 94px;
  flex: 1 1 auto;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 8px 10px;
  overscroll-behavior: contain;
  color: var(--ink);
  color: #d4dfe2;
  font-size: 10px;
  line-height: 1.55;
  scrollbar-color: rgba(114, 147, 154, 0.58) transparent;
  scrollbar-width: thin;
}
.crt-body::-webkit-scrollbar {
  width: 6px;
}
.crt-body::-webkit-scrollbar-thumb {
  background: rgba(114, 147, 154, 0.58);
}
.markdown-body :deep(p) {
  margin: 0 0 0.55em;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  margin: 0.7em 0 0.35em;
  color: var(--ink);
  color: #edf5f7;
}
.markdown-body :deep(pre) {
  overflow: visible;
  padding: 6px 7px;
  color: var(--ink);
  color: #cce5e9;
  white-space: pre-wrap;
  word-break: break-word;
}
.markdown-body :deep(code) {
  color: var(--ink);
  color: #bfe2e7;
  overflow-wrap: anywhere;
}
.is-thinking {
  color: #9aa9ae;
}
.crt-foot {
  flex: 0 0 20px;
  display: flex;
  align-items: center;
  padding: 0 8px;
  border-top: 1px solid @line;
  color: @muted;
  background: @surface;
  font:
    8px/1.2 system-ui,
    sans-serif;
}
.crt-content-enter-active,
.crt-content-leave-active {
  transition: opacity 130ms @ease-out;
}
.crt-content-enter-from,
.crt-content-leave-to {
  opacity: 0;
}
@media (hover: hover) and (pointer: fine) {
  .crt-actions button:hover,
  .crt-tabs button:hover {
    color: var(--ink);
    color: #e3edef;
  }
}
.status-running .live-dot {
  animation: live-dot-pulse 1.4s linear infinite;
}
@keyframes live-dot-pulse {
  50% {
    opacity: 0.42;
  }
}

@media (prefers-reduced-motion: reduce) {
  .status-running .live-dot {
    animation: none;
  }

  .crt-content-enter-active,
  .crt-content-leave-active,
  .crt-actions button,
  .crt-tabs button,
  .crt-tabs button::after {
    transition: none;
  }
}
</style>
