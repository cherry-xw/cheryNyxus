<script setup lang="ts">
import { computed } from 'vue'
import type { GraphToolCall } from '@/application/backend/public'
import LiteFieldRows from './LiteFieldRows.vue'
import LiteBuiltinResult from './LiteBuiltinResult.vue'
import { argsRecord } from './builtinToolArgs'
import type { RenderedEntry } from './toolRendering'

const props = defineProps<{ call: GraphToolCall }>()
const args = computed(() => argsRecord(props.call.arguments))
const isStop = computed(() => props.call.name === 'stop_child')
const fields = computed<RenderedEntry[]>(() => {
  const entries: RenderedEntry[] = [
    {
      key: 'childChatId',
      label: '目标子会话',
      value: typeof args.value.childChatId === 'string' ? args.value.childChatId : '（缺失）',
    },
  ]
  if (isStop.value) {
    entries.push({
      key: 'recursive',
      label: '停止范围',
      value: args.value.recursive === true ? '目标及全部后代' : '仅目标角色',
    })
  } else {
    entries.push({
      key: 'content',
      label: '追加任务',
      value: typeof args.value.content === 'string' ? args.value.content : '（缺失）',
    })
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
