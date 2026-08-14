<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useAgentsStore, useConnectionStore, useThemeStore } from '@/stores'
import { agentApi } from '@/services/agentApi'
import NyxusParticle from './NyxusParticle.vue'
import NyxusToolRing from './NyxusToolRing.vue'
import ServerLoginDialog from '@/components/dialog/ServerLoginDialog.vue'
import { useNyxusWorkState } from '../composables/useNyxusWorkState'
import { useStandaloneNyxusMotion } from '../composables/useStandaloneNyxusMotion'
import { createClickDisambiguator } from '../composables/clickDisambiguator'
import { closeNyxusMenu, nyxusMenuOpen, toggleNyxusMenu } from '../nyxusUiState'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'

const agents = useAgentsStore()
const connection = useConnectionStore()
const themeStore = useThemeStore()
const creating = ref(false)
const openingChat = ref(false)
const loginOpen = ref(false)
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
/** 已打开成 pet 的预设（master）→ 从创建列表隐藏；全部打开时 PresetPicker 隐藏按钮。 */
const openedPresets = computed(() =>
  [...new Set(
    agents.pets
      .filter((pet) => pet.isMaster && pet.preset)
      .map((pet) => pet.preset as string),
  )],
)
const excludedPresets = computed(() => [CHERY_NYXUS_PRESET, ...openedPresets.value])

const clickIntent = createClickDisambiguator(toggleNyxusMenu, () => void openNyxusDialog())

/** 单击延迟到双击判定窗结束后切换工具环，避免第一次 click 抢先打开业务界面。 */
function onNyxusClick(): void {
  if (consumeSuppressedClick()) return
  clickIntent.single()
}

/** 双击独占开窗语义：取消尚未执行的单击，再打开统一消息对话框。 */
function onNyxusDoubleClick(): void {
  clickIntent.double()
}

/** Cherry Nyxus 双击或工具环聊天按钮打开统一弹窗。 */
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
    error.value = cause instanceof Error ? cause.message : '打开 Cherry Nyxus 失败'
    console.error('[CherryNyxus] open dialog failed:', cause)
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
    console.warn('[CherryNyxus] brain.list unavailable:', cause)
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
    console.error('[CherryNyxus] create master pet failed:', cause)
  } finally {
    creating.value = false
  }
}

function openSettings(): void {
  if (connection.status !== 'connected') return
  agents.settingsOpen = true
  closeNyxusMenu()
}

/** 打开登录/连接服务弹窗（远端后端对接）。 */
function openLogin(): void {
  loginOpen.value = true
}

/** 打开 cheryNyxus（主预设）的节点树工作台，并刷新钢琴依赖的轻量会话目录。 */
async function openWorkbench(): Promise<void> {
  if (connection.status !== 'connected') return
  try {
    await agents.getActiveNyxus()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '加载 Cherry Nyxus 绘画列表失败'
    console.error('[CherryNyxus] load workbench catalog failed:', cause)
    return
  }
  const id = agents.openWorkbenchWindow(CHERY_NYXUS_PRESET)
  // 仅新建窗口（chatId 为空）时恢复活跃 Nyxus 会话，避免打开即空树；已存在窗口不覆盖当前浏览。
  if (!agents.workbenchWindows[id]?.chatId) {
    const active = agents.activeNyxusChatId
    if (active) agents.setWorkbenchWindowChat(id, active)
    else return
  }
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
    class="nyxus-menu-dismiss"
    aria-label="关闭 Cherry Nyxus 工具"
    @click="closeNyxusMenu"
  />
  <aside
    class="nyxus-entry"
    :class="{ 'is-dragging': dragging, 'is-open': nyxusMenuOpen }"
    :style="anchorStyle"
    aria-label="Cherry Nyxus 入口"
  >
    <button
      type="button"
      class="nyxus-entry-button"
      :aria-disabled="openingChat || connection.status !== 'connected'"
      aria-label="打开 Cherry Nyxus"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="endPointer"
      @pointercancel="endPointer"
      @click="onNyxusClick"
      @dblclick="onNyxusDoubleClick"
    >
      <NyxusParticle :size="112" :working="working" :interactive="false" :status-dot="true" boot />
    </button>
    <NyxusToolRing
      :disabled="disabled"
      :connected="connection.status === 'connected'"
      :excluded-presets="excludedPresets"
      :dark="themeStore.theme === 'dark'"
      @create-preset="createPreset"
      @create-fallback="createFallback"
      @open-settings="openSettings"
      @open-workbench="openWorkbench"
      @open-login="openLogin"
      @toggle-theme="themeStore.toggle"
    />
    <ServerLoginDialog v-model="loginOpen" />
    <div v-if="error" class="nyxus-error" role="alert">{{ error }}</div>
  </aside>
</template>

<style scoped lang="less">
.nyxus-menu-dismiss {
  position: fixed;
  inset: 0;
  z-index: 249;
  padding: 0;
  border: 0;
  background: transparent;
  appearance: none;
  -webkit-appearance: none;
}

.nyxus-entry {
  position: fixed;
  z-index: 250;
  width: 1px;
  height: 1px;
  user-select: none;
}

.nyxus-entry-button {
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

.nyxus-entry.is-dragging .nyxus-entry-button {
  cursor: grabbing;
}

.nyxus-error {
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
