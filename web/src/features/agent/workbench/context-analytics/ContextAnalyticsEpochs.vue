<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ContextAnalyticsDemo } from './model'
import { snapshotFor } from './model'
import { formatDate } from './presentation'

const props = defineProps<{ model: ContextAnalyticsDemo }>()
const emit = defineEmits<{ openContent: [agentId: string, epochId: string] }>()

const selectedAgentId = ref(props.model.agents[0]?.agentId ?? '')
const selectedEpochId = ref(props.model.epochs[0]?.epochId ?? '')
const selectedEpoch = computed(
  () => props.model.epochs.find((epoch) => epoch.epochId === selectedEpochId.value) ?? props.model.epochs[0],
)
const selectedSnapshot = computed(() =>
  snapshotFor(props.model, selectedAgentId.value, selectedEpochId.value),
)

function qualityLabel(): string {
  const quality = selectedEpoch.value?.quality
  if (quality === 'exact') return '已保存'
  if (quality === 'partial') return '部分保存'
  return '旧数据重建'
}
</script>

<template>
  <section class="epoch-view">
    <header>
      <label>查看 Agent
        <select v-model="selectedAgentId">
          <option v-for="agent in model.agents" :key="agent.agentId" :value="agent.agentId">
            {{ agent.name }} · {{ agent.isMain ? '主 Agent' : agent.role }}
          </option>
        </select>
      </label>
      <p>选择纪元只改变查看范围，不会切换 Agent 的运行上下文。</p>
    </header>
    <div class="epoch-layout">
      <ol class="epoch-list">
        <li v-for="epoch in model.epochs" :key="epoch.epochId">
          <button
            type="button"
            :class="{ active: selectedEpochId === epoch.epochId }"
            @click="selectedEpochId = epoch.epochId"
          >
            <span><strong>{{ epoch.label }}</strong><em>{{ epoch.status === 'active' ? '当前' : '历史只读' }}</em></span>
            <small>{{ formatDate(epoch.createdAt) }}</small>
            <small>{{ epoch.transitionReason }}</small>
          </button>
        </li>
      </ol>
      <article v-if="selectedEpoch" class="epoch-detail">
        <header>
          <div>
            <small>上下文纪元 {{ selectedEpoch.ordinal }}</small>
            <h3>{{ selectedEpoch.label }}</h3>
          </div>
          <span :class="`quality-${selectedEpoch.quality}`">{{ qualityLabel() }}</span>
        </header>
        <dl>
          <div><dt>形成原因</dt><dd>{{ selectedEpoch.transitionReason }}</dd></div>
          <div><dt>开始时间</dt><dd>{{ formatDate(selectedEpoch.createdAt) }}</dd></div>
          <div><dt>结束时间</dt><dd>{{ selectedEpoch.closedAt ? formatDate(selectedEpoch.closedAt) : '当前仍在使用' }}</dd></div>
          <div><dt>Agent 快照</dt><dd>{{ selectedEpoch.availableAgentIds.length }} 份</dd></div>
        </dl>
        <section v-if="selectedEpoch.handoffSummary">
          <h4>交接摘要</h4>
          <p>{{ selectedEpoch.handoffSummary }}</p>
        </section>
        <section>
          <h4>内容保存情况</h4>
          <ul>
            <li><span>系统提示词</span><b>{{ selectedSnapshot ? '已保存' : '未保存' }}</b></li>
            <li><span>工具定义</span><b>{{ selectedSnapshot?.items.some((item) => item.category === 'tools') ? '已保存' : '未保存' }}</b></li>
            <li><span>技能正文</span><b>{{ selectedSnapshot?.items.some((item) => item.category === 'skills') ? '已保存' : '未保存' }}</b></li>
            <li><span>动态会话</span><b>{{ selectedSnapshot?.items.some((item) => item.category === 'conversation') ? '已保存' : '未保存' }}</b></li>
          </ul>
          <p>整体快照质量不代表每一类内容都完整，缺失内容不会由当前配置补写。</p>
        </section>
        <button
          class="open-content"
          type="button"
          :disabled="!selectedSnapshot"
          @click="emit('openContent', selectedAgentId, selectedEpoch.epochId)"
        >
          {{ selectedSnapshot ? '查看该纪元内容' : '此 Agent 没有快照' }}
        </button>
      </article>
    </div>
  </section>
