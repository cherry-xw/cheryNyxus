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
    <div class="approval-badges">
      <span class="actor">{{ presentation.actorLabel }}</span>
      <span class="approval">{{ presentation.approvalLabel }}</span>
    </div>
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
    </dl>
    <p v-if="!compact">{{ presentation.summary }}</p>
  </section>
</template>

<style scoped lang="less">
.approval-summary {
  display: grid;
  gap: 6px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid color-mix(in srgb, #d88a26 32%, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, #f6b73c 8%, var(--surface));
}
.approval-summary h3 {
  margin: 0;
  color: var(--ink);
  font-size: 14px;
  line-height: 1.35;
}
.approval-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.approval-badges span {
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.25;
}
.approval-badges .actor {
  background: color-mix(in srgb, var(--el-color-primary) 14%, var(--surface));
  color: color-mix(in srgb, var(--el-color-primary) 82%, var(--ink));
}
.approval-badges .approval {
  background: color-mix(in srgb, #f6b73c 18%, var(--surface));
  color: color-mix(in srgb, #9a5b00 82%, var(--ink));
}
.approval-summary dl {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
}
.approval-summary dl > div {
  display: flex;
  min-width: 0;
  gap: 4px;
}
.approval-summary dt {
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 11px;
}
.approval-summary dd {
  margin: 0;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.approval-summary p {
  margin: 0;
  color: color-mix(in srgb, var(--ink) 72%, transparent);
  font-size: 12px;
  line-height: 1.45;
}
.approval-summary.is-compact {
  padding: 7px 8px;
}
</style>
