<script setup lang="ts">
import { computed } from 'vue'
import { useChatSessionsStore, useWorkspaceStore } from '@/application/public'
import type { WorkspaceWindowState } from '@/application/shell/public'

const props = defineProps<{ window: WorkspaceWindowState }>()
const chats = useChatSessionsStore()
const workspace = useWorkspaceStore()

const attentionSessions = computed(() =>
  chats.catalogSummaries.filter(
    (summary) => summary.pendingApproval || (summary.pendingQuestionCount ?? 0) > 0,
  ),
)

function openAttention(chatId: string): void {
  workspace.activeDialogSource = 'history'
  workspace.activeDialogView = 'attention'
  workspace.activeDialogChatId = chatId
}
</script>

<template>
  <div class="cyber-capability">
    <template v-if="window.context.kind === 'attention'">
      <header><span>待处理操作</span><b>{{ attentionSessions.length }}</b></header>
      <button
        v-for="session in attentionSessions"
        :key="session.chatId"
        type="button"
        class="capability-row"
        @click="openAttention(session.chatId)"
      >
        <span>{{ session.preset ?? '未绑定会话' }}</span>
        <strong>{{ session.preview ?? session.chatId }}</strong>
        <small>
          {{ session.pendingApproval ? '审批' : '提问' }} /
          {{ session.pendingQuestionCount ?? (session.pendingApproval ? 1 : 0) }}
        </small>
      </button>
      <div v-if="!attentionSessions.length" class="capability-empty">暂无待处理中断</div>
    </template>
  </div>
</template>

<style scoped lang="less">
.cyber-capability {
  height: 100%;
  overflow: auto;
  padding: 14px;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 4%, transparent) 1px, transparent 1px),
    linear-gradient(color-mix(in srgb, var(--accent) 4%, transparent) 1px, transparent 1px);
  background-size: 18px 18px;
  font-family: var(--font-mono);
}

header,
.capability-row {
  border: 1px solid var(--cyber-line-soft);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
}

header {
  position: sticky;
  z-index: 2;
  top: 0;
  display: flex;
  justify-content: space-between;
  padding: 9px 11px;
  color: var(--accent);
  font-size: 10px;
  letter-spacing: 0.1em;
}

header b {
  font-weight: 600;
}

.capability-row {
  width: 100%;
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  margin-top: 7px;
  padding: 12px;
  border-radius: 0;
  color: var(--ink);
  text-align: left;
  cursor: pointer;
}

.capability-row:hover,
.capability-row:focus-visible {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.capability-row span,
.capability-row small {
  color: color-mix(in srgb, var(--ink) 54%, transparent);
  font-size: 9px;
}

.capability-row strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
}

.capability-empty {
  display: grid;
  min-height: 180px;
  place-items: center;
  color: color-mix(in srgb, var(--ink) 38%, transparent);
  font-size: 10px;
  letter-spacing: 0.12em;
}
</style>
