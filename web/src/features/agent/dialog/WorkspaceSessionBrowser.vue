<script setup lang="ts">
import { computed } from 'vue'
import type { ChatSummary } from '@/services/agentApi'

const props = defineProps<{
  sessions: ChatSummary[]
}>()

const emit = defineEmits<{
  tree: [chatId: string, sourceChatId?: string, interactionId?: string]
}>()

const byId = computed(() => new Map(props.sessions.map((chat) => [chat.chatId, chat])))

function rootOf(chat: ChatSummary): ChatSummary {
  let current = chat
  const seen = new Set<string>()
  while (current.parentChatId && !seen.has(current.chatId)) {
    seen.add(current.chatId)
    const parent = byId.value.get(current.parentChatId)
    if (!parent) break
    current = parent
  }
  return current
}

const attentionItems = computed(() =>
  props.sessions.flatMap((chat) => {
    const root = rootOf(chat)
    const source = chat.agentType || chat.preview || chat.chatId.slice(0, 8)
    const approval = chat.pendingApproval
      ? [
          {
            id: chat.pendingApproval.approvalId,
            rootChatId: root.chatId,
            sourceChatId: chat.chatId,
            type: 'approval' as const,
            title: `确认 ${chat.pendingApproval.senseName}`,
            source,
            createdAt: chat.pendingApproval.createdAt,
          },
        ]
      : []
    const questions = (chat.pendingQuestions ?? []).map((question) => ({
      id: question.questionId,
      rootChatId: root.chatId,
      sourceChatId: chat.chatId,
      type: 'question' as const,
      title: question.header || question.question,
      source,
      createdAt: question.createdAt,
    }))
    return [...approval, ...questions]
  }).sort((a, b) => a.createdAt - b.createdAt),
)

function titleOf(chat: ChatSummary): string {
  return chat.preview?.trim() || `会话 ${chat.chatId.slice(0, 8)}`
}

function timeOf(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : ''
}
</script>

<template>
  <section class="workspace-browser" aria-label="待处理交互">
    <header class="browser-head">
      <strong>待处理交互</strong>
      <span>{{ attentionItems.length }} 项待处理</span>
    </header>

    <div class="browser-list">
      <button
        v-for="item in attentionItems"
        :key="`${item.type}:${item.id}`"
        type="button"
        class="attention-row"
        @click="emit('tree', item.rootChatId, item.sourceChatId, item.id)"
      >
        <span class="attention-kind">{{ item.type === 'approval' ? '需确认' : '需回答' }}</span>
        <span class="attention-copy">
          <strong>{{ item.title }}</strong>
          <small>{{ titleOf(byId.get(item.rootChatId)!) }} → {{ item.source }}</small>
        </span>
        <span class="attention-time">{{ timeOf(item.createdAt) }}</span>
      </button>
      <p v-if="attentionItems.length === 0" class="empty">当前 Pet 没有待处理交互</p>
    </div>
  </section>
</template>

<style scoped lang="less">
.workspace-browser { min-height: 280px; padding: 12px 14px 16px; overflow: hidden; }
.browser-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; color:var(--ink); }
.browser-head strong { font-size:13px; }
.browser-head span { color:color-mix(in srgb, var(--ink) 55%, transparent); font-size:10px; }
.browser-list { display:flex; flex-direction:column; gap:7px; max-height:min(52vh,430px); overflow:auto; }
.attention-row { display:flex; align-items:center; gap:9px; width:100%; padding:9px; border:1px solid color-mix(in srgb, var(--ink) 12%, transparent); border-radius:10px; background:var(--surface); text-align:left; cursor:pointer; }
.attention-kind { flex:none; padding:3px 6px; border-radius:999px; background:color-mix(in srgb, #f6b73c 20%, var(--surface-soft)); color:color-mix(in srgb, #c25b12 78%, var(--ink)); font-size:9px; font-weight:800; }
.attention-copy { flex:1; min-width:0; }
.attention-copy strong,.attention-copy small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.attention-copy strong { color:var(--ink); font-size:11px; }
.attention-copy small { margin-top:3px; color:color-mix(in srgb, var(--ink) 55%, transparent); font-size:9px; }
.attention-time { flex:none; color:color-mix(in srgb, var(--ink) 50%, transparent); font-size:8px; }
.empty { margin:36px 0; text-align:center; color:color-mix(in srgb, var(--ink) 50%, transparent); font-size:11px; }
</style>