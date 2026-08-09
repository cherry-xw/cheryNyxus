<script setup lang="ts">
/**
 * AgentDialog orchestrator：发消息弹窗（runtime 切换合一）。
 * 状态/逻辑下沉 useAgentDialogOptions；角色卡下沉 RoleConfigPopover；媒体预览下沉 MediaPreviewBar。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElPopover, ElTooltip } from 'element-plus'
import RoleConfigPopover from '../dialog/RoleConfigPopover.vue'
import AgentComposer from '../dialog/AgentComposer.vue'
import ContextBreakdownTip from '../toolbar/ContextBreakdownTip.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import { useAgentDialogOptions } from '../dialog/useAgentDialogOptions'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'
import MessageBranchTree from '@/features/pets/nyxus/components/MessageBranchTree.vue'
import NyxusPianoStrip from '@/features/pets/nyxus/components/NyxusPianoStrip.vue'
import {
  terminalActionMode,
  type TerminalActionMode,
} from '@/features/pets/nyxus/composables/nodeInteraction'
import { selectCanResume } from '@/stores/chats/selectors'
import { NYXUS_WORKBENCH_Z_INDEX, OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const emptyNyxusDialog = ref(false)
// 共用单蒙层：仅当 AgentDialog 是栈顶 overlay 时其蒙层带 blur，否则透明（避免多层 blur 叠加）
const isTopMask = computed(() => agents.topOverlay === 'agentDialog' || emptyNyxusDialog.value)

const MotionDiv = motion.div

const {
  chatId,
  pet,
  presetName,
  brains,
  senseGroups,
  config,
  senseTools,
  roleSelections,
  primaryRole,
  text,
  editorRef,
  commandOptions,
  commandTabs,
  activeCommandTab,
  comboCommandGroups,
  showCommandMenu,
  activeCommandIndex,
  commandMenuRef,
  roleMenuRef,
  matchingRoleMentions,
  showRoleMenu,
  activeRoleIndex,
  uploading,
  mediaHint,
  mediaAttachments,
  sending,
  loading,
  error,
  primarySelection,
  orderedRoleSelections,
  mediaServicesByType,
  close: closeAgentDialog,
  handleSend,
  onEditorKeydown,
  onEditorInput,
  onEditorSelectionChange,
  onEditorPaste,
  selectCommand,
  selectCommandTab,
  selectRoleMention,
  resetEditor,
  resetMedia,
  removeMedia,
  onMediaSelected,
  senseEntries,
  senseTool,
  brainConfig,
  supportsTools,
} = useAgentDialogOptions()

/** Cherry Nyxus 会话：节点树铺满工作台，历史钢琴与角色卡从右侧 dock 按需展开。 */
const dialogVisible = computed(() => !!chatId.value || emptyNyxusDialog.value)
const isNyxus = computed(() => emptyNyxusDialog.value || presetName.value === CHERY_NYXUS_PRESET)
const branchTreeRef = ref<InstanceType<typeof MessageBranchTree> | null>(null)
const nyxusDraftActive = ref(false)
const treeFolded = ref(true)
const toolDrawerOpen = ref(false)
const toolDrawerPinned = ref(false)
let toolDrawerCloseTimer: ReturnType<typeof setTimeout> | undefined
const pianoOpen = ref(false)
/** 删除交互期间锁定 popout：hover 可删键 / 拖拽 / 倒掉动画时为 true，跳过延迟关闭。 */
const pianoPinned = ref(false)
let pianoCloseTimer: ReturnType<typeof setTimeout> | undefined
let pianoCloseRequested = false
// AgentComposer 的 3 个 DOM ref 桥接回 useAgentDialogOptions（selectCommand / commandMenuStyle 等依赖）。
const editorRefFn = (el: HTMLElement | null) => {
  editorRef.value = el
}
const commandMenuRefFn = (el: HTMLElement | null) => {
  commandMenuRef.value = el
}
const roleMenuRefFn = (el: HTMLElement | null) => {
  roleMenuRef.value = el
}
function cancelToolDrawerClose(): void {
  if (toolDrawerCloseTimer) clearTimeout(toolDrawerCloseTimer)
  toolDrawerCloseTimer = undefined
}
function openToolDrawer(): void {
  cancelToolDrawerClose()
  toolDrawerOpen.value = true
}
function toggleToolDrawer(): void {
  if (toolDrawerPinned.value) {
    closeToolDrawer()
    return
  }
  openToolDrawer()
  toolDrawerPinned.value = true
}
function scheduleToolDrawerClose(): void {
  if (toolDrawerPinned.value) return
  if (toolDrawerCloseTimer) clearTimeout(toolDrawerCloseTimer)
  toolDrawerCloseTimer = setTimeout(() => {
    toolDrawerOpen.value = false
    toolDrawerCloseTimer = undefined
    if (!pianoPinned.value) pianoOpen.value = false
  }, 120)
}
function closeToolDrawer(): void {
  if (toolDrawerCloseTimer) clearTimeout(toolDrawerCloseTimer)
  toolDrawerCloseTimer = undefined
  toolDrawerPinned.value = false
  toolDrawerOpen.value = false
  if (!pianoPinned.value) pianoOpen.value = false
}
function onToolNavFocusOut(event: FocusEvent): void {
  const nav = event.currentTarget as HTMLElement | null
  if (nav?.contains(event.relatedTarget as Node | null)) return
  if (nav?.matches(':hover')) return
  scheduleToolDrawerClose()
}
function showPiano(): void {
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  pianoCloseTimer = undefined
  pianoCloseRequested = false
  pianoOpen.value = true
}
function schedulePianoClose(): void {
  if (pianoPinned.value) {
    pianoCloseRequested = true
    return
  }
  pianoCloseRequested = false
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  pianoCloseTimer = setTimeout(() => {
    pianoOpen.value = false
    pianoCloseTimer = undefined
  }, 160)
}
function onPianoInteracting(v: boolean): void {
  pianoPinned.value = v
  if (v) {
    showPiano()
    return
  }
  if (pianoCloseRequested) schedulePianoClose()
}
function activateNyxusInput(): void {
  nyxusDraftActive.value = true
  closeToolDrawer()
  void nextTick(() => editorRef.value?.focus())
}
function cancelNyxusInput(): void {
  if (sending.value) return
  nyxusDraftActive.value = false
  resetEditor()
  resetMedia()
  error.value = null
}
async function sendFromComposer(): Promise<void> {
  if (isNyxus.value) nyxusDraftActive.value = false
  await handleSend()
  if (isNyxus.value && text.value) nyxusDraftActive.value = true
}
function resetBranchTree(): void {
  branchTreeRef.value?.resetLayout()
}
/** 查看 Nyxus 会话完整对话历史：打开根历史抽屉（与 PetStage 同款；panel 挂载自动 loadHistory）。 */
function openHistory(): void {
  const id = chatId.value
  if (!id) return
  agents.openHistoryRoot(id)
}
/**
 * 会话控制（停止/继续运行）：原挂 MessageBranchTree 终点节点，现移至弹窗 header 刷新按钮边。
 * running 显停止、canResume 且无未完成直接子会话显继续运行；逻辑参考 pet resume/abort。
 */
