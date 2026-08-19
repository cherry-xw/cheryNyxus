<script setup lang="ts">
import { computed, ref } from 'vue'
import PetSprite from './components/PetSprite.vue'
import { usePetWorld } from './composables/usePetWorld'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import type { StreamState } from '@/stores'
import { selectOwnTimeline, selectActiveMessage } from '@/stores/chats/selectors'
import type { PetInstance } from './types/types'
import { COMPACT_COMMAND, serializeCommandToken } from '@/features/agent/composables/commands'

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
const visiblePets = computed(() => agents.pets.filter((pet) => !pet.isGhost))
/**
 * Transitional presentation bridge: Pet widgets still accept legacy StreamState,
 * while ChatSession is now authoritative for V2 timeline/session data. This
 * projection keeps the visual surface live without letting it write history.
 */
const visibleStreams = computed<Record<string, StreamState>>(() => {
  const result = { ...agents.streams }
  for (const session of Object.values(chatSessions.sessionsById)) {
    const base = result[session.chatId]
    if (!base) continue
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
const { isPaused, startDrag, dragPet, endDrag, hoverPet, clickPet } = usePetWorld(stageRef, agents.pets)

/**
 * 主 pet 点击 → 打开 AgentDialog（设 activeDialogChatId）。
 * 子 pet 点击 → 沿用装饰 clickPet（CP3+ 改路由 HistoryDrawer）。
 * 工作中主 pet 仍可点击（用户可排队下一条）。
 */
async function handleClick(pet: PetInstance): Promise<void> {
  if (pet.isMaster) {
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
  agents.activeDialogSource = 'history'
  agents.activatePresetSession(pet.presetId, root.chatId)
  agents.activeDialogView = 'attention'
  agents.activeDialogChatId = root.chatId
  await chatSessions.hydrateTree(root.chatId)
}

async function handleCompact(pet: PetInstance): Promise<void> {
  try {
    await chatSessions.sendMessage(activeRoot(pet), serializeCommandToken(COMPACT_COMMAND))
  } catch (e) {
    console.error('[PetStage] compact failed:', e)
  }
}

async function handleResume(pet: PetInstance): Promise<void> {
  try {
    await chatSessions.resumeAgent(activeRoot(pet))
  } catch (e) {
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
      :attention-count="presetAttentionCount(pet)"
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
    linear-gradient(color-mix(in srgb, var(--ink) 9%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--ink) 9%, transparent) 1px, transparent 1px),
    radial-gradient(circle at 18% 18%, rgba(255, 196, 87, 0.34), transparent 28%),
    radial-gradient(circle at 82% 28%, rgba(88, 196, 189, 0.28), transparent 30%),
    radial-gradient(circle at 50% 80%, rgba(151, 122, 255, 0.26), transparent 34%), var(--bg);
  background-size:
    42px 42px,
    42px 42px,
    auto,
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
      linear-gradient(180deg, color-mix(in srgb, var(--surface-soft) 55%, transparent), transparent 22%),
      linear-gradient(0deg, color-mix(in srgb, var(--ink) 8%, transparent), transparent 34%);
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
