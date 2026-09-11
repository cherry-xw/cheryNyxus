<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ActiveTurnSnapshot } from '@/application/backend/public'
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'

const props = defineProps<{ turn: ActiveTurnSnapshot }>()
const bodyRef = ref<HTMLElement | null>(null)
const userScrolled = ref(false)
const channel = computed(() => (props.turn.content ? '正文' : props.turn.thinking ? '思考' : '响应'))
const source = computed(() => props.turn.content || props.turn.thinking || '等待首个响应片段…')
const { html } = useRenderedMarkdown(() => source.value, { mode: 'preview' })

function followTail(): void {
  if (userScrolled.value) return
  void nextTick(() => {
    const body = bodyRef.value
    if (body) body.scrollTop = body.scrollHeight
  })
}
function onScroll(): void {
  const body = bodyRef.value
  if (!body) return
  userScrolled.value = body.scrollHeight - body.scrollTop - body.clientHeight > 16
}
watch(source, followTail, { immediate: true })
</script>

<template>
  <aside class="workflow-live-crt nodrag nopan" role="status" aria-label="模型实时响应">
    <header>
      <span class="workflow-live-crt-dot" aria-hidden="true" />
      <strong>LLM LIVE</strong>
      <span>{{ channel }}</span>
    </header>
    <div ref="bodyRef" class="workflow-live-crt-body" @scroll="onScroll" v-html="html" />
    <footer>{{ userScrolled ? '已暂停自动跟随' : '正在实时打印' }}</footer>
  </aside>
</template>

<style scoped lang="less">
.workflow-live-crt {
  position: absolute;
  z-index: 18;
  top: calc(100% + 9px);
  left: 0;
  display: grid;
  grid-template-rows: 25px minmax(72px, 112px) 19px;
  width: 258px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--workflow-capability) 72%, #82939b);
  background: #091117;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.38);
  color: #d9e7eb;
  font-family: ui-monospace, 'JetBrains Mono', monospace;
  pointer-events: auto;
}
.workflow-live-crt::before {
  position: absolute;
  z-index: 1;
  inset: 25px 0 19px;
  background: repeating-linear-gradient(
    to bottom,
    transparent 0 3px,
    rgba(126, 205, 217, 0.035) 3px 4px
  );
  content: '';
  pointer-events: none;
}
.workflow-live-crt header,
.workflow-live-crt footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 7px;
  background: #101b22;
  color: #849aa3;
  font-size: 9px;
  letter-spacing: 0.04em;
}
.workflow-live-crt header {
  border-bottom: 1px solid rgba(145, 183, 194, 0.18);
}
.workflow-live-crt header strong {
  color: #e6f1f4;
  font-size: 10px;
}
.workflow-live-crt header > :last-child {
  margin-left: auto;
}
.workflow-live-crt footer {
  border-top: 1px solid rgba(145, 183, 194, 0.18);
}
.workflow-live-crt-dot {
  width: 5px;
  height: 5px;
  background: #63d59a;
  box-shadow: 0 0 7px rgba(99, 213, 154, 0.65);
}
.workflow-live-crt-body {
  position: relative;
  overflow: auto;
  padding: 7px 9px;
  color: #cde0e5;
  font-size: 10px;
  line-height: 1.5;
  overscroll-behavior: contain;
  scrollbar-color: rgba(116, 157, 168, 0.55) transparent;
  scrollbar-width: thin;
  user-select: text;
}
.workflow-live-crt-body :deep(p) {
  margin: 0 0 0.45em;
}
.workflow-live-crt-body :deep(p:last-child) {
  margin-bottom: 0;
}
.workflow-live-crt-body :deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (prefers-reduced-motion: reduce) {
  .workflow-live-crt-dot {
    box-shadow: none;
  }
}
</style>
