<script setup lang="ts">
import { computed } from 'vue'
import { formatApprovalArgumentScalar, toArgumentKeyLabel } from '@/utils/approvalPresentation'

defineOptions({ name: 'ArgumentValue' })

const props = withDefaults(
  defineProps<{
    value: unknown
    fieldKey?: string
    depth?: number
  }>(),
  { fieldKey: '', depth: 0 },
)

const isArray = computed(() => Array.isArray(props.value))
const arrayItems = computed(() => (Array.isArray(props.value) ? props.value : []))
const objectEntries = computed(() => {
  if (!props.value || typeof props.value !== 'object' || Array.isArray(props.value)) return []
  return Object.entries(props.value as Record<string, unknown>)
})
const isObject = computed(
  () => !!props.value && typeof props.value === 'object' && !Array.isArray(props.value),
)
const scalar = computed(() => formatApprovalArgumentScalar(props.fieldKey, props.value))
</script>

<template>
  <ol v-if="isArray" class="argument-list">
    <li v-for="(item, index) in arrayItems" :key="index">
      <ArgumentValue :value="item" :depth="depth + 1" />
    </li>
    <li v-if="!arrayItems.length" class="argument-empty">空列表</li>
  </ol>
  <dl v-else-if="isObject" class="argument-object">
    <div
      v-for="([key, item], index) in objectEntries"
      :key="`${key}-${index}`"
      class="argument-field"
    >
      <dt>{{ toArgumentKeyLabel(key) }}</dt>
      <dd><ArgumentValue :value="item" :field-key="key" :depth="depth + 1" /></dd>
    </div>
    <div v-if="!objectEntries.length" class="argument-empty">空对象</div>
  </dl>
  <span v-else class="argument-scalar">{{ scalar }}</span>
</template>

<style scoped lang="less">
.argument-list,
.argument-object {
  margin: 0;
  padding-left: 18px;
}
.argument-list {
  display: grid;
  gap: 4px;
}
.argument-object {
  display: grid;
  gap: 5px;
  padding-left: 0;
}
.argument-field {
  min-width: 0;
  padding: 5px 7px;
  border-left: 2px solid color-mix(in srgb, var(--el-color-primary) 35%, var(--border));
  border-radius: 0 5px 5px 0;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
}
.argument-field dt {
  margin-bottom: 2px;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 11px;
}
.argument-field dd {
  margin: 0;
}
.argument-scalar {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.argument-empty {
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-style: italic;
}
</style>
