<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useTaskOverviewStore, useWorkspaceStore } from '@/application/public'
import type { InteractionRecord, TaskOverview } from '@/application/backend/public'
import { desktopBridge } from '@/features/desktop/desktopBridge'
import TaskCenterAttentionWorkspace from './TaskCenterAttentionWorkspace.vue'

type WorkspaceMode = 'overview' | 'attention'
type TaskFilter = 'unfinished' | 'completed' | 'all'

const FILTERS: Array<{ id: TaskFilter; label: string; tip: string }> = [
  {
    id: 'unfinished',
    label: '未完成',
    tip: '尚未结束的任务，包括运行中、等你处理、已暂停和有失败。',
  },
  {
    id: 'completed',
    label: '本次完成',
    tip: '从本次任务中心会话开始后完成的任务，不包含更早的历史任务。',
  },
  {
    id: 'all',
    label: '全部',
    tip: '当前任务中心保留的所有任务：未完成任务与本次完成任务。',
  },
]

const overview = useTaskOverviewStore()
const workspace = useWorkspaceStore()
const workspaceMode = ref<WorkspaceMode>('overview')
const filter = ref<TaskFilter>('unfinished')
const selectedRootId = ref<string>()
const cleanup: Array<() => void> = []

const unfinishedCount = computed(
  () => overview.tasks.filter((task) => task.status !== 'completed').length,
)
const completedCount = computed(
  () => overview.tasks.filter((task) => task.status === 'completed').length,
)
const visibleTasks = computed(() =>
  overview.tasks.filter((task) => {
    if (filter.value === 'all') return true
    return filter.value === 'completed' ? task.status === 'completed' : task.status !== 'completed'
  }),
)
const taskGroups = computed(() => {
  const pinned = new Set(overview.pinnedRootIds)
  return [
    {
      id: 'pinned',
      label: '已关注',
      description: '固定在当前筛选顶部，快速查看最新活动。',
      tasks: visibleTasks.value.filter((task) => pinned.has(task.rootChatId)),
    },
    {
      id: 'other',
      label: pinned.size ? '其他任务' : '任务',
      description: '',
      tasks: visibleTasks.value.filter((task) => !pinned.has(task.rootChatId)),
    },
  ].filter((group) => group.tasks.length > 0)
})
const selectedTask = computed(() =>
  visibleTasks.value.find((task) => task.rootChatId === selectedRootId.value),
)
const selectedTaskPinned = computed(
  () => !!selectedTask.value && overview.pinnedRootIds.includes(selectedTask.value.rootChatId),
)
const canPinSelected = computed(() => selectedTaskPinned.value || overview.pinnedRootIds.length < 3)

watch(
  visibleTasks,
  (tasks) => {
    if (!tasks.some((task) => task.rootChatId === selectedRootId.value)) {
      selectedRootId.value = tasks[0]?.rootChatId
    }
  },
  { immediate: true },
)

onMounted(() => {
  workspace.setWorkspaceWindowAttention('window:task-center', false)
  const bridge = desktopBridge()
  if (bridge) {
    cleanup.push(
      bridge.onWindowFocused((focused) => {
        if (focused) bridge.flashFrame(false)
      }),
      watch(
        () => overview.pendingCount,
        (count, previous) => {
          if (count > previous && !document.hasFocus()) bridge.flashFrame(true)
        },
      ),
    )
  }
})

onBeforeUnmount(() => cleanup.splice(0).forEach((stop) => stop()))

function filterCount(id: TaskFilter): number {
  return id === 'unfinished'
    ? unfinishedCount.value
    : id === 'completed'
      ? completedCount.value
      : overview.tasks.length
}

function statusLabel(status: TaskOverview['status']): string {
  return {
    needs_user: '等你处理',
    running: '运行中',
    paused: '已暂停',
    failed: '有失败',
    completed: '已完成',
  }[status]
}

