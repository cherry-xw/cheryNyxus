<script setup lang="ts">
/**
 * LiteReadFileDetail：read_file 专有内容区（精简模式详情抽屉工具链内使用）。
 * 展示 路径 → 读取范围 → 内容（直接全量展示，含行数与压缩标记）。
 * 头部（工具名/简介/风险徽章）由 LiteToolCallDetail 统一提供；层级保持扁平，不套边框背景。
 * 内容解析与树/对话视图 FileReadRenderer 同源（result 文本 + 末尾压缩标记）。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import { argsRecord, argString, argNumber } from './builtinToolArgs'

const props = defineProps<{ call: GraphToolCall; label: string }>()

const args = computed(() => argsRecord(props.call.arguments))
const path = computed(() => argString(args.value, 'path', 'file_path', 'filepath', 'file'))
const offset = computed(() => argNumber(args.value, 'offset'))
const limit = computed(() => argNumber(args.value, 'limit'))

const rawResult = computed(() => props.call.result?.trim() ?? '')
/** 移除末尾压缩标记后的内容文本。 */
const content = computed(() =>
  rawResult.value.replace(/\[(compressed|truncated):\s*\w+\]$/, '').trim(),
)
const compression = computed(() => {
  const match = rawResult.value.match(/\[(compressed|truncated):\s*(\w+)\]$/)
  return match?.[2] ?? ''
})
const lineCount = computed(() => (content.value ? content.value.split('\n').length : 0))

const rangeText = computed(() => {
  if (offset.value === undefined && limit.value === undefined) return ''
  const start = offset.value !== undefined ? `第 ${offset.value} 行` : '开头'
  const count = limit.value !== undefined ? ` +${limit.value} 行` : '至末尾'
  return `${start}${count}`
})
</script>

<template>
  <div class="lite-bt">
    <div v-if="path" class="lite-bt-row">
      <span class="lite-bt-label">路径</span>
      <code class="lite-bt-code">{{ path }}</code>
    </div>
    <div v-if="rangeText" class="lite-bt-row">
      <span class="lite-bt-label">范围</span>
      <span class="lite-bt-value">{{ rangeText }}</span>
    </div>
    <template v-if="content">
      <div class="lite-bt-row">
        <span class="lite-bt-label">内容</span>
        <span class="lite-bt-chip">{{ lineCount }} 行</span>
        <span v-if="compression" class="lite-bt-chip">{{ compression }}</span>
      </div>
      <pre class="lite-bt-pre">{{ content }}</pre>
    </template>
  </div>
</template>

<style scoped>
/* 与 LiteCommandDetail 相同的扁平字段行/代码块（层级保持扁平）。 */
.lite-bt {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.lite-bt-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.lite-bt-label {
  flex: none;
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.5;
}
.lite-bt-value {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-size: 15px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.lite-bt-code {
  min-width: 0;
  color: var(--el-text-color-primary);
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.lite-bt-chip {
  color: var(--el-text-color-placeholder);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.lite-bt-pre {
  margin: 0;
  padding: 6px 8px;
  background: var(--el-fill-color-blank);
  font-family: var(--el-font-family-mono);
  font-size: 13.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow: auto;
  scrollbar-width: none;
}
</style>
