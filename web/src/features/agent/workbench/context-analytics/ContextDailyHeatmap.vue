<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { EChartsOption } from 'echarts'
import AnalyticsChart from './AnalyticsChart.vue'
import {
  addCalendarDays,
  calendarDayCount,
  calendarDisplayRange,
  createDailyUsageDemo,
  dailyHeatmapValue,
  dailyUsageStateLabel,
  enumerateCalendarDays,
  type DailyUsagePoint,
  type DailyTaskUsage,
} from './dailyModel'
import { formatTokens } from './presentation'
import { agentApi } from '@/application/backend/public'
import { DAILY_CHART_TOP, DAILY_CHART_LEFT, DAILY_COLOR_BANDS, dailyCellColor, dailyCellLayout } from './dailyChart'

const props = withDefaults(
  defineProps<{ timeRange?: 'all' | 'day' | 'week' | 'month' }>(),
  { timeRange: 'all' },
)
const emit = defineEmits<{
  analytics: [demoTaskKey: string]
  dateSelected: [date: string, demoTaskKeys: string[]]
  rangeChanged: [startDate: string, endDate: string]
}>()
const demo = createDailyUsageDemo()
const remotePoints = ref<DailyUsagePoint[]>()
const remoteLoaded = ref(false)
const remoteTaskKeys = ref(new Map<string, string[]>())
const selectedDate = ref(demo.selectedDate)
const calendarHost = ref<HTMLElement>()
const hostWidth = ref(800)
const hostHeight = ref(238)
let calendarObserver: ResizeObserver | undefined
const rows = 7
const maximumColumns = calendarDayCount(calendarDisplayRange(demo)) / rows
const visibleRange = computed(() => {
  const days = { all: 0, day: 0, week: 6, month: 29 }[props.timeRange]
  return props.timeRange !== 'all' ? { startDate: addCalendarDays(demo.today, -days), endDate: demo.today } : demo
})
const visiblePoints = computed(() =>
  (remoteLoaded.value ? (remotePoints.value ?? []) : demo.points.map((point) => ({
    ...point,
    tokens: null,
    state: 'unknown' as const,
    tasks: [],
  }))).filter(
    (point) => point.date >= visibleRange.value.startDate && point.date <= visibleRange.value.endDate,
  ),
)
const displayRange = computed(() => calendarDisplayRange(visibleRange.value))
const displayColumns = computed(() => calendarDayCount(displayRange.value) / rows)
const cell = computed(() => dailyCellLayout(hostWidth.value, hostHeight.value, maximumColumns))
const displayPoints = computed(() => {
  const known = new Map(visiblePoints.value.map((point) => [point.date, point]))
  return enumerateCalendarDays(displayRange.value).map<DailyUsagePoint>((date) =>
    known.get(date) ?? { date, tokens: null, state: 'outside', tasks: [] },
  )
})
const selectedIndex = computed(() =>
  Math.max(0, displayPoints.value.findIndex((point) => point.date === selectedDate.value)),
)
const selectedPoint = computed(
  () => visiblePoints.value.find((point) => point.date === selectedDate.value) ?? visiblePoints.value[0]!,
)

function tooltipContent(params: unknown): string {
  const item = (Array.isArray(params) ? params[0] : params) as { data?: { value?: unknown[] }; value?: unknown[]; name?: string }
  const value = item.data?.value ?? item.value ?? []
  const date = typeof value[0] === 'string' ? value[0] : item.name?.split(' · ')[0] ?? '未知日期'
  const point = displayPoints.value.find((candidate) => candidate.date === date)
  if (!point) return date
  const amount = point.tokens === null ? 'Token 未知' : `${formatTokens(point.tokens)} Token`
  return `${date}<br/>${dailyUsageStateLabel(point)} · ${amount}`
}

function pointDescription(index: number): string {
  const point = displayPoints.value[index]!
  const amount = point.tokens === null ? '' : ` · ${formatTokens(point.tokens)} Token`
  return `${point.date} · ${dailyUsageStateLabel(point)}${amount}`
}

