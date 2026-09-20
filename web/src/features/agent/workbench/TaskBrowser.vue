<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { TaskCatalogItem, TaskOverviewStatus } from '@/application/backend/public'
import {
  hasTaskBrowserFilters,
  splitHighlightedText,
  taskBrowserDetail,
  taskBrowserStatusLabel,
  taskSearchSourceLabel,
} from './taskBrowserModel'
import {
  ContextUsageRing,
  contextAnalyticsCardSummaryFromUsage,
  type ContextAnalyticsCardSummary,
} from './context-analytics/public'
import ContextDailyHeatmap from './context-analytics/ContextDailyHeatmap.vue'
import { formatMetric } from './context-analytics/presentation'
import { useTaskBrowserController } from './useTaskBrowserController'
import { taskBrowserCatalogScope } from './useTaskBrowserOverlay'
import { agentApi } from '@/application/backend/public'

const props = withDefaults(
  defineProps<{
    windowId: string
    presetId?: string
    presetName?: string
    activeChatId?: string | null
    entryFocus?: 'all' | 'attention'
  }>(),
  { presetId: undefined, presetName: undefined, activeChatId: null, entryFocus: 'all' },
)

const emit = defineEmits<{
  close: []
  openTask: [chatId: string]
  analytics: [demoTaskKey: string]
  archived: [taskKey: string, archivedChatIds: string[], activeChatIdAtStart?: string]
}>()

const scope = computed(() =>
  taskBrowserCatalogScope(props.windowId, props.presetId, props.presetName),
)
const preferenceScope = computed(() =>
  props.presetId
    ? `id:${props.presetId}`
    : props.presetName
      ? `name:${props.presetName}`
      : `window:${props.windowId}`,
)
const presetId = computed(() => props.presetId)
const presetName = computed(() => props.presetName)
const activeChatId = computed(() => props.activeChatId)
const entryFocus = computed(() => props.entryFocus)
const controller = useTaskBrowserController({
  scope,
  preferenceScope,
  presetId,
  presetName,
  activeChatId,
  entryFocus,
  onOpenTask: (chatId) => emit('openTask', chatId),
  onArchived: (taskKey, archivedChatIds, activeChatIdAtStart) =>
    emit('archived', taskKey, archivedChatIds, activeChatIdAtStart),
})

const viewport = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const restored = ref(false)
const pendingArchiveKey = ref<string>()
const dailyFilterDate = ref<string>()
const dailyDemoTaskKeys = ref<string[]>()
const usageSummaries = ref(new Map<string, import('@chery/protocol').TaskUsageSummary>())
const usageStatus = ref<'loading' | 'ready' | 'error'>('loading')
let usageRequestId = 0