const sessionControlPending = ref(false)
const sessionControl = computed<{ mode: TerminalActionMode; label: string } | undefined>(() => {
  const id = chatId.value
  if (!id) return undefined
  const session = chatSessions.sessionsById[id]
  if (!session) return undefined
  const hasUnfinishedDirectChild = Object.values(chatSessions.sessionsById).some(
    (candidate) => candidate.meta.parentChatId === id && candidate.meta.finished !== true,
  )
  const mode = terminalActionMode(
    session.run.status === 'running',
    selectCanResume(session),
    hasUnfinishedDirectChild,
  )
  return mode ? { mode, label: mode === 'stop' ? '停止' : '继续运行' } : undefined
})
async function executeSessionControl(): Promise<void> {
  const mode = sessionControl.value?.mode
  const id = chatId.value
  if (!mode || !id || sessionControlPending.value) return
  sessionControlPending.value = true
  try {
    if (mode === 'stop') await chatSessions.abortAgent(id)
    else await chatSessions.resumeAgent(id)
  } catch (cause) {
    console.error(`[AgentDialog] ${mode} failed:`, cause)
  } finally {
    sessionControlPending.value = false
  }
}
/** 顶部树的独立根：琴键按下即同步更新，不等待对话框 options/hydration 的异步链。 */
const treeRootChatId = ref('')
watch(
  chatId,
  (id) => {
    if (id) {
      nyxusDraftActive.value = false
      treeRootChatId.value = id
    }
  },
  { immediate: true },
)
watch(
  [treeRootChatId, isNyxus],
  ([rootChatId, nyxus]) => {
    if (!rootChatId) return
    if (!nyxus) {
      void chatSessions.closeRootTimeline(rootChatId)
      return
    }
    void chatSessions
      .observeRootTimeline(rootChatId, 'tree')
      .catch((cause) => console.error('[AgentDialog] observe Nyxus root failed:', cause))
  },
  { immediate: true },
)
const creating = ref(false)

/** 钢琴键只切换观察中的 root。chat.close 仅取消旧订阅，后台 run 不受影响；
 * 新 root 通过原子 open + 完整 tree snapshot 恢复，不回放逐 chat token 事件。 */
async function switchSession(id: string): Promise<void> {
  if (!id) return
  treeRootChatId.value = id
  if (id !== chatId.value) {
    agents.activeNyxusChatId = id
    agents.activeDialogChatId = id
  }
  try {
    await chatSessions.observeRootTimeline(id, 'tree')
  } catch (e) {
    console.error('[AgentDialog] switch Nyxus session failed:', e)
  }
}

/**
 * 加号「新建会话」：复用已有空白会话；无则新建。均跳转定位过去。
 * 刷新后 historyList 来自 listChats(false)(无 turnCount)；fetchHistoryList 取 listChats(true)
 * 才有 turnCount(0=空白，>0=有内容)，确保空白判定可靠。
 */
async function createSession(): Promise<void> {
  if (creating.value) return
  creating.value = true
  try {
    await agents.fetchHistoryList()
    const blank = agents.historyList.find(
      (c) => !c.parentChatId && c.preset === CHERY_NYXUS_PRESET && (c.turnCount ?? 0) === 0,
    )
    const id = blank ? blank.chatId : await agents.createNyxusSession()
    await switchSession(id)
    emptyNyxusDialog.value = false
  } catch (e) {
    console.error('[AgentDialog] createSession failed:', e)
  } finally {
    creating.value = false
  }
}

/**
 * 钢琴键「删除会话」：先把焦点切到下一会话，再级联删除；本地 catalog 同步移除。
 * 删当前焦点会话时 deleteSession 内 removePetsAndStreams 会清 activeDialogChatId=null ->
 * overlay v-if 失败卸载再重挂载 = 整弹窗闪烁。故先切走焦点（同步设 id 在前），
 * 删除时 activeDialogChatId 已非被删项不触发 null 清理，弹窗仅数据响应式变化。
 * 删除唯一会话时保留 Nyxus 空态；弹窗不依赖待删 chatId，因而不会关闭或闪烁。
 */
