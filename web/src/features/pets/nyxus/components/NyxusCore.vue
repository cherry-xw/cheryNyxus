<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useAgentsStore, useConnectionStore } from '@/stores'
import { agentApi } from '@/services/agentApi'
import NyxusParticle from './NyxusParticle.vue'
import NyxusToolRing from './NyxusToolRing.vue'
import { useNyxusWorkState } from '../composables/useNyxusWorkState'
import { useStandaloneNyxusMotion } from '../composables/useStandaloneNyxusMotion'
import { createClickDisambiguator } from '../composables/clickDisambiguator'
import { closeNyxusMenu, nyxusMenuOpen, toggleNyxusMenu } from '../nyxusUiState'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'

const agents = useAgentsStore()
const connection = useConnectionStore()
const creating = ref(false)
const openingChat = ref(false)
const error = ref<string | null>(null)
const { working } = useNyxusWorkState()
const { position, dragging, onPointerDown, onPointerMove, endPointer, consumeSuppressedClick } =
  useStandaloneNyxusMotion(
    () => true,
    () => nyxusMenuOpen.value,
    closeNyxusMenu,
  )
const anchorStyle = computed(() => ({ left: `${position.x}px`, top: `${position.y}px` }))
const disabled = computed(
  () => creating.value || openingChat.value || connection.status !== 'connected',
)

const clickIntent = createClickDisambiguator(toggleNyxusMenu, () => void openNyxusDialog())

/** 单击延迟到双击判定窗结束后切换工具环，避免第一次 click 抢先打开业务界面。 */
function onNexusClick(): void {
  if (consumeSuppressedClick()) return
  clickIntent.single()
}

/** 双击独占开窗语义：取消尚未执行的单击，再打开统一消息对话框。 */
function onNexusDoubleClick(): void {
  clickIntent.double()
}

/** Cherry Nexus 双击或工具环聊天按钮打开统一弹窗。 */
async function openNyxusDialog(): Promise<void> {
  if (connection.status !== 'connected' || openingChat.value || creating.value) return
  openingChat.value = true
  error.value = null
  try {
    const chatId = await agents.getActiveNyxus()
    // getActiveNyxus 的轻量 catalog 已足够建立钢琴索引；节点正文由树挂载后
    // 仅针对当前 rootChatId 按需读取，不在开窗时扫描所有会话 preview。
    agents.activeDialogChatId = chatId
    closeNyxusMenu()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '打开 Cherry Nexus 失败'
    console.error('[CherryNexus] open dialog failed:', cause)
  } finally {
    openingChat.value = false
  }
}

async function createPreset(name: string): Promise<void> {
  await runCreate({ preset: name })
}

async function createFallback(): Promise<void> {
  let firstBrain = 'longcat'
  try {
    const list = await agentApi.listBrains()
    firstBrain = list.brains[0]?.name ?? firstBrain
  } catch (cause) {
    console.warn('[CherryNexus] brain.list unavailable:', cause)
  }
  await runCreate({ brain: firstBrain, senseGroup: '', mcpServers: [] })
}

async function runCreate(opts: {
  preset?: string
  brain?: string
  senseGroup?: string
  mcpServers?: string[]
}): Promise<void> {
  if (creating.value || openingChat.value || connection.status !== 'connected') return
  creating.value = true
  error.value = null
  try {
    await agents.createMasterPet(opts)
    closeNyxusMenu()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '创建失败'
    console.error('[CherryNexus] create master pet failed:', cause)
  } finally {
    creating.value = false
  }
}

function openSettings(): void {
  if (connection.status !== 'connected') return
  agents.settingsOpen = true
  closeNyxusMenu()
}

onBeforeUnmount(() => {
  clickIntent.dispose()
  closeNyxusMenu()
})
</script>

<template>
  <button
    v-if="nyxusMenuOpen"
    type="button"
    class="nexus-menu-dismiss"
    aria-label="关闭 Cherry Nexus 工具"
    @click="closeNyxusMenu"
  />
  <aside
    class="nexus-entry"
    :class="{ 'is-dragging': dragging, 'is-open': nyxusMenuOpen }"
    :style="anchorStyle"
    aria-label="Cherry Nexus 入口"
  >
    <button
      type="button"
      class="nexus-entry-button"
      :aria-disabled="openingChat || connection.status !== 'connected'"
      aria-label="打开 Cherry Nexus"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endPointer"
      @pointercancel="endPointer"
      @click="onNexusClick"
      @dblclick="onNexusDoubleClick"
    >
      <NyxusParticle :size="112" :working="working" :interactive="false" :status-dot="true" boot />
    </button>
    <NyxusToolRing
      :disabled="disabled"
      :connected="connection.status === 'connected'"
      :excluded-presets="[CHERY_NYXUS_PRESET]"
      @create-preset="createPreset"
      @create-fallback="createFallback"
      @open-chat="openNyxusDialog"
      @open-settings="openSettings"
    />
    <div v-if="error" class="nexus-error" role="alert">{{ error }}</div>
  </aside>
</template>

<style scoped lang="less">
.nexus-menu-dismiss {
  position: fixed;
  inset: 0;
  z-index: 249;
  padding: 0;
  border: 0;
  background: transparent;
  appearance: none;
  -webkit-appearance: none;
}

.nexus-entry {
  position: fixed;
  z-index: 250;
  width: 1px;
  height: 1px;
  user-select: none;
}

.nexus-entry-button {
  position: absolute;
  left: -56px;
  top: -56px;
  width: 112px;
  height: 112px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: grab;
  touch-action: none;
  appearance: none;
  -webkit-appearance: none;
  -webkit-tap-highlight-color: transparent;

  &:focus-visible {
    outline: 2px solid rgba(129, 157, 255, 0.72);
    outline-offset: 5px;
    border-radius: 50%;
  }
}

.nexus-entry.is-dragging .nexus-entry-button {
  cursor: grabbing;
}

.nexus-error {
  position: absolute;
  left: -105px;
  bottom: 78px;
  width: 210px;
  padding: 7px 9px;
  border: 1px solid rgba(239, 68, 68, 0.7);
  border-radius: 6px;
  color: #ffe8e8;
  background: rgba(30, 17, 25, 0.94);
  font-size: 11px;
  line-height: 1.35;
}
</style>
