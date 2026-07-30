<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useAgentsStore, useChatSessionsStore, useConnectionStore } from '@/stores'
import { agentApi } from '@/services/agentApi'
import NyxusParticle from './NyxusParticle.vue'
import type { NyxusReaction } from '../particles/nyxusParticleEngine'
import type { NyxusNearbyPet } from '../particles/nyxusParticleEngine'
import { useStandaloneNyxusMotion } from '../composables/useStandaloneNyxusMotion'
import { useNyxusWorkState } from '../composables/useNyxusWorkState'
import { useStreamBubble } from '@/features/pets/composables/useStreamBubble'
import NyxusBubbles from './NyxusBubbles.vue'
import NyxusToolRing from './NyxusToolRing.vue'
import { closeNyxusMenu, nyxusMenuOpen, toggleNyxusMenu } from '../nyxusUiState'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const connection = useConnectionStore()
const creating = ref(false)
const openingChat = ref(false)
const error = ref<string | null>(null)
const hovering = ref(false)
const reaction = ref<NyxusReaction | null>(null)
const {
  position: standalonePosition,
  dragging: standaloneDragging,
  onPointerDown: onStandalonePointerDown,
  onPointerMove: onStandalonePointerMove,
  endPointer: endStandalonePointer,
  consumeSuppressedClick,
} = useStandaloneNyxusMotion(
  () => true,
  () => nyxusMenuOpen.value,
  closeNyxusMenu,
  () => agents.pets,
)
const disabled = computed(
  () => creating.value || openingChat.value || connection.status !== 'connected',
)
const anchorStyle = computed(() => ({
  left: `${standalonePosition.x}px`,
  top: `${standalonePosition.y}px`,
}))
/**
 * 普通 Pet 只以相对中心和主题色进入 Canvas。既有 motion composable 仍独占避让与位置，
 * 因而该弱关联不会拉动 Pet、改变安全距离或暴露任何 Pet UI。
 */
const nearbyPet = computed<NyxusNearbyPet | null>(() => {
  let closest: NyxusNearbyPet | null = null
  for (const pet of agents.pets) {
    const position = {
      x: pet.x + pet.width / 2 - standalonePosition.x,
      y: pet.y + pet.height / 2 - standalonePosition.y,
    }
    const distance = Math.hypot(position.x, position.y)
    if (distance < 190 || distance > 390 || (closest && distance >= closest.distance)) continue
    closest = { position, distance, color: pet.color }
  }
  return closest
})

// nyxus 工作态：chatSessions 投影 → useStreamBubble 气泡逻辑（不经 PetInstance）
const { stream, working, activity, runningToolCount, contentPulse } = useNyxusWorkState()
const {
  isBusy,
  showWorkMain,
  showThinkingButton,
  thinkingOnly,
  hasContent,
  displayThinking,
  displayContent,
  renderedContent,
  workTextRef,
  onWorkTextScroll,
  onBubbleEnter,
  onBubbleLeave,
} = useStreamBubble({ isGhost: false, isWorking: working, stream })

function setWorkTextRef(el: HTMLElement | null): void {
  workTextRef.value = el
}

let clickTimer: ReturnType<typeof setTimeout> | undefined
let reactionTimer: ReturnType<typeof setTimeout> | undefined
let rapidClicks = 0
let lastClickAt = 0

function react(nextReaction: NyxusReaction, duration = 1100): void {
  reaction.value = nextReaction
  if (reactionTimer) clearTimeout(reactionTimer)
  reactionTimer = setTimeout(() => (reaction.value = null), duration)
}

function onStandaloneClick(): void {
  if (consumeSuppressedClick()) return
  const now = performance.now()
  rapidClicks = now - lastClickAt < 650 ? rapidClicks + 1 : 1
  lastClickAt = now
  if (rapidClicks >= 3) {
    if (clickTimer) clearTimeout(clickTimer)
    react('agitated', 1400)
    rapidClicks = 0
    return
  }
  if (clickTimer) clearTimeout(clickTimer)
  clickTimer = setTimeout(() => {
    react('positive')
    toggleNyxusMenu()
  }, 220)
}

function onStandaloneDoubleClick(): void {
  if (clickTimer) clearTimeout(clickTimer)
  clickTimer = undefined
  void openNyxusChat()
}

async function openNyxusChat(): Promise<void> {
  if (connection.status !== 'connected' || openingChat.value || creating.value) return
  openingChat.value = true
  error.value = null
  try {
    const chatId = await agents.getActiveNyxus()
    await chatSessions.hydrateTree(chatId)
    agents.activeDialogChatId = chatId
    closeNyxusMenu()
  } catch (cause) {
    error.value = (cause as Error).message
    react('error', 1800)
    console.error('[NyxusControls] open fixed chat failed:', cause)
  } finally {
    openingChat.value = false
  }
}

async function pickPreset(name: string): Promise<void> {
  await runCreate({ preset: name })
}

async function createFallback(): Promise<void> {
  let firstBrain = 'longcat'
  try {
    const list = await agentApi.listBrains()
    firstBrain = list.brains[0]?.name ?? 'longcat'
  } catch (cause) {
    console.warn('[NyxusControls] brain.list unavailable:', (cause as Error).message)
  }
  await runCreate({ brain: firstBrain, senseGroup: '', mcpServers: [] })
}

