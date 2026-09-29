<script setup lang="ts">
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import LiteFieldRows from './LiteFieldRows.vue'
import LiteBuiltinResult from './LiteBuiltinResult.vue'
import { argsRecord } from './builtinToolArgs'
import type { RenderedEntry } from './toolRendering'

const props = defineProps<{ call: GraphToolCall }>()
const args = computed(() => argsRecord(props.call.arguments))
const fields = computed<RenderedEntry[]>(() => {
  const target = args.value.chatId === null ? '新建会话' : args.value.chatId
  const entries: RenderedEntry[] = [
    {
      key: 'chatId',
      label: '选择目标',
      value: target ?? '（缺失）',
    },
  ]
  if (typeof args.value.confidence === 'number') {
    entries.push({
      key: 'confidence',
      label: '判断把握',
      value: `${Math.round(args.value.confidence * 100)}%`,
    })
  }
  if (typeof args.value.reason === 'string') {
    entries.push({ key: 'reason', label: '选择理由', value: args.value.reason })
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