const option = computed<EChartsOption>(() => ({
  aria: {
    enabled: true,
    description: `每日 Token 日历，日期范围 ${visibleRange.value.startDate} 至 ${visibleRange.value.endDate}，时区 ${demo.timeZone}`,
  },
  tooltip: { trigger: 'item', formatter: tooltipContent, confine: true },
  visualMap: {
    type: 'piecewise',
    dimension: 1,
    orient: 'horizontal',
    top: 0,
    right: 12,
    itemWidth: 12,
    itemHeight: 12,
    itemGap: 8,
    textStyle: { color: '#888', fontSize: 12, fontWeight: 400 },
    pieces: DAILY_COLOR_BANDS,
    inRange: { opacity: 1 },
    outOfRange: { opacity: 1 },
  },
  calendar: {
    top: DAILY_CHART_TOP,
    left: DAILY_CHART_LEFT,
    width: displayColumns.value * cell.value.pitchX,
    height: rows * cell.value.pitchY,
    range: [displayRange.value.startDate, displayRange.value.endDate],
    cellSize: [cell.value.pitchX, cell.value.pitchY],
    orient: 'horizontal',
    splitLine: { show: false },
    itemStyle: { color: 'transparent', borderColor: 'transparent', borderWidth: 0 },
    yearLabel: { show: false },
    monthLabel: {
      show: true,
      margin: 9,
      color: '#888',
      fontSize: 12,
      fontWeight: 400,
      nameMap: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
    },
    dayLabel: {
      show: true,
      firstDay: 1,
      margin: 8,
      color: '#888',
      fontSize: 12,
      fontWeight: 400,
      nameMap: ['日', '一', '二', '三', '四', '五', '六'],
    },
  },
  series: [
    {
      type: 'custom',
      coordinateSystem: 'calendar',
      renderItem: (_params, api) => {
        const position = api.coord([api.value(0)])
        const fill = dailyCellColor(Number(api.value(1)))
        return {
          type: 'rect',
          shape: { x: position[0]! - cell.value.width / 2,
            y: position[1]! - cell.value.height / 2,
            width: cell.value.width, height: cell.value.height, r: cell.value.radius },
          style: { fill, opacity: 1 },
          emphasis: { style: { fill, opacity: 1 } },
        }
      },
      selectedMode: 'single',
      itemStyle: { borderWidth: 0, opacity: 1 },
      emphasis: { itemStyle: { borderWidth: 0, opacity: 1 } },
      select: { itemStyle: { borderWidth: 0, opacity: 1 } },
      data: displayPoints.value.map((point, index) => ({
        name: pointDescription(index),
        value: [point.date, dailyHeatmapValue(point)],
        selected: point.date === selectedDate.value,
      })),
    },
  ],
}))

function selectIndex(index: number): void {
  const point = displayPoints.value[index]
  if (point && point.state !== 'outside') selectDate(point.date)
}

function selectDate(date: string): void {
  const point = visiblePoints.value.find((candidate) => candidate.date === date)
  if (!point) return
  selectedDate.value = point.date
  void loadDayTasks(point).then((keys) => emit('dateSelected', point.date, keys))
}

async function loadDayTasks(point: DailyUsagePoint): Promise<string[]> {
  const cached = remoteTaskKeys.value.get(point.date)
  if (cached) return cached
  try {
    const response = await agentApi.getContextUsageDayTasks({ date: point.date, timezone: demo.timeZone, limit: 100 })
    point.tasks = response.items.map((item) => ({
      taskKey: item.taskKey,
      demoTaskKey: item.taskKey,
      title: item.taskKey,
      tokens: item.tokens.value,
      coverage: item.tokens.coverage === 'complete' ? 'complete' as const : item.tokens.coverage === 'partial' ? 'partial' as const : 'unknown' as const,
    }))
    const keys = response.items.map((item) => item.taskKey)
    remoteTaskKeys.value.set(point.date, keys)
    return keys
  } catch {
    return [...new Set(point.tasks.map((task) => task.demoTaskKey))]
  }
}

