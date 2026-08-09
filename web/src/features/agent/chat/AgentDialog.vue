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
import NexusPianoStrip from '@/features/pets/nyxus/components/NexusPianoStrip.vue'
import { usePianoAudio } from '@/features/pets/nyxus/composables/usePianoAudio'
import {
  terminalActionMode,
  type TerminalActionMode,
} from '@/features/pets/nyxus/composables/nodeInteraction'
import { selectCanResume } from '@/stores/chats/selectors'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

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

/** Cherry Nexus 会话：节点树铺满工作台，历史钢琴与角色卡从右侧 dock 按需展开。 */
const dialogVisible = computed(() => !!chatId.value || emptyNyxusDialog.value)
const isNyxus = computed(() => emptyNyxusDialog.value || presetName.value === CHERY_NYXUS_PRESET)
const branchTreeRef = ref<InstanceType<typeof MessageBranchTree> | null>(null)
const nyxusComposerTarget = ref<HTMLElement | null>(null)
const nyxusDraftActive = ref(false)
const treeFolded = ref(true)
const pianoOpen = ref(false)
let pianoCloseTimer: ReturnType<typeof setTimeout> | undefined
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
function showPiano(): void {
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  pianoCloseTimer = undefined
  pianoOpen.value = true
}
function schedulePianoClose(): void {
  if (pianoCloseTimer) clearTimeout(pianoCloseTimer)
  pianoCloseTimer = setTimeout(() => {
    pianoOpen.value = false
    pianoCloseTimer = undefined
  }, 160)
}
function activateNyxusInput(): void {
  nyxusDraftActive.value = true
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
/** 查看 Nexus 会话完整对话历史：打开根历史抽屉（与 PetStage 同款；panel 挂载自动 loadHistory）。 */
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
      nyxusComposerTarget.value = null
      treeRootChatId.value = id
    }
  },
  { immediate: true },
)
watch(
  [treeRootChatId, isNyxus],
  ([rootChatId, nexus]) => {
    if (!rootChatId) return
    if (!nexus) {
      void chatSessions.closeRootTimeline(rootChatId)
      return
    }
    void chatSessions
      .observeRootTimeline(rootChatId, 'tree')
      .catch((cause) => console.error('[AgentDialog] observe Nexus root failed:', cause))
  },
  { immediate: true },
)
const creating = ref(false)
// 琴键音开关（与 NexusPianoStrip 共享同一 usePianoAudio 单例 muted）。
const pianoAudio = usePianoAudio()

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
    console.error('[AgentDialog] switch Nexus session failed:', e)
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
      :style="{ zIndex: OVERLAY_Z_INDEX.composer }"
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
          :editing="nyxusDraftActive"
          :folded="treeFolded"
          @activate-input="activateNyxusInput"
          @composer-target="nyxusComposerTarget = $event"
        />
      </div>
      <button
        v-if="isNyxus"
        type="button"
        class="nyxus-page-close"
        aria-label="关闭 Nexus 工作台"
        title="关闭"
        @click="closeDialog"
      >
        ✕
      </button>
      <nav v-if="isNyxus" class="nyxus-side-tools" aria-label="Nexus 功能工具栏">
        <button
          type="button"
          class="nyxus-tool-btn"
          :class="{ 'is-active': treeFolded }"
          :title="treeFolded ? '展开整棵节点树' : '折叠已完成节点'"
          :aria-label="treeFolded ? '展开整棵节点树' : '折叠已完成节点'"
          :aria-pressed="treeFolded"
          @click="treeFolded = !treeFolded"
        >
          {{ treeFolded ? '▤' : '☷' }}
        </button>
        <button
          type="button"
          class="nyxus-tool-btn"
          title="重置节点树布局"
          aria-label="重置节点树布局"
          @click="resetBranchTree"
        >
          ↻
        </button>
        <button
          v-if="chatId && sessionControl"
          type="button"
          class="nyxus-tool-btn"
          :class="`is-${sessionControl.mode}`"
          :title="sessionControl.label"
          :aria-label="sessionControl.label"
          :disabled="sessionControlPending"
          @click="executeSessionControl"
        >
          {{ sessionControl.mode === 'stop' ? '■' : '▶' }}
        </button>
        <button
          v-if="chatId"
          type="button"
          class="nyxus-tool-btn"
          title="查看完整对话历史"
          aria-label="查看完整对话历史"
          @click="openHistory"
        >
          📜
        </button>
        <button
          type="button"
          class="nyxus-tool-btn"
          title="新建 Nexus 会话"
          aria-label="新建 Nexus 会话"
          :disabled="creating"
          @click="createSession"
        >
          +
        </button>
        <button
          type="button"
          class="nyxus-tool-btn"
          :title="pianoAudio.muted.value ? '开启琴键音' : '静音琴键音'"
          :aria-label="pianoAudio.muted.value ? '开启琴键音' : '静音琴键音'"
          :aria-pressed="pianoAudio.muted.value"
          @click="pianoAudio.toggleMute"
        >
          {{ pianoAudio.muted.value ? '🔇' : '🔊' }}
        </button>
        <el-popover
          trigger="click"
          placement="left-start"
          :width="440"
          popper-class="role-runtime-popper nyxus-role-popper"
        >
          <template #reference>
            <button type="button" class="nyxus-tool-btn" title="查看角色" aria-label="查看角色">
              ♟
            </button>
          </template>
          <div class="nyxus-role-card-list" aria-label="Nexus 角色列表">
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
        <div
          class="nyxus-piano-tool"
          @pointerenter="showPiano"
          @pointerleave="schedulePianoClose"
          @focusin="showPiano"
          @focusout="schedulePianoClose"
        >
          <button
            type="button"
            class="nyxus-tool-btn"
            :class="{ 'is-active': pianoOpen }"
            title="会话钢琴"
            aria-label="显示会话钢琴"
            :aria-expanded="pianoOpen"
          >
            🎹
          </button>
          <AnimatePresence>
            <MotionDiv
              v-if="pianoOpen"
              key="piano-popout"
              class="nyxus-piano-popout"
              :initial="{ opacity: 0, scale: 0.72, x: 28 }"
              :animate="{ opacity: 1, scale: 1, x: 0 }"
              :exit="{ opacity: 0, scale: 0.8, x: 20 }"
              :transition="{ type: 'spring', stiffness: 410, damping: 24, mass: 0.72 }"
              @pointerenter="showPiano"
              @pointerleave="schedulePianoClose"
            >
              <div class="nyxus-piano-popout-title">
                <span>NEXUS · SESSION KEYS</span><span>CHERRY</span>
              </div>
              <NexusPianoStrip @select="switchSession" @delete="deleteNyxusSession" />
            </MotionDiv>
          </AnimatePresence>
        </div>
      </nav>
      <!-- Nyxus composer：Teleport 到节点树终端 composerMountRef；draftActive 时才渲染 -->
      <Teleport v-if="isNyxus" :to="nyxusComposerTarget ?? 'body'">
        <AgentComposer
          v-if="nyxusDraftActive"
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
          @cancel="cancelNyxusInput"
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
      </Teleport>

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
          @cancel="cancelNyxusInput"
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
  z-index: 12;
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
}
.nyxus-page-close:hover {
  color: #fff;
  border-color: #ff718c;
  background: rgba(86, 18, 37, 0.92);
}
.nyxus-side-tools {
  position: absolute;
  z-index: 11;
  top: 50%;
  right: max(18px, env(safe-area-inset-right));
  display: flex;
  flex-direction: column;
  gap: 8px;
  transform: translateY(-50%);
  pointer-events: auto;
}
.nyxus-tool-btn {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid rgba(107, 207, 247, 0.38);
  border-radius: 11px;
  background: rgba(5, 20, 31, 0.88);
  color: #dff8ff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22);
  transition:
    transform 140ms cubic-bezier(0.2, 1.4, 0.35, 1),
    border-color 120ms ease,
    background-color 120ms ease;
}
.nyxus-tool-btn:hover:not(:disabled),
.nyxus-tool-btn.is-active {
  transform: scale(1.08);
  border-color: rgba(181, 255, 242, 0.78);
  background: rgba(10, 54, 68, 0.95);
}
.nyxus-tool-btn:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}
.nyxus-piano-tool {
  position: relative;
  display: flex;
}
.nyxus-piano-popout {
  position: absolute;
  right: calc(100% + 12px);
  bottom: 50%;
  width: min(680px, calc(100vw - 92px));
  height: 153px;
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
.nyxus-piano-popout-title {
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: rgba(255, 230, 177, 0.76);
  font:
    700 8px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
  letter-spacing: 0.13em;
}
.nyxus-piano-popout :deep(.piano-keyboard) {
  position: relative;
  inset: auto;
  height: 116px;
  padding: 0;
}
.nyxus-piano-popout :deep(.piano-viewport) {
  height: 116px;
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

// 节点树覆盖整个页面可用区域；对话框和钢琴作为更高层 overlay 截获各自手势。
.nyxus-branch-top {
  position: absolute;
  inset: 0;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 6;
  isolation: isolate;
}

.nyxus-branch-top :deep(.tree-viewport) {
  pointer-events: auto;
}

.composer-wrap {
  position: relative;
}
.composer-wrap.is-node-terminal {
  isolation: isolate;
  min-height: 194px;
  padding: 30px 10px 10px;
  border: 1px solid transparent;
  clip-path: polygon(
    0 0,
    calc(100% - 12px) 0,
    100% 12px,
    100% 100%,
    12px 100%,
    0 calc(100% - 12px)
  );
  background:
    linear-gradient(145deg, rgba(3, 20, 30, 0.97), rgba(2, 9, 17, 0.985)) padding-box,
    linear-gradient(120deg, #67e8f9, rgba(34, 211, 238, 0.16) 48%, #89efaf) border-box;
  filter: drop-shadow(0 0 7px rgba(34, 211, 238, 0.28)) drop-shadow(0 12px 22px rgba(0, 0, 0, 0.42));
  box-sizing: border-box;
  color: #b5fff2;

  &::before {
    content: '▣ NEXUS_INPUT // READY';
    position: absolute;
    z-index: 2;
    top: 0;
    right: 0;
    left: 0;
    height: 24px;
    display: flex;
    align-items: center;
    padding: 0 34px 0 10px;
    border-bottom: 1px solid rgba(103, 232, 249, 0.34);
    background:
      repeating-linear-gradient(90deg, rgba(103, 232, 249, 0.08) 0 1px, transparent 1px 5px),
      rgba(3, 31, 43, 0.92);
    color: #89efaf;
    font:
      700 9px/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      Consolas,
      monospace;
    letter-spacing: 0.13em;
    text-shadow: 0 0 8px rgba(137, 239, 175, 0.72);
    box-sizing: border-box;
  }

  &::after {
    content: '';
    position: absolute;
    z-index: 0;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(circle, rgba(181, 255, 242, 0.24) 0 0.65px, transparent 0.8px) 0 0 / 5px 5px,
      repeating-linear-gradient(180deg, transparent 0 3px, rgba(69, 217, 234, 0.055) 3px 4px);
    opacity: 0.38;
    mix-blend-mode: screen;
    animation: node-terminal-grain 2.8s steps(3, end) infinite;
  }

  > * {
    position: relative;
    z-index: 1;
  }

  .rich-message-input {
    min-height: 142px;
    padding: 12px 72px 44px 12px;
    border: 1px solid rgba(103, 232, 249, 0.34);
    border-radius: 0;
    background:
      linear-gradient(rgba(2, 12, 20, 0.88), rgba(1, 8, 14, 0.94)),
      repeating-linear-gradient(90deg, rgba(103, 232, 249, 0.035) 0 1px, transparent 1px 8px);
    box-shadow:
      inset 0 0 0 1px rgba(0, 0, 0, 0.5),
      inset 0 0 22px rgba(17, 94, 111, 0.2);
    color: #c8fff5;
    caret-color: #89efaf;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    letter-spacing: 0.025em;
    text-shadow: 0 0 5px rgba(181, 255, 242, 0.22);

    &.is-empty::before {
      color: rgba(137, 239, 175, 0.48);
    }

    &:focus {
      border-color: rgba(137, 239, 175, 0.88);
      box-shadow:
        inset 0 0 0 1px rgba(137, 239, 175, 0.14),
        inset 0 0 24px rgba(17, 94, 111, 0.26),
        0 0 0 1px rgba(137, 239, 175, 0.18),
        0 0 16px rgba(34, 211, 238, 0.22);
    }

    &.is-disabled {
      background: rgba(2, 9, 15, 0.9);
      color: rgba(181, 255, 242, 0.42);
    }
  }

  :deep(.instruction-token) {
    background: rgba(246, 200, 95, 0.16);
    color: #ffe49b;
  }

  :deep(.role-mention-token) {
    background: rgba(103, 232, 249, 0.14);
    color: #a8f4ff;
  }

  .textarea-actions {
    right: 9px;
    bottom: 9px;
  }

  .add-media-btn,
  .send-btn {
    width: 30px;
    height: 30px;
    border: 1px solid rgba(103, 232, 249, 0.28);
    border-radius: 0;
    clip-path: polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 0 100%);
    background: rgba(3, 31, 43, 0.76);
    color: rgba(181, 255, 242, 0.7);

    &:hover:not(:disabled) {
      border-color: rgba(137, 239, 175, 0.72);
      background: rgba(8, 57, 67, 0.92);
      color: #89efaf;
      box-shadow: 0 0 10px rgba(34, 211, 238, 0.22);
    }
  }

  .send-btn:not(:disabled) {
    color: #89efaf;
  }

  .node-composer-error {
    border: 1px solid rgba(255, 113, 140, 0.52);
    border-radius: 0;
    background: rgba(55, 8, 22, 0.88);
    color: #ffb4c2;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
}
.composer-close-btn {
  position: absolute;
  z-index: 2;
  top: -9px;
  right: -9px;
  width: 24px;
  height: 24px;
  border: 1px solid rgba(107, 207, 247, 0.45);
  border-radius: 50%;
  background: rgba(5, 20, 31, 0.96);
  color: #dff8ff;
  cursor: pointer;
}
.composer-wrap.is-node-terminal .composer-close-btn {
  z-index: 3;
  top: 4px;
  right: 7px;
  width: 17px;
  height: 17px;
  border-color: rgba(255, 113, 140, 0.62);
  border-radius: 0;
  clip-path: polygon(0 0, calc(100% - 4px) 0, 100% 4px, 100% 100%, 0 100%);
  background: rgba(55, 8, 22, 0.88);
  color: #ff9aae;
  font:
    700 11px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    monospace;
}
.composer-wrap.is-node-terminal .composer-close-btn:hover:not(:disabled) {
  background: rgba(105, 18, 42, 0.94);
  color: #fff;
  box-shadow: 0 0 9px rgba(255, 113, 140, 0.38);
}
.composer-close-btn:disabled {
  cursor: wait;
  opacity: 0.45;
}
.node-composer-error {
  margin-top: 6px;
}

@keyframes node-terminal-grain {
  0% {
    background-position:
      0 0,
      0 0;
  }
  50% {
    background-position:
      2px -1px,
      0 2px;
  }
  100% {
    background-position:
      -1px 2px,
      0 4px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer-wrap.is-node-terminal::after {
    animation: none;
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
