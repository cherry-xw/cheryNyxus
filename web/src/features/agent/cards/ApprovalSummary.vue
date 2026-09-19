<script setup lang="ts">
import { computed } from 'vue'
import { createApprovalPresentation } from '@/utils/approvalPresentation'

const props = withDefaults(
  defineProps<{
    senseName: unknown
    args: unknown
    compact?: boolean
  }>(),
  { compact: false },
)

const presentation = computed(() => createApprovalPresentation(props.senseName, props.args))
</script>

<template>
  <section
    class="approval-summary"
    :class="{ 'is-compact': compact }"
    :aria-label="presentation.title"
  >
    <h3>{{ presentation.title }}</h3>
    <dl>
      <div>
        <dt>能力</dt>
        <dd>{{ presentation.toolLabel }}</dd>
      </div>
      <div>
        <dt>行为</dt>
        <dd>{{ presentation.operationLabel }}</dd>
      </div>
      <div v-if="presentation.target">
        <dt>对象</dt>
        <dd>{{ presentation.target }}</dd>
      </div>
      <div
        v-for="change in presentation.changes"
        :key="`${change.label}:${change.detail}`"
        class="change"
      >
        <dt>{{ change.label }}</dt>
        <dd>{{ change.detail }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped lang="less">
.approval-summary {
  display: grid;
  gap: 5px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, #d88a26 32%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}
.approval-summary h3 {
  margin: 0;
  color: var(--ink);
  font-size: 16px;
  line-height: 1.4;
}
.approval-summary dl {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 14px;
  margin: 0;
}
.approval-summary dl > div {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 4px;
}
.approval-summary dt {
  flex-shrink: 0;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 13px;
  line-height: 1.4;
}
.approval-summary dd {
  margin: 0;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  font-size: 14px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.approval-summary .change {
  flex-basis: 100%;
}
.approval-summary.is-compact {
  padding: 7px 8px;
}
</style>
