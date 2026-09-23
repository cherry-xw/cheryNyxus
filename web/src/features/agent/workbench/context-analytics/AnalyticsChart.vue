<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { init, use, type EChartsType } from 'echarts/core'
import { BarChart, CustomChart, HeatmapChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  AriaComponent,
  CalendarComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts'
use([
  BarChart,
  CustomChart,
  HeatmapChart,
  ScatterChart,
  PieChart,
  AriaComponent,
  CalendarComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  VisualMapComponent,
  CanvasRenderer,
])
const props = defineProps<{ option: EChartsOption; label: string; selectedIndex?: number; selectOnHover?: boolean }>()
const emit = defineEmits<{ select: [index: number] }>()
const host = ref<HTMLElement>()
let chart: EChartsType | undefined
let observer: ResizeObserver | undefined
function highlight(): void {
  chart?.dispatchAction({ type: 'downplay' })
  if (props.selectedIndex !== undefined)
    chart?.dispatchAction({ type: 'highlight', dataIndex: props.selectedIndex })
}
function update(): void {
  if (!host.value) return
  const styles = getComputedStyle(host.value)
  const color = styles.color
  const surface = styles.getPropertyValue('--nx-bg').trim() || styles.backgroundColor
  const border = styles.getPropertyValue('--nx-border-soft').trim() || color
  const configuredTooltip =
    props.option.tooltip && !Array.isArray(props.option.tooltip)
      ? (props.option.tooltip as Record<string, unknown>)
      : {}
  const configuredTooltipText =
    configuredTooltip.textStyle && typeof configuredTooltip.textStyle === 'object'
      ? (configuredTooltip.textStyle as Record<string, unknown>)
      : {}
  const normalizeAxis = (axis: unknown): unknown => {
    const normalizeOne = (value: unknown) => {
      if (!value || typeof value !== 'object') return value
      const source = value as Record<string, unknown>
      const axisLabel = source.axisLabel && typeof source.axisLabel === 'object'
        ? (source.axisLabel as Record<string, unknown>)
        : {}
      const nameTextStyle = source.nameTextStyle && typeof source.nameTextStyle === 'object'
        ? (source.nameTextStyle as Record<string, unknown>)
        : {}
      return {
        ...source,
        axisLabel: { color, ...axisLabel },
        nameTextStyle: { color, ...nameTextStyle },
      }
    }
    return Array.isArray(axis) ? axis.map(normalizeOne) : normalizeOne(axis)
  }
  const configuredLegend =
    props.option.legend && !Array.isArray(props.option.legend)
      ? (props.option.legend as Record<string, unknown>)
      : undefined
  const configuredLegendText =
    configuredLegend?.textStyle && typeof configuredLegend.textStyle === 'object'
      ? (configuredLegend.textStyle as Record<string, unknown>)
      : {}
  chart?.setOption({
    ...props.option,
    ...(configuredLegend
      ? { legend: { ...configuredLegend, textStyle: { color, ...configuredLegendText } } }
      : {}),
    ...(props.option.xAxis ? { xAxis: normalizeAxis(props.option.xAxis) } : {}),
    ...(props.option.yAxis ? { yAxis: normalizeAxis(props.option.yAxis) } : {}),
    tooltip: {
      backgroundColor: surface,
      borderColor: border,
      borderWidth: 1,
      padding: 10,
      confine: true,
      extraCssText: 'max-width:320px;white-space:normal;line-height:1.55;box-shadow:none;font-weight:400;',
      ...configuredTooltip,
      textStyle: { color, fontSize: 12, fontWeight: 400, ...configuredTooltipText },
    },
    textStyle: { color, fontSize: 12, fontWeight: 400 },
    animation: false,
  }, { notMerge: true })
  highlight()
}
onMounted(() => {
  if (!host.value) return
  chart = init(host.value, undefined, { renderer: 'canvas' })
  chart.on('mouseover', (event) => {
    if (typeof event.dataIndex === 'number') {
      if (props.selectOnHover !== false) emit('select', event.dataIndex)
      if (props.selectedIndex !== undefined) void nextTick(highlight)
    }
  })
  chart.on('mouseout', () => { if (props.selectedIndex !== undefined) void nextTick(highlight) })
  chart.on('click', (event) => {
    const params = event as { dataIndex?: unknown; offsetX?: unknown; offsetY?: unknown }
    let index: number | undefined = typeof params.dataIndex === 'number' ? params.dataIndex : undefined
    if (index === undefined && typeof params.offsetX === 'number' && typeof params.offsetY === 'number') {
      const converted = chart?.convertFromPixel({ gridIndex: 0 }, [params.offsetX, params.offsetY])
      const candidate = Array.isArray(converted) ? Number(converted[0]) : NaN
      if (Number.isFinite(candidate) && candidate >= 0) index = Math.round(candidate)
    }
    if (index !== undefined) emit('select', index)
  })
  observer = new ResizeObserver(() => { chart?.resize() })
  observer.observe(host.value)
  update()
})
watch(() => props.option, update, { deep: true })
watch(() => props.selectedIndex, highlight)
onBeforeUnmount(() => { observer?.disconnect(); chart?.dispose() })
</script>
<template><div ref="host" class="analytics-chart" role="img" :aria-label="label" /></template>
<style scoped>.analytics-chart { width: 100%; height: 100%; min-width: 0; color: var(--nx-text); }</style>
