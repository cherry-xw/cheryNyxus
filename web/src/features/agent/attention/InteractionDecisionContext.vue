<script setup lang="ts">
import { computed } from 'vue'
import type { InteractionRecord } from '@/application/backend/public'

const props = defineProps<{ item: InteractionRecord }>()

const context = computed(() => {
  const value = props.item.payload?.context
  return value && typeof value === 'object' ? (value as Record<string, string>) : {}
})
</script>

<template>
  <dl v-if="Object.keys(context).length" class="decision-context">
    <div v-if="context.taskGoal">
      <dt>任务目标</dt>
      <dd>{{ context.taskGoal }}</dd>
    </div>
    <div v-if="context.agent">
      <dt>Agent 角色</dt>
      <dd>{{ context.agent }}</dd>
    </div>
    <div v-if="context.rationale">
      <dt>为什么需要你决定</dt>
      <dd>{{ context.rationale }}</dd>
    </div>
    <div v-if="context.nextStep">
      <dt>决定后会发生什么</dt>
      <dd>{{ context.nextStep }}</dd>
    </div>
  </dl>
</template>

<style scoped lang="less">
.decision-context {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  > div {
    min-width: 0;
    padding: 12px;
    border-left: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    background: var(--surface-soft);
  }
  dt {
    margin-bottom: 6px;
    color: color-mix(in srgb, var(--ink) 65%, transparent);
    font-size: 12px;
    font-weight: 400;
    line-height: 1.5;
  }
  dd {
    margin: 0;
    color: var(--ink);
    font-size: 13px;
    font-weight: 400;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
}
@media (max-width: 720px) {
  .decision-context {
    grid-template-columns: 1fr;
  }
}
</style>
