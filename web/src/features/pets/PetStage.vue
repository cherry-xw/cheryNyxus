<script setup lang="ts">
import { computed, ref } from 'vue'
import PetSprite from './components/PetSprite.vue'
import { usePetWorld } from './composables/usePetWorld'
import { useAgentsStore, useChatSessionsStore } from '@/application/public'
import type { StreamState } from '@/application/public'
import { selectOwnTimeline, selectActiveMessage } from '@/application/chat/public'
import type { PetInstance } from '@/domain/pets/types'
import { COMPACT_COMMAND, serializeCommandToken } from '@/features/agent/composables/commands'
import { desktopBridge, openQuickComposerWindow } from '@/features/desktop/desktopBridge'

/**
 * 透明模式（Electron desktop surface）：清除网格纹理与渐变背景，只保留 sprite——
 * 全工作区透明覆盖窗下实体外区域全部让给桌面。
 */
const props = withDefaults(defineProps<{ transparent?: boolean }>(), {
  transparent: false,
})

const stageRef = ref<HTMLElement | null>(null)
// pets 单一数据源 = agents store；usePetWorld 注入数组，RAF/交互直接作用于 store state
const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
// 渲染全部 pets（含 ghost 灵魂点）：PetSprite 模板按 isGhost 走 GhostDot 分支，
// ghost 天然无交互（不绑 pointer/hover/click，无 toolbar/气泡）。过滤会让
// GhostDot 分支成为死代码，与 docs/agent-pet.md §5.6 灵魂点语义不符。
const visiblePets = computed(() => agents.pets)
/**
 * Transitional presentation bridge: Pet widgets still accept legacy StreamState,
 * while ChatSession is now authoritative for V2 timeline/session data. This
 * projection keeps the visual surface live without letting it write history.
 */
const visibleStreams = computed<Record<string, StreamState>>(() => {
  const result = { ...agents.streams }
  for (const session of Object.values(chatSessions.sessionsById)) {
    const base: StreamState = result[session.chatId] ?? {
      thinking: '',
      content: '',
      isWorking: false,
      history: [],
      historyLoaded: false,
      historyDirty: false,
      runningTools: [],
      approvalQueue: [],
      questionBatches: [],
    }
    const active = selectActiveMessage(session)
    const turn = session.activeTurns[session.activeTurns.length - 1]
    result[session.chatId] = {
      ...base,
      thinking: turn?.thinking ?? active?.thinking ?? '',
      content: turn?.content ?? active?.content ?? '',
      isWorking: session.run.status === 'running',
      history: selectOwnTimeline(session),
      historyLoaded: session.sync.loaded,
      historyDirty: false,
      approval: session.interaction.approval,
      approvalQueue: session.interaction.approvalQueue,
      runningTools: session.interaction.runningTools,
      questionBatches: session.interaction.questionBatches,
      activeQuestionId: session.interaction.activeQuestionId,
      currentTodo: session.interaction.currentTodo,
      activeRunId: session.run.activeRunId,
    }
  }
  return result
})
function presetAttentionCount(pet: PetInstance): number {
  return agents.historyList
    .filter((chat) =>
      pet.presetId ? chat.presetId === pet.presetId : chat.preset === pet.name,
    )
    .reduce(
      (count, chat) => count + (chat.pendingApproval ? 1 : 0) + (chat.pendingQuestionCount ?? 0),
      0,
    )
}
function activeRoot(pet: PetInstance): string {
  return agents.activeRootForPet(pet)
}
const { isPaused, startDrag, dragPet, endDrag, hoverPet, clickPet, positionRefFor } = usePetWorld(stageRef, agents.pets)

/**
 * 主 pet 点击 → 打开 AgentDialog（设 activeDialogChatId）。
 * 子 pet 点击 → 沿用装饰 clickPet（CP3+ 改路由 HistoryDrawer）。
 * 工作中主 pet 仍可点击（用户可排队下一条）。
 */
