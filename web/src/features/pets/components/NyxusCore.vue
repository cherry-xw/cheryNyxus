<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ChatDotRound, Clock, Plus, Setting } from '@element-plus/icons-vue'
import { useAgentsStore, useChatSessionsStore, useConnectionStore } from '@/stores'
import { agentApi } from '@/services/agentApi'
import NyxusParticle from '@/features/pets/components/NyxusParticle.vue'
import type { NyxusReaction } from '@/features/pets/particles/nyxusParticleEngine'
import { useStandaloneNyxusMotion } from '@/features/pets/composables/useStandaloneNyxusMotion'
import { useNyxusWorkState } from '@/features/pets/composables/useNyxusWorkState'
import { useStreamBubble } from '@/features/pets/composables/useStreamBubble'
import NyxusBubbles from './NyxusBubbles.vue'
import {
  closeNyxusMenu,
  highlightNyxusTool,
  nyxusMenuOpen,
  setNyxusMenuTargets,
  toggleNyxusMenu,
  type NyxusMenuTarget,
} from '@/features/pets/nyxusUiState'
import PresetPicker from '@/features/agent/toolbar/PresetPicker.vue'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const connection = useConnectionStore()
const creating = ref(false)
const openingChat = ref(false)
const error = ref<string | null>(null)
const hovering = ref(false)
const reaction = ref<NyxusReaction | null>(null)
const createButtonRef = ref<HTMLElement | null>(null)
const chatButtonRef = ref<HTMLElement | null>(null)
const historyButtonRef = ref<HTMLElement | null>(null)
const settingsButtonRef = ref<HTMLElement | null>(null)
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

// nyxus 工作态：chatSessions 投影 → useStreamBubble 气泡逻辑（不经 PetInstance）
const { stream, working } = useNyxusWorkState()
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
let toolTrackingRaf = 0
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
    const chatId = await agents.getOrCreateCheryNyxus()
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
    const chatId = await agents.createMasterPet(opts)
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
  agents.historyListOpen = true
  closeNyxusMenu()
}

function openSettings(): void {
  if (connection.status !== 'connected') return
  agents.settingsOpen = true
  closeNyxusMenu()
}

function updateToolTargets(): void {
  const entries: Array<[NyxusMenuTarget['id'], HTMLElement | null]> = [
    ['create', createButtonRef.value],
    ['chat', chatButtonRef.value],
    ['history', historyButtonRef.value],
    ['settings', settingsButtonRef.value],
  ]
  const targets = entries.flatMap<NyxusMenuTarget>(([id, element]) => {
    if (!element) return []
    const rect = element.getBoundingClientRect()
    return [{ id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }]
  })
  setNyxusMenuTargets(targets)
  toolTrackingRaf = requestAnimationFrame(updateToolTargets)
}

watch(
  nyxusMenuOpen,
  async (open) => {
    cancelAnimationFrame(toolTrackingRaf)
    toolTrackingRaf = 0
    if (!open) {
      setNyxusMenuTargets([])
      highlightNyxusTool(null)
      return
    }
    await nextTick()
    updateToolTargets()
  },
  { flush: 'post' },
)

onBeforeUnmount(() => {
  if (clickTimer) clearTimeout(clickTimer)
  if (reactionTimer) clearTimeout(reactionTimer)
  cancelAnimationFrame(toolTrackingRaf)
  setNyxusMenuTargets([])
  highlightNyxusTool(null)
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
        :reaction="reaction"
        :status-dot="true"
        boot
      />
      <span v-if="isBusy" class="busy-indicator" aria-label="思考中">
        <span class="thinking-dot" />
        <span class="thinking-dot" />
        <span class="thinking-dot" />
      </span>
    </button>

    <transition name="ring">
      <div v-if="nyxusMenuOpen" class="tool-ring">
        <el-tooltip content="创建预设宠物" placement="left">
          <span class="tool-slot tool-create">
            <PresetPicker
              :disabled="disabled"
              :excluded="[CHERY_NYXUS_PRESET]"
              @pick="pickPreset"
              @fallback="createFallback"
            >
              <button
                ref="createButtonRef"
                type="button"
                class="ring-button"
                :disabled="disabled"
                aria-label="创建预设宠物"
                @pointerenter="highlightNyxusTool('create')"
                @pointerleave="highlightNyxusTool(null)"
              >
                <Plus />
              </button>
            </PresetPicker>
          </span>
        </el-tooltip>
        <el-tooltip content="历史会话" placement="top">
          <button
            ref="historyButtonRef"
            type="button"
            class="ring-button tool-history"
            :disabled="connection.status !== 'connected'"
            aria-label="历史会话"
            @click="openSessions"
            @pointerenter="highlightNyxusTool('history')"
            @pointerleave="highlightNyxusTool(null)"
          >
            <Clock />
          </button>
        </el-tooltip>
        <el-tooltip content="设置" placement="right">
          <button
            ref="settingsButtonRef"
            type="button"
            class="ring-button tool-settings"
            :disabled="connection.status !== 'connected'"
            aria-label="设置"
            @click="openSettings"
            @pointerenter="highlightNyxusTool('settings')"
            @pointerleave="highlightNyxusTool(null)"
          >
            <Setting />
          </button>
        </el-tooltip>
        <el-tooltip content="与 cheryNyxus 对话" placement="bottom">
          <button
            ref="chatButtonRef"
            type="button"
            class="ring-button tool-chat"
            :disabled="disabled"
            aria-label="与 cheryNyxus 对话"
            @click="openNyxusChat"
            @pointerenter="highlightNyxusTool('chat')"
            @pointerleave="highlightNyxusTool(null)"
          >
            <ChatDotRound />
          </button>
        </el-tooltip>
      </div>
    </transition>
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

.tool-ring {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 5;
  width: 1px;
  height: 1px;
  pointer-events: auto;
}

.ring-button {
  position: absolute;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 8px;
  border: 1px solid rgba(120, 231, 255, 0.72);
  border-radius: 50%;
  color: #e0ffff;
  background: #202432;
  box-shadow:
    0 0 0 2px rgba(16, 18, 29, 0.7),
    0 5px 14px rgba(0, 0, 0, 0.28);
  cursor: pointer;
  transition:
    transform 120ms steps(2, end),
    background 120ms linear;

  &:hover:not(:disabled) {
    color: #15212a;
    background: #8ef2ff;
    transform: scale(1.12);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }

  svg {
    width: 20px;
    height: 20px;
  }
}

.tool-slot,
.tool-history,
.tool-settings,
.tool-chat {
  position: absolute;
}

.tool-create {
  left: -76px;
  top: -22px;
}

.tool-create .ring-button {
  position: relative;
}

.tool-history {
  left: -19px;
  top: -78px;
}

.tool-settings {
  left: 38px;
  top: -22px;
}

.tool-chat {
  left: -19px;
  top: 40px;
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

.ring-enter-active,
.ring-leave-active {
  transition:
    opacity 120ms linear,
    transform 180ms steps(3, end);
}

.ring-enter-from,
.ring-leave-to {
  opacity: 0;
  transform: scale(0.45) rotate(-16deg);
}

</style>
