<script setup lang="ts">
/**
 * LiteRoleDetail：spawn_role 专有内容区（精简模式详情抽屉工具链内使用）。
 * 展示 角色 → 任务说明 → 唤醒策略。
 * 头部（工具名/简介/风险徽章）由 LiteToolCallDetail 统一提供；层级保持扁平，不套边框背景。
 * 精简模式无子会话抽屉下钻机制，故不展示内部 chatId（对用户无意义）。
 */
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import { argsRecord, argString } from './builtinToolArgs'

const props = defineProps<{ call: GraphToolCall; label: string }>()

const args = computed(() => argsRecord(props.call.arguments))
const type = computed(() => argString(args.value, 'type', 'role'))
const prompt = computed(() => argString(args.value, 'prompt', '任务'))
const wake = computed(() => argString(args.value, 'wake'))

const WAKE_LABEL: Record<string, string> = {
  immediate: '立即唤醒',
  deferred: '暂存不唤醒',
  barrier: '等待全部完成',
}
const wakeText = computed(() => (wake.value ? (WAKE_LABEL[wake.value] ?? wake.value) : ''))
</script>

<template>
  <div class="lite-bt">
    <div v-if="type" class="lite-bt-row">
      <span class="lite-bt-label">角色</span>
      <code class="lite-bt-code">{{ type }}</code>
    </div>
    <div v-if="prompt" class="lite-bt-row">
      <span class="lite-bt-label">任务</span>
      <span class="lite-bt-value">{{ prompt }}</span>
    </div>
    <div v-if="wakeText" class="lite-bt-row">
      <span class="lite-bt-label">唤醒</span>
      <span class="lite-bt-value">{{ wakeText }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 与其余内置工具一致的扁平字段行（层级保持扁平）。 */
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
</style>
