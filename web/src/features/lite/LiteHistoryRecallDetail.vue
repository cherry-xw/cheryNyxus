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
  const action = args.value.action === 'list_generations' ? '查看代际目录' : '搜索历史消息'
  const entries: RenderedEntry[] = [{ key: 'action', label: '操作', value: action }]
  const labels: Record<string, string> = {
    query: '关键词',
    generation: '限定代际',
    role: '限定角色',
    limit: '命中上限',
  }
  for (const key of ['query', 'generation', 'role', 'limit']) {
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
