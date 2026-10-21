<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { managerRequest } from '../../../packages/manager-ui/src/api'
import type { useQq } from './useQq'
import { applyLabel } from './qqPresentation'
const props = defineProps<{ controller: ReturnType<typeof useQq> }>()
const { state, refresh } = props.controller
const flag = (value: unknown) => value === true ? '是' : value === false ? '否' : '未知'
const memory = ref<Array<{scope: string; files: number; count: number; unreadable: number}>>([])
const memoryError = ref(''), memoryLoading = ref(false)
async function readMemory() {
  if (memoryLoading.value) return
  memoryLoading.value = true
  try { memory.value = (await managerRequest<{data: typeof memory.value}>('/api/modules/qq/memory')).data; memoryError.value = '' }
  catch (error) { memoryError.value = error instanceof Error ? error.message : '统计读取失败' }
  finally { memoryLoading.value = false }
}
onMounted(() => void readMemory())
</script>
<template>
  <section class="panel">
    <div class="section-heading"><h2>连接与诊断</h2><button :disabled="state.statusLoading" @click="refresh('status')">{{ state.statusLoading ? '读取中…' : '刷新诊断' }}</button></div>
    <p v-if="state.statusError" class="error" role="alert">QQ 状态读取失败：{{ state.statusError }}</p><p v-else-if="!state.status">正在读取 QQ 状态…</p>
    <div v-else class="diagnostic-grid">
      <article><h3>插件与身份</h3><p>已安装：{{ flag(state.status.installed) }} · 已启用：{{ flag(state.status.enabled) }}</p><p>活动版本：{{ state.status.activeVersion || '未读取' }}</p><p>NapCat 已连接：{{ flag(state.status.napcatConnected) }}</p><p>身份已验证：{{ flag(state.status.trustedIdentity) }}</p><p>QQ 在线：{{ flag(state.status.qqOnline) }}</p></article>
      <article><h3>业务准备情况</h3><p>业务暂停：{{ flag(state.status.paused) }}</p><p>保存版本：{{ state.status.savedRevision ?? '未知' }} · 应用版本：{{ state.status.appliedRevision ?? '未知' }}</p><p>{{ applyLabel(state.status.apply?.state) }}</p><p>缺少绑定：{{ state.status.missingBindings?.join('、') || '无' }}</p><p>资源缺失：{{ state.status.missingResources?.join('、') || '无' }}</p><p v-for="reason in state.status.reasons" :key="reason">{{ reason }}</p></article>
    </div>
    <article v-if="state.status?.summaries?.length"><h3>讨论总结</h3><p v-for="item in state.status.summaries" :key="item.target">{{ item.target }} · {{ ({ pending: '等待整理', running: '正在整理', completed: '已完成', failed: '未完成', cancelled: '已让位给新请求' } as Record<string,string>)[item.status] }} · {{ ({history:'读取历史',memory:'保存群记忆',summary:'生成摘要',commit:'保存摘要'} as Record<string,string>)[item.phase] || item.phase }}<span v-if="item.lastSummaryAt"> · 上次完成 {{ new Date(item.lastSummaryAt).toLocaleString() }}</span><span v-if="item.throughEventId"> · 覆盖消息 {{ item.throughEventId }}</span><span v-if="item.reason"> · {{ item.reason }}</span></p></article>
    <p class="muted">Manager 不启停 NapCat，不负责实时 QQ 消息。连接成功不等于目标已允许或模型可用。</p>
  </section>
  <slot name="token" />
  <section class="panel">
    <div class="section-heading"><h2>记忆文件统计</h2><button :disabled="memoryLoading" @click="readMemory">{{ memoryLoading ? '读取中…' : '刷新统计' }}</button></div>
    <p v-if="memoryError" class="error" role="alert">{{ memoryError }}</p>
    <p class="muted">这里只统计私聊及旧群 / 群成员记忆文件，不包含新的群事实库。</p>
    <dl><div v-for="item in memory" :key="item.scope"><dt>{{ ({personal: '私聊', group: '旧群记忆', member: '旧群成员记忆'} as Record<string,string>)[item.scope] }}</dt><dd>{{ item.files }} 个文件 · {{ item.count }} 条记忆<span v-if="item.unreadable"> · {{ item.unreadable }} 个文件无法读取</span></dd></div></dl>
  </section>
</template>
