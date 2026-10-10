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
  const entries: RenderedEntry[] = []
  if (args.value.role) entries.push({ key: 'role', label: '验收角色', value: args.value.role })
  if (Array.isArray(args.value.scenarios)) {
    entries.push({ key: 'scenarios', label: '验收场景', value: args.value.scenarios })
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
