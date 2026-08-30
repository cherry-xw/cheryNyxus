<script setup lang="ts">
/**
 * ParsedArgs：审批参数结构化展示组件。
 * 从 ApprovalCard 拆出，复用 SenseCallBox 的 parseArgs 逻辑。
 * description 字段作折叠标题；其余字段作 key:value 行。解析失败 → fallback JSON pretty-print。
 */
import { computed, ref } from 'vue'
import { parseArgs } from '@/utils/parseArgs'
import { toArgumentKeyLabel } from '@/utils/approvalPresentation'
import ArgumentValue from './ArgumentValue.vue'

const props = defineProps<{
  args: unknown
  title?: string
}>()

const expanded = ref(true)

const argsParsed = computed(() => parseArgs(props.args))
const argsFallback = computed(() => argsParsed.value.fallback)
const argsEntries = computed(() => argsParsed.value.parsed?.entries ?? [])
const argsToggleLabel = computed(
  () => props.title ?? argsParsed.value.parsed?.description ?? '操作参数',
)
const hasArgs = computed(() => {
  const { parsed, fallback } = argsParsed.value
  if (parsed) return parsed.description != null || parsed.entries.length > 0
  return fallback.length > 0
})
</script>

<template>
  <div v-if="hasArgs" class="args">
    <button
      type="button"
      class="args-toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      {{ expanded ? '▾' : '▸' }} {{ argsToggleLabel }}
    </button>
    <div v-if="expanded" class="args-body">
      <div v-if="argsEntries.length" class="arg-rows">
        <div v-for="entry in argsEntries" :key="entry.key" class="arg-row">
          <span class="arg-key">{{ toArgumentKeyLabel(entry.key) }}</span>
          <span class="arg-val"><ArgumentValue :value="entry.value" :field-key="entry.key" /></span>
        </div>
      </div>
      <pre v-else-if="argsFallback" class="args-pre">{{ argsFallback }}</pre>
      <span v-else class="arg-empty">(无其他参数)</span>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.args {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.args-toggle {
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;

  &:hover {
    background: var(--surface-hover);
  }
}

.args-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 8px;
  width: 100%;
}

.arg-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.arg-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.arg-key {
  flex-shrink: 0;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 400;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}

.arg-val {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--ink) 90%, transparent);
}

.arg-empty {
  font-size: 12px;
  font-style: italic;
  color: color-mix(in srgb, var(--ink) 58%, transparent);
}

.args-pre {
  margin: 0;
  padding: 4px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: color-mix(in srgb, var(--ink) 90%, transparent);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  width: 100%;
}
</style>