onMounted(() => {
  void agentApi.getContextUsageDaily({ from: demo.startDate, to: demo.endDate, timezone: demo.timeZone }).then((response) => {
    remotePoints.value = response.points.map((point) => ({
      date: point.date,
      tokens: point.tokens.value,
      state: point.state,
       tasks: point.taskKeys.map((taskKey) => ({ taskKey, demoTaskKey: taskKey, title: taskKey, tokens: null, coverage: 'unknown' as const })),
     }))
    const current = remotePoints.value.find((point) => point.date === selectedDate.value)
    if (current) void loadDayTasks(current)
  }).catch(() => undefined).finally(() => { remoteLoaded.value = true })
})

watch(selectedDate, (date) => {
  const point = visiblePoints.value.find((candidate) => candidate.date === date)
  if (!point || remoteTaskKeys.value.has(date)) return
  void loadDayTasks(point)
})

function moveDay(offset: number): void {
  const next = addCalendarDays(selectedDate.value, offset)
  if (next >= visibleRange.value.startDate && next <= visibleRange.value.endDate) selectDate(next)
}

function openAnalytics(task: DailyTaskUsage): void {
  emit('analytics', task.demoTaskKey)
}

watch(
  () => [props.timeRange, visibleRange.value.startDate, visibleRange.value.endDate] as const,
  () => {
    if (
      selectedDate.value < visibleRange.value.startDate ||
      selectedDate.value > visibleRange.value.endDate
    ) {
      selectedDate.value = visibleRange.value.endDate
    }
    emit('rangeChanged', visibleRange.value.startDate, visibleRange.value.endDate)
  },
)

onMounted(() => {
  if (!calendarHost.value) return
  const updateSize = (entry: ResizeObserverEntry) => {
    hostWidth.value = entry.contentRect.width
    hostHeight.value = entry.contentRect.height
  }
  calendarObserver = new ResizeObserver(([entry]) => {
    if (entry) updateSize(entry)
  })
  calendarObserver.observe(calendarHost.value)
})

onBeforeUnmount(() => calendarObserver?.disconnect())
</script>

<template>
  <section class="daily-usage" aria-labelledby="daily-usage-title">
    <header class="daily-usage-head">
      <div>
        <small>当前工作台全部非归档任务 · 不随下方筛选变化</small>
        <h3 id="daily-usage-title">每日 Token 消耗</h3>
        <p>{{ visibleRange.startDate }} 至 {{ visibleRange.endDate }} · 时区 {{ demo.timeZone }} · 演示数据</p>
      </div>
      <div class="daily-date-control" aria-label="选择日期">
        <button type="button" :disabled="selectedDate === visibleRange.startDate" @click="moveDay(-1)">
          前一天
        </button>
        <input
          v-model="selectedDate"
          type="date"
          :min="visibleRange.startDate"
          :max="visibleRange.endDate"
          aria-label="每日 Token 日期"
          @change="selectDate(selectedDate)"
        />
        <button type="button" :disabled="selectedDate === visibleRange.endDate" @click="moveDay(1)">
          后一天
        </button>
      </div>
    </header>

    <div class="daily-usage-layout">
      <div ref="calendarHost" class="daily-calendar">
        <AnalyticsChart
          :option="option"
          :selected-index="selectedIndex"
          :select-on-hover="false"
          label="最近一年每日 Token 消耗日历热力图"
          @select="selectIndex"
        />
      </div>

      <aside class="daily-detail" aria-live="polite">
        <div class="daily-detail-title">
          <div>
            <small>{{ selectedPoint.date }}</small>
            <h4>{{ dailyUsageStateLabel(selectedPoint) }}</h4>
          </div>
          <strong>
            {{ selectedPoint.tokens === null ? '—' : formatTokens(selectedPoint.tokens) }}
            <span v-if="selectedPoint.tokens !== null">Token</span>
          </strong>
        </div>

        <p v-if="selectedPoint.state === 'future'" class="daily-empty">
          这是未来日期，仅作日历占位，不计为零消耗。
        </p>
        <p v-else-if="selectedPoint.state === 'unknown'" class="daily-empty">
          当天没有足够的 Token 记录，未知值不会计为零。
        </p>
        <p v-else-if="!selectedPoint.tasks.length" class="daily-empty">
          当天已有完整记录，任务消耗为零。
        </p>
        <ul v-else class="daily-task-list">
          <li v-for="task in selectedPoint.tasks" :key="`${task.taskKey}-${task.title}`">
            <div>
              <strong>{{ task.title }}</strong>
              <span>{{ task.tokens === null ? 'Token 未知' : `${formatTokens(task.tokens)} Token` }}</span>
              <small v-if="task.note">{{ task.note }}</small>
            </div>
            <button type="button" @click="openAnalytics(task)">查看统计</button>
          </li>
        </ul>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.daily-usage {
  margin-bottom: 16px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--ink) 22%, transparent);
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  font-size: 13px;
  font-weight: 400;
}

