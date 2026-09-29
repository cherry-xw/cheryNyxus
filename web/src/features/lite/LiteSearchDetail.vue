<script setup lang="ts">
/**
 * LiteSearchDetail：search_codebase 专有内容区（精简模式详情抽屉工具链内使用）。
 * 展示 查询 → 模式（内容/文件名/正则） → 结果列表（直接全量展示，路径:行号 + 匹配内容）。
 * 头部（工具名/简介/风险徽章）由 LiteToolCallDetail 统一提供；层级保持扁平，不套边框背景。
 * 结果解析与树/对话视图 SearchRenderer 同源（result 按行解析 路径:行号:内容）。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import { argsRecord, argString, argBoolean, argNumber } from './builtinToolArgs'

const props = defineProps<{ call: GraphToolCall; label: string }>()

const args = computed(() => argsRecord(props.call.arguments))
const query = computed(() => argString(args.value, 'query', '关键字'))
const mode = computed(() => argString(args.value, 'mode'))
const regex = computed(() => argBoolean(args.value, 'regex'))
const maxResults = computed(() => argNumber(args.value, 'max_results', 'maxResults'))

interface SearchResult {
  filePath: string
  line?: number
  content?: string
}
const results = computed<SearchResult[]>(() => {
  const text = (props.call.result ?? '').trim()
  if (!text) return []
  const list: SearchResult[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const match = line.match(/^([^\s:]+):(\d+):(.*)$/)
    if (match && match[1] && match[2]) {
      list.push({ filePath: match[1], line: parseInt(match[2], 10), content: match[3]?.trim() })
    } else {
      const nameMatch = line.match(/^([^\s:]+)$/)
      if (nameMatch && nameMatch[1]) list.push({ filePath: nameMatch[1] })
    }
  }
  return list
})
const modeText = computed(() =>
  mode.value === 'filename' ? '文件名' : regex.value ? '内容 · 正则' : '内容',
)
</script>

<template>
  <div class="lite-bt">
    <div v-if="query" class="lite-bt-row">
      <span class="lite-bt-label">查询</span>
      <code class="lite-bt-code">{{ query }}</code>
    </div>
    <div v-if="modeText" class="lite-bt-row">
      <span class="lite-bt-label">模式</span>
      <span class="lite-bt-value">{{ modeText }}</span>
    </div>
    <div v-if="maxResults !== undefined" class="lite-bt-row">
      <span class="lite-bt-label">结果上限</span>
      <span class="lite-bt-value">{{ maxResults }}</span>
    </div>
    <template v-if="results.length">
      <div class="lite-bt-row">
        <span class="lite-bt-label">结果</span>
        <span class="lite-bt-chip">{{ results.length }} 项</span>
      </div>
      <ul class="lite-bt-list">
        <li v-for="(r, index) in results" :key="index" class="lite-bt-result">
          <code class="lite-bt-file">{{ r.filePath }}</code>
          <span v-if="r.line !== undefined" class="lite-bt-line">:{{ r.line }}</span>
          <span v-if="r.content" class="lite-bt-content">{{ r.content }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
/* 与其余内置工具一致的扁平字段行 + 结果列表（层级保持扁平）。 */
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
.lite-bt-list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.lite-bt-result {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
}
.lite-bt-file {
  flex: none;
  color: var(--el-color-primary);
  font-family: var(--el-font-family-mono);
  font-size: 13px;
  word-break: break-all;
}
.lite-bt-line {
  flex: none;
  color: var(--el-text-color-placeholder);
  font-family: var(--el-font-family-mono);
  font-size: 13px;
}
.lite-bt-content {
  min-width: 0;
  color: var(--el-text-color-secondary);
  font-size: 13.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