</template>

<style scoped lang="less">
.epoch-view { color: var(--nx-text); }
.epoch-view > header { display: flex; align-items: end; justify-content: space-between; gap: 12px; }
label { display: grid; gap: 5px; color: color-mix(in srgb, var(--nx-text) 58%, transparent); font-size: 11px; }
select { min-width: 210px; padding: 8px; border: 1px solid color-mix(in srgb, var(--nx-text) 15%, transparent); border-radius: 7px; color: inherit; background: var(--nx-bg); }
.epoch-view > header p { margin: 0; color: color-mix(in srgb, var(--nx-text) 52%, transparent); font-size: 11px; }
.epoch-layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 14px; margin-top: 14px; }
.epoch-list,
.epoch-detail { border: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--nx-bg) 94%, var(--nx-text) 6%); }
.epoch-list { display: grid; align-content: start; gap: 5px; margin: 0; padding: 8px; list-style: none; }
.epoch-list button { display: grid; gap: 5px; width: 100%; padding: 10px; border: 1px solid transparent; border-radius: 7px; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.epoch-list button.active { border-color: color-mix(in srgb, var(--nx-cyan) 35%, transparent); background: color-mix(in srgb, var(--nx-cyan) 9%, transparent); }
.epoch-list span { display: flex; justify-content: space-between; gap: 8px; }
.epoch-list em { color: var(--nx-cyan); font-size: 10px; font-style: normal; }
.epoch-list small { color: color-mix(in srgb, var(--nx-text) 50%, transparent); }
.epoch-detail { padding: 18px; }
.epoch-detail > header { display: flex; align-items: start; justify-content: space-between; gap: 12px; padding-bottom: 14px; border-bottom: 1px solid color-mix(in srgb, var(--nx-text) 10%, transparent); }
.epoch-detail h3 { margin: 3px 0 0; }
.epoch-detail > header span { color: var(--nx-cyan); font: 11px/1.3 var(--font-mono); }
.epoch-detail > header .quality-partial,
.epoch-detail > header .quality-reconstructed { color: var(--nx-yellow); }
.epoch-detail dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 18px 0; }
dt { color: color-mix(in srgb, var(--nx-text) 52%, transparent); font-size: 10px; }
dd { margin: 4px 0 0; font-size: 12px; }
.epoch-detail section { margin-top: 16px; }
.epoch-detail h4 { margin: 0 0 8px; font-size: 12px; }
.epoch-detail p { color: color-mix(in srgb, var(--nx-text) 58%, transparent); font-size: 11px; line-height: 1.55; }
.epoch-detail ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px 14px; margin: 0; padding: 0; list-style: none; }
.epoch-detail li { display: flex; justify-content: space-between; padding: 8px; border-radius: 6px; background: color-mix(in srgb, var(--nx-text) 5%, transparent); font-size: 11px; }
.epoch-detail li b { font-weight: 500; }
.open-content { margin-top: 18px; padding: 8px 12px; border: 1px solid color-mix(in srgb, var(--nx-cyan) 40%, transparent); border-radius: 7px; color: var(--nx-cyan); background: color-mix(in srgb, var(--nx-cyan) 8%, transparent); cursor: pointer; }
.open-content:disabled { opacity: 0.42; cursor: default; }
@media (max-width: 760px) {
  .epoch-view > header { align-items: start; flex-direction: column; }
  .epoch-layout { grid-template-columns: 1fr; }
  .epoch-list { grid-template-columns: repeat(3, minmax(180px, 1fr)); overflow-x: auto; }
}
</style>
