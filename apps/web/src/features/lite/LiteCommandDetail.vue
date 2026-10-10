<script setup lang="ts">
/**
 * LiteCommandDetail：execute_command 专有内容区（精简模式详情抽屉工具链内使用）。
 * 展示 说明 → 命令 → 输出（直接全量展示）；耗时/时长按项目决策不展示（不可靠，用户去顶部流程图查看）。
 * 头部（工具名/简介/风险徽章）由 LiteToolCallDetail 统一提供；层级保持扁平，不套边框背景。
 * 结果解析与树/对话视图 CommandRenderer 同源（后端 result 为中文 key: value 文本）。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import { argsRecord, argString } from './builtinToolArgs'

const props = defineProps<{ call: GraphToolCall; label: string }>()

const args = computed(() => argsRecord(props.call.arguments))
const command = computed(() => argString(args.value, 'command', 'cmd'))
const description = computed(() => argString(args.value, 'description', '说明'))

const result = computed(() => props.call.result?.trim() ?? '')
const output = computed(() => result.value.match(/\[输出\]\r?\n([\s\S]*)/)?.[1] ?? '')
const exitCode = computed(() => result.value.match(/退出码:\s*(\d+)/)?.[1] ?? '')
</script>

<template>
  <div class="lite-bt">
    <div v-if="description" class="lite-bt-row">
      <span class="lite-bt-label">说明</span>
      <span class="lite-bt-value">{{ description }}</span>
    </div>
    <div v-if="command" class="lite-bt-row">
      <span class="lite-bt-label">命令</span>
      <code class="lite-bt-code">{{ command }}</code>
    </div>
    <template v-if="output">
      <div class="lite-bt-row">
        <span class="lite-bt-label">输出</span>
        <span v-if="exitCode" class="lite-bt-chip">退出码 {{ exitCode }}</span>
      </div>
      <pre class="lite-bt-pre">{{ output }}</pre>
    </template>
  </div>
</template>

<style scoped>
/* 扁平字段行 + 代码块，不套边框/背景（层级保持扁平）。 */
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
