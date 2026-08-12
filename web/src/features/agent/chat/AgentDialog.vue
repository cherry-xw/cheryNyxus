<script setup lang="ts">
/**
 * AgentDialog orchestrator：发消息弹窗（runtime 切换合一）。
 * C-3 抽取后仅保留「快速发送 composer 弹窗」单例面板（Pet 单击打开）。
 * 节点树工作台已抽到 WorkbenchDialog（多窗口），此处不再承载 .workbench-shell 子树。
 * 状态/逻辑下沉 useAgentDialogOptions；角色卡下沉 RoleConfigPopover；媒体预览下沉 MediaPreviewBar。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElPopover, ElTooltip } from 'element-plus'
import RoleConfigPopover from '../dialog/RoleConfigPopover.vue'
import AgentComposer from '../dialog/AgentComposer.vue'
import ConversationTargetPicker from '../dialog/ConversationTargetPicker.vue'
import WorkspaceSessionBrowser from '../dialog/WorkspaceSessionBrowser.vue'
import ContextBreakdownTip from '../toolbar/ContextBreakdownTip.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import { useAgentDialogOptions } from '../dialog/useAgentDialogOptions'
import { useAgentsStore, useChatSessionsStore, useInteractionsStore } from '@/stores'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()
const interactions = useInteractionsStore()
// 共用单蒙层：仅当 AgentDialog 是栈顶 overlay 时其蒙层带 blur，否则透明（避免多层 blur 叠加）
const isTopMask = computed(() => agents.topOverlay === 'agentDialog')

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
  removeMedia,
  onMediaSelected,
  senseEntries,
  senseTool,
  brainConfig,
  supportsTools,
} = useAgentDialogOptions()

/** 快速发送 composer 单例面板：仅有活跃 chatId 时可见（Pet 单击/PetStage 打开）。 */
const dialogVisible = computed(() => !!chatId.value)
interface QuickTargetSelection {
  target: string | 'new'
  source: 'ai' | 'user'
  confidence?: number
}
const quickTarget = ref<QuickTargetSelection>()
const quickRoutingPending = ref(false)
const quickRoutingWaiters: Array<() => void> = []
function setQuickRoutingPending(pending: boolean): void {
  quickRoutingPending.value = pending
  if (!pending) quickRoutingWaiters.splice(0).forEach((resolve) => resolve())
}
function clearAiQuickTarget(): void {
  if (quickTarget.value?.source === 'ai') quickTarget.value = undefined
}
function enableAiQuickTarget(): void {
  quickTarget.value = undefined
  error.value = null
}
async function waitForQuickRouting(): Promise<void> {
  if (!quickRoutingPending.value) return
  await new Promise<void>((resolve) => quickRoutingWaiters.push(resolve))
}
const dialogView = computed({
  get: () => agents.activeDialogView,
  set: (view: 'composer' | 'attention' | 'tree') => {
    agents.activeDialogView = view
  },
})
const quickTargetRequired = computed(
  () => agents.activeDialogSource === 'pet' && !!presetName.value,
)
const quickPresetId = computed(() => {
  if (pet.value?.presetId) return pet.value.presetId
  const summary = chatId.value
    ? agents.historyList.find((item) => item.chatId === chatId.value)
    : undefined
  return summary?.presetId
})
const quickSessions = computed(() =>
  (agents.historyList ?? [])
    .filter(
      (item) =>
        !item.parentChatId &&
        (quickPresetId.value
          ? item.presetId === quickPresetId.value
          : !!presetName.value && item.preset === presetName.value),
    )
    .sort(
      (a, b) =>
        (b.lastUserActivityAt ?? b.createdAt ?? 0) -
        (a.lastUserActivityAt ?? a.createdAt ?? 0),
    ),
)
const workspaceAttentionCount = computed(() =>
  interactions.pending.filter((item) => item.presetId === quickPresetId.value).length,
)
const quickRoutingEnabled = computed(() => {
  const preset = presetName.value ? config.value?.presets?.[presetName.value] : undefined
  return !!preset?.routingBrain
})

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

async function selectQuickTarget(selection: QuickTargetSelection): Promise<void> {
  if (quickTarget.value?.source === 'user' && selection.source === 'ai') return
  quickTarget.value = selection
  if (selection.target === 'new') return
  agents.activatePresetSession(quickPresetId.value, selection.target, presetName.value)
  agents.activeDialogChatId = selection.target
  await chatSessions.openSession(selection.target).catch((cause) =>
    console.warn('[AgentDialog] open explicitly selected target failed:', cause),
  )
}

async function sendFromComposer(): Promise<void> {
  if (quickTargetRequired.value && quickRoutingPending.value) await waitForQuickRouting()
  if (quickTargetRequired.value && !quickTarget.value) {
    error.value = '请选择消息指向的目标后继续'
    return
  }
  let targetChatId = chatId.value ?? undefined
  if (quickTargetRequired.value) {
    if (quickTarget.value?.target === 'new') {
      if (!presetName.value) {
        error.value = '当前 Pet 没有关联预设'
        return
      }
      try {
        targetChatId = await agents.createMasterPet({ preset: presetName.value })
        await agents.fetchHistoryList()
      } catch (cause) {
        console.error('[AgentDialog] create target session failed:', cause)
        error.value = '新建会话失败，请重试或选择一个历史会话'
        return
      }
    } else {
      targetChatId = quickTarget.value?.target
    }
  }
  if (targetChatId) {
    agents.activatePresetSession(quickPresetId.value, targetChatId, presetName.value)
    agents.activeDialogChatId = targetChatId
  }
  await handleSend(targetChatId)
}

