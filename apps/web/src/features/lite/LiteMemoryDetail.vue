<script setup lang="ts">
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import LiteFieldRows from './LiteFieldRows.vue'
import LiteBuiltinResult from './LiteBuiltinResult.vue'
import { argsRecord } from './builtinToolArgs'
import type { RenderedEntry } from './toolRendering'

const props = defineProps<{ call: GraphToolCall }>()
const args = computed(() => argsRecord(props.call.arguments))
const actionLabels: Record<string, string> = {
  add: '添加记忆',
  remove: '删除记忆',
  update: '更新记忆',
  list: '查看活跃记忆',
  history: '查看历史记忆',
}
const fields = computed<RenderedEntry[]>(() => {
  const entries: RenderedEntry[] = [
    {
      key: 'action',
      label: '操作',
      value: actionLabels[String(args.value.action)] ?? args.value.action ?? '（缺失）',
    },
  ]
  const labels: Record<string, string> = {
    scope: '作用范围',
    name: '记忆名称',
    type: '分类',
    description: '说明',
    content: '正文',
    replaceTarget: '淘汰记忆',
    replaceReason: '淘汰原因',
    reason: '删除原因',
  }
  for (const key of Object.keys(labels)) {
    const value = args.value[key]
    if (value !== undefined && value !== null && value !== '') {
      entries.push({ key, label: labels[key]!, value })
    }
  }
  return entries
})
</script>

<template>
  <div class="lite-builtin-detail">
    <LiteFieldRows :entries="fields" />
    <LiteBuiltinResult :call="call" />
  </div>
</template>

<style scoped>
.lite-builtin-detail {
  display: grid;
  gap: 8px;
  min-width: 0;
}
</style>
