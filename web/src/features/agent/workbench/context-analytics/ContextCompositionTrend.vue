<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EChartsOption } from 'echarts'
import AnalyticsChart from './AnalyticsChart.vue'
import ContextOperationList from './ContextOperationList.vue'
import { compositionTotal, groupRequestComposition, type RequestComposition, type AnalyticsOperation } from './model'
import { formatTokens } from './presentation'
const props = defineProps<{ requests: RequestComposition[]; operations: AnalyticsOperation[] }>()
const mode = ref<'step' | 'round'>('step')
const viewport = ref<HTMLElement>()
const capacity = ref(48)
let resizeObserver: ResizeObserver | undefined
onMounted(() => {
  if (!viewport.value) return
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) capacity.value = entry.contentRect.width >= 480 ? 48 : 30
  })
  resizeObserver.observe(viewport.value)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
const selected = ref(0)
const points = computed(() => groupRequestComposition(props.requests, mode.value))
const chartPoints = computed<(RequestComposition | null)[]>(() => {
  const visible = points.value.slice(-capacity.value)
  return [...Array(Math.max(0, capacity.value - visible.length)).fill(null), ...visible]
})
const point = computed(() => points.value[selected.value])
const selectedRequests = computed(() => props.requests.filter(r => mode.value === 'step' ? r.step === point.value?.step : r.round === point.value?.round))
const operations = computed(() => props.operations.filter(o => selectedRequests.value.some(r => r.step === o.step)))
const legend = computed(() => [...new Map(props.requests.flatMap(p => p.segments).map(s => [s.key, s])).values()])
const totalTokens = computed(() => props.requests.reduce((sum, row) => sum + compositionTotal(row.segments), 0))
const share = computed(() => totalTokens.value && point.value ? (compositionTotal(point.value.segments) / totalTokens.value * 100).toFixed(1) + '%' : '—')
const option = computed<EChartsOption>(() => {
  if (!points.value.length) {
    const now = Date.now()
    return {
      grid: { left: 54, right: 18, top: 36, bottom: 68 },
      tooltip: { show: false },
      xAxis: {
        type: 'time',
        min: now - 24 * 60 * 60 * 1000,
        max: now,
        name: '历史时间',
        nameLocation: 'middle',
        nameGap: 42,
        axisLabel: { fontSize: 12 },
        axisLine: { show: true },
        splitLine: { show: true, lineStyle: { opacity: 0.12 } },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 1,
        name: 'Token',
        axisLabel: { formatter: () => '0', fontSize: 12 },
        axisLine: { show: true },
        splitLine: { show: true, lineStyle: { opacity: 0.12 } },
      },
      series: [{ type: 'bar', data: [] }],
    }
  }
  return {
  legend: { top: 0, type: 'scroll', textStyle: { color: '#888', fontSize: 12 } },
  grid: { left: 12, right: 12, top: 42, bottom: 68 },
  tooltip: { trigger: 'axis', showContent: false, axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(128,128,128,0.25)' } } },
  xAxis: { type: 'category', data: chartPoints.value.map(p => p ? (mode.value === 'step' ? p.step + ' 步' : p.round + ' 轮') : ''), axisLabel: { color: '#888', fontSize: 12, hideOverlap: true }, axisTick: { show: false } },
  yAxis: { type: 'value', show: false },
  series: legend.value.map(segment => ({
    name: segment.label, type: 'bar', stack: 'input', barWidth: '92%', barCategoryGap: '8%',
    emphasis: { focus: 'none' },
    itemStyle: { color: segment.color, borderRadius: 0 },
     data: chartPoints.value.map(p => p?.segments.find(s => s.key === segment.key)?.tokens.value ?? null),
  })),
  }
})
watch(points, () => {
  selected.value = Math.max(0, points.value.length - 1)
}, { immediate: true })
function selectChartIndex(index: number): void {
  const emptyCount = Math.max(0, capacity.value - Math.min(points.value.length, capacity.value))
  const actualIndex = points.value.length - Math.min(points.value.length, capacity.value) + index - emptyCount
  if (actualIndex >= 0 && actualIndex < points.value.length) selected.value = actualIndex
}
function move(offset: number): void {
  selected.value = Math.min(points.value.length - 1, Math.max(0, selected.value + offset))
}
</script>
<template>
  <article class="composition-trend">
    <header><div><small>请求输入组成 · 估算 Token</small><h3>Token 变化</h3></div>
      <div class="mode-switch"><button type="button" :aria-pressed="mode === 'round'" @click="mode = 'round'">按轮次展示</button><button type="button" :aria-pressed="mode === 'step'" @click="mode = 'step'">按步骤展示</button></div>
    </header>
    <div ref="viewport" class="chart-scroll">
      <div style="width: 100%; height: 300px">
         <AnalyticsChart :option="option" label="按步骤或轮次排列的输入组成堆叠图" @select="selectChartIndex" />
      </div>
    </div>
    <section v-if="point" class="step-detail" aria-label="所选柱子的行为详情" style="max-height: 280px; overflow-y: auto">
      <header><h3>第 {{ point.round }} 轮{{ mode === 'step' ? ' · 第 ' + point.step + ' 步' : '' }}</h3>
        <div><button type="button" :disabled="selected === 0" @click="move(-1)">上一项</button><button type="button" :disabled="selected === points.length - 1" @click="move(1)">下一项</button></div>
      </header>
      <div class="metrics">
        <span>{{ selectedRequests.length }} / {{ requests.length }} 步 · 步数占比 {{ requests.length ? (selectedRequests.length / requests.length * 100).toFixed(1) : 0 }}%</span>
        <span>输入 {{ formatTokens(compositionTotal(point.segments)) }} Token · 占已记录输入 {{ share }}</span>
        <span>{{ operations.length }} 项操作</span>
      </div>
      <p v-for="request in selectedRequests" :key="request.step">第 {{ request.step }} 步 · {{ request.summary ?? '未保存步骤说明' }}</p>
      <div class="metrics"><span v-for="segment in point.segments" :key="segment.key">{{ segment.label }} {{ formatTokens(segment.tokens.value) }}</span></div>
      <div class="step-operations"><ContextOperationList :operations="operations" /></div>
    </section>
    <p v-if="!point" class="empty-chart-note">当前时间之前没有已保存的输入组成记录。</p>
  </article>
</template>
<style scoped>
.composition-trend { min-width: 0; padding: 16px; border: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent); }
header, .metrics, .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }header { justify-content: space-between; }
h3 { font-size: 15px; font-weight: 400; margin: 4px 0; }small, p, .metrics { font-size: 12px; line-height: 1.7; }
button { padding: 5px 8px; border: 1px solid color-mix(in srgb, var(--nx-text) 20%, transparent); background: transparent; color: inherit; font-size: 12px; cursor: pointer; }button[aria-pressed="true"] { border-color: var(--nx-cyan); color: var(--nx-cyan); }button:disabled { opacity: .4; cursor: default; }
.legend { margin: 12px 0; font-size: 12px; }.legend span { display: flex; gap: 5px; align-items: center; }.legend i { width: 8px; height: 8px; }
.chart-scroll { overflow: hidden; width: 100%; }.step-detail { margin-top: 12px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--nx-text) 15%, transparent); }.metrics { color: color-mix(in srgb, var(--nx-text) 70%, transparent); margin: 8px 0; }
.step-operations { max-height: 240px; overflow-y: auto; }
.empty-chart-note { margin-top: -34px; text-align: center; pointer-events: none; color: color-mix(in srgb, var(--nx-text) 58%, transparent); }
</style>
