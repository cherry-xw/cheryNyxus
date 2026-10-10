<script setup lang="ts">
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import { parseJsonValue, prettyTranslatedJson } from './toolRendering'

const props = defineProps<{ call: GraphToolCall }>()

const result = computed(() => {
  const raw = props.call.result?.trim() ?? ''
  if (!raw) return ''
  const value = parseJsonValue(raw)
  return value && typeof value === 'object' ? prettyTranslatedJson(value) : raw
})
</script>

<template>
  <section class="lite-builtin-result">
    <div class="lite-builtin-result-label">结果</div>
    <pre v-if="result" class="lite-builtin-result-content">{{ result }}</pre>
    <p v-else class="lite-builtin-result-empty">
      {{ call.status === 'pending' || call.status === 'accepted' ? '等待工具返回…' : '（无结果）' }}
    </p>
  </section>
</template>

<style scoped>
.lite-builtin-result {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.lite-builtin-result-label {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.5;
}
.lite-builtin-result-content {
  max-height: 300px;
  overflow: auto;
  margin: 0;
  color: var(--el-text-color-primary);
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  scrollbar-width: none;
}
.lite-builtin-result-empty {
  margin: 0;
  color: var(--el-text-color-placeholder);
  font-size: 14px;
}
</style>