async function handleClick(pet: PetInstance): Promise<void> {
  if (pet.isMaster) {
    // Electron desktop 面：发消息改走 composer 原生窗（WindowFrame 外壳承载标题/能力按钮/三键），
    // 会话切换经 main `surface:retarget` 下发，水合由 composer 窗内 App.vue 负责（本面不再管）。
    if (openQuickComposerWindow(activeRoot(pet), 'pet')) return
    const restoringMinimizedWorkbench =
      agents.workbenchMinimized && agents.activeDialogChatId === activeRoot(pet)
    agents.workbenchMinimized = false
    if (!restoringMinimizedWorkbench) {
      agents.activeDialogSource = 'pet'
      agents.activeDialogView = 'composer'
    }
    void agents.fetchHistoryList().catch((e) =>
      console.warn(`[PetStage] fetchHistoryList ${pet.presetId ?? pet.chatId} 失败:`, e),
    )
    // startup 仅 hydrate running root；非运行会话点开时按需加载，AgentDialog 数据渐进填充。
    void chatSessions
      .hydrateTree(activeRoot(pet))
      .catch((e) => console.warn(`[PetStage] hydrateTree ${activeRoot(pet)} 失败:`, e))
    agents.activeDialogChatId = activeRoot(pet)
    return
  }
  clickPet(pet)
}

function handleDoubleClick(pet: PetInstance): void {
  if (!pet.isMaster) return
  // Electron desktop 面：双击与单击同语义（打开 composer 原生窗）
  if (openQuickComposerWindow(activeRoot(pet), 'pet')) return
  const restoringMinimizedWorkbench =
    agents.workbenchMinimized && agents.activeDialogChatId === activeRoot(pet)
  agents.workbenchMinimized = false
  if (!restoringMinimizedWorkbench) {
    agents.activeDialogSource = 'pet'
    agents.activeDialogView = 'composer'
  }
  agents.activeDialogChatId = activeRoot(pet)
}

function handleStroke(pet: PetInstance): void {
  clickPet(pet)
}

function handleStartDrag(pet: PetInstance, event: PointerEvent): void {
  startDrag(pet, event)
}

function handleDrag(pet: PetInstance, event: PointerEvent): void {
  dragPet(pet, event)
}
function handleEndDrag(pet: PetInstance, event: PointerEvent): void {
  endDrag(pet, event)
}

function handleHover(pet: PetInstance, hovering: boolean): void {
  hoverPet(pet, hovering)
}

async function handleAbort(pet: PetInstance): Promise<void> {
  try {
    await chatSessions.abortAgent(activeRoot(pet))
  } catch (e) {
    // 规则 12 fail loud
    console.error('[PetStage] abort failed:', e)
  }
}

function handleDestroy(pet: PetInstance): void {
  // CP8: stage destroy = 隐藏（仅前端移除 pets 含子 pet，不删 DB）；
  //   运行中（isWorking 或任一子 isWorking）由 PetToolbar canHide 守卫禁用按钮
  agents.hide(pet.chatId)
}

async function handleHistory(pet: PetInstance): Promise<void> {
  // 方案 A：默认绑定 preset 工作区内最近更新的 root 会话（历史入口恒定「最新」）；
  //   抽屉内下拉可切换查看其他会话，切换不写 activeRootByPreset/activeNyxusChatId（纯查看器）。
  await agents.fetchHistoryList()
  const latest = agents.latestRootInPreset(pet.presetId, pet.preset)
  agents.openHistoryRoot(latest ?? activeRoot(pet))
}

