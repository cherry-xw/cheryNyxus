<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EChartsOption } from 'echarts'
import AnalyticsChart from './AnalyticsChart.vue'
import { compositionTotal, groupRequestComposition, type RequestComposition, type AnalyticsOperation } from './model'
import { formatDuration, formatTokens } from './presentation'
const props = defineProps<{ requests: RequestComposition[]; operations: AnalyticsOperation[]; height?: number }>()
const kindLabel = (kind: AnalyticsOperation['kind']): string =>
  ({ command: '指令', read: '读取', write: '写入', search: '搜索', compression: '压缩' })[kind]
const mode = ref<'step' | 'round'>('step')
const viewport = ref<HTMLElement>()
const capacity = ref(24)
let resizeObserver: ResizeObserver | undefined
onMounted(() => {
  if (!viewport.value) return
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) {
      const plotWidth = Math.max(0, entry.contentRect.width - 24)
      capacity.value = Math.max(1, Math.floor((plotWidth + 4) / (12 + 4)))
    }
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
const opsByStep = computed(() => {
  const map = new Map<number, AnalyticsOperation[]>()
  for (const operation of props.operations) {
    const list = map.get(operation.step)
    if (list) list.push(operation)
    else map.set(operation.step, [operation])
  }
  return map
})
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
  legend: { top: 0, type: 'scroll', icon: 'rect', itemWidth: 10, itemHeight: 10, textStyle: { color: '#888', fontSize: 12 } },
  grid: { left: 12, right: 12, top: 36, bottom: 56 },
  tooltip: { trigger: 'axis', showContent: false, axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(128,128,128,0.25)' } } },
  xAxis: { type: 'category', data: chartPoints.value.map(p => p ? (mode.value === 'step' ? p.step + ' 步' : p.round + ' 轮') : ''), axisLabel: { color: '#888', fontSize: 12, hideOverlap: true }, axisTick: { show: false } },
  yAxis: { type: 'value', show: false },
  series: legend.value.map(segment => ({
    name: segment.label, type: 'bar', stack: 'input', barWidth: 12, barCategoryGap: 4,
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
  <article class="composition-trend" :style="{ height: height != null ? height + 'px' : undefined }">
    <header><div><small>请求输入组成 · 估算 Token</small><h3>Token 变化</h3></div>
      <div class="mode-switch"><button type="button" :aria-pressed="mode === 'round'" @click="mode = 'round'">按轮次展示</button><button type="button" :aria-pressed="mode === 'step'" @click="mode = 'step'">按步骤展示</button></div>
    </header>
    <div ref="viewport" class="chart-scroll">
      <div style="width: 100%; height: 220px">
         <AnalyticsChart :option="option" label="按步骤或轮次排列的输入组成堆叠图" @select="selectChartIndex" />
      </div>
    </div>
    <section v-if="point" class="step-detail" aria-label="所选柱子的行为详情">
      <header><h3>第 {{ point.round }} 轮{{ mode === 'step' ? ' · 第 ' + point.step + ' 步' : '' }}</h3>
        <div><button type="button" :disabled="selected === 0" @click="move(-1)">上一项</button><button type="button" :disabled="selected === points.length - 1" @click="move(1)">下一项</button></div>
      </header>
      <div class="metrics">
        <span>{{ selectedRequests.length }} / {{ requests.length }} 步 · 步数占比 {{ requests.length ? (selectedRequests.length / requests.length * 100).toFixed(1) : 0 }}%</span>
        <span>输入 {{ formatTokens(compositionTotal(point.segments)) }} Token · 占已记录输入 {{ share }}</span>
        <span>{{ operations.length }} 项操作</span>
      </div>
      <template v-if="mode === 'round'">
        <div v-for="request in selectedRequests" :key="request.step" class="round-step">
          <div class="request-row">
            <span class="request-head">第 {{ request.step }} 步</span>
            <span v-if="request.modelName" class="request-model">{{ request.modelName }}</span>
            <span v-for="segment in request.segments" :key="segment.key" class="segment">
              <i :style="{ background: segment.color }" />{{ segment.label }} {{ formatTokens(segment.tokens.value) }}
            </span>
          </div>
          <div v-if="opsByStep.get(request.step)?.length" class="step-tools">
            <span class="step-tools-label">工具</span>
            <span v-for="op in opsByStep.get(request.step)" :key="op.id" class="tool-chip">
              <b>{{ kindLabel(op.kind) }}</b>{{ op.toolName }}<em>{{ formatDuration(op.durationMs) }}</em>
            </span>
          </div>
        </div>
      </template>
      <template v-else>
        <div class="step-composition" aria-label="该步骤的上下文构成明细">
          <div v-for="segment in point.segments" :key="segment.key" class="comp-row">
            <span class="comp-label"><i :style="{ background: segment.color }" />{{ segment.label }}</span>
            <span class="comp-value">{{ formatTokens(segment.tokens.value) }}</span>
          </div>
        </div>
        <div v-if="point.modelName" class="step-model"><span>模型</span>{{ point.modelName }}</div>
        <div v-if="opsByStep.get(point.step)?.length" class="step-tools">
          <span class="step-tools-label">工具</span>
          <span v-for="op in opsByStep.get(point.step)" :key="op.id" class="tool-chip">
            <b>{{ kindLabel(op.kind) }}</b>{{ op.toolName }}<em>{{ formatDuration(op.durationMs) }}</em>
          </span>
        </div>
      </template>
    </section>
    <p v-if="!point" class="empty-chart-note">当前时间之前没有已保存的输入组成记录。</p>
  </article>
</template>
<style scoped>
.composition-trend { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 16px; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent); }
header, .metrics, .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }header { justify-content: space-between; }
h3 { font-size: 15px; font-weight: 400; margin: 4px 0; }small, p, .metrics { font-size: 12px; line-height: 1.45; }
button { padding: 5px 8px; border: 1px solid color-mix(in srgb, var(--nx-text) 20%, transparent); background: transparent; color: inherit; font-size: 12px; cursor: pointer; }button[aria-pressed="true"] { border-color: var(--nx-cyan); color: var(--nx-cyan); }button:disabled { opacity: .4; cursor: default; }
.legend { margin: 12px 0; font-size: 12px; }.legend span { display: flex; gap: 5px; align-items: center; }.legend i { width: 8px; height: 8px; }
.chart-scroll { overflow: hidden; width: 100%; }
.step-detail { flex: 1; min-height: 0; overflow-y: auto; margin-top: 12px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--nx-text) 15%, transparent); }
.metrics { color: color-mix(in srgb, var(--nx-text) 70%, transparent); margin: 4px 0; }
.round-step { margin: 6px 0; padding-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 10%, transparent); }
.round-step:last-child { border-bottom: 0; }
.request-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.request-head { white-space: nowrap; }
.request-model { color: color-mix(in srgb, var(--nx-text) 82%, transparent); white-space: nowrap; }
.segment { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.segment i { width: 8px; height: 8px; border-radius: 2px; }
.step-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 6px; margin: 4px 0 0 18px; }
.step-tools-label { color: color-mix(in srgb, var(--nx-text) 50%, transparent); font-size: 12px; }
.tool-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid color-mix(in srgb, var(--nx-text) 16%, transparent); border-radius: 999px; font-size: 12px; line-height: 1.5; }
.tool-chip b { font-weight: 400; color: var(--nx-cyan); }
.tool-chip em { font-style: normal; color: color-mix(in srgb, var(--nx-text) 58%, transparent); }
.step-composition { display: grid; gap: 2px; margin: 6px 0; }
.comp-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; padding: 2px 0; }
.comp-label { display: inline-flex; align-items: center; gap: 6px; }
.comp-label i { width: 8px; height: 8px; border-radius: 2px; }
.comp-value { font: 13px/1.5 var(--font-mono); }
.step-model { display: flex; gap: 6px; font-size: 12px; margin: 4px 0; }
.step-model span { color: color-mix(in srgb, var(--nx-text) 50%, transparent); }
.empty-chart-note { margin-top: -34px; text-align: center; pointer-events: none; color: color-mix(in srgb, var(--nx-text) 58%, transparent); }
</style>
