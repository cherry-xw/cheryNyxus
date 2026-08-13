<script setup lang="ts">
import type { FieldView } from '../graph/toolArgumentFields'

defineOptions({ name: 'ToolFieldTree' })
defineProps<{ fields: readonly FieldView[] }>()
</script>

<template>
  <dl class="tool-field-tree">
    <div
      v-for="field in fields"
      :key="field.key"
      class="tool-field"
      :class="[`is-${field.kind}`, { 'has-children': field.children?.length }]"
    >
      <dt>
        <span>{{ field.label }}</span>
        <small v-if="field.kind === 'group' || field.kind === 'list'">{{ field.value }}</small>
      </dt>
      <dd v-if="field.children?.length">
        <ToolFieldTree :fields="field.children" />
      </dd>
      <dd v-else-if="field.kind === 'boolean'">
        <span class="boolean-value" :class="{ 'is-true': field.value === '是' }" aria-hidden="true">
          <i />
        </span>
        <span>{{ field.value }}</span>
      </dd>
      <dd v-else>
        <code v-if="field.kind === 'command' || field.kind === 'path' || field.kind === 'url'">
          {{ field.value }}
        </code>
        <pre v-else-if="field.kind === 'multiline'">{{ field.value }}</pre>
        <span v-else>{{ field.value }}</span>
      </dd>
    </div>
  </dl>
</template>

<style scoped lang="less">
.tool-field-tree {
  display: grid;
  gap: 6px;
  min-width: 0;
  margin: 0;
}
.tool-field {
  min-width: 0;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  background: color-mix(in srgb, currentColor 3%, transparent);
}
.tool-field > dt {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  color: var(--field-accent, currentColor);
  font-size: 9px;
  font-weight: 850;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.tool-field > dt small {
  flex: 0 0 auto;
  opacity: 0.55;
  font-size: 8px;
}
.tool-field > dd {
  min-width: 0;
  margin: 4px 0 0;
  color: inherit;
  font-size: 10px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.tool-field.has-children > dd {
  margin-top: 7px;
}
.tool-field :deep(.tool-field) {
  border-left-width: 2px;
  background: color-mix(in srgb, currentColor 2%, transparent);
}
.tool-field code,
.tool-field pre {
  margin: 0;
  color: inherit;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tool-field.is-command code,
.tool-field.is-path code,
.tool-field.is-url code {
  font-family: ui-monospace, 'Cascadia Mono', monospace;
}
.tool-field.is-command code::before {
  content: '$ ';
  opacity: 0.6;
}
.tool-field.is-boolean > dd {
  display: flex;
  align-items: center;
  gap: 6px;
}
.boolean-value {
  position: relative;
  width: 24px;
  height: 13px;
  border: 1px solid currentColor;
  border-radius: 999px;
  opacity: 0.55;
}
.boolean-value i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}
.boolean-value.is-true {
  opacity: 1;
}
.boolean-value.is-true i {
  transform: translateX(11px);
}
</style>
