<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { useQq } from './useQq'
import { deliveryLabel, deliverySummary, outputLabel, recordPage, taskLabel } from './qqPresentation'
const props = defineProps<{ kind: 'queue' | 'history'; active: boolean; controller: ReturnType<typeof useQq> }>()
const { state, refresh, detail } = props.controller
const page = ref(1)
const result = computed(() => recordPage(state[props.kind]?.entries || [], page.value))
const time = (value?: number) => value === undefined ? '未记录' : new Date(value).toLocaleString()
watch(() => props.active, active => { if (active && !state[props.kind]) void refresh(props.kind) }, { immediate: true })
watch(() => result.value.page, value => { page.value = value })
function expand(event: Event, id: string) { if ((event.target as HTMLDetailsElement).open) void detail(id) }
</script>

<template>
  <section class="panel qq-records" :aria-label="kind === 'queue' ? 'QQ 队列' : 'QQ 历史'" :aria-busy="state[`${kind}Loading`]">
    <div class="section-heading"><h2>{{ kind === 'queue' ? '队列' : '历史记录' }}</h2><button type="button" :disabled="state[`${kind}Loading`]" @click="refresh(kind)">{{ state[`${kind}Loading`] ? '读取中…' : '刷新' }}</button></div>
    <p v-if="state[`${kind}Error`]" class="error" role="alert">{{ state[`${kind}Error`] }}</p>
    <p v-else-if="!state[kind]" role="status">{{ state[`${kind}Loading`] ? '正在读取记录…' : '尚未读取。' }}</p>
    <template v-else>
      <p v-if="!result.total">{{ kind === 'queue' ? '当前没有排队或处理中的请求。' : '当前没有保留的历史记录。' }}</p>
      <template v-else>
        <nav class="record-pagination" aria-label="记录分页">
          <span>当前保留 {{ result.total }} 条 · 第 {{ result.page }} / {{ result.pages }} 页</span>
          <button type="button" :disabled="result.page <= 1" @click="page--">上一页</button><button type="button" :disabled="result.page >= result.pages" @click="page++">下一页</button>
        </nav>
        <p class="muted">处理状态与实际发送结果分别记录；发送成功的确认表情或失败说明不代表原回复已发送。</p>
        <ol class="record-list">
          <li v-for="item in result.entries" :key="item.requestId" class="record-card">
            <div class="section-heading"><h3>{{ item.conversationType === 'group' ? '群' : '私聊' }} {{ item.targetId }}</h3><span>{{ taskLabel(item.state) }}</span></div>
            <p class="muted"><time>{{ time(item.acceptedAt) }}</time> · {{ item.senderName || '未记录昵称' }}（{{ item.senderId }}） · 预设：{{ item.preset }}</p>
            <p class="record-preview">{{ item.inputPreview || (item.attachmentCount ? '仅附件消息' : '仅 @ 或无文字输入') }}</p>
            <p v-if="item.messageCount > 1 || item.attachmentCount" class="muted">合并输入 {{ item.messageCount }} 条 · 附件 {{ item.attachmentCount }} 个</p>
            <p v-if="item.replyPreview" class="record-preview">已有回复：{{ item.replyPreview }}</p>
            <p>投递记录：{{ deliverySummary(item) }}</p><p v-if="item.reason" class="warning">原因：{{ item.reason }}</p>
            <details :key="`${item.requestId}:${state.recordsRevision}:${result.page}`" @toggle="expand($event, item.requestId)">
              <summary>查看消息、回复与发送详情</summary>
              <p v-if="state.detailsLoading[item.requestId]" role="status">正在读取详情…</p>
              <p v-if="state.detailErrors[item.requestId]" class="error" role="alert">{{ state.detailErrors[item.requestId] }} <button type="button" @click="detail(item.requestId)">重试读取详情</button></p>
              <template v-if="state.details[item.requestId]">
                <h4>收到的消息</h4>
                <article v-for="message in state.details[item.requestId].messages" :key="message.eventId" class="record-message">
                  <p>{{ message.senderName || '未记录昵称' }}（{{ message.senderId }}）</p><pre>{{ message.content || '无文字内容' }}</pre><p v-if="message.contentTruncated" class="warning">原文超过 20,000 字，此处仅显示前 20,000 字。</p>
                  <ul v-if="message.attachments.length"><li v-for="(attachment, index) in message.attachments" :key="index">附件：{{ attachment.type }} {{ attachment.name || '未提供名称' }}</li></ul>
                </article>
                <h4>已有回复文字</h4><pre>{{ state.details[item.requestId].reply || '没有回复文字；请同时查看下方媒体与互动的投递记录。' }}</pre><p v-if="state.details[item.requestId].replyTruncated" class="warning">回复超过 100,000 字，此处仅显示前 100,000 字。</p>
                <h4>实际投递记录</h4><p v-if="!state.details[item.requestId].deliveries.length">尚无投递记录。</p><p v-if="state.details[item.requestId].deliveriesTruncated" class="warning">这里只显示最近 200 条投递记录；上方计数包含全部保留记录。</p>
                <ul><li v-for="output in state.details[item.requestId].deliveries" :key="output.eventId">{{ outputLabel(output.type) }}：{{ deliveryLabel(output.status) }}<span v-if="output.confirmedAt !== undefined"> · 结果记录于 {{ time(output.confirmedAt) }}</span><span v-else-if="output.issuedAt !== undefined"> · 发起于 {{ time(output.issuedAt) }}</span></li></ul>
                <dl class="record-identifiers"><div><dt>请求 ID</dt><dd>{{ item.requestId }}</dd></div><div><dt>输入事件 ID</dt><dd>{{ item.eventId }}</dd></div><div><dt>使用的配置版本</dt><dd>{{ item.policyRevision }}</dd></div></dl>
              </template>
            </details>
          </li>
        </ol>
      </template>
    </template>
  </section>
</template>

<style scoped>
.qq-records { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.record-list { list-style: none; padding: 0; margin: 0; }
.record-card { padding: 12px; border: 1px solid #808080; background: #c0c0c0; margin: 12px 0; overflow-wrap: anywhere; }
.record-card h3 { margin: 0; }
.record-card p { margin: 8px 0; }
.record-preview, pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.record-message { border-bottom: 1px solid #808080; padding: 8px 0; }
.record-identifiers { color: #454545; }
.record-identifiers dd { margin: 4px 0 12px; }
.record-pagination { align-items: center; }
</style>
