<script setup lang="ts">
/**
 * LiteSkillDetail：skill 专有内容区（精简模式详情抽屉工具链内使用）。
 * 展示 技能名 → 指令（直接全量展示，含行数）。
 * 头部（工具名/简介/风险徽章）由 LiteToolCallDetail 统一提供；层级保持扁平，不套边框背景。
 * 指令解析与树/对话视图 SkillRenderer 同源（result 中「"技能名" 技能已激活…」后的内容）。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import { argsRecord, argString } from './builtinToolArgs'

const props = defineProps<{ call: GraphToolCall; label: string }>()

const args = computed(() => argsRecord(props.call.arguments))
const paramName = computed(() => argString(args.value, 'name'))

const skillName = computed(() => {
  const match = (props.call.result ?? '').match(/"([^"]+)" 技能已激活/)
  return match?.[1] ?? paramName.value
})
const instructions = computed(() => {
  const text = props.call.result ?? ''
  const match = text.match(/"([^"]+)" 技能已激活[^\n]*\n\n([\s\S]*)$/)
  if (match && match[2]) return match[2].trim()
  return ''
})
const lineCount = computed(() => (instructions.value ? instructions.value.split('\n').length : 0))
</script>

<template>
  <div class="lite-bt">
    <div v-if="skillName" class="lite-bt-row">
      <span class="lite-bt-label">技能</span>
      <span class="lite-bt-value">{{ skillName }}</span>
    </div>
    <template v-if="instructions">
      <div class="lite-bt-row">
        <span class="lite-bt-label">指令</span>
        <span class="lite-bt-chip">{{ lineCount }} 行</span>
      </div>
      <pre class="lite-bt-pre">{{ instructions }}</pre>
    </template>
  </div>
</template>

<style scoped>
/* 与其余内置工具一致的扁平字段行/代码块（层级保持扁平）。 */
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