.daily-usage-head,
.daily-date-control,
.daily-detail-title,
.daily-task-list li {
  display: flex;
  align-items: center;
}

.daily-usage-head {
  justify-content: space-between;
  gap: 18px;
}

.daily-usage h3,
.daily-usage h4,
.daily-usage p {
  margin: 0;
}

.daily-usage h3 {
  margin-top: 3px;
  font-size: 17px;
  font-weight: 600;
}

.daily-usage-head p,
.daily-usage small,
.daily-empty {
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 12px;
  line-height: 1.5;
}

.daily-usage-head p {
  margin-top: 4px;
}

.daily-date-control {
  flex: 0 0 auto;
  gap: 6px;
}

.daily-date-control button,
.daily-date-control input,
.daily-task-list button {
  min-height: 30px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 24%, transparent);
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
}

.daily-date-control button,
.daily-task-list button {
  cursor: pointer;
}

.daily-date-control button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.daily-usage-layout {
  display: grid;
  grid-template-columns: minmax(0, 2.3fr) minmax(270px, 0.8fr);
  gap: 14px;
  margin-top: 12px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
}

.daily-calendar {
  min-width: 0;
  height: 238px;
  padding-top: 8px;
}

.daily-detail {
  min-width: 0;
  max-height: 238px;
  padding: 14px 0 0 14px;
  overflow: auto;
  border-left: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 28%, transparent) transparent;
}

.daily-detail::-webkit-scrollbar {
  width: 7px;
}

.daily-detail::-webkit-scrollbar-track {
  background: transparent;
}

.daily-detail::-webkit-scrollbar-thumb {
  border: 2px solid transparent;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 28%, transparent);
  background-clip: padding-box;
}

.daily-detail::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--accent) 70%, transparent);
  background-clip: padding-box;
}

.daily-detail-title {
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.daily-detail h4 {
  margin-top: 2px;
  font-size: 14px;
  font-weight: 400;
}

.daily-detail-title > strong {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 18px;
  font-weight: 400;
  white-space: nowrap;
}

.daily-detail-title > strong span {
  font-family: inherit;
  font-size: 12px;
}

.daily-empty {
  margin-top: 18px;
}

.daily-task-list {
  display: grid;
  gap: 0;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.daily-task-list li {
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
}

.daily-task-list li > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.daily-task-list strong,
.daily-task-list span {
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.daily-task-list span {
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}

.daily-task-list button {
  flex: 0 0 auto;
  font-size: 12px;
}

@media (max-width: 900px) {
  .daily-usage-head {
    align-items: flex-start;
    flex-direction: column;
  }

  .daily-usage-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .daily-detail {
    max-height: 230px;
    padding: 12px 0 0;
    border-top: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
    border-left: 0;
  }
}
</style>
