<script setup lang="ts">
import { computed } from 'vue'
import type { EChartsOption } from 'echarts'
import AnalyticsChart from './AnalyticsChart.vue'
import { compositionTotal, type ContextSnapshotView } from './model'
const props = defineProps<{ snapshot: ContextSnapshotView }>()
const option = computed<EChartsOption>(() => ({
  grid: { left: 0, right: 0, top: 0, bottom: 0 },
  xAxis: { type: 'value', show: false, max: props.snapshot.limitTokens ?? Math.max(1, compositionTotal(props.snapshot.segments)) },
  yAxis: { type: 'category', show: false, data: ['上下文'] },
  tooltip: { trigger: 'item', renderMode: 'richText', formatter: '{a}: {c} Token' },
  series: props.snapshot.segments.map(s => ({ name: s.label, type: 'bar', stack: 'context', barWidth: 12, data: [s.tokens.value], itemStyle: { color: s.color } })),
}))
</script>
<template><div class="composition-bar"><AnalyticsChart :option="option" label="当前上下文组成" /></div></template>
<style scoped>.composition-bar { height: 20px; width: 100%; background: color-mix(in srgb, var(--nx-text) 7%, transparent); }</style>
