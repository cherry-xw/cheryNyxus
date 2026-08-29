<script setup lang="ts">
import { ref } from 'vue'
import type { FeedbackAction, UserFeedback } from '@chery/protocol'
import { useAgentsStore, useChatSessionsStore, useConnectionStore } from '@/application/public'
import { desktopBridge, openQuickComposerWindow } from '@/features/desktop/desktopBridge'
import { FEEDBACK_ACTION_LABEL } from '@/domain/chat/runOutcome'

const props = defineProps<{
  feedback: UserFeedback
  chatId: string
  compact?: boolean
}>()

const emit = defineEmits<{ dismiss: [] }>()
const chats = useChatSessionsStore()
const connection = useConnectionStore()
const agents = useAgentsStore()
const detailsOpen = ref(false)
const busyAction = ref<string>()
const copied = ref(false)
const dismissed = ref(false)

async function execute(action: FeedbackAction): Promise<void> {
  if (action.type === 'view_details') {
    detailsOpen.value = !detailsOpen.value
    return
  }
  if (action.type === 'dismiss') {
    dismissed.value = true
    emit('dismiss')
    return
  }
  busyAction.value = action.type
  try {
    if (action.type === 'resume_run' || action.type === 'retry') {
      await chats.resumeAgent(props.chatId)
    } else if (action.type === 'reconnect') {
      await connection.reconnect()
    } else if (action.type === 'open_settings') {
      const bridge = desktopBridge()
      if (bridge) bridge.openWindow({ kind: 'settings', settingsSection: action.section })
      else {
        agents.settingsSection = action.section
        agents.settingsOpen = true
      }
    } else if (action.type === 'resend_input' || action.type === 'select_chat') {
      if (!openQuickComposerWindow(props.chatId, 'pet')) {
        agents.workbenchMinimized = false
        agents.activeDialogSource = 'pet'
        agents.activeDialogView = 'composer'
        agents.activeDialogChatId = props.chatId
      }
    }
  } finally {
    busyAction.value = undefined
  }
}

async function copyDiagnostics(): Promise<void> {
  const diagnostics = [
    props.feedback.tracingId ? `trace=${props.feedback.tracingId}` : '',
    props.feedback.detail ?? '',
  ]
    .filter(Boolean)
    .join('\n')
  if (!diagnostics) return
  await navigator.clipboard.writeText(diagnostics)
  copied.value = true
  window.setTimeout(() => (copied.value = false), 1200)
}
</script>

<template>
  <section
    v-if="!dismissed"
    class="feedback-card"
    :class="[`is-${feedback.severity}`, { compact }]"
    role="status"
  >
    <header>
      <span class="feedback-icon" aria-hidden="true">{{
        feedback.severity === 'error' ? '⛔' : feedback.severity === 'warning' ? '⚠' : 'ℹ'
      }}</span>
      <strong>{{ feedback.title }}</strong>
    </header>
    <p>{{ feedback.description }}</p>
    <p v-if="feedback.guidance" class="feedback-guidance">{{ feedback.guidance }}</p>
    <div v-if="feedback.actions.length" class="feedback-actions">
      <button
        v-for="(action, index) in feedback.actions"
        :key="`${action.type}-${index}`"
        type="button"
        :class="{ primary: index === 0 }"
        :disabled="busyAction !== undefined"
        @click="execute(action)"
      >
        {{ busyAction === action.type ? '处理中…' : FEEDBACK_ACTION_LABEL[action.type] }}
      </button>
    </div>
    <div v-if="detailsOpen && (feedback.tracingId || feedback.detail)" class="feedback-details">
      <code v-if="feedback.tracingId">追踪码：{{ feedback.tracingId }}</code>
      <code v-if="feedback.detail">{{ feedback.detail }}</code>
      <button type="button" @click="copyDiagnostics">{{ copied ? '已复制' : '复制详情' }}</button>
    </div>
  </section>
</template>

<style scoped lang="less">
.feedback-card {
  color: var(--ink);
  font-size: 12px;
  line-height: 1.45;

  header {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  p {
    margin: 5px 0 0;
    font-weight: 500;
    white-space: normal;
  }
  .feedback-guidance {
    color: color-mix(in srgb, var(--ink) 72%, transparent);
  }
  .feedback-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 8px;
  }
  button {
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 3px 7px;
    background: var(--surface);
    color: var(--ink);
    cursor: pointer;
    font-size: 11px;
  }
  button.primary {
    border-color: currentColor;
    font-weight: 700;
  }
  button:disabled {
    cursor: wait;
    opacity: 0.55;
  }
  .feedback-details {
    display: grid;
    gap: 4px;
    margin-top: 7px;
    padding-top: 6px;
    border-top: 1px dashed var(--border);
  }
  code {
    overflow-wrap: anywhere;
    font-size: 10px;
    font-weight: 400;
  }
  &.is-error {
    color: var(--danger);
  }
  &.is-warning {
    color: var(--warning, #b7791f);
  }
  &.is-info {
    color: var(--accent);
  }
  &.compact {
    font-size: 11px;
  }
}
</style>
