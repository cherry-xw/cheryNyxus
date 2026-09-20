<script setup lang="ts">
import { computed } from 'vue'
import ContextUsageRing from './ContextUsageRing.vue'
import ContextCompositionTrend from './ContextCompositionTrend.vue'
import ContextAgentRanking from './ContextAgentRanking.vue'
import type { ContextAnalyticsDemo } from './model'
import { metricStateLabel } from './model'
import { formatMetric, formatDuration } from './presentation'
import ContextRunSummary from './ContextRunSummary.vue'

const props = defineProps<{ model: ContextAnalyticsDemo }>()
const primaryAgent = computed(() => props.model.agents.find((agent) => agent.isMain))
const hitRate = computed(() => props.model.cacheHitRequests != null && props.model.cache.reportedRequests > 0 ? (props.model.cacheHitRequests / props.model.cache.reportedRequests * 100).toFixed(1) + '%' : '未知')
</script>

<template>
  <section class="overview-grid" aria-label="上下文与消耗统计">
    <article v-if="primaryAgent" class="overview-card primary-context">
      <header><div><small>当前主 Agent</small><h3>上下文构成</h3></div><span class="quality">{{ metricStateLabel(primaryAgent.currentContext.usedTokens) }}</span></header>
      <div class="primary-context-body">
        <ContextUsageRing :snapshot="primaryAgent.currentContext" size="large" legend />
      </div>
      <p>当前窗口占用 · {{ primaryAgent.modelName ?? '模型未记录' }}</p>
      <dl class="runtime-summary">
        <div><dt>总历时 / 执行</dt><dd>{{ formatDuration(model.taskDurationMs.value) }} / {{ formatDuration(model.activeDurationMs.value) }}</dd></div>
        <div><dt>轮次 / 步数</dt><dd>{{ formatMetric(model.rounds) }} / {{ formatMetric(model.requests) }}</dd></div>
        <div><dt>累计 Token</dt><dd>{{ formatMetric(model.totalTokens) }}</dd></div>
        <div><dt>主 / 子 Agent</dt><dd>{{ model.agents.filter(a => a.isMain).length }} / {{ model.agents.filter(a => !a.isMain).length }}</dd></div>
        <div><dt>已报告请求缓存命中</dt><dd>{{ hitRate }}</dd></div>
        <div><dt>缓存报告覆盖</dt><dd>{{ model.cache.reportedRequests }} / {{ model.cache.totalRequests }} 步</dd></div>
        <div><dt>缓存读取 Token</dt><dd>{{ formatMetric(model.cache.readTokens) }}</dd></div>
        <div><dt>缓存写入 Token</dt><dd>{{ formatMetric(model.cache.writeTokens) }}</dd></div>
      </dl>
    </article>
    <ContextCompositionTrend :requests="model.requestComposition ?? []" :operations="model.operations ?? []" />
  </section>
  <ContextAgentRanking :model="model" />
  <ContextRunSummary :model="model" />
</template>
<style scoped src="./ContextAnalyticsOverview.styles.less" lang="less" />