const STATUS_OPTIONS: Array<{ value: TaskOverviewStatus; label: string }> = [
  { value: 'needs_user', label: '等待处理' },
  { value: 'running', label: '运行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'failed', label: '失败' },
  { value: 'completed', label: '已完成' },
  { value: 'stopped', label: '已停止' },
  { value: 'idle', label: '空闲' },
]
const TIME_RANGE_OPTIONS: Array<{ value: typeof controller.filters.value.timeRange; label: string }> = [
  { value: 'all', label: '全部时间' },
  { value: 'day', label: '24 小时内' },
  { value: 'week', label: '7 天内' },
  { value: 'month', label: '30 天内' },
]
const SORT_OPTIONS: Array<{ value: typeof controller.filters.value.sort; label: string }> = [
  { value: 'updated_desc', label: '最近更新' },
  { value: 'created_desc', label: '最近创建' },
  { value: 'relevance', label: '搜索相关度' },
]

const resultSummary = computed(() => {
  if (dailyFilterDate.value) {
    return `${visibleItems.value.length} 个任务 · ${dailyFilterDate.value}`
  }
  if (controller.filters.value.attentionOnly) {
    return `${controller.items.value.length} 个已加载的需关注任务`
  }
  return `${controller.state.value.total} 个任务`
})

const hasFilters = computed(
  () => hasTaskBrowserFilters(controller.filters.value) || !!dailyFilterDate.value,
)

const visibleItems = computed(() => {
  if (!dailyFilterDate.value || !dailyDemoTaskKeys.value) return controller.items.value
  return controller.items.value.filter((item) => {
    return dailyDemoTaskKeys.value?.includes(item.taskKey)
  })
})

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function toggleStatus(status: TaskOverviewStatus): void {
  const statuses = controller.filters.value.statuses
  controller.filters.value.statuses = statuses.includes(status)
    ? statuses.filter((item) => item !== status)
    : [...statuses, status]
}

function selectTimeRange(timeRange: typeof controller.filters.value.timeRange): void {
  controller.filters.value.timeRange = timeRange
}

function selectSort(sort: typeof controller.filters.value.sort): void {
  controller.filters.value.sort = sort
}

function selectDailyUsage(date: string, demoTaskKeys: string[]): void {
  if (dailyFilterDate.value === date) {
    clearDailyUsageFilter()
    return
  }
  dailyFilterDate.value = date
  dailyDemoTaskKeys.value = demoTaskKeys
}

function onDailyRangeChanged(startDate: string, endDate: string): void {
  if (
    dailyFilterDate.value &&
    (dailyFilterDate.value < startDate || dailyFilterDate.value > endDate)
  ) {
    clearDailyUsageFilter()
  }
}

function clearDailyUsageFilter(): void {
  dailyFilterDate.value = undefined
  dailyDemoTaskKeys.value = undefined
}

function clearAllFilters(): void {
  controller.clearFilters()
  clearDailyUsageFilter()
}

function analyticsFor(item: TaskCatalogItem): ContextAnalyticsCardSummary | undefined {
  const summary = usageSummaries.value.get(item.taskKey)
  if (!summary) return undefined
  return contextAnalyticsCardSummaryFromUsage(summary)
}

async function loadUsageSummaries(items: TaskCatalogItem[]): Promise<void> {
  const requestId = ++usageRequestId
  const taskKeys = items.map((item) => item.taskKey).filter(Boolean)
  if (!taskKeys.length) {
    usageSummaries.value = new Map()
    usageStatus.value = 'ready'
    return
  }
  usageStatus.value = 'loading'
  try {
    const batches = Array.from({ length: Math.ceil(taskKeys.length / 100) }, (_, index) =>
      taskKeys.slice(index * 100, (index + 1) * 100),
    )
    const responses = await Promise.all(
      batches.map((batch) => agentApi.getContextUsageSummaries(batch)),
    )
    if (requestId !== usageRequestId) return
    usageSummaries.value = new Map(
      responses.flatMap((response) => response.items).map((item) => [item.taskKey, item]),
    )
    usageStatus.value = 'ready'
  } catch {
    if (requestId !== usageRequestId) return
    usageSummaries.value = new Map()
    usageStatus.value = 'error'
  }
}

function onCardKeydown(event: KeyboardEvent, item: TaskCatalogItem): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  controller.openTask(item)
}

function closeCardMenu(event?: MouseEvent): void {
  const details = (event?.currentTarget as HTMLElement | null)?.closest('details')
  details?.removeAttribute('open')
}

function requestArchive(item: TaskCatalogItem, event?: MouseEvent): void {
  pendingArchiveKey.value = item.taskKey
  closeCardMenu(event as MouseEvent)
}

async function confirmArchive(item: TaskCatalogItem): Promise<void> {
  await controller.archiveTask(item)
  if (!controller.actionErrors.value[item.taskKey]) pendingArchiveKey.value = undefined
}

function onScroll(): void {
  if (viewport.value) controller.rememberScroll(viewport.value)
}

function onRootKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  emit('close')
}

watch(
  () => controller.state.value.loading,
  async (loading) => {
    if (loading || restored.value || !viewport.value) return
    restored.value = true
    await controller.restoreScroll(viewport.value)
  },
)

watch(() => controller.items.value, (items) => { void loadUsageSummaries(items) }, { immediate: true })

onMounted(async () => {
  await nextTick()
  searchInput.value?.focus()
})
</script>

