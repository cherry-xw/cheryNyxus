<script setup lang="ts">
import { ref } from 'vue'
import { agentApi, type ChatSummary } from '@/application/backend/public'
import { useWorkspaceStore } from '@/application/public'

const workspace = useWorkspaceStore()
const dialog = ref<HTMLDialogElement>()
const chats = ref<ChatSummary[]>([])
const loading = ref(false)
const error = ref('')

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    chats.value = (await agentApi.listChats({ scope: 'history', includePreview: true })).filter(
      (chat) => chat.lifecycle === 'archived' && !chat.parentChatId,
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '加载归档会话失败，请重试'
  } finally {
    loading.value = false
  }
}

function open() {
  dialog.value?.showModal()
  void refresh()
}

function viewHistory(chatId: string) {
  dialog.value?.close()
  workspace.openHistoryRoot(chatId)
}
</script>

<template>
  <button type="button" @click="open">归档验收（临时）</button>
  <Teleport to="body">
    <dialog ref="dialog" aria-labelledby="archive-verification-title" class="archive-verification">
      <header>
        <h2 id="archive-verification-title">归档验收（临时）</h2>
        <button type="button" @click="dialog?.close()">关闭</button>
      </header>
      <p>这些会话已归档，不可继续执行。查看历史不会恢复预设或会话。</p>
      <button type="button" :disabled="loading" @click="refresh">刷新列表</button>
      <p v-if="loading" role="status">正在读取归档会话…</p>
      <p v-else-if="error" role="alert">{{ error }}</p>
      <p v-else-if="!chats.length">暂无已归档的主会话。</p>
      <ul v-else>
        <li v-for="chat in chats" :key="chat.chatId">
          <strong>{{ chat.preset ?? chat.presetId ?? '未命名预设' }} · 已归档</strong>
          <code>{{ chat.chatId }}</code>
          <p>{{ chat.preview || '无用户消息预览' }}</p>
          <span>消息数：{{ chat.messageCount ?? '未知' }}</span>
          <button type="button" @click="viewHistory(chat.chatId)">查看历史</button>
        </li>
      </ul>
    </dialog>
  </Teleport>
</template>

<style scoped>
.archive-verification {
  width: min(720px, calc(100vw - 32px));
  max-height: 80vh;
  overflow: auto;
  padding: 20px;
  border: 1px solid var(--ink);
  border-radius: 12px;
  background: var(--cyber-desktop-bg, #161b24);
  color: var(--ink, #eee);
}
.archive-verification::backdrop {
  background: #0008;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
h2 {
  font-size: 18px;
}
ul {
  list-style: none;
  padding: 0;
}
li {
  padding: 16px 0;
  border-bottom: 1px solid #8885;
}
code {
  display: block;
  overflow-wrap: anywhere;
  margin-top: 8px;
}
li button {
  margin-left: 16px;
}
button {
  cursor: pointer;
}
</style>
