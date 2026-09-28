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
    <!-- 关键信息：该工具类型需要重点核对的内容（优先、放大强调）；未定义时回退通用能力/行为/对象 -->
    <dl v-if="presentation.keyFacts.length" class="key-facts">
      <div v-for="fact in presentation.keyFacts" :key="fact.label" class="key-fact">
        <dt>{{ fact.label }}</dt>
        <dd>{{ fact.value }}</dd>
      </div>
    </dl>
    <dl v-else class="generic-facts">
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
    <dl v-if="presentation.changes.length" class="change-facts">
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
  font-weight: 400; /* 非加粗：标题由字号/边框承担层级，字重保持 400 */
}
/* 关键信息：核心核对项，值字号更大、实色更强，纵向逐行排列突出权重 */
.key-facts {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 6px 0 0;
}
.key-fact {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.key-fact dt {
  flex-shrink: 0;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 13px;
  line-height: 1.4;
  font-weight: 400; /* 非加粗：标签行不加重 */
}
.key-fact dd {
  margin: 0;
  color: var(--ink);
  font-size: 15px;
  line-height: 1.45;
  overflow-wrap: anywhere;
  font-weight: 400; /* 非加粗：关键值由字号/实色承担强调 */
}
/* 通用回退（未定义关键信息的工具）：能力/行为/对象 */
.generic-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 14px;
  margin: 4px 0 0;
}
.generic-facts > div,
.change-facts > div {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 4px;
}
.generic-facts dt,
.change-facts dt {
  flex-shrink: 0;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 13px;
  line-height: 1.4;
  font-weight: 400; /* 非加粗：标签行不加重 */
}
.generic-facts dd,
.change-facts dd {
  margin: 0;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  font-size: 14px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  font-weight: 400; /* 非加粗：对象/行为正文不加重 */
}
.change-facts {
  margin: 4px 0 0;
}
.change-facts .change {
  flex-basis: 100%;
}
.approval-summary.is-compact {
  padding: 7px 8px;
}
</style>