/** 打开当前会话的节点树工作台（WorkbenchDialog 多窗口，windowId = presetId）。 */
function openWorkbenchForChat(): void {
  const preset = quickPresetId.value
  if (!preset) return
  const id = agents.openWorkbenchWindow(preset)
  if (chatId.value) agents.setWorkbenchWindowChat(id, chatId.value)
}

/** 从待处理抽屉 @tree 打开某会话的节点树工作台。 */
async function openWorkspaceTree(
  rootChatId: string,
  sourceChatId?: string,
  interactionId?: string,
  anchorNodeId?: string,
): Promise<void> {
  const preset = quickPresetId.value
  if (!preset) return
  const id = agents.openWorkbenchWindow(preset)
  agents.setWorkbenchWindowChat(id, rootChatId)
  agents.setWorkbenchWindowFocus(id, {
    sourceChatId,
    interactionId,
    anchorNodeId,
  })
}

function closeDialog(): void {
  agents.closeAllHistory()
  closeAgentDialog()
}

function onDialogEditorKeydown(e: KeyboardEvent): void {
  onEditorKeydown(e, () => void sendFromComposer())
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
      :class="{ 'is-top-mask': isTopMask }"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <!-- 快速发送 composer 弹窗 panel（header + 角色编制 + composer + 待处理抽屉） -->
      <MotionDiv
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
                  >{{ pet?.name ?? presetName ?? 'agent' }}
                </span>
              </el-tooltip>
              <span v-else class="who">{{ pet?.name ?? presetName ?? 'agent' }}</span>
            </span>
            <span class="hint">Cmd/Ctrl+Enter 发送 · Esc 关闭</span>
          </span>
          <div class="head-actions">
            <el-tooltip placement="bottom" :show-after="120" :hide-after="0">
              <template #content>
                <span>打开当前会话的节点树工作台</span>
              </template>
              <button
                type="button"
                class="history-keys-btn"
                :class="{ 'is-active': dialogView === 'tree' }"
                aria-label="打开当前会话节点树工作台"
                @click="openWorkbenchForChat"
              >
                🌳
              </button>
            </el-tooltip>
            <el-tooltip placement="bottom" :show-after="120" :hide-after="0">
              <template #content>
                <span>待处理交互（审批 / 提问）</span>
              </template>
              <button
                type="button"
                class="history-keys-btn attention-head-btn"
                :class="{ 'is-active': dialogView === 'attention' }"
                aria-label="待处理交互"
                :aria-pressed="dialogView === 'attention'"
                @click="dialogView = dialogView === 'attention' ? 'composer' : 'attention'"
              >
                !<b v-if="workspaceAttentionCount">{{ workspaceAttentionCount }}</b>
              </button>
            </el-tooltip>
            <button type="button" class="close-btn" aria-label="关闭" @click="closeDialog">
              ✕
            </button>
          </div>
        </header>

        <WorkspaceSessionBrowser
          v-show="dialogView === 'attention'"
          :preset-id="quickPresetId"
          @tree="openWorkspaceTree"
        />

        <div v-show="dialogView !== 'attention'" class="dialog-composer-content">
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

        <ConversationTargetPicker
          v-if="quickTargetRequired && quickPresetId"
          :preset-id="quickPresetId"
          :draft="text"
          :sessions="quickSessions"
          :selected="quickTarget?.target"
          :selected-source="quickTarget?.source"
          :routing-enabled="quickRoutingEnabled"
          @select="selectQuickTarget"
          @clear-ai="clearAiQuickTarget"
          @clear-target="quickTarget = undefined"
          @enable-auto="enableAiQuickTarget"
          @routing-change="setQuickRoutingPending"
        />

        <AgentComposer
          :is-nyxus="false"
          :nyxus-draft-active="false"
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
          :target-locked="!quickTargetRequired || (!!quickTarget && !quickRoutingPending)"
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
        </div>
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
.role-summary-meta-row {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
}
.history-keys-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  margin-right: 6px;
}
.history-keys-btn.is-active {
  border-color: #7c3aed;
  color: #6d28d9;
  background: rgba(124, 58, 237, 0.1);
}
.attention-head-btn {
  position: relative;
}
.attention-head-btn b {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 999px;
  background: #dc2626;
  color: #fff;
  font-size: 8px;
  line-height: 15px;
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
  color: var(--ink);
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
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-hover);
  box-shadow: 0 7px 18px rgba(20, 22, 26, 0.18);
  color: var(--ink);
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
  color: color-mix(in srgb, var(--ink) 76%, transparent);
}

.instruction-token-floating-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  color: var(--accent-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 700;
}
</style>
