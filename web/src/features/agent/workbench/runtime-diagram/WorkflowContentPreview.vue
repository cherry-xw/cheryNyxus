<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'
import type { WorkflowGraphNodeData } from './graphModel'

const props = defineProps<{ data: Extract<WorkflowGraphNodeData, { kind: 'content' }> }>()
const emit = defineEmits<{ select: []; close: [] }>()
const tab = ref<'content' | 'thinking'>('content')
const source = computed(() =>
  tab.value === 'thinking'
    ? props.data.node.thinking || props.data.node.sourceFact?.thinking || '暂无思考内容'
    : props.data.node.content || '暂无正文内容',
)
const { html } = useRenderedMarkdown(source, { mode: 'full' })
</script>

<template>
  <section
    class="workflow-content-preview nowheel nodrag nopan"
    :aria-label="data.title"
    @wheel.stop
    @pointerdown.stop
    @keydown.esc.stop="emit('close')"
  >
    <header>
      <strong>{{ data.title }}</strong
      ><button type="button" @click="emit('select')">打开完整卡片</button>
    </header>
    <nav aria-label="内容分类">
      <button type="button" :aria-pressed="tab === 'thinking'" @click="tab = 'thinking'">
        思考
      </button>
      <button type="button" :aria-pressed="tab === 'content'" @click="tab = 'content'">正文</button>
    </nav>
    <div
      class="preview-body markdown-body"
      tabindex="0"
      :aria-label="tab === 'thinking' ? '思考内容' : '正文内容'"
      v-html="html"
    />
  </section>
</template>

<style scoped lang="less">
.workflow-content-preview {
  color: var(--ink);
  font-size: 13px;
  font-weight: 400;
}
header,
nav {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
header {
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
}
strong {
  font-weight: 400;
}
button {
  min-height: 32px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface);
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
button[aria-pressed='true'] {
  border-color: var(--accent);
  color: var(--accent);
}
:is(button, [tabindex]):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.preview-body {
  max-height: min(440px, 55vh);
  overflow: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  user-select: text;
  line-height: 1.6;
}
.preview-body :deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