async function deleteNyxusSession(targetId: string): Promise<void> {
  if (!targetId) return
  const wasFocus = targetId === chatId.value
  if (wasFocus) {
    const remaining = (agents.historyList ?? [])
      .filter((c) => !c.parentChatId && c.preset === CHERY_NYXUS_PRESET && c.chatId !== targetId)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (remaining) {
      // switchSession 同步设 activeDialogChatId 在前、异步打开新 root；切走即生效。
      await switchSession(remaining.chatId)
    } else {
      // 空态保持弹窗可见；用户可通过标题栏“+”按需创建下一条会话。
      emptyNyxusDialog.value = true
      treeRootChatId.value = ''
    }
  }
  try {
    await agents.deleteSession(targetId)
  } catch (e) {
    console.error('[AgentDialog] deleteNyxusSession failed:', e)
    emptyNyxusDialog.value = false
    error.value = '删除会话失败'
    return
  }
}

function closeDialog(): void {
  const observedRoot = treeRootChatId.value
  closeToolDrawer()
  cancelNyxusInput()
  emptyNyxusDialog.value = false
  closeAgentDialog()
  if (observedRoot) void chatSessions.closeRootTimeline(observedRoot)
}

function onDialogEditorKeydown(e: KeyboardEvent): void {
  if (isNyxus.value && nyxusDraftActive.value && e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelNyxusInput()
    return
  }
  if (emptyNyxusDialog.value && e.key === 'Escape') {
    e.preventDefault()
    closeDialog()
    return
  }
  onEditorKeydown(e)
}

// ── 斜杠指令菜单定位（Teleport 到 body 后用 fixed 定位；锚定 .msg-input 顶部，向上展开） ──
const commandMenuStyle = reactive({
  zIndex: OVERLAY_Z_INDEX.composerMenu,
  bottom: '0px',
  left: '0px',
  width: '390px',
  maxHeight: '280px',
})
function positionCommandMenu(): void {
  const editor = editorRef.value
  const menu = commandMenuRef.value ?? roleMenuRef.value
  if (!editor || !menu) return
  const editorRect = editor.getBoundingClientRect()
  const margin = 8
  const minWidth = 280
  const maxWidth = Math.min(420, window.innerWidth - margin * 2)
  const width = Math.max(minWidth, Math.min(maxWidth, editorRect.width))
  const left = Math.max(margin, Math.min(editorRect.left, window.innerWidth - width - margin))
  // 菜单底边固定在输入框上沿 6px；内容/Tab 高度变化时只向上伸缩。
  commandMenuStyle.bottom = `${window.innerHeight - editorRect.top + 6}px`
  commandMenuStyle.left = `${left}px`
  commandMenuStyle.width = `${width}px`
  commandMenuStyle.maxHeight = `${Math.min(280, Math.max(0, editorRect.top - margin - 6))}px`
}
watch(showCommandMenu, async (open) => {
  if (open) {
    await nextTick()
    positionCommandMenu()
  }
})
watch(showRoleMenu, async (open) => {
  if (open) {
    await nextTick()
    positionCommandMenu()
  }
})
watch(activeCommandIndex, () => {
  // 高亮项滚动进视口后再校准菜单位置（菜单高度变化时）
  if (showCommandMenu.value) {
    nextTick(() => positionCommandMenu())
  }
})
watch([activeCommandTab, commandOptions], () => {
  if (showCommandMenu.value) nextTick(() => positionCommandMenu())
})
if (typeof window !== 'undefined') {
  window.addEventListener('resize', positionCommandMenu)
  window.addEventListener('scroll', positionCommandMenu, true)
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', positionCommandMenu)
    window.removeEventListener('scroll', positionCommandMenu, true)
  }
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  if (toolDrawerCloseTimer) clearTimeout(toolDrawerCloseTimer)
})

/** 颜色分级（与 SessionList / HistoryDrawerPanel / ContextBar 对齐：<50% 绿 / 50-80% 黄 / >=80% 红）。 */
function usageClass(u: number): 'usage-low' | 'usage-mid' | 'usage-high' {
  if (u >= 0.8) return 'usage-high'
  if (u >= 0.5) return 'usage-mid'
  return 'usage-low'
}

/** 每角色上下文占用（按当前 brain 的 contextLimit 折算）。brain / config / pet 任一未就绪 → null（chip 隐藏）。 */
const roleUsages = computed<Record<string, { used: number; total: number; usage: number } | null>>(
  () => {
    const p = pet.value
    const out: Record<string, { used: number; total: number; usage: number } | null> = {}
    for (const [role, sel] of Object.entries(roleSelections.value)) {
      const limit = brainConfig(sel.brain)?.contextLimit
      if (!limit || !p) {
        out[role] = null
        continue
      }
      const used = p.contextUsed ?? 0
      const usage = Math.min(1, Math.max(0, used / limit))
      out[role] = { used, total: limit, usage }
    }
    return out
  },
)

