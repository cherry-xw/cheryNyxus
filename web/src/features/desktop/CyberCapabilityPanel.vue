<script setup lang="ts">
import { computed } from 'vue'
import {
  useAgentsStore,
  useChatSessionsStore,
  useWorkspaceStore,
} from '@/application/public'
import type { WorkspaceWindowState } from '@/application/shell/public'

const props = defineProps<{ window: WorkspaceWindowState }>()
const agents = useAgentsStore()
const chats = useChatSessionsStore()
const workspace = useWorkspaceStore()

const attentionSessions = computed(() =>
  chats.catalogSummaries.filter(
    (summary) => summary.pendingApproval || (summary.pendingQuestionCount ?? 0) > 0,
  ),
)
const routeChatId = computed(() =>
  props.window.context.kind === 'routing' ? props.window.context.chatId : undefined,
)
const routeSummary = computed(() =>
  chats.catalogSummaries.find((summary) => summary.chatId === routeChatId.value),
)
const routeCandidates = computed(() =>
  chats.catalogSummaries.filter(
    (summary) =>
      summary.parentChatId == null &&
      summary.chatId !== routeChatId.value &&
      (routeSummary.value?.presetId
        ? summary.presetId === routeSummary.value.presetId
        : summary.preset === routeSummary.value?.preset),
  ),
)
const rolePreset = computed(() => {
  const context = props.window.context
  if (context.kind !== 'roles') return undefined
  return Object.entries(agents.globalConfig?.presets ?? {}).find(
    ([, preset]) => preset.id === context.presetId,
  )
})
const roleEntries = computed(() => {
  const preset = rolePreset.value?.[1]
  if (!preset) return []
  return [preset.leader, ...(preset.roles ?? []).filter((role) => role !== preset.leader)].map(
    (name) => ({ name, config: agents.globalConfig?.roles?.[name] }),
  )
})

function openAttention(chatId: string): void {
  workspace.activeDialogSource = 'history'
  workspace.activeDialogView = 'attention'
  workspace.activeDialogChatId = chatId
}

function switchRoute(chatId: string): void {
  workspace.activeDialogSource = 'history'
  workspace.activeDialogView = 'composer'
  workspace.activeDialogChatId = chatId
}

function openSettings(): void {
  workspace.settingsOpen = true
}
</script>

<template>
  <div class="cyber-capability">
    <template v-if="window.context.kind === 'attention'">
      <header><span>PENDING OPERATIONS</span><b>{{ attentionSessions.length }}</b></header>
      <button
        v-for="session in attentionSessions"
        :key="session.chatId"
        type="button"
        class="capability-row"
        @click="openAttention(session.chatId)"
      >
        <span>{{ session.preset ?? 'UNBOUND SESSION' }}</span>
        <strong>{{ session.preview ?? session.chatId }}</strong>
        <small>
          {{ session.pendingApproval ? 'APPROVAL' : 'QUESTION' }} /
          {{ session.pendingQuestionCount ?? (session.pendingApproval ? 1 : 0) }}
        </small>
      </button>
      <div v-if="!attentionSessions.length" class="capability-empty">NO PENDING INTERRUPTS</div>
    </template>

    <template v-else-if="window.context.kind === 'routing'">
      <header><span>SESSION ROUTE TRACE</span><b>LIVE</b></header>
      <section class="route-current">
        <small>CURRENT CHANNEL</small>
        <strong>{{ routeSummary?.preview ?? routeChatId }}</strong>
        <code>{{ routeChatId }}</code>
      </section>
      <button
        v-for="session in routeCandidates"
        :key="session.chatId"
        type="button"
        class="capability-row"
        @click="switchRoute(session.chatId)"
      >
        <span>{{ session.preset ?? 'ROUTE CANDIDATE' }}</span>
        <strong>{{ session.preview ?? session.chatId }}</strong>
        <small>{{ session.messageCount ?? session.turnCount ?? 0 }} FACTS</small>
      </button>
      <div v-if="!routeCandidates.length" class="capability-empty">NO ALTERNATE ROUTES</div>
    </template>

    <template v-else-if="window.context.kind === 'roles'">
      <header><span>ROLE ROSTER / {{ rolePreset?.[0] ?? 'UNKNOWN' }}</span><b>{{ roleEntries.length }}</b></header>
      <article v-for="(role, index) in roleEntries" :key="role.name" class="role-row">
        <i>{{ String(index + 1).padStart(2, '0') }}</i>
        <div>
          <strong>{{ role.name }}</strong>
          <span>{{ index === 0 ? 'LEADER CORE' : 'COLLABORATION NODE' }}</span>
        </div>
        <code>{{ role.config?.brain ?? 'NO BRAIN' }} / {{ role.config?.senseGroup ?? 'NO SENSE' }}</code>
      </article>
      <button type="button" class="configure-action" @click="openSettings">OPEN ROLE CONFIGURATION ⇥</button>
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
.capability-row,
.role-row,
.route-current {
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
.capability-row:focus-visible,
.configure-action:hover,
.configure-action:focus-visible {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.capability-row span,
.capability-row small,
.role-row span,
.role-row code,
.route-current small,
.route-current code {
  color: color-mix(in srgb, var(--ink) 54%, transparent);
  font-size: 9px;
}

.capability-row strong,
.role-row strong,
.route-current strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
}

.route-current {
  display: grid;
  gap: 8px;
  margin-top: 7px;
  padding: 16px;
}

.role-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  margin-top: 7px;
  padding: 12px;
}

.role-row i {
  color: var(--accent);
  font-style: normal;
}

.role-row div {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.capability-empty {
  display: grid;
  min-height: 180px;
  place-items: center;
  color: color-mix(in srgb, var(--ink) 38%, transparent);
  font-size: 10px;
  letter-spacing: 0.12em;
}

.configure-action {
  width: 100%;
  margin-top: 10px;
  padding: 11px;
  border: 1px solid var(--cyber-line-soft);
  border-radius: 0;
  background: var(--surface);
  color: var(--accent);
  font: 600 9px/1 var(--font-mono);
  cursor: pointer;
}
</style>
