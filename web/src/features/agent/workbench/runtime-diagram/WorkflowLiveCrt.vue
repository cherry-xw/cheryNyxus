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
  width: 380px;
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
  font-size: 14px;
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
  padding: 8px 12px;
  font-size: 14px;
  line-height: 1.45;
  overscroll-behavior: contain;
  scrollbar-color: var(--border-strong) var(--panel);
  scrollbar-width: thin;
  user-select: text;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
  background: repeating-linear-gradient(
    transparent 0 3px,
    color-mix(in srgb, var(--accent) 5%, transparent) 3px 4px
  );
}
/* 小窗口内统一 markdown 排版：收敛默认标题字号，收紧段落与列表行距 */
/* 只保留文本块内部的源码换行（pre-wrap），块之间的空白换行文本节点折叠，
   避免 markdown-it 输出的 </p>\n<p> 在 pre-wrap 下渲染成整行空隙。 */
.workflow-live-crt-body :deep(p),
.workflow-live-crt-body :deep(h1),
.workflow-live-crt-body :deep(h2),
.workflow-live-crt-body :deep(h3),
.workflow-live-crt-body :deep(h4),
.workflow-live-crt-body :deep(h5),
.workflow-live-crt-body :deep(h6),
.workflow-live-crt-body :deep(li),
.workflow-live-crt-body :deep(blockquote),
.workflow-live-crt-body :deep(th),
.workflow-live-crt-body :deep(td) {
  white-space: pre-wrap;
}
.workflow-live-crt-body :deep(p) {
  margin: 0 0 0.35em;
}
.workflow-live-crt-body :deep(p:last-child) {
  margin-bottom: 0;
}
.workflow-live-crt-body :deep(h1),
.workflow-live-crt-body :deep(h2),
.workflow-live-crt-body :deep(h3),
.workflow-live-crt-body :deep(h4),
.workflow-live-crt-body :deep(h5),
.workflow-live-crt-body :deep(h6) {
  margin: 0.5em 0 0.25em;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.3;
}
.workflow-live-crt-body :deep(h1),
.workflow-live-crt-body :deep(h2) {
  font-size: 15px;
}
.workflow-live-crt-body :deep(ul),
.workflow-live-crt-body :deep(ol) {
  margin: 0 0 0.35em;
  padding-left: 1.5em;
}
.workflow-live-crt-body :deep(li) {
  margin: 0.1em 0;
}
.workflow-live-crt-body :deep(pre) {
  margin: 0.35em 0;
  padding: 5px 7px;
  font-size: 13px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.workflow-live-crt-body :deep(code) {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.workflow-live-crt-body :deep(blockquote) {
  margin: 0.35em 0;
  padding: 0 0 0 8px;
  border-left: 2px solid var(--border-strong);
  color: var(--workflow-muted);
}
.workflow-live-crt-body :deep(hr) {
  margin: 0.5em 0;
  border: 0;
  border-top: 1px solid var(--border);
}
.workflow-live-crt-body :deep(table) {
  margin: 0.35em 0;
  font-size: 13.5px;
  border-collapse: collapse;
}
.workflow-live-crt-body :deep(th),
.workflow-live-crt-body :deep(td) {
  padding: 3px 7px;
  border: 1px solid var(--border);
}
.workflow-live-crt-body :deep(img) {
  max-width: 100%;
  height: auto;
}
.workflow-live-crt-body :deep(a) {
  color: var(--accent);
}
.crt-caret {
  color: var(--accent);
}
</style>
