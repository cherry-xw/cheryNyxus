<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ActiveTurnSnapshot } from '@/application/backend/public'
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'
const props = defineProps<{ turn?: ActiveTurnSnapshot }>()
const bodyRef = ref<HTMLElement | null>(null)
const userScrolled = ref(false)
const selectedChannel = ref<'content' | 'thinking'>('content')
const channels = computed(() => ({
  content: props.turn?.content ?? '',
  thinking: props.turn?.thinking ?? '',
}))
const channel = computed(() =>
  channels.value[selectedChannel.value]
    ? selectedChannel.value
    : props.turn?.content
      ? 'content'
      : props.turn?.thinking
        ? 'thinking'
        : 'content',
)
const source = computed(() => channels.value[channel.value] || (props.turn ? '等待首个响应片段…' : '暂无模型响应'))
const { html: rendered } = useRenderedMarkdown(() => source.value, { mode: 'preview' })
const characterCount = computed(() =>
  Object.values(channels.value).reduce((total, value) => total + value.length, 0),
)
function followTail(): void {
  if (userScrolled.value) return
  void nextTick(() => {
    if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight
  })
}
function onScroll(): void {
  const body = bodyRef.value
  if (body) userScrolled.value = body.scrollHeight - body.scrollTop - body.clientHeight > 16
}
function returnToLatest(): void {
  userScrolled.value = false
  followTail()
}
watch(source, followTail, { immediate: true })
watch(
  () => props.turn?.turnId,
  () => {
    userScrolled.value = false
    selectedChannel.value = 'content'
    followTail()
  },
)
</script>
<template>
  <aside
    class="workflow-live-crt nodrag nopan nowheel"
    :class="{ 'is-streaming': !!turn }"
    aria-label="模型实时响应"
    @pointerdown.stop
    @wheel.stop
  >
    <header v-if="false">
      <strong>模型响应</strong>
      <button
        v-if="turn?.content"
        type="button"
        :aria-pressed="channel === 'content'"
        @click.stop="selectedChannel = 'content'"
      >
        正文
      </button>
      <button
        v-if="turn?.thinking"
        type="button"
        :aria-pressed="channel === 'thinking'"
        @click.stop="selectedChannel = 'thinking'"
      >
        思考
      </button>

    </header>
    <div ref="bodyRef" class="workflow-live-crt-body" @scroll="onScroll">
      <div class="markdown-body" v-html="rendered" />
      <span v-if="turn" class="crt-caret" aria-hidden="true">▌</span>
    </div>
    <footer v-if="false">
      <span
        >{{ userScrolled ? '已暂停跟随' : source.length > 6000 ? '最新 6000 字符' : turn ? '实时累积' : '等待模型调用' }} ·
        {{ characterCount }} 字符</span
      >
      <button v-if="userScrolled" type="button" @click.stop="returnToLatest">回到最新</button>
    </footer>
  </aside>
</template>
<style scoped lang="less">
.workflow-live-crt {
  position: relative;
  z-index: 18;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  width: 280px;
  height: 180px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 0;
  background: var(--panel);
  color: var(--ink);
  pointer-events: auto;
}
.is-streaming { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
header,
footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 400;
  background: var(--surface);
}
.workflow-live-crt > header[style], .workflow-live-crt > footer[style] { display: none; }
header {
  border-bottom: 1px solid var(--border);
}
header strong {
  font-weight: 600;
  margin-right: auto;
}
footer {
  justify-content: space-between;
  border-top: 1px solid var(--border);
}
button {
  padding: 3px;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-weight: 400;
  cursor: pointer;
}
button[aria-pressed='true'] {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 4px;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.workflow-live-crt-body {
  overflow: auto;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.5;
  overscroll-behavior: contain;
  scrollbar-color: var(--border-strong) var(--panel);
  scrollbar-width: thin;
  user-select: text;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
  background: repeating-linear-gradient(
    transparent 0 3px,
    color-mix(in srgb, var(--accent) 5%, transparent) 3px 4px
  );
}
.workflow-live-crt-body :deep(p) {
  margin: 0 0 0.45em;
}
.workflow-live-crt-body :deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.crt-caret {
  color: var(--accent);
}
</style>
