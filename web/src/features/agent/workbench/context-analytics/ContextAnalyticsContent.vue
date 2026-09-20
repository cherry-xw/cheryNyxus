<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { renderMarkdown } from '@/utils/markdownEngine'
import type { ContextAnalyticsDemo, ContextCategory, ContextContentItem, ContextSnapshotView } from './model'
import { CATEGORY_ORDER, snapshotFor } from './model'
import { formatDate, formatTokens } from './presentation'
import { agentApi } from '@/application/backend/public'
import { contextContentItemFromResponse } from './contentModel'

const props = defineProps<{
  model: ContextAnalyticsDemo
  initialAgentId?: string
  initialCategory?: ContextCategory
  initialEpochId?: string
}>()
const selectedAgentId = ref(props.initialAgentId ?? props.model.agents[0]?.agentId ?? '')
const selectedEpochId = ref('')
const remoteSnapshot = ref<ContextSnapshotView>()
const selectedTool = ref<ContextContentItem>()
const snapshot = computed(() => remoteSnapshot.value ?? snapshotFor(props.model, selectedAgentId.value, selectedEpochId.value))
const epoch = computed(() => props.model.epochs.find((item) => item.epochId === selectedEpochId.value))
const categories: Record<ContextCategory, string> = {
  system: '系统规则', userRules: '用户规则', memory: '记忆', skills: '技能',
  tools: '工具定义', conversation: '会话与工具结果', other: '未分类内容',
}
const groups = computed(() => CATEGORY_ORDER.map((category) => ({
  category, label: categories[category], items: snapshot.value?.items.filter((item) => item.category === category) ?? [],
})).filter((group) => group.items.length))
function onAgentChange(): void {
  selectedEpochId.value = props.model.agents.find((agent) => agent.agentId === selectedAgentId.value)?.currentContext.epochId ?? props.model.epochs[0]?.epochId ?? ''
}
async function loadContent(): Promise<void> {
  remoteSnapshot.value = undefined
  if (!selectedAgentId.value) return
  try {
    const response = await agentApi.getContextContent({ chatId: selectedAgentId.value, ...(selectedEpochId.value ? { epochId: selectedEpochId.value } : {}), limit: 100 })
    remoteSnapshot.value = {
      snapshotId: response.snapshotId,
      agentId: selectedAgentId.value,
      epochId: response.epochId ?? selectedEpochId.value,
      capturedAt: null,
      origin: response.origin === 'missing' ? 'reconstructed' : response.origin,
      quality: response.contentState === 'available' ? 'exact' : 'partial',
      usedTokens: { value: null, source: 'unknown', coverage: 'none', knownCount: 0, totalCount: 0 },
      limitTokens: null,
      segments: [],
      items: response.items.map((item) => {
        const sourceLabel = response.origin === 'frozen' ? '冻结快照' : '只读重建'
        return contextContentItemFromResponse(item, sourceLabel, response.contentState)
      }),
    }
  } catch {
    // Keep the local snapshot visible; the panel still marks its source.
  }
}
watch(() => [props.initialAgentId, props.initialCategory, props.initialEpochId] as const, ([agent, _category, selectedEpoch]) => {
  if (agent) selectedAgentId.value = agent
  onAgentChange()
  if (selectedEpoch) selectedEpochId.value = selectedEpoch
  void loadContent()
}, { immediate: true })
watch([selectedAgentId, selectedEpochId], () => { void loadContent() })
</script>

