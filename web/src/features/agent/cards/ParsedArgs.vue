<script setup lang="ts">
/**
 * ParsedArgs：审批参数结构化展示组件。
 * 从 ApprovalCard 拆出，复用 SenseCallBox 的 parseArgs 逻辑。
 * description 字段作折叠标题；其余字段作 key:value 行。解析失败 → fallback JSON pretty-print。
 */
import { computed, ref } from 'vue'
import { formatArgValue, parseArgs } from '@/utils/parseArgs'

const props = defineProps<{
  args: unknown
}>()

const expanded = ref(true)

const argsParsed = computed(() => parseArgs(props.args))
const argsFallback = computed(() => argsParsed.value.fallback)
const argsEntries = computed(() => argsParsed.value.parsed?.entries ?? [])
const argsToggleLabel = computed(() => argsParsed.value.parsed?.description ?? 'arguments')
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
          <span class="arg-key">{{ entry.key }}:</span>
          <span class="arg-val">{{ formatArgValue(entry.value) }}</span>
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
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  font-size: 9px;
  font-weight: 700;
  cursor: pointer;

  &:hover {
    background: var(--surface-hover);
  }
}

.args-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 4px;
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
  font-size: 9px;
  font-weight: 700;
  color: color-mix(in srgb, var(--ink) 60%, transparent);
}

.arg-val {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--ink) 82%, transparent);
  max-height: 80px;
  overflow: auto;
}

.arg-empty {
  font-size: 9px;
  font-style: italic;
  color: color-mix(in srgb, var(--ink) 44%, transparent);
}

.args-pre {
  margin: 0;
  padding: 3px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: color-mix(in srgb, var(--ink) 82%, transparent);
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 9px;
  font-weight: 500;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 80px;
  overflow: auto;
  width: 100%;
}
</style>
