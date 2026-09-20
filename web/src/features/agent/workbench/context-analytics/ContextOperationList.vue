<script setup lang="ts">
import type { AnalyticsOperation } from './model'
import { formatDuration } from './presentation'
defineProps<{ operations: AnalyticsOperation[] }>()
const labels = { command: '指令', read: '读取', write: '写入', search: '搜索', compression: '压缩' }
</script>
<template>
  <ol class="operation-list">
    <li v-for="operation in operations" :key="operation.id">
      <header><span class="kind">{{ labels[operation.kind] }}</span><span>第 {{ operation.round }} 轮 · 第 {{ operation.step }} 步</span><span>{{ formatDuration(operation.durationMs) }} · {{ operation.status === 'failed' ? '失败' : '完成' }}</span></header>
      <p>{{ operation.description }}</p>
      <pre v-if="operation.command">{{ operation.command }}</pre>
      <code v-if="operation.path">{{ operation.path }}</code>
      <p v-if="operation.query">关键词：{{ operation.query }}</p>
      <p v-if="operation.kind === 'write'" class="changes"><span>+{{ operation.addedLines ?? '未知' }} 行</span><span>−{{ operation.removedLines ?? '未知' }} 行</span></p>
    </li>
  </ol>
  <p v-if="!operations.length">此范围没有已保存的操作记录。</p>
</template>
<style scoped>
.operation-list { display: grid; grid-template-columns: 1fr; grid-auto-rows: 1fr; gap: 10px; list-style: none; margin: 12px 0 0; padding: 0; }
.operation-list:has(> :last-child:nth-child(2n)) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
@media (max-width: 640px) { .operation-list:has(> :last-child:nth-child(n)) { grid-template-columns: 1fr; } }
li { min-width: 0; padding: 12px; border: 1px solid color-mix(in srgb, var(--nx-text) 16%, transparent); background: color-mix(in srgb, var(--nx-bg) 94%, var(--nx-text) 6%); }
header { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: color-mix(in srgb, var(--nx-text) 65%, transparent); }
.kind { color: var(--nx-cyan); }
p, pre, code { font-size: 12px; line-height: 1.7; font-weight: 400; overflow-wrap: anywhere; white-space: pre-wrap; margin: 8px 0 0; }
.changes { display: flex; gap: 12px; }.changes span:first-child { color: var(--nx-green); }.changes span:last-child { color: var(--nx-yellow); }
</style>
