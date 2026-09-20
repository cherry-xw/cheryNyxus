<script setup lang="ts">
import { computed, ref } from 'vue'
import ContextUsageRing from './ContextUsageRing.vue'
import ContextCompositionBar from './ContextCompositionBar.vue'
import { metricPercent, rankAgents, type ContextAnalyticsDemo, type AgentUsageView } from './model'
import { formatMetric, formatDuration } from './presentation'
const props = defineProps<{ model: ContextAnalyticsDemo }>()
const ranked = computed(() => rankAgents(props.model.agents))
const podium = computed(() => ranked.value.filter((entry) => entry.detailedByDefault))
const rows = computed(() => ranked.value.filter((entry) => !entry.detailedByDefault))
const expanded = ref(new Set<string>())
function toggle(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
function share(agent: AgentUsageView): string {
  const value = metricPercent(agent.cumulativeTokens, props.model.totalTokens)
  return value === null ? '未知' : value.toFixed(1) + '%'
}
</script>

<template>
  <section class="agent-section">
    <header><div><h3>参与 Agent</h3><p>按已记录累计 Token 排名 · 共 {{ model.agents.length }} 个 Agent</p></div></header>
    <div class="podium">
      <article v-for="entry in podium" :key="entry.agent.agentId" :class="['podium-card', 'rank-' + entry.rank]">
        <header><span class="rank">第 {{ entry.rank }} 名</span><span>{{ entry.agent.isMain ? '主 Agent' : entry.agent.role }}</span></header>
        <h4>{{ entry.agent.name }}</h4>
        <p class="model-name">{{ entry.agent.modelName ?? '模型未记录' }} · {{ entry.agent.modelSource === 'configured' ? '默认配置' : '最近请求' }}</p>
        <div class="podium-detail">
          <ContextUsageRing :snapshot="entry.agent.currentContext" />
          <dl>
            <div><dt>累计 Token</dt><dd>{{ formatMetric(entry.agent.cumulativeTokens) }}</dd></div>
            <div><dt>任务占比</dt><dd>{{ share(entry.agent) }}</dd></div>
            <div><dt>轮次 / 步骤</dt><dd>{{ formatMetric(entry.agent.rounds) }} / {{ formatMetric(entry.agent.requests) }}</dd></div>
            <div><dt>执行时间</dt><dd>{{ formatDuration(entry.agent.durationMs.value) }}</dd></div>
          </dl>
        </div>

      </article>
    </div>
    <div class="agent-rows">
      <article v-for="entry in rows" :key="entry.agent.agentId" class="agent-row">
        <div class="row-summary">
          <span class="rank">{{ entry.rank ? '第 ' + entry.rank + ' 名' : '未排名' }}</span>
          <span>{{ entry.agent.name }}</span>
          <span class="model-name">{{ entry.agent.modelName ?? '模型未记录' }}</span>
          <span>{{ formatMetric(entry.agent.cumulativeTokens) }} Token</span>
          <span>{{ formatMetric(entry.agent.requests) }} 步</span>
          <button type="button" :aria-expanded="expanded.has(entry.agent.agentId)" @click="toggle(entry.agent.agentId)">{{ expanded.has(entry.agent.agentId) ? '收起详情' : '查看详情' }}</button>
        </div>
        <div v-if="expanded.has(entry.agent.agentId)" class="row-detail">
          <div class="row-metrics">
            <span>任务占比 {{ share(entry.agent) }}</span><span>{{ formatMetric(entry.agent.rounds) }} 轮</span>
            <span>执行 {{ formatDuration(entry.agent.durationMs.value) }}</span>
            <span>{{ entry.agent.modelSource === 'configured' ? '模型来源：默认配置' : '模型来源：最近请求' }}</span>

          </div>
          <ContextCompositionBar :snapshot="entry.agent.currentContext" />
          <div class="segments">
            <span>当前上下文{{ entry.agent.currentContext.limitTokens ? '' : '（上限未知，色块仅表示组成）' }}</span>
            <span v-for="segment in entry.agent.currentContext.segments" :key="segment.key"><i :style="{ background: segment.color }" />{{ segment.label }} {{ formatMetric(segment.tokens) }}</span>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped lang="less">
.agent-section { margin-top: 18px; }
h3, h4 { font-size: 15px; font-weight: 400; margin: 0; }
p { margin: 6px 0; font-size: 12px; color: color-mix(in srgb, var(--nx-text) 65%, transparent); }
.podium { display: grid; grid-template-columns: 1fr 1.12fr 1fr; align-items: end; gap: 12px; margin-top: 14px; }
.podium-card { min-width: 0; padding: 16px; border: 1px solid color-mix(in srgb, var(--nx-text) 18%, transparent); background: color-mix(in srgb, var(--nx-bg) 94%, var(--nx-text) 6%); }
.rank-1 { grid-column: 2; grid-row: 1; padding-top: 28px; padding-bottom: 24px; border-top: 3px solid var(--nx-yellow); }
.rank-2 { grid-column: 1; grid-row: 1; padding-top: 20px; border-top: 2px solid var(--nx-cyan); }
.rank-3 { grid-column: 3; grid-row: 1; border-top: 2px solid color-mix(in srgb, var(--nx-yellow) 55%, transparent); }
.podium-card header, .row-metrics, .segments { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; font-size: 12px; }
.podium-card header { justify-content: space-between; margin-bottom: 10px; }
.rank { color: var(--nx-cyan); white-space: nowrap; }
.rank-1 .rank { color: var(--nx-yellow); font-size: 15px; }
.model-name { overflow-wrap: anywhere; color: color-mix(in srgb, var(--nx-text) 65%, transparent); font-size: 12px; }
.podium-detail { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin: 16px 0; }
dl { flex: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 0; min-width: 160px; }
dt { font-size: 12px; color: color-mix(in srgb, var(--nx-text) 65%, transparent); }
dd { font-size: 13px; margin: 4px 0 0; overflow-wrap: anywhere; }
button { padding: 5px 8px; color: inherit; border: 1px solid color-mix(in srgb, var(--nx-text) 20%, transparent); background: transparent; font-family: inherit; font-size: 12px; font-weight: 400; line-height: 1.5; cursor: pointer; }
.agent-rows { margin-top: 12px; border-top: 1px solid color-mix(in srgb, var(--nx-text) 15%, transparent); }
.agent-row { border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 15%, transparent); padding: 12px; }
.row-summary { display: grid; grid-template-columns: 70px 1fr 1.5fr 1fr 70px auto; align-items: center; gap: 12px; font-size: 13px; }
.row-detail { margin-top: 12px; }
.segments span { display: flex; gap: 5px; align-items: center; }
.segments i { width: 8px; height: 8px; }
@media (max-width: 760px) {
  .podium { grid-template-columns: 1fr; }
  .podium-card { grid-column: 1; grid-row: auto; }
  .rank-1 { order: -1; }
  .row-summary { grid-template-columns: 70px 1fr auto; }
}
</style>