async function handleAttention(pet: PetInstance): Promise<void> {
  await agents.fetchHistoryList()
  const chats = agents.historyList.filter((chat) =>
    pet.presetId ? chat.presetId === pet.presetId : chat.preset === pet.name,
  )
  const byId = new Map(chats.map((chat) => [chat.chatId, chat]))
  const source = chats.find(
    (chat) => !!chat.pendingApproval || (chat.pendingQuestionCount ?? 0) > 0,
  )
  if (!source) return
  agents.workbenchMinimized = false
  let root = source
  const seen = new Set<string>()
  while (root.parentChatId && !seen.has(root.chatId)) {
    seen.add(root.chatId)
    root = byId.get(root.parentChatId) ?? root
    if (!root.parentChatId) break
  }
  // Electron desktop 面：待处理交互在 composer 原生窗以 attention 视图打开（不抢占 desktop 面状态）。
  const bridge = desktopBridge()
  if (bridge) {
    bridge.openWindow({
      kind: 'composer',
      chatId: root.chatId,
      source: 'history',
      view: 'attention',
    })
    return
  }
  agents.activeDialogSource = 'history'
  agents.activatePresetSession(pet.presetId, root.chatId)
  agents.activeDialogView = 'attention'
  agents.activeDialogChatId = root.chatId
  await chatSessions.hydrateTree(root.chatId)
}

async function handleCompact(pet: PetInstance): Promise<void> {
  try {
    const chatId = activeRoot(pet)
    const content = serializeCommandToken(COMPACT_COMMAND)
    const prepared = chatSessions.prepareInput(chatId, content)
    await chatSessions.submitInput(chatId, content, undefined, prepared)
  } catch (e) {
    console.error('[PetStage] compact failed:', e)
  }
}

async function handleResume(pet: PetInstance): Promise<void> {
  const chatId = activeRoot(pet)
  try {
    await chatSessions.resumeAgent(chatId)
  } catch (e) {
    if ((e as Error & { code?: string }).code === 'RUNTIME_SELECTION_REQUIRED') {
      if (openQuickComposerWindow(chatId, 'pet')) return
      agents.workbenchMinimized = false
      agents.activeDialogSource = 'pet'
      agents.activeDialogView = 'composer'
      agents.activeDialogChatId = chatId
      return
    }
    console.error('[PetStage] resume failed:', e)
  }
}
</script>

<template>
  <main ref="stageRef" class="pet-stage" :class="{ 'is-transparent': transparent }" aria-label="Interactive desktop pets">
    <PetSprite
      v-for="pet in visiblePets"
      :key="pet.instanceId"
      :pet="pet"
      :paused="isPaused"
      :stream="visibleStreams[activeRoot(pet)]"
      :stream-chat-id="activeRoot(pet)"
      :attention-count="presetAttentionCount(pet)"
      :position-ref="positionRefFor(pet)"
      @start-drag="handleStartDrag"
      @drag="handleDrag"
      @end-drag="handleEndDrag"
      @hover="handleHover"
      @click-pet="handleClick"
      @stroke-pet="handleStroke"
      @double-click-pet="handleDoubleClick"
      @history="handleHistory"
      @attention="handleAttention"
      @abort="handleAbort"
      @destroy="handleDestroy"
      @compact="handleCompact"
      @resume="handleResume"
    />
  </main>
</template>

<style scoped lang="less">
.pet-stage {
  // absolute + z-index:auto avoids trapping approval bubbles in a root stacking context.
  // Their z-index:400 must stay above HistoryDrawer's full-screen z-index:280 overlay.
  position: absolute;
  inset: 0;
  overflow: hidden;
  min-width: 320px;
  min-height: 420px;
  background:
    linear-gradient(color-mix(in srgb, var(--accent) 8%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 8%, transparent) 1px, transparent 1px),
    radial-gradient(circle at 18% 18%, var(--stage-glow-a), transparent 30%),
    radial-gradient(circle at 82% 26%, var(--stage-glow-b), transparent 34%),
    linear-gradient(135deg, transparent 0 49.9%, color-mix(in srgb, var(--accent) 4%, transparent) 50%, transparent 50.1%),
    var(--bg);
  background-size:
    42px 42px,
    42px 42px,
    auto,
    auto,
    auto;
  color: var(--ink);

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(180deg, color-mix(in srgb, var(--surface-soft) 42%, transparent), transparent 20%),
      linear-gradient(0deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent 32%);
  }

  // desktop surface：背景全清（含 ::before），透明窗下只保留 sprite 实体
  &.is-transparent {
    background: none;
    color: inherit;

    &::before {
      display: none;
    }
  }
}
</style>
