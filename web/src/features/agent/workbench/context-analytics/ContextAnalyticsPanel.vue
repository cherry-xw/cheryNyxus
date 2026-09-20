<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ContextAnalyticsDemo, ContextCategory } from './model'
import { formatMetric } from './presentation'
import ContextAnalyticsOverview from './ContextAnalyticsOverview.vue'
import ContextAnalyticsContent from './ContextAnalyticsContent.vue'
import { agentApi } from '@/application/backend/public'

const props = withDefaults(
  defineProps<{ models: ContextAnalyticsDemo[]; initialTaskKey?: string; eligible?: boolean }>(),
  { initialTaskKey: undefined, eligible: true },
)
const emit = defineEmits<{ close: [] }>()

type TabId = 'overview' | 'content'
const activeTab = ref<TabId>('overview')
const contentAgentId = ref<string>()
const contentCategory = ref<ContextCategory>()
const contentEpochId = ref<string>()
const closeButton = ref<HTMLButtonElement>()
const selectedScenario = ref(0)
const resolvedModels = ref<ContextAnalyticsDemo[]>(props.models)
const loading = ref(false)
const loadError = ref<string>()
const isReal = ref(!!props.initialTaskKey)
const model = computed(() => resolvedModels.value[selectedScenario.value] ?? resolvedModels.value[0]!)
const canShowContent = computed(() => !isReal.value || props.eligible)

function mergeDetail(detail: import('@chery/protocol').TaskUsageDetail): ContextAnalyticsDemo {
  const unknownMetric = { value: null, source: 'unknown' as const, coverage: 'none' as const, knownCount: 0, totalCount: 0 }
  return {
    taskKey: detail.summary.taskKey,
    taskTitle: detail.summary.taskKey,
    asOf: detail.asOf,
    totalTokens: detail.summary.totalTokens,
    rounds: detail.summary.rounds,
    requests: detail.summary.requests,
    agents: detail.agents.map((item) => ({
      agentId: item.chatId,
      name: item.name,
      role: item.isMain ? '主 Agent' : '子 Agent',
      isMain: item.isMain,
      status: item.lifecycle === 'active' ? 'running' : 'completed',
      cumulativeTokens: item.totalTokens,
      rounds: item.rounds,
      requests: item.requests,
      durationMs: unknownMetric,
      currentContext: {
        snapshotId: `missing-${item.chatId}`,
        agentId: item.chatId,
        epochId: '',
        capturedAt: null,
        origin: 'reconstructed',
        quality: 'partial',
        usedTokens: unknownMetric,
        limitTokens: null,
        segments: [],
        items: [],
      },
    })),
    cache: detail.cache,
    cacheHitRequests: null,
    imageCount: null,
    audioCount: null,
    taskDurationMs: detail.elapsedMs,
    activeDurationMs: detail.activeMs,
    tools: detail.tools.map((tool) => ({ name: tool.name, calls: tool.calls, failures: 0, rejected: tool.rejected, totalDurationMs: tool.durationMs })),
    trend: [],
    requestComposition: undefined,
    operations: undefined,
    epochs: [],
    snapshots: [],
  }
}

async function loadRealDetail(taskKey: string): Promise<void> {
  isReal.value = true
  loading.value = true
  loadError.value = undefined
  try {
    const detail = await agentApi.getContextUsageDetail(taskKey)
    resolvedModels.value = [mergeDetail(detail)]
    selectedScenario.value = 0
    isReal.value = true
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '统计加载失败'
  } finally { loading.value = false }
}

watch(
  () => props.initialTaskKey,
  (taskKey) => {
    const index = props.models.findIndex((candidate) => candidate.taskKey === taskKey)
    if (index >= 0) selectedScenario.value = index
  },
  { immediate: true },
)
watch(() => props.initialTaskKey, (taskKey) => { if (taskKey) void loadRealDetail(taskKey) }, { immediate: true })


function focusClose(): void {
  void nextTick(() => closeButton.value?.focus())
}

defineExpose({ focusClose })
</script>