async function runCreate(opts: {
  preset?: string
  brain?: string
  senseGroup?: string
  mcpServers?: string[]
}): Promise<void> {
  if (creating.value || openingChat.value) return
  creating.value = true
  error.value = null
  try {
    await agents.createMasterPet(opts)
    closeNyxusMenu()
  } catch (cause) {
    error.value = (cause as Error).message
    react('error', 1800)
    console.error('[NyxusControls] createMasterPet failed:', cause)
  } finally {
    creating.value = false
  }
}

function openSessions(): void {
  if (connection.status !== 'connected') return
  agents.nyxusHistoryOpen = true
  closeNyxusMenu()
}

function openSettings(): void {
  if (connection.status !== 'connected') return
  agents.settingsOpen = true
  closeNyxusMenu()
}

onBeforeUnmount(() => {
  if (clickTimer) clearTimeout(clickTimer)
  if (reactionTimer) clearTimeout(reactionTimer)
})
</script>

<template>
  <button
    v-if="nyxusMenuOpen"
    class="nyxus-menu-dismiss"
    type="button"
    aria-label="关闭 Nyxus 工具"
    @click="closeNyxusMenu"
  />
  <aside
    class="nyxus-controls"
    :class="{
      'is-open': nyxusMenuOpen,
      'is-dragging': standaloneDragging,
    }"
    :style="anchorStyle"
    aria-label="cheryNyxus controls"
  >
    <NyxusBubbles
      :stream="stream"
      :show-work-main="showWorkMain"
      :show-thinking-button="showThinkingButton"
      :thinking-only="thinkingOnly"
      :has-content="hasContent"
      :display-thinking="displayThinking"
      :display-content="displayContent"
      :rendered-content="renderedContent"
      :work-text-ref="setWorkTextRef"
      :on-work-text-scroll="onWorkTextScroll"
      @bubble-enter="onBubbleEnter"
      @bubble-leave="onBubbleLeave"
    />
    <button
      type="button"
      class="nyxus-hit"
      aria-label="cheryNyxus，单击打开工具，双击聊天"
      @pointerenter="hovering = true"
      @pointerleave="hovering = false"
      @pointerdown="onStandalonePointerDown"
      @pointermove="onStandalonePointerMove"
      @pointerup="endStandalonePointer"
      @pointercancel="endStandalonePointer"
      @click="onStandaloneClick"
      @dblclick="onStandaloneDoubleClick"
    >
      <NyxusParticle
        :size="112"
        :action="standaloneDragging ? 'dragging' : hovering ? 'hover' : 'idle'"
        :working="working"
        :reaction="reaction"
        :activity="activity"
        :running-tool-count="runningToolCount"
        :content-pulse="contentPulse"
        :nearby-pet="nearbyPet"
        :status-dot="true"
        boot
      />
      <span v-if="isBusy" class="busy-indicator" aria-label="思考中">
        <span class="thinking-dot" />
        <span class="thinking-dot" />
        <span class="thinking-dot" />
      </span>
    </button>

    <NyxusToolRing
      :disabled="disabled"
      :connected="connection.status === 'connected'"
      :excluded-presets="[CHERY_NYXUS_PRESET]"
      @create-preset="pickPreset"
      @create-fallback="createFallback"
      @open-chat="openNyxusChat"
      @open-history="openSessions"
      @open-settings="openSettings"
    />
    <div v-if="error" class="nyxus-error" role="alert">{{ error }}</div>
  </aside>
</template>

<style scoped lang="less">
.nyxus-menu-dismiss {
  position: fixed;
  inset: 0;
  z-index: 239;
  padding: 0;
  border: 0;
  background: transparent;
  appearance: none;
  -webkit-appearance: none;
  outline: none;
  -webkit-tap-highlight-color: transparent;
}

.nyxus-controls {
  position: fixed;
  right: auto;
  bottom: auto;
  z-index: 250;
  width: 1px;
  height: 1px;
  pointer-events: none;
  user-select: none;

  &.is-dragging .nyxus-hit {
    cursor: grabbing;
  }
}

.nyxus-hit {
  position: absolute;
  left: -56px;
  top: -56px;
  z-index: 2;
  width: 112px;
  height: 112px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  pointer-events: auto;
  touch-action: none;
}

.nyxus-error {
  position: absolute;
  left: -105px;
  bottom: 78px;
  width: 210px;
  padding: 7px 9px;
  border: 1px solid #ff3b3b;
  border-radius: 6px;
  color: #ffe8e8;
  background: rgba(30, 17, 25, 0.94);
  font-size: 11px;
  line-height: 1.35;
  pointer-events: auto;
}

.busy-indicator {
  position: absolute;
  right: 6px;
  top: 6px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 5px;
  border: 1px dashed rgba(124, 58, 237, 0.55); /* 思考紫虚线 */
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.9);
  pointer-events: none;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.18));

  .thinking-dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #7c3aed;
    animation: nyxus-thinking-dot 1.2s ease-in-out infinite;

    &:nth-child(2) {
      animation-delay: 0.18s;
    }
    &:nth-child(3) {
      animation-delay: 0.36s;
    }
  }
}

@keyframes nyxus-thinking-dot {
  0%,
  60%,
  100% {
    opacity: 0.28;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-2px);
  }
}
</style>