/** dialog-head 工作区模式：workspace 有值时 pet name 前 📁（路径失效改 ⚠ 红色），hover 显全路径。无 workspace 纯文本。 */
const workspaceInvalid = computed(() => pet.value?.workspaceValid === false)
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="dialogVisible"
      key="overlay"
      class="dialog-overlay"
      :style="{
        zIndex: OVERLAY_Z_INDEX.composer,
        '--nx-z-canvas': NYXUS_WORKBENCH_Z_INDEX.canvas,
        '--nx-z-node-hit-target': NYXUS_WORKBENCH_Z_INDEX.nodeHitTarget,
        '--nx-z-node-overlay': NYXUS_WORKBENCH_Z_INDEX.nodeOverlay,
        '--nx-z-run-crt': NYXUS_WORKBENCH_Z_INDEX.runCrt,
        '--nx-z-composer': NYXUS_WORKBENCH_Z_INDEX.composer,
        '--nx-z-blocking-interaction': NYXUS_WORKBENCH_Z_INDEX.blockingInteraction,
        '--nx-z-chrome': NYXUS_WORKBENCH_Z_INDEX.chrome,
      }"
      :class="{ 'is-top-mask': isTopMask, 'is-nyxus-layout': isNyxus }"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <div v-if="isNyxus" class="nyxus-branch-top">
        <MessageBranchTree
          v-if="treeRootChatId"
          ref="branchTreeRef"
          :key="treeRootChatId"
          :root-chat-id="treeRootChatId"
          :folded="treeFolded"
        />
      </div>

      <Transition name="nyxus-composer">
        <section
          v-if="isNyxus && nyxusDraftActive"
          id="nyxus-message-composer"
          class="nyxus-composer-dock"
          role="dialog"
          aria-modal="false"
          aria-label="发送新消息"
          @pointerdown.stop
          @pointermove.stop
          @pointerup.stop
          @wheel.stop
        >
          <header class="nyxus-composer-head">
            <span class="nyxus-composer-status" aria-hidden="true" />
            <span class="nyxus-composer-title">
              <strong>发送新消息</strong>
              <small>发送后将作为新节点加入当前会话</small>
            </span>
            <button
              type="button"
              class="nyxus-composer-close"
              aria-label="放弃未发送消息"
              title="放弃草稿"
              :disabled="sending"
              @click="cancelNyxusInput"
            >
              ✕
            </button>
          </header>
          <AgentComposer
            is-nyxus
            :nyxus-draft-active="nyxusDraftActive"
            :sending="sending"
            :loading="loading"
            :text="text"
            :error="error"
            :media-attachments="mediaAttachments"
            :media-hint="mediaHint"
            :uploading="uploading"
            :primary-selection="primarySelection"
            :supports-tools="supportsTools"
            :media-services-by-type="mediaServicesByType"
            :command-options="commandOptions"
            :command-tabs="commandTabs"
            :active-command-tab="activeCommandTab"
            :combo-command-groups="comboCommandGroups"
            :show-command-menu="showCommandMenu"
            :command-menu-style="commandMenuStyle"
            :active-command-index="activeCommandIndex"
            :show-role-menu="showRoleMenu"
            :matching-role-mentions="matchingRoleMentions"
            :active-role-index="activeRoleIndex"
            :editor-ref-fn="editorRefFn"
            :command-menu-ref-fn="commandMenuRefFn"
            :role-menu-ref-fn="roleMenuRefFn"
            @remove-media="removeMedia"
            @editor-input="onEditorInput"
            @editor-keydown="onDialogEditorKeydown"
            @editor-selection-change="onEditorSelectionChange"
            @editor-paste="onEditorPaste"
            @select-command="selectCommand"
            @select-command-tab="selectCommandTab"
            @select-role-mention="selectRoleMention"
            @media-selected="(f: any) => onMediaSelected(f)"
            @send="sendFromComposer"
            @update:active-command-index="activeCommandIndex = $event"
            @update:active-role-index="activeRoleIndex = $event"
          />
          <footer class="nyxus-composer-hint">
            <span><kbd>/</kbd> 指令 · <kbd>@</kbd> 角色</span>
            <span><kbd>Cmd/Ctrl</kbd> + <kbd>Enter</kbd> 发送</span>
          </footer>
        </section>
      </Transition>
      <button
        v-if="isNyxus"
        type="button"
        class="nyxus-page-close"
        aria-label="关闭 Nyxus 工作台"
        title="关闭"
        @click="closeDialog"
      >
        ✕
      </button>
      <nav
        v-if="isNyxus"
        class="nyxus-side-tools"
        aria-label="Nyxus 功能工具栏"
        @focusout="onToolNavFocusOut"
        @keydown.esc.stop.prevent="closeToolDrawer"
      >
        <div class="nyxus-primary-tools" aria-label="主要操作">
          <button
            type="button"
            class="nyxus-rail-action is-message"
            :class="{ 'is-active': nyxusDraftActive }"
            :disabled="!chatId"
            :aria-label="nyxusDraftActive ? '继续编辑消息' : '发送消息'"
            :title="nyxusDraftActive ? '继续编辑' : '发送消息'"
            aria-controls="nyxus-message-composer"
            :aria-expanded="nyxusDraftActive"
            @click="activateNyxusInput"
          >
            <span aria-hidden="true">↗</span>
          </button>
          <button
            v-if="chatId && sessionControl"
            type="button"
            class="nyxus-rail-action"
            :class="`is-${sessionControl.mode}`"
            :disabled="sessionControlPending"
            :aria-label="sessionControl.mode === 'stop' ? '停止运行' : '继续运行'"
            :title="sessionControlPending ? '正在处理…' : sessionControl.mode === 'stop' ? '停止运行' : '继续运行'"
            @click="executeSessionControl"
          >
            <span aria-hidden="true">{{ sessionControl.mode === 'stop' ? '■' : '▶' }}</span>
          </button>
        </div>
        <div
          class="nyxus-tool-capsule"
          :class="{ 'is-expanded': toolDrawerOpen }"
          @pointerenter="openToolDrawer"
          @pointerleave="scheduleToolDrawerClose"
        >
          <section
            v-if="toolDrawerOpen"
            id="nyxus-tool-capsule-content"
            class="nyxus-capsule-content"
            aria-label="更多工具"
          >
            <div class="nyxus-capsule-group" role="group" aria-label="会话工具">
              <button
                type="button"
                class="nyxus-drawer-tool"
                :disabled="!chatId"
                aria-label="对话历史"
                title="对话历史"
                @click="openHistory"
              >
                <span aria-hidden="true">◷</span>
              </button>
              <button
                type="button"
                class="nyxus-drawer-tool"
                :class="{ 'is-busy': creating }"
                :disabled="creating"
                aria-label="新建会话"
                title="新建会话"
                @click="createSession"
              >
                <span aria-hidden="true">＋</span>
              </button>
              <div
                class="nyxus-piano-tool"
                @pointerenter="showPiano"
                @focusin="showPiano"
              >
                <button
                  type="button"
                  class="nyxus-drawer-tool"
                  :class="{ 'is-active': pianoOpen }"
                  aria-label="会话钢琴"
                  title="会话钢琴"
                  :aria-expanded="pianoOpen"
                  @click="showPiano"
                >
                  <span aria-hidden="true">▥</span>
                </button>
              </div>
            </div>
            <div class="nyxus-capsule-group is-secondary" role="group" aria-label="视图与配置工具">
              <button
                type="button"
                class="nyxus-drawer-tool"
                :class="{ 'is-active': treeFolded }"
                :aria-label="treeFolded ? '展开完整节点树' : '折叠已完成节点'"
                :title="treeFolded ? '展开完整节点树' : '折叠已完成节点'"
                :aria-pressed="treeFolded"
                @click="treeFolded = !treeFolded"
              >
                <span aria-hidden="true">{{ treeFolded ? '▤' : '☷' }}</span>
              </button>
              <button
                type="button"
                class="nyxus-drawer-tool"
                aria-label="复位布局"
                title="复位布局"
                @click="resetBranchTree"
              >
                <span aria-hidden="true">↻</span>
              </button>
              <el-popover
                trigger="click"
                placement="left-start"
                :width="440"
                popper-class="role-runtime-popper nyxus-role-popper"
              >
                <template #reference>
                  <button
                    type="button"
                    class="nyxus-drawer-tool"
                    aria-label="角色配置"
                    title="角色配置"
                  >
                    <span aria-hidden="true">♟</span>
                  </button>
                </template>
                <div class="nyxus-role-card-list" aria-label="Nyxus 角色列表">
                  <div v-if="loading" class="nyxus-role-loading">角色加载中…</div>
                  <template v-else>
                    <RoleConfigPopover
                      v-for="[role, selection] in orderedRoleSelections"
                      :key="role"
                      :role="role"
                      :selection="selection"
                      :brains="brains"
                      :sense-groups="senseGroups"
                      :config="config"
                      :sense-tools="senseTools"
                      :is-primary="role === primaryRole"
                      :primary-role="primaryRole"
                      @update:selection="roleSelections[role] = $event"
                    />
                  </template>
                </div>
              </el-popover>
            </div>
          </section>
          <button
            type="button"
            class="nyxus-drawer-handle"
            :class="{ 'is-open': toolDrawerOpen }"
            aria-label="更多工具"
            title="更多工具"
            aria-controls="nyxus-tool-capsule-content"
            :aria-expanded="toolDrawerOpen"
            @focus="openToolDrawer"
            @click="toggleToolDrawer"
          >
            <span class="nyxus-drawer-handle-dots" aria-hidden="true"><i /><i /><i /></span>
          </button>
        </div>
        <AnimatePresence>
          <MotionDiv
            v-if="pianoOpen"
            key="piano-popout"
            class="nyxus-piano-popout"
            :initial="{ opacity: 0, transform: 'translateX(18px) scale(0.96)' }"
            :animate="{ opacity: 1, transform: 'translateX(0) scale(1)' }"
            :exit="{ opacity: 0, transform: 'translateX(14px) scale(0.97)' }"
            :transition="{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }"
            @pointerenter="openToolDrawer(); showPiano()"
            @pointerleave="scheduleToolDrawerClose(); schedulePianoClose()"
          >
            <NyxusPianoStrip
              @select="switchSession"
              @delete="deleteNyxusSession"
              @interacting-change="onPianoInteracting"
            />
          </MotionDiv>
        </AnimatePresence>
      </nav>
      <!-- 非 Nyxus：发消息弹窗 panel（header + 角色编制 + composer） -->
      <MotionDiv
        v-else
        key="panel"
        class="dialog-panel"
        :initial="{ opacity: 0, y: 16, scale: 0.96 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 12, scale: 0.97 }"
        :transition="{ duration: 0.18, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        :aria-label="`向 ${pet?.name ?? '智能体'} 发送消息`"
      >
        <header class="dialog-head">
          <span class="title">
            <span class="title-row">
              <el-tooltip
                v-if="pet?.workspace"
                placement="bottom"
                :show-after="200"
                :hide-after="0"
              >
                <template #content>
                  <span>工作区：{{ pet.workspace }}</span>
                  <span v-if="workspaceInvalid" style="color: #fca5a5"> · 路径失效</span>
                </template>
                <span class="who" :class="{ 'is-ws-invalid': workspaceInvalid }">
                  <span class="who-icon">{{ workspaceInvalid ? '⚠' : '📁' }}</span
                  >{{ pet?.name ?? 'agent' }}
                </span>
              </el-tooltip>
              <span v-else class="who">{{ pet?.name ?? 'agent' }}</span>
            </span>
            <span class="hint">Cmd/Ctrl+Enter 发送 · Esc 关闭</span>
          </span>
          <div class="head-actions">
            <button type="button" class="close-btn" aria-label="关闭" @click="closeDialog">
              ✕
            </button>
          </div>
        </header>

        <div class="role-configs">
          <div class="session-note">小组角色编制</div>
          <div
            v-if="loading"
            class="role-tags role-tags-skel"
            aria-busy="true"
            aria-label="角色编制加载中"
          >
            <span v-for="n in 3" :key="n" class="role-skel-tile" aria-hidden="true" />
          </div>
          <div v-else class="role-tags" aria-label="小组角色编制">
            <el-popover
              v-for="[role, selection] in orderedRoleSelections"
              :key="role"
              trigger="click"
              placement="bottom-start"
              :width="420"
              popper-class="role-runtime-popper"
            >
              <template #reference>
                <button
                  type="button"
                  class="role-summary-tag"
                  :class="{ 'is-primary': role === primaryRole }"
                  :aria-label="`配置角色 ${role}，大脑 ${selection.brain || '未选择'}，${senseEntries(selection.senseGroup).length} 项能力`"
                >
                  <span class="role-summary-main">
                    <span aria-hidden="true">{{ role === primaryRole ? '♛' : '✦' }}</span>
                    <span class="role-summary-name">{{ role }}</span>
                  </span>
                  <span class="role-summary-meta-row">
                    <span class="role-summary-model-slot">
                      <span class="role-summary-model">◈ {{ selection.brain || '—' }}</span>
                    </span>
                    <el-tooltip
                      v-if="roleUsages[role]"
                      placement="top"
                      :show-after="200"
                      :hide-after="0"
                    >
                      <template #content>
                        <ContextBreakdownTip
                          v-if="pet?.contextBreakdown"
                          :breakdown="pet.contextBreakdown"
                        />
                        <span v-else>上下文 {{ Math.round(roleUsages[role]!.usage * 100) }}%</span>
                      </template>
                      <span
                        class="role-usage-chip"
                        :class="usageClass(roleUsages[role]!.usage)"
                        :aria-label="`上下文 ${Math.round(roleUsages[role]!.usage * 100)}% · ${fmtTokens(roleUsages[role]!.used)} / ${fmtTokens(roleUsages[role]!.total)}`"
                        >{{ fmtTokens(roleUsages[role]!.used) }}/{{
                          fmtTokens(roleUsages[role]!.total)
                        }}</span
                      >
                    </el-tooltip>
                  </span>
                  <span
                    v-if="senseEntries(selection.senseGroup).length"
                    class="role-summary-senses"
                    aria-label="当前能力"
                  >
                    <span
                      v-for="entry in senseEntries(selection.senseGroup)"
                      :key="entry"
                      class="role-summary-sense-icon"
                    >
                      {{ senseTool(entry)?.icon ?? '⚙' }}
                    </span>
                  </span>
                </button>
              </template>

              <RoleConfigPopover
                :role="role"
                :selection="selection"
                :brains="brains"
                :sense-groups="senseGroups"
                :config="config"
                :sense-tools="senseTools"
                :is-primary="role === primaryRole"
                :primary-role="primaryRole"
                @update:selection="roleSelections[role] = $event"
              />
            </el-popover>
          </div>
        </div>

        <AgentComposer
          :is-nyxus="false"
          :nyxus-draft-active="nyxusDraftActive"
          :sending="sending"
          :loading="loading"
          :text="text"
          :error="error"
          :media-attachments="mediaAttachments"
          :media-hint="mediaHint"
          :uploading="uploading"
          :primary-selection="primarySelection"
          :supports-tools="supportsTools"
          :media-services-by-type="mediaServicesByType"
          :command-options="commandOptions"
          :command-tabs="commandTabs"
          :active-command-tab="activeCommandTab"
          :combo-command-groups="comboCommandGroups"
          :show-command-menu="showCommandMenu"
          :command-menu-style="commandMenuStyle"
          :active-command-index="activeCommandIndex"
          :show-role-menu="showRoleMenu"
          :matching-role-mentions="matchingRoleMentions"
          :active-role-index="activeRoleIndex"
          :editor-ref-fn="editorRefFn"
          :command-menu-ref-fn="commandMenuRefFn"
          :role-menu-ref-fn="roleMenuRefFn"
          @remove-media="removeMedia"
          @editor-input="onEditorInput"
          @editor-keydown="onDialogEditorKeydown"
          @editor-selection-change="onEditorSelectionChange"
          @editor-paste="onEditorPaste"
          @select-command="selectCommand"
          @select-command-tab="selectCommandTab"
          @select-role-mention="selectRoleMention"
          @media-selected="(f: any) => onMediaSelected(f)"
          @send="sendFromComposer"
          @update:active-command-index="activeCommandIndex = $event"
          @update:active-role-index="activeRoleIndex = $event"
        />
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import '../dialog/agentDialog.less';