function statusDescription(status: TaskOverview['status']): string {
  return {
    needs_user: '存在需要你审批或回答的操作，处理后 Agent 才能继续。',
    running: '至少一个 Agent 正在执行任务步骤。',
    paused: '当前没有 Agent 在运行，但任务尚未结束。',
    failed: '至少一个 Agent 执行失败，可打开节点树查看原因。',
    completed: '任务已结束；任务中心只保留本次会话内的完成记录。',
  }[status]
}

function agentStatusLabel(status: TaskOverview['agents'][number]['status']): string {
  return status === 'idle' ? '空闲' : statusLabel(status)
}

function formatTime(value?: number): string {
  return value
    ? new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(value)
    : '—'
}

function latestActivity(task: TaskOverview): string {
  return task.recentEvents.at(-1)?.label ?? '等待关键活动'
}

function toggleSelectedPin(): void {
  if (selectedTask.value && canPinSelected.value) overview.togglePin(selectedTask.value.rootChatId)
}

function openWorkbench(task: TaskOverview, focus?: InteractionRecord): void {
  if (!task.presetId) {
    workspace.openHistoryRoot(focus?.chatId ?? task.rootChatId)
    return
  }
  const bridge = desktopBridge()
  if (bridge) {
    bridge.openWindow({
      kind: 'workbench',
      presetId: task.presetId,
      presetName: task.preset,
      chatId: task.rootChatId,
      view: 'tree',
      focus: focus
        ? {
            sourceChatId: focus.chatId,
            interactionId: focus.interactionId,
            anchorNodeId: focus.anchorNodeId,
          }
        : { sourceChatId: task.rootChatId },
    })
    return
  }
  const windowId = workspace.openWorkbenchWindow(task.presetId, task.preset)
  workspace.setWorkbenchWindowChat(windowId, task.rootChatId)
  workspace.setWorkbenchWindowView(windowId, 'tree')
  if (focus) {
    workspace.setWorkbenchWindowFocus(windowId, {
      sourceChatId: focus.chatId,
      interactionId: focus.interactionId,
      anchorNodeId: focus.anchorNodeId,
    })
  }
}

function locateInteraction(item: InteractionRecord): void {
  const task = overview.tasksByRoot[item.rootChatId]
  if (task) openWorkbench(task, item)
  else workspace.openHistoryRoot(item.chatId || item.rootChatId)
}
</script>

