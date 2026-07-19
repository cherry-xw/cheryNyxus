<script setup lang="ts">
import { computed, ref } from 'vue'
import PetSprite from './PetSprite.vue'
import { usePetWorld } from './composables/usePetWorld'
import { useAgentsStore } from '@/stores'
import type { PetInstance } from './types/types'
import { COMPACT_COMMAND, serializeCommandToken } from '@/features/agent/composables/commands'

const stageRef = ref<HTMLElement | null>(null)
// pets 单一数据源 = agents store；usePetWorld 注入数组，RAF/交互直接作用于 store state
const agents = useAgentsStore()
const { pets, isPaused, startDrag, dragPet, endDrag, hoverPet, clickPet } = usePetWorld(
  stageRef,
  agents.pets,
)

/**
 * ghost 首领集合：每 tribe（同主）中 ghostCreatedAt 最小者 = 首领（可拖）。
 * 与 usePetWorld.ghostQueueIndex idx0 语义一致。PetStage 传给 PetSprite 放行首领拖拽。
 */
const leaderIds = computed(() => {
  const byTribe = new Map<string, PetInstance>()
  for (const p of agents.pets) {
    if (!p.isGhost) continue
    const cur = byTribe.get(p.tribe)
    if (!cur || (p.ghostCreatedAt ?? 0) < (cur.ghostCreatedAt ?? 0)) byTribe.set(p.tribe, p)
  }
  const ids = new Set<string>()
  for (const pet of byTribe.values()) ids.add(pet.instanceId)
  return ids
})

/**
 * 主 pet 点击 → 打开 AgentDialog（设 activeDialogChatId）。
 * 子 pet 点击 → 沿用装饰 clickPet（CP3+ 改路由 HistoryDrawer）。
 * 工作中主 pet 仍可点击（用户可排队下一条）。
 */
function handleClick(pet: PetInstance): void {
  // ghost（子 agent 已完成灵魂态）：点击 → 查历史；不响应主/子常规交互
  if (pet.isGhost) {
    agents.openHistoryRoot(pet.chatId)
    return
  }
  if (pet.isMaster) {
    agents.activeDialogChatId = pet.chatId
    return
  }
  clickPet(pet)
}

async function handleAbort(pet: PetInstance): Promise<void> {
  try {
    // CP6: store.abort 封装 abortAgent + 清工作态（后端中止流可能不推 done）
    await agents.abort(pet.chatId)
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

function handleHistory(pet: PetInstance): void {
  // CP4 接 HistoryDrawer；本轮仅设 store 值（数字气泡/抽屉触发点共用）
  agents.openHistoryRoot(pet.chatId)
}

async function handleCompact(pet: PetInstance): Promise<void> {
  try {
    await agents.sendMessage(pet.chatId, serializeCommandToken(COMPACT_COMMAND))
  } catch (e) {
    console.error('[PetStage] compact failed:', e)
  }
}

async function handleResume(pet: PetInstance): Promise<void> {
  try {
    pet.canResume = false // 立即隐藏按钮（乐观 UI），失败时后端状态不变
    await agents.resumeAgent(pet.chatId)
  } catch (e) {
    console.error('[PetStage] resume failed:', e)
  }
}
</script>

<template>
  <main ref="stageRef" class="pet-stage" aria-label="Interactive desktop pets">
    <PetSprite
      v-for="pet in pets"
      :key="pet.instanceId"
      :pet="pet"
      :paused="isPaused"
      :stream="agents.streams[pet.chatId]"
      :ghost-draggable="leaderIds.has(pet.instanceId)"
      @start-drag="startDrag"
      @drag="dragPet"
      @end-drag="endDrag"
      @hover="hoverPet"
      @click-pet="handleClick"
      @history="handleHistory"
      @abort="handleAbort"
      @destroy="handleDestroy"
      @compact="handleCompact"
      @resume="handleResume"
    />
  </main>
</template>

<style scoped lang="less">
.pet-stage {
  position: fixed;
  inset: 0;
  overflow: hidden;
  min-width: 320px;
  min-height: 420px;
  background:
    linear-gradient(rgba(255, 255, 255, 0.36) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.36) 1px, transparent 1px),
    radial-gradient(circle at 18% 18%, rgba(255, 196, 87, 0.34), transparent 28%),
    radial-gradient(circle at 82% 28%, rgba(88, 196, 189, 0.28), transparent 30%),
    radial-gradient(circle at 50% 80%, rgba(151, 122, 255, 0.26), transparent 34%), #f5f0e8;
  background-size:
    42px 42px,
    42px 42px,
    auto,
    auto,
    auto,
    auto;
  color: #25262d;

  &::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.74), transparent 22%),
      linear-gradient(0deg, rgba(0, 0, 0, 0.08), transparent 34%);
  }
}
</style>