.role-usage-chip {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
.role-summary-meta-row {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
}
.role-usage-chip.usage-low {
  background: rgba(34, 197, 94, 0.14);
  color: #16a34a;
}
.role-usage-chip.usage-mid {
  background: rgba(234, 179, 8, 0.16);
  color: #a16207;
}
.role-usage-chip.usage-high {
  background: rgba(239, 68, 68, 0.16);
  color: #b91c1c;
}

.nyxus-page-close {
  position: absolute;
  z-index: var(--nx-z-chrome);
  top: max(18px, env(safe-area-inset-top));
  right: max(18px, env(safe-area-inset-right));
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 126, 148, 0.62);
  border-radius: 12px;
  background: rgba(25, 8, 16, 0.88);
  color: #ffd9e2;
  font-size: 16px;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease,
    border-color 120ms ease,
    background-color 120ms ease;
}
.nyxus-page-close:active {
  transform: scale(0.97);
}
.nyxus-side-tools {
  position: absolute;
  z-index: var(--nx-z-chrome);
  top: 50%;
  right: max(10px, env(safe-area-inset-right));
  width: 148px;
  transform: translateY(-50%);
  pointer-events: none;
}
.nyxus-primary-tools {
  width: 30px;
  display: grid;
  gap: 4px;
  margin: 0 0 6px auto;
  pointer-events: auto;
}
.nyxus-rail-action {
  position: relative;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgba(138, 211, 228, 0.14);
  border-radius: 10px;
  color: rgba(202, 231, 237, 0.64);
  background: rgba(5, 18, 27, 0.5);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14);
  backdrop-filter: blur(9px) saturate(115%);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease,
    border-color 120ms ease,
    background-color 120ms ease;
}
.nyxus-rail-action.is-active {
  color: #eafffa;
  border-color: rgba(112, 225, 205, 0.24);
  background: rgba(67, 154, 139, 0.22);
}
.nyxus-rail-action.is-message {
  color: #c9fff3;
}
.nyxus-rail-action.is-stop {
  color: #ffc0cc;
}
.nyxus-rail-action.is-resume {
  color: #c8ffda;
}
.nyxus-tool-capsule {
  width: 148px;
  height: 66px;
  display: flex;
  justify-content: flex-end;
  box-sizing: border-box;
  border: 1px solid rgba(138, 211, 228, 0.16);
  border-radius: 15px;
  background: rgba(5, 18, 27, 0.68);
  box-shadow: -6px 8px 22px rgba(0, 0, 0, 0.2);
  backdrop-filter: blur(12px) saturate(120%);
  clip-path: inset(0 0 0 116px round 15px);
  pointer-events: auto;
  transition: clip-path 180ms cubic-bezier(0.32, 0.72, 0, 1);
}
.nyxus-tool-capsule.is-expanded {
  clip-path: inset(0 0 0 0 round 15px);
}
.nyxus-capsule-content {
  width: 116px;
  box-sizing: border-box;
  display: grid;
  grid-template-rows: repeat(2, 1fr);
  padding: 4px 3px 4px 5px;
}
.nyxus-capsule-group {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 2px;
}
.nyxus-capsule-group.is-secondary {
  border-top: 1px solid rgba(145, 207, 219, 0.08);
}
.nyxus-drawer-handle {
  position: relative;
  flex: 0 0 31px;
  width: 31px;
  height: 64px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-left: 1px solid rgba(155, 215, 226, 0.09);
  border-radius: 0 14px 14px 0;
  color: rgba(202, 231, 237, 0.64);
  background: transparent;
  line-height: 1;
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease,
    background-color 120ms ease;
}
.nyxus-drawer-handle.is-open {
  color: #eafffa;
  background: rgba(112, 225, 205, 0.13);
}
.nyxus-drawer-handle-dots {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nyxus-drawer-handle-dots i {
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: currentColor;
}
.nyxus-rail-action:active:not(:disabled),
.nyxus-drawer-handle:active,
.nyxus-drawer-tool:active:not(:disabled) {
  transform: scale(0.97);
}
.nyxus-rail-action:disabled,
.nyxus-drawer-tool:disabled {
  cursor: not-allowed;
  opacity: 0.36;
}
.nyxus-drawer-tool {
  width: 100%;
  height: 27px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: rgba(216, 241, 245, 0.7);
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 120ms ease,
    background-color 120ms ease;
}
.nyxus-piano-tool {
  position: relative;
  width: 100%;
}
.nyxus-drawer-tool.is-active {
  color: #c8fff2;
  background: rgba(83, 211, 187, 0.1);
}
.nyxus-rail-action:focus-visible,
.nyxus-drawer-handle:focus-visible,
.nyxus-drawer-tool:focus-visible,
.nyxus-page-close:focus-visible {
  outline: 2px solid #b5fff2;
  outline-offset: 2px;
}
.nyxus-piano-popout {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  width: min(680px, calc(100vw - 190px));
  height: 153px;
  margin-top: -76px;
  padding: 0 7px 7px;
  transform-origin: right center;
  pointer-events: auto;
  border: 1px solid rgba(255, 223, 157, 0.48);
  border-radius: 12px;
  background:
    linear-gradient(
      90deg,
      rgba(66, 36, 15, 0.97),
      rgba(132, 76, 25, 0.98) 50%,
      rgba(66, 36, 15, 0.97)
    ),
    #5f3312;
  box-shadow:
    0 18px 34px rgba(0, 0, 0, 0.42),
    inset 0 1px 0 rgba(255, 221, 151, 0.38);
}
.nyxus-piano-popout :deep(.piano-keyboard) {
  position: relative;
  inset: auto;
  height: 146px;
  padding: 0;
}
.nyxus-piano-popout :deep(.piano-viewport) {
  height: 112px;
}
.nyxus-role-card-list {
  display: grid;
  gap: 10px;
  max-height: min(72vh, 680px);
  overflow: auto;
  padding: 2px;
}
.nyxus-role-loading {
  padding: 18px;
  color: rgba(255, 255, 255, 0.72);
  text-align: center;
}

// 节点树不建立独立 stacking context；内部语义层可与 composer/工具栏正确比较。
.nyxus-branch-top {
  position: absolute;
  inset: 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.nyxus-branch-top :deep(.tree-viewport) {
  pointer-events: auto;
}

.nyxus-composer-dock {
  position: absolute;
  z-index: var(--nx-z-composer);
  right: max(62px, calc(env(safe-area-inset-right) + 52px));
  bottom: max(22px, env(safe-area-inset-bottom));
  left: max(22px, env(safe-area-inset-left));
  width: min(720px, calc(100vw - 106px));
  margin-inline: auto;
  overflow: hidden;
  border: 1px solid rgba(116, 173, 184, 0.38);
  border-radius: 12px;
  color: #d9e7ea;
  background: rgba(8, 16, 22, 0.96);
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.48),
    0 0 0 1px rgba(87, 199, 212, 0.06);
  backdrop-filter: blur(14px);
  transform-origin: right bottom;
  pointer-events: auto;
}
.nyxus-composer-head {
  min-height: 46px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 10px 8px 14px;
  border-bottom: 1px solid rgba(150, 180, 190, 0.14);
  background: rgba(14, 25, 32, 0.82);
}
.nyxus-composer-status {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #69c995;
  box-shadow: 0 0 0 3px rgba(105, 201, 149, 0.1);
}
.nyxus-composer-title {
  min-width: 0;
  display: grid;
  gap: 2px;
}
.nyxus-composer-title strong {
  color: #edf5f7;
  font-size: 12px;
  line-height: 1.2;
}
.nyxus-composer-title small {
  overflow: hidden;
  color: rgba(180, 199, 204, 0.66);
  font-size: 10px;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nyxus-composer-close {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-left: auto;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  color: rgba(190, 207, 211, 0.72);
  background: transparent;
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    color 140ms ease,
    border-color 140ms ease,
    background-color 140ms ease;
}
.nyxus-composer-close:active:not(:disabled) {
  transform: scale(0.97);
}
.nyxus-composer-close:disabled {
  cursor: wait;
  opacity: 0.42;
}
.nyxus-composer-hint {
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px 8px;
  color: rgba(158, 181, 187, 0.58);
  font-size: 9px;
}
.nyxus-composer-hint kbd {
  padding: 1px 4px;
  border: 1px solid rgba(150, 180, 190, 0.18);
  border-radius: 4px;
  color: rgba(210, 225, 228, 0.78);
  background: rgba(150, 180, 190, 0.06);
  font: inherit;
}
.nyxus-composer-enter-active,
.nyxus-composer-leave-active {
  transition:
    opacity 180ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
.nyxus-composer-leave-active {
  transition-duration: 140ms;
}
.nyxus-composer-enter-from,
.nyxus-composer-leave-to {
  opacity: 0;
  transform: translateX(18px) scale(0.98);
}
@media (hover: hover) and (pointer: fine) {
  .nyxus-page-close:hover:not(:active) {
    color: #fff;
    border-color: #ff718c;
    background: rgba(86, 18, 37, 0.92);
  }
  .nyxus-rail-action:hover:not(:active):not(:disabled),
  .nyxus-drawer-handle:hover:not(:active) {
    color: #effffc;
    background: rgba(112, 225, 205, 0.11);
  }
  .nyxus-drawer-tool:hover:not(:active):not(:disabled) {
    color: #f3fdff;
    background: rgba(101, 207, 190, 0.11);
  }
  .nyxus-composer-close:hover:not(:disabled) {
    color: #edf5f7;
    border-color: rgba(87, 199, 212, 0.22);
    background: rgba(87, 199, 212, 0.07);
  }
}
@media (max-width: 720px) {
  .nyxus-side-tools {
    top: 50%;
    right: 8px;
  }
  .nyxus-piano-popout {
    right: -62px;
    top: auto;
    bottom: calc(100% + 10px);
    width: calc(100vw - 72px);
    margin-top: 0;
  }
  .nyxus-composer-dock {
    right: 52px;
    bottom: 12px;
    left: 12px;
    width: auto;
  }
  .nyxus-composer-title small,
  .nyxus-composer-hint span:first-child {
    display: none;
  }
}
@media (max-height: 520px) and (min-width: 721px) {
  .nyxus-side-tools {
    top: 50%;
  }
}
@media (prefers-reduced-motion: reduce) {
  .nyxus-composer-enter-active,
  .nyxus-composer-leave-active {
    transition: opacity 150ms ease;
  }
  .nyxus-composer-enter-from,
  .nyxus-composer-leave-to {
    transform: none;
  }
  .nyxus-piano-popout {
    transform: none !important;
  }
  .nyxus-tool-capsule {
    transition: none;
  }
  .nyxus-rail-action,
  .nyxus-drawer-handle,
  .nyxus-drawer-tool,
  .nyxus-page-close,
  .nyxus-composer-close {
    transform: none !important;
    transition-duration: 0ms, 120ms, 120ms, 120ms;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .nyxus-rail-action,
  .nyxus-tool-capsule,
  .nyxus-composer-dock {
    background: #071822;
    backdrop-filter: none;
  }
}
@media (prefers-contrast: more) {
  .nyxus-rail-action,
  .nyxus-tool-capsule,
  .nyxus-composer-dock {
    border-color: currentcolor;
  }
  .nyxus-drawer-tool {
    border: 1px solid currentcolor;
  }
}

// 标题栏右簇（静音 + 关闭）。
.head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

// 标题栏图标钮（琴键音开关），与 close-btn 同尺寸。
.head-icon-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgba(180, 110, 20, 0.3);
  border-radius: 7px;
  background: rgba(255, 245, 230, 0.5);
  color: #76500e;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 100ms ease,
    border-color 100ms ease;
  &:hover {
    background: rgba(255, 233, 184, 0.7);
    border-color: rgba(246, 183, 60, 0.6);
  }
  &.is-active {
    color: #155e75;
    border-color: rgba(34, 211, 238, 0.62);
    background: rgba(165, 243, 252, 0.58);
  }
}
</style>

<!-- Popover 挂载到 Teleport 根节点，需用非 scoped 样式去除 Element Plus 的外层壳。 -->
<style lang="less">
.role-runtime-popper.el-popper {
  --el-popover-border-color: transparent;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.role-runtime-popper .el-popper__arrow {
  display: none;
}

.add-media-popper.el-popover {
  border-radius: 10px;
}

.add-media-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.add-media-upload {
  width: 100%;

  .el-upload {
    width: 100%;
    display: block;
  }
}

.add-media-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 550;
  color: #14161a;
  transition: background-color 100ms ease;

  &:hover {
    background: rgba(246, 183, 60, 0.12);
  }

  span:first-child {
    font-size: 14px;
  }
}

.media-svc-tag {
  margin-left: auto;
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(246, 183, 60, 0.15);
  color: #9a7422;
  &.missing {
    background: rgba(180, 30, 30, 0.08);
    color: #b04040;
  }
}

// 指令卡片由富文本编辑器在 hover 时挂到 body，避免被输入框和弹窗滚动容器裁剪。
.instruction-token-floating-popover {
  position: fixed;
  z-index: 320;
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 248px;
  padding: 8px 9px;
  border: 1px solid rgba(35, 38, 44, 0.14);
  border-radius: 7px;
  background: #fffdf8;
  box-shadow: 0 7px 18px rgba(20, 22, 26, 0.18);
  color: #14161a;
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1.45;
  pointer-events: none;
}

.instruction-token-floating-title {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 750;
}

.instruction-token-floating-description {
  color: rgba(20, 22, 26, 0.76);
}

.instruction-token-floating-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 5px;
  border-top: 1px solid rgba(35, 38, 44, 0.1);
  color: #8c6114;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
}
</style>