<template>
  <main class="task-center">
    <header class="command-bar">
      <nav class="workspace-tabs" aria-label="任务中心工作区">
        <button
          type="button"
          :class="{ active: workspaceMode === 'overview' }"
          :aria-pressed="workspaceMode === 'overview'"
          @click="workspaceMode = 'overview'"
        >
          <span>任务概览</span>
          <small>查看状态与进展</small>
        </button>
        <button
          type="button"
          :class="{ active: workspaceMode === 'attention', alert: overview.pendingCount > 0 }"
          :aria-pressed="workspaceMode === 'attention'"
          @click="workspaceMode = 'attention'"
        >
          <span
            >等你处理 <b>{{ overview.pendingCount }}</b></span
          >
          <small>审批或回答后 Agent 才能继续</small>
        </button>
      </nav>

      <dl class="summary-stats" aria-label="任务中心摘要">
        <div title="未完成任务与本次会话内完成的任务">
          <dt>当前任务</dt>
          <dd>{{ overview.tasks.length }}</dd>
        </div>
        <div title="至少有一个 Agent 正在执行的任务">
          <dt>运行中</dt>
          <dd>{{ overview.runningCount }}</dd>
        </div>
      </dl>
      <span v-if="overview.error" class="load-error" role="alert">{{ overview.error }}</span>
    </header>

    <p class="workspace-description">
      {{
        workspaceMode === 'overview'
          ? '集中查看尚未结束及本次会话内刚完成的任务。选择任务可查看 Agent 状态和关键活动。'
          : '这里只列出需要你参与的操作。处理前可查看原因、影响、后续步骤和原会话详情。'
      }}
    </p>

    <section v-if="workspaceMode === 'overview'" class="overview-workspace">
      <aside class="task-list-pane">
        <header class="pane-title">
          <h2>任务列表</h2>
          <p>按任务是否结束进行筛选；“等你处理”已移到独立工作区。</p>
        </header>
        <nav class="filters" aria-label="按任务生命周期筛选">
          <el-tooltip
            v-for="item in FILTERS"
            :key="item.id"
            :content="item.tip"
            placement="bottom"
            :show-after="250"
          >
            <button
              type="button"
              :class="{ active: filter === item.id }"
              :aria-label="`${item.label}：${item.tip}`"
              :aria-pressed="filter === item.id"
              @click="filter = item.id"
            >
              {{ item.label }} <span>{{ filterCount(item.id) }}</span>
            </button>
          </el-tooltip>
        </nav>

        <div class="task-list">
          <section v-for="group in taskGroups" :key="group.id" class="task-group">
            <header>
              <strong>{{ group.label }}</strong>
              <small v-if="group.description">{{ group.description }}</small>
            </header>
            <button
              v-for="task in group.tasks"
              :key="task.rootChatId"
              type="button"
              class="task-card"
              :class="[
                `is-${task.status}`,
                { selected: task.rootChatId === selectedTask?.rootChatId },
              ]"
              @click="selectedRootId = task.rootChatId"
            >
              <span class="status-dot" />
              <b>{{ task.title }}</b>
              <span class="task-status">{{ statusLabel(task.status) }}</span>
              <small>{{ task.preset ?? '未命名预设' }} · {{ task.agents.length }} Agent</small>
              <span v-if="task.pendingCount" class="pending-count"
                >待处理 {{ task.pendingCount }}</span
              >
              <span v-if="group.id === 'pinned'" class="latest-activity">
                {{ latestActivity(task) }} ·
                {{ formatTime(task.recentEvents.at(-1)?.at ?? task.updatedAt) }}
              </span>
            </button>
          </section>
          <div v-if="visibleTasks.length === 0" class="empty-state">
            <strong>当前筛选下没有任务</strong>
            <p>{{ FILTERS.find((item) => item.id === filter)?.tip }}</p>
          </div>
        </div>
      </aside>

      <section class="task-detail-pane">
        <template v-if="selectedTask">
          <header class="task-detail-head">
            <div>
              <small>{{ selectedTask.preset ?? '任务' }}</small>
              <h2>{{ selectedTask.title }}</h2>
              <p>{{ statusDescription(selectedTask.status) }}</p>
            </div>
            <span class="detail-status" :class="`is-${selectedTask.status}`">
              {{ statusLabel(selectedTask.status) }}
            </span>
            <button
              type="button"
              :disabled="!canPinSelected"
              :title="
                canPinSelected
                  ? selectedTaskPinned
                    ? '取消关注后，任务将回到普通排序。'
                    : '关注后固定在任务列表顶部，最多 3 个。'
                  : '已达到 3 个关注任务的上限。'
              "
              @click="toggleSelectedPin"
            >
              {{ selectedTaskPinned ? '取消关注' : `关注任务 ${overview.pinnedRootIds.length}/3` }}
            </button>
            <button type="button" @click="openWorkbench(selectedTask)">打开节点树 ↗</button>
          </header>

          <section class="detail-section agents" aria-labelledby="agents-title">
            <header>
              <h3 id="agents-title">参与 Agent</h3>
              <p>展示每个 Agent 当前所处的状态和正在执行的步骤。</p>
            </header>
            <div class="agent-grid">
              <article v-for="agent in selectedTask.agents" :key="agent.chatId">
                <span class="agent-state" :class="`is-${agent.status}`" />
                <div>
                  <b>{{ agent.role }}</b>
                  <small>{{ agent.currentStep ?? agentStatusLabel(agent.status) }}</small>
                </div>
                <time>{{ formatTime(agent.startedAt) }}</time>
              </article>
            </div>
            <p v-if="selectedTask.agents.length === 0" class="section-empty">还没有 Agent 状态。</p>
          </section>

          <section class="detail-section activity" aria-labelledby="activity-title">
            <header>
              <h3 id="activity-title">关键活动</h3>
              <p>只展示开始、完成、失败和 Agent 变化等关键事件，不包含完整消息流。</p>
            </header>
            <ol>
              <li v-for="event in [...selectedTask.recentEvents].reverse()" :key="event.id">
                <time>{{ formatTime(event.at) }}</time
                ><span>{{ event.label }}</span>
              </li>
            </ol>
            <p v-if="selectedTask.recentEvents.length === 0" class="section-empty">
              尚无关键活动。
            </p>
          </section>
        </template>
        <div v-else class="detail-empty">
          <strong>选择一个任务查看详情</strong>
          <p>任务详情包含状态含义、Agent 进展和关键活动。</p>
        </div>
      </section>
    </section>

    <TaskCenterAttentionWorkspace v-else @locate="locateInteraction" />
  </main>