<template>
  <section class="content-view">
    <header class="content-scope">
      <label>查看 Agent
        <select v-model="selectedAgentId" @change="onAgentChange">
          <option v-for="agent in model.agents" :key="agent.agentId" :value="agent.agentId">{{ agent.name }} · {{ agent.modelName ?? '模型未记录' }}</option>
        </select>
      </label>
      <label v-if="model.epochs.length">上下文纪元
        <select v-model="selectedEpochId">
          <option v-for="item in model.epochs" :key="item.epochId" :value="item.epochId">{{ item.label }} · {{ item.status === 'active' ? '当前' : '历史只读' }}</option>
        </select>
      </label>
      <span v-if="snapshot" class="scope-note">{{ snapshot.origin === 'frozen' ? '冻结快照' : '重建内容' }} · {{ formatDate(snapshot.capturedAt) }}</span>
    </header>
    <div v-if="epoch" class="epoch-note">
      <span>{{ epoch.transitionReason }} · 创建于 {{ formatDate(epoch.createdAt) }}</span>
      <span v-if="epoch.closedAt">结束于 {{ formatDate(epoch.closedAt) }}</span>
      <p v-if="epoch.handoffSummary">{{ epoch.handoffSummary }}</p>
    </div>
    <p v-if="snapshot && snapshot.quality !== 'exact'" class="content-warning">此纪元内容{{ snapshot.quality === 'partial' ? '仅部分保存' : '来自旧数据重建' }}，以下列出全部已保存原文。</p>
    <div v-if="snapshot" class="document-flow">
      <section v-for="group in groups" :key="group.category" class="content-group" :class="'category-' + group.category">
        <h3 class="section-divider"><span>{{ group.label }}</span><small>{{ group.items.length }} 项</small></h3>
        <div class="group-items"><article v-for="item in group.items" :key="item.itemId" class="reader" :class="{ 'is-tool': item.kind === 'tool' }">
          <header>
            <div><h4>{{ item.label }}</h4><small>{{ item.sourceLabel }} · {{ formatTokens(item.tokenEstimate) }} Token</small></div>
          </header>
          <p v-if="item.contentState !== 'available'" class="content-warning">{{ item.contentState === 'partial' ? '此条目只保存了部分内容。' : '此内容没有可靠历史记录，不会用当前配置补写。' }}</p>
          <!-- eslint-disable-next-line vue/no-v-html -- Existing markdown renderer escapes raw HTML. -->
          <div v-if="item.kind === 'markdown'" class="formatted-content" v-html="renderMarkdown(item.content)" />
          <pre v-else-if="item.kind !== 'tool'" class="raw-content">{{ item.content }}</pre>
          <div v-if="item.toolParameters?.length" class="parameter-list">
            <div v-for="field in item.toolParameters" :key="field.name">
              <code>{{ field.name }}</code><span>{{ field.type }} · {{ field.required ? '必填' : '可选' }}</span>
              <!-- eslint-disable-next-line vue/no-v-html -- Existing markdown renderer escapes raw HTML. -->
              <div class="parameter-description" v-html="renderMarkdown(field.description)" />
            </div>
          </div>
          <button v-if="item.kind === 'tool'" type="button" class="tool-detail-button" @click="selectedTool = item">查看工具详情</button>
        </article></div>
      </section>
      <p v-if="!groups.length" class="snapshot-empty">此快照没有保存正文。没有记录不代表当时未使用。</p>
    </div>
    <div v-else class="snapshot-empty"><p>该 Agent 在此纪元没有快照。</p><p>请选择其他纪元。当前配置不会替代历史内容。</p></div>
    <el-dialog
      :model-value="!!selectedTool"
      append-to-body
      width="min(720px, calc(100vw - 32px))"
      class="context-tool-dialog"
      :title="selectedTool?.label ?? '工具详情'"
      @close="selectedTool = undefined"
    >
      <template v-if="selectedTool">
        <!-- eslint-disable-next-line vue/no-v-html -- Existing markdown renderer escapes raw HTML. -->
        <div class="tool-dialog-description formatted-content" v-html="renderMarkdown(selectedTool.preview)" />
        <details class="tool-schema">
          <summary>查看完整定义</summary>
          <pre class="raw-content">{{ selectedTool.content }}</pre>
        </details>
      </template>
    </el-dialog>
  </section>
</template>
<style scoped src="./ContextAnalyticsContent.styles.less" lang="less" />
