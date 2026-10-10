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
  if (args.value.phase === 'stage') {
    const entries: RenderedEntry[] = [{ key: 'phase', label: '步骤', value: '获取并检查技能来源' }]
    if (args.value.url) entries.push({ key: 'url', label: '来源链接', value: args.value.url })
    if (args.value.branch) entries.push({ key: 'branch', label: '分支', value: args.value.branch })
    return entries
  }
  const entries: RenderedEntry[] = [{ key: 'phase', label: '步骤', value: '安装已确认的技能' }]
  if (args.value.stagingId) {
    entries.push({ key: 'stagingId', label: '暂存编号', value: args.value.stagingId })
  }
  if (args.value.selections !== undefined) {
    entries.push({ key: 'selections', label: '安装选择', value: args.value.selections })
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
