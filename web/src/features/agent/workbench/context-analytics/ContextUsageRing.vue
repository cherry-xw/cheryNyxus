<script setup lang="ts">
import { computed } from 'vue'
import type { EChartsOption } from 'echarts'
import AnalyticsChart from './AnalyticsChart.vue'
import { compositionTotal, contextOccupancy, type ContextSnapshotView } from './model'
import { formatTokens } from './presentation'
const props = withDefaults(defineProps<{ snapshot: ContextSnapshotView; size?: 'large' | 'small'; legend?: boolean }>(), { size: 'small', legend: false })
const occupancy = computed(() => contextOccupancy(props.snapshot))
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}
function tooltipContent(params: unknown): string {
  const item = (Array.isArray(params) ? params[0] : params) as {
    name?: string
    value?: unknown
    color?: unknown
  }
  const name = item.name ?? '未分类'
  const value = typeof item.value === 'number' ? item.value : Number(item.value ?? 0)
  const markerColor = typeof item.color === 'string' ? item.color : 'currentColor'
  const total = props.snapshot.limitTokens ?? compositionTotal(props.snapshot.segments)
  const percent = total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '占比未知'
  const summary = props.snapshot.limitTokens
    ? `上下文窗口 ${formatTokens(props.snapshot.usedTokens.value)} / ${formatTokens(props.snapshot.limitTokens)} Token`
    : `已记录上下文 ${formatTokens(props.snapshot.usedTokens.value)} Token · 上限未知`
  return `<div style="min-width:190px;font-weight:400"><div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><i style="display:inline-block;width:8px;height:8px;background:${markerColor}"></i><span>${escapeHtml(name)}</span></div><div>${formatTokens(value)} Token · ${percent}</div><div style="margin-top:6px;opacity:.72">${summary}</div></div>`
}
const option = computed<EChartsOption>(() => ({
  legend: { show: props.legend, orient: 'vertical', right: 0, top: 'center', textStyle: { fontSize: 12 }, data: props.snapshot.segments.map(s => s.label) },
  tooltip: { trigger: 'item', renderMode: 'html', confine: true, formatter: tooltipContent },
  series: [{
    type: 'pie', center: props.legend ? ['25%', '50%'] : ['50%', '50%'], radius: props.legend ? [48, 64] : ['65%', '85%'], label: { show: false }, emphasis: { scale: true, scaleSize: 6 },
    data: [
      ...props.snapshot.segments.filter(s => s.tokens.value !== null).map(s => ({ name: s.label, value: s.tokens.value!, itemStyle: { color: s.color } })),
      ...(props.snapshot.limitTokens ? [{ name: '剩余窗口', value: Math.max(0, props.snapshot.limitTokens - compositionTotal(props.snapshot.segments)), itemStyle: { color: '#80808028' } }] : []),
    ],
  }],
}))
</script>
<template>
  <div class="ring" :class="[size, { 'with-legend': legend }]">
    <AnalyticsChart :option="option" :label="'当前上下文 ' + formatTokens(snapshot.usedTokens.value) + ' Token'" />
    <div class="center"><span>{{ occupancy === null ? '上限未知' : occupancy.toFixed(0) + '%' }}</span><small>{{ formatTokens(snapshot.usedTokens.value) }}</small></div>
  </div>
</template>
<style scoped>
.ring { position: relative; flex: none; width: 92px; height: 92px; }.ring.large { width: 150px; height: 150px; }
.center { position: absolute; inset: 25%; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; font-size: 13px; font-weight: 400; }
.ring.with-legend { width: 100%; height: 180px; }
.with-legend .center { inset: 25% 60% 25% 10%; }
small { font-size: 12px; margin-top: 4px; }
</style>