<template>
  <section class="task-browser" aria-label="全部任务" @keydown="onRootKeydown">
    <header class="task-browser-toolbar">
      <div class="task-browser-heading">
        <div>
          <h2>全部任务</h2>
          <p>{{ resultSummary }}。搜索范围包含当前工作台的任务标题、用户提问和结果。</p>
        </div>
        <!-- 关闭入口只保留标题栏「全部任务」按钮的高亮切换（Esc 仍可关闭）。 -->
      </div>

      <form class="task-browser-filters" role="search" @submit.prevent="controller.applyFilters">
        <label class="task-browser-search">
          <span>搜索历史任务</span>
          <input
            ref="searchInput"
            v-model="controller.filters.value.query"
            type="search"
            placeholder="输入任务名称、用户提问或结果"
          />
        </label>

        <details class="task-browser-status-filter">
          <summary>
            状态{{
              controller.filters.value.statuses.length
                ? `（${controller.filters.value.statuses.length}）`
                : ''
            }}
          </summary>
          <fieldset>
            <legend>按状态筛选</legend>
            <label v-for="option in STATUS_OPTIONS" :key="option.value">
              <input
                type="checkbox"
                :checked="controller.filters.value.statuses.includes(option.value)"
                @change="toggleStatus(option.value)"
              />
              <span>{{ option.label }}</span>
            </label>
          </fieldset>
        </details>

        <details class="task-browser-status-filter">
          <summary>最近活动</summary>
          <fieldset>
            <legend>按最近活动筛选</legend>
            <label v-for="option in TIME_RANGE_OPTIONS" :key="option.value">
              <input
                type="radio"
                name="task-browser-time-range"
                :checked="controller.filters.value.timeRange === option.value"
                @change="selectTimeRange(option.value)"
              />
              <span>{{ option.label }}</span>
            </label>
          </fieldset>
        </details>

        <details class="task-browser-status-filter">
          <summary>排序</summary>
          <fieldset>
            <legend>任务排序</legend>
            <label v-for="option in SORT_OPTIONS" :key="option.value">
              <input
                type="radio"
                name="task-browser-sort"
                :checked="controller.filters.value.sort === option.value"
                @change="selectSort(option.value)"
              />
              <span>{{ option.label }}</span>
            </label>
          </fieldset>
        </details>

        <button type="submit" class="is-primary">应用</button>
        <button type="button" :disabled="!dailyFilterDate" @click="clearDailyUsageFilter">
          清除日期
        </button>
        <button type="button" :disabled="!hasFilters" @click="clearAllFilters">清除筛选</button>
      </form>

      <div v-if="controller.filters.value.attentionOnly" class="task-browser-notice" role="status">
        当前只显示已加载任务中需要处理、失败或有未查看结果的任务。
        <button type="button" @click="controller.showAllTasks">显示全部任务</button>
      </div>
      <div v-if="controller.newContentCount.value" class="task-browser-notice" role="status">
        有 {{ controller.newContentCount.value }} 个新任务，当前卡片顺序保持不变。
        <button type="button" @click="controller.refresh(true)">显示新内容</button>
      </div>
    </header>

    <div ref="viewport" class="task-browser-viewport" tabindex="-1" @scroll.passive="onScroll">
      <ContextDailyHeatmap
        :time-range="controller.filters.value.timeRange"
        @analytics="emit('analytics', $event)"
        @date-selected="selectDailyUsage"
        @range-changed="onDailyRangeChanged"
      />

      <div v-if="controller.state.value.loading" class="task-browser-state" role="status">
        正在加载任务…
      </div>

      <div
        v-else-if="controller.state.value.error && !controller.items.value.length"
        class="task-browser-state"
        role="alert"
      >
        <p>任务加载失败：{{ controller.state.value.error }}</p>
        <button type="button" @click="controller.retry">重试</button>
      </div>

      <div v-else-if="!visibleItems.length" class="task-browser-state">
        <p>{{ hasFilters ? '没有符合当前条件的任务。' : '当前工作台还没有任务。' }}</p>
        <button v-if="hasFilters" type="button" @click="clearAllFilters">清除筛选</button>
      </div>

      <div v-else class="task-browser-grid" role="list">
        <article
          v-for="item in visibleItems"
          :key="item.taskKey"
          class="task-browser-card"
          :class="[`status-${item.status}`, { 'has-unread': item.unreadResult }]"
          role="listitem"
          tabindex="0"
          :aria-label="`打开任务：${item.title || '未命名任务'}`"
          @click="controller.openTask(item)"
          @keydown="onCardKeydown($event, item)"
        >
          <div class="task-card-head">
            <div class="task-card-title-wrap">
              <h3>
                {{ item.title || '未命名任务' }}
                <span class="task-card-status" :class="`is-${item.status}`">
                  {{ taskBrowserStatusLabel(item.status) }}
                </span>
                <span v-if="item.unreadResult" class="task-card-unread">未查看结果</span>
              </h3>
            </div>
            <details class="task-card-menu" @click.stop @keydown.stop>
              <summary :aria-label="`任务操作：${item.title || '未命名任务'}`">•••</summary>
              <div class="task-card-menu-items">
                <button type="button" @click="controller.toggleShortcut(item); closeCardMenu($event)">
                  {{
                    controller.shortcutKeys.value.has(item.taskKey)
                      ? '从标题栏收起'
                      : '显示在标题栏'
                  }}
                </button>
                <button type="button" class="is-danger" @click="requestArchive(item, $event)">
                  归档任务
                </button>
              </div>
            </details>
          </div>

          <!-- 统计区属于卡片主体，点击不再拦截：整卡任意位置（除菜单/归档确认/错误提示）都打开任务活动主流程。 -->
          <section v-if="item.lastUserPrompt" class="task-card-analytics">
            <template v-for="analytics in [analyticsFor(item)]" :key="analytics?.taskKey ?? item.taskKey">
              <template v-if="analytics">
                <ContextUsageRing v-if="analytics.currentContext" :snapshot="analytics.currentContext" />
                <div v-else class="task-card-analytics-placeholder" aria-label="当前上下文快照暂无记录">
                  <span>暂无快照</span>
                </div>
                <div class="task-card-analytics-copy">
                  <div class="task-card-analytics-heading">
                    <h4>当前上下文</h4>
                  </div>
                  <div class="task-card-analytics-total">累计 Token {{ formatMetric(analytics.totalTokens) }}</div>
                  <div class="task-card-analytics-metrics">
                    <span>轮次 {{ formatMetric(analytics.rounds) }}</span>
                    <span>请求 {{ formatMetric(analytics.requests) }}</span>
                    <span>Agent {{ analytics.agentCount }}</span>
                  </div>
                </div>
              </template>
              <template v-else>
                <div class="task-card-analytics-unavailable" :aria-label="usageStatus === 'error' ? '统计读取失败' : '正在读取统计'">
                  <strong>当前上下文</strong>
                  <span>{{ usageStatus === 'error' ? '统计读取失败' : '正在读取统计…' }}</span>
                  <small>{{ usageStatus === 'error' ? '当前未显示任何替代数据，请稍后刷新重试。' : '正在读取该任务的长期统计。' }}</small>
                </div>
              </template>
            </template>
          </section>

          <section class="task-card-section">
            <h4>最近要求</h4>
            <p>{{ item.lastUserPrompt || '暂无最近要求。' }}</p>
          </section>

          <section class="task-card-section task-card-detail">
            <h4>{{ taskBrowserDetail(item).label }}</h4>
            <p>{{ taskBrowserDetail(item).content }}</p>
          </section>

          <section v-if="item.matches.length" class="task-card-matches" aria-label="搜索命中片段">
            <h4>搜索命中</h4>
            <p v-for="(match, index) in item.matches.slice(0, 3)" :key="`${match.source}-${index}`">
              <span class="match-source">{{ taskSearchSourceLabel(match.source) }}</span>
              <template
                v-for="(part, partIndex) in splitHighlightedText(match.text, match.highlights)"
                :key="partIndex"
              >
                <mark v-if="part.highlighted">{{ part.text }}</mark>
                <span v-else>{{ part.text }}</span>
              </template>
            </p>
          </section>

          <div
            v-if="pendingArchiveKey === item.taskKey"
            class="task-card-confirm"
            @click.stop
            @keydown.stop
          >
            <p>归档后任务会从这里移除，可在归档设置中恢复。</p>
            <div>
              <button type="button" @click="pendingArchiveKey = undefined">取消</button>
              <button
                type="button"
                class="is-danger"
                :disabled="controller.archivingKeys.value.has(item.taskKey)"
                @click="confirmArchive(item)"
              >
                {{ controller.archivingKeys.value.has(item.taskKey) ? '归档中…' : '确认归档' }}
              </button>
            </div>
          </div>

          <p
            v-if="controller.actionErrors.value[item.taskKey]"
            class="task-card-error"
            role="alert"
            @click.stop
          >
            {{ controller.actionErrors.value[item.taskKey] }}
          </p>

          <footer>
            <span>更新于 {{ formatTime(item.updatedAt) }}</span>
            <span>{{ item.branchCount }} 个分支</span>
          </footer>
        </article>
      </div>

      <div
        v-if="controller.state.value.error && controller.items.value.length"
        class="task-browser-inline-error"
        role="alert"
      >
        {{ controller.state.value.error }}
        <button type="button" @click="controller.retry">重试</button>
      </div>

      <div v-if="controller.hasMore.value" class="task-browser-load-more">
        <button
          type="button"
          :disabled="controller.state.value.loadingMore"
          @click="controller.loadMore"
        >
          {{ controller.state.value.loadingMore ? '正在加载…' : '加载更多' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less" src="./TaskBrowser.styles.less"></style>