</template>

<style scoped lang="less">
.task-center {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  padding: 16px;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.6;
  container-type: inline-size;
  background: var(--bg);
  color: var(--ink);
}
.task-center :deep(button),
.task-center :deep(input),
.task-center :deep(textarea),
.task-center :deep(b),
.task-center :deep(strong) {
  font-family: inherit;
  font-weight: 400;
}
.task-center :deep(button) {
  border-radius: 0;
  font-size: 13px;
  line-height: 1.5;
}
.task-center :deep(small) {
  font-size: 12px;
  line-height: 1.5;
}
.task-center :deep(h2),
.task-center :deep(h3) {
  font-weight: 600;
  line-height: 1.4;
}
.task-center :deep(button:focus-visible),
.task-center :deep(summary:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.command-bar {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 12px;
}
.workspace-tabs {
  display: flex;
  min-width: 0;
  gap: 5px;
}
.workspace-tabs button {
  display: grid;
  gap: 2px;
  min-width: 180px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  background: var(--surface);
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.workspace-tabs button.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.workspace-tabs button.alert:not(.active) {
  border-color: color-mix(in srgb, var(--warning) 62%, transparent);
}
.workspace-tabs span {
  font-size: 13px;
}
.workspace-tabs b {
  margin-left: 4px;
  padding: 1px 5px;
  background: var(--warning);
  color: var(--bg);
  font-size: 12px;
}
.workspace-tabs small {
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  font-size: 12px;
}
.summary-stats {
  display: flex;
  gap: 5px;
  margin: 0 0 0 auto;
}
.summary-stats div {
  min-width: 80px;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: var(--surface);
}
.summary-stats dt {
  color: color-mix(in srgb, var(--ink) 50%, transparent);
  font: 12px/1.2 var(--font-mono);
}
.summary-stats dd {
  margin: 2px 0 0;
  font: 400 18px/1.2 var(--font-mono);
}
.load-error {
  align-self: center;
  color: var(--danger);
  font-size: 12px;
}
.workspace-description {
  flex: none;
  margin: 8px 0 12px;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 12px;
  line-height: 1.45;
}
.overview-workspace {
  display: grid;
  grid-template-columns: minmax(275px, 330px) minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
  flex: 1;
}
.task-list-pane,
.task-detail-pane {
  min-width: 0;
  min-height: 0;
  border: 1px solid color-mix(in srgb, var(--ink) 13%, transparent);
  background: var(--surface);
}
.task-list-pane {
  display: flex;
  flex-direction: column;
}
.pane-title {
  padding: 16px 16px 12px;
}
.pane-title h2 {
  margin: 0;
  font-size: 15px;
}
.pane-title p,
.detail-section > header p {
  margin: 4px 0 0;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  font-size: 12px;
  line-height: 1.45;
}
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 16px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
}
.filters button,
.task-detail-head button {
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
}
.filters button.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.filters button span {
  margin-left: 2px;
  opacity: 0.62;
  font-variant-numeric: tabular-nums;
}
.task-detail-head button:disabled {
  opacity: 0.4;
  cursor: default;
}
.task-list {
  min-height: 0;
  overflow: auto;
  padding: 12px;
}
.task-group + .task-group {
  margin-top: 12px;
}
.task-group > header {
  display: grid;
  gap: 2px;
  padding: 0 2px 6px;
}
.task-group > header strong {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.task-group > header small {
  color: color-mix(in srgb, var(--ink) 48%, transparent);
  font-size: 12px;
}
.task-card {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  gap: 4px 7px;
  width: 100%;
  padding: 12px;
  border: 1px solid transparent;
  background: var(--surface-soft);
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.task-card + .task-card {
  margin-top: 8px;
}
.task-card.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.task-card b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.task-card > small {
  grid-column: 2;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  overflow-wrap: anywhere;
}
.task-status {
  grid-column: 3;
  grid-row: 1 / 3;
  align-self: center;
  font: 12px/1.2 var(--font-mono);
}
.pending-count {
  grid-column: 2 / -1;
  color: var(--warning);
  font-size: 12px;
}
.latest-activity {
  grid-column: 2 / -1;
  overflow: hidden;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-dot,
.agent-state {
  width: 7px;
  height: 7px;
  margin-top: 4px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 30%, transparent);
}
.is-running .status-dot,
.agent-state.is-running {
  background: var(--success);
}
.is-needs_user .status-dot,
.agent-state.is-needs_user {
  background: var(--warning);
}
.is-failed .status-dot,
.agent-state.is-failed {
  background: var(--danger);
}
.is-completed .status-dot,
.agent-state.is-completed {
  background: var(--accent);
}
.task-detail-pane {
  overflow: auto;
  padding: 16px;
}
.task-detail-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 16px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 11%, transparent);
}
.task-detail-head > div {
  min-width: 0;
  margin-right: auto;
  flex: 1 1 240px;
}
.task-detail-head > div > small {
  color: var(--accent);
  font: 12px/1.2 var(--font-mono);
}
.task-detail-head h2 {
  margin: 3px 0 0;
  overflow-wrap: anywhere;
  font-size: 18px;
}
.task-detail-head p {
  margin: 5px 0 0;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 12px;
  line-height: 1.45;
}
.detail-status {
  flex: none;
  padding: 4px 7px;
  background: var(--surface-soft);
  font-size: 12px;
}
.detail-status.is-needs_user {
  color: var(--warning);
}
.detail-status.is-running {
  color: var(--success);
}
.detail-status.is-failed {
  color: var(--danger);
}
.detail-section {
  margin-top: 24px;
}
.detail-section > header {
  margin-bottom: 8px;
}
.detail-section h3 {
  margin: 0;
  font-size: 13px;
}
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr));
  gap: 6px;
}
.agent-grid article {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  padding: 9px;
  background: var(--surface-soft);
}
.agent-grid small {
  display: block;
  margin-top: 2px;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  overflow-wrap: anywhere;
}
.agent-grid time,
.activity time {
  color: color-mix(in srgb, var(--ink) 45%, transparent);
  font: 12px/1.3 var(--font-mono);
}
.activity ol {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.activity li {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 8px;
  font-size: 12px;
}
.section-empty,
.empty-state,
.detail-empty {
  color: color-mix(in srgb, var(--ink) 50%, transparent);
  text-align: center;
  font-size: 12px;
}
.empty-state,
.detail-empty {
  padding: 24px;
}
.empty-state p,
.detail-empty p {
  margin: 5px 0 0;
  line-height: 1.45;
}
.detail-empty {
  margin: auto;
}
@container (max-width: 820px) {
  .command-bar {
    flex-wrap: wrap;
  }
  .summary-stats {
    margin-left: 0;
  }
  .workspace-tabs {
    width: 100%;
  }
  .workspace-tabs button {
    min-width: 0;
    flex: 1;
  }
  .overview-workspace {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(220px, 38%) minmax(0, 1fr);
  }
  .task-detail-head {
    flex-wrap: wrap;
  }
}
</style>