<template>
  <section class="analytics-panel" role="dialog" aria-modal="true" aria-label="上下文与统计">
    <header class="analytics-head">
      <div class="title-block">
        <span v-if="!isReal" class="demo-badge">演示数据</span>
        <div><small>上下文与统计</small><h2>{{ loading || loadError ? (initialTaskKey ?? model.taskTitle) : model.taskTitle }}</h2></div>
      </div>
      <label v-if="!isReal" class="scenario-picker">演示场景
        <select v-model.number="selectedScenario">
          <option v-for="(scenario, index) in models" :key="scenario.taskKey" :value="index">
            {{ scenario.taskTitle }}
          </option>
        </select>
      </label>
      <span v-else class="scenario-picker">真实任务</span>
      <dl v-if="!loading && !loadError && canShowContent" class="task-summary" aria-label="整个任务统计摘要">
        <div><dt>累计 Token</dt><dd>{{ formatMetric(model.totalTokens) }}</dd></div>
        <div><dt>轮次</dt><dd>{{ formatMetric(model.rounds) }}</dd></div>
        <div><dt>模型请求</dt><dd>{{ formatMetric(model.requests) }}</dd></div>
        <div><dt>Agent</dt><dd>{{ model.agents.length }}</dd></div>
      </dl>
      <button ref="closeButton" class="close-button" type="button" aria-label="关闭上下文与统计" @click="emit('close')">✕</button>
    </header>
    <p v-if="loading" class="analytics-state">正在读取长期统计…</p>
    <p v-else-if="loadError" class="analytics-state error">{{ loadError }}</p>
    <p v-else-if="!canShowContent" class="analytics-state">首次发送消息后才会显示统计概览和上下文内容。</p>

    <nav v-if="!loading && !loadError && canShowContent" class="analytics-tabs" aria-label="上下文与统计页面">
      <button type="button" :class="{ active: activeTab === 'overview' }" @click="activeTab = 'overview'">统计概览</button>
      <button type="button" :class="{ active: activeTab === 'content' }" @click="activeTab = 'content'">上下文内容</button>
      <span>只读 · 不会修改配置或运行上下文</span>
    </nav>

    <div v-if="!loading && !loadError && canShowContent" class="analytics-body">
      <ContextAnalyticsOverview v-if="activeTab === 'overview'" :key="model.taskKey" :model="model" />
      <ContextAnalyticsContent
        v-else
        :key="model.taskKey"
        :model="model"
        :initial-agent-id="contentAgentId"
        :initial-category="contentCategory"
        :initial-epoch-id="contentEpochId"
      />
    </div>
  </section>
</template>

<style scoped lang="less">
.analytics-panel { font-size: 13px; font-weight: 400; position: absolute; z-index: var(--nx-z-drawer); inset: 40px 0 0; display: flex; flex-direction: column; color: var(--nx-text); background: var(--nx-bg); }
.analytics-head { display: flex; align-items: center; gap: 18px; min-height: 66px; padding: 10px 16px; border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent); background: color-mix(in srgb, var(--nx-bg) 90%, var(--nx-text) 5%); }
.title-block { display: flex; align-items: center; gap: 10px; min-width: 220px; margin-right: auto; }
.title-block small { color: color-mix(in srgb, var(--nx-text) 52%, transparent); }
.title-block h2 { font-weight: 400; max-width: 420px; margin: 2px 0 0; overflow: hidden; font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.demo-badge { flex: none; padding: 4px 7px; border-radius: 999px; color: var(--nx-yellow); background: color-mix(in srgb, var(--nx-yellow) 12%, transparent); font-size: 12px; }
.scenario-picker { display: grid; gap: 3px; color: color-mix(in srgb, var(--nx-text) 48%, transparent); font-size: 12px; }
.scenario-picker select { max-width: 210px; padding: 5px 7px; border: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent); border-radius: 6px; color: var(--nx-text); background: var(--nx-bg); font-size: 12px; }
.task-summary { display: flex; gap: 20px; margin: 0; }
.task-summary div { min-width: 70px; }
.task-summary dt { color: color-mix(in srgb, var(--nx-text) 48%, transparent); font-size: 12px; }
.task-summary dd { margin: 2px 0 0; font: 13px/1.2 var(--font-mono); }
.close-button { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 1px solid transparent; border-radius: 7px; color: color-mix(in srgb, var(--nx-text) 65%, transparent); background: transparent; cursor: pointer; }
.close-button:hover { color: var(--nx-text); border-color: color-mix(in srgb, var(--nx-cyan) 22%, transparent); background: color-mix(in srgb, var(--nx-cyan) 7%, transparent); }
.analytics-tabs { display: flex; align-items: center; gap: 5px; padding: 8px 16px; border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 10%, transparent); }
.analytics-tabs button { padding: 7px 11px; border: 1px solid transparent; border-radius: 7px; color: color-mix(in srgb, var(--nx-text) 65%, transparent); background: transparent; cursor: pointer; }
.analytics-tabs button.active { color: var(--nx-cyan); border-color: color-mix(in srgb, var(--nx-cyan) 35%, transparent); background: color-mix(in srgb, var(--nx-cyan) 9%, transparent); }
.analytics-tabs span { margin-left: auto; color: color-mix(in srgb, var(--nx-text) 45%, transparent); font-size: 12px; }
.analytics-body { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
@media (max-width: 760px) {
  .analytics-head { align-items: flex-start; flex-wrap: wrap; }
  .title-block { width: calc(100% - 48px); }
  .task-summary { order: 3; width: 100%; justify-content: space-between; gap: 8px; }
  .task-summary div { min-width: 0; }
  .analytics-tabs { overflow-x: auto; }
  .analytics-tabs button { flex: none; }
  .analytics-tabs span { display: none; }
}
</style>
