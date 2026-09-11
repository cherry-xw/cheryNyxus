<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ActiveTurnSnapshot } from '@/application/backend/public'
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'
const props = defineProps<{ turn: ActiveTurnSnapshot }>()
const bodyRef = ref<HTMLElement | null>(null)
const userScrolled = ref(false)
const selectedChannel = ref<'content' | 'thinking'>('content')
const channel = computed(() => selectedChannel.value === 'thinking' && props.turn.thinking ? 'thinking' : props.turn.content ? 'content' : 'thinking')
const source = computed(() => props.turn[channel.value] || '等待首个响应片段…')
const { html } = useRenderedMarkdown(() => source.value, { mode: 'preview' })
function followTail(): void {
  if (userScrolled.value) return
  void nextTick(() => { if (bodyRef.value) bodyRef.value.scrollTop = bodyRef.value.scrollHeight })
}
function onScroll(): void {
  const body = bodyRef.value
  if (body) userScrolled.value = body.scrollHeight - body.scrollTop - body.clientHeight > 16
}
function returnToLatest(): void { userScrolled.value = false; followTail() }
watch(source, followTail, { immediate: true })
watch(() => props.turn.turnId, () => { userScrolled.value = false; selectedChannel.value = 'content'; followTail() })
</script>
<template>
  <aside class="workflow-live-crt nodrag nopan nowheel" aria-label="模型实时响应" @pointerdown.stop @wheel.stop>
    <header>
      <strong>实时响应</strong>
      <button v-if="turn.content" type="button" :aria-pressed="channel === 'content'" @click.stop="selectedChannel = 'content'">正文</button>
      <button v-if="turn.thinking" type="button" :aria-pressed="channel === 'thinking'" @click.stop="selectedChannel = 'thinking'">思考摘要</button>
    </header>
    <div ref="bodyRef" class="workflow-live-crt-body" @scroll="onScroll" v-html="html" />
    <footer>
      <span>{{ userScrolled ? '已暂停自动跟随' : '正在实时输出' }}</span>
      <button v-if="userScrolled" type="button" @click.stop="returnToLatest">回到最新</button>
    </footer>
  </aside>
</template>
<style scoped lang="less">
.workflow-live-crt { position: absolute; z-index: 18; top: calc(100% + 8px); left: 0; display: grid; grid-template-rows: 32px minmax(0, 1fr) 30px; width: 280px; height: 180px; box-sizing: border-box; overflow: hidden; border: 1px solid var(--border-strong); border-radius: 0; background: var(--panel); color: var(--ink); pointer-events: auto; }
header, footer { display: flex; align-items: center; gap: 8px; padding: 0 8px; font-size: 12px; font-weight: 400; background: var(--surface); }
header { border-bottom: 1px solid var(--border); }
header strong { font-weight: 600; margin-right: auto; }
footer { justify-content: space-between; border-top: 1px solid var(--border); }
button { padding: 3px; border: 0; background: transparent; color: var(--ink); font: inherit; font-weight: 400; cursor: pointer; }
button[aria-pressed='true'] { color: var(--accent); text-decoration: underline; text-underline-offset: 4px; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.workflow-live-crt-body { overflow: auto; padding: 8px 10px; font-size: 12px; line-height: 1.5; overscroll-behavior: contain; scrollbar-color: var(--border-strong) var(--panel); scrollbar-width: thin; user-select: text; }
.workflow-live-crt-body :deep(p) { margin: 0 0 0.45em; }
.workflow-live-crt-body :deep(pre) { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
