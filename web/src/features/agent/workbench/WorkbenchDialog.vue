<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { BellFilled, Connection, Reading } from '@element-plus/icons-vue'
import RuntimeDiagram from './runtime-diagram/RuntimeDiagram.vue'
import ConversationView from './ConversationView.vue'
import WorkbenchAttentionSurface from './WorkbenchAttentionSurface.vue'
import WorkbenchOfflineMask from './WorkbenchOfflineMask.vue'
import TaskBrowser from './TaskBrowser.vue'
import {
  useWorkbenchDialogController,
  type WorkbenchDialogControllerProps,
} from './useWorkbenchDialogController'
import { useOverlayTransitionHooks } from '@/composables/useOverlayAnimation'
import { useAgentsStore } from '@/application/public'
import WorkbenchViewToggle from './WorkbenchViewToggle.vue'
import WorkbenchFoldTool from './WorkbenchFoldTool.vue'
import WorkbenchWindowControls from './WorkbenchWindowControls.vue'
import ContextAnalyticsPanel from './context-analytics/ContextAnalyticsPanel.vue'
import WorkbenchFilesWorkspace from './files/WorkbenchFilesWorkspace.vue'
import { serializeFileMention } from '../composables/commands'
const props = defineProps<WorkbenchDialogControllerProps>()
const controller = useWorkbenchDialogController(props)
const agents = useAgentsStore()
const workbenchMotion = useOverlayTransitionHooks('dialog')
const rolePopoutMotion = useOverlayTransitionHooks('panel')
// 查看上下文侧边抽屉：drawer 型动效（面板 x 轴滑入，与全局抽屉一致）。
const contextDrawerMotion = useOverlayTransitionHooks('drawer')
const contextTrigger = ref<HTMLButtonElement>()
const filesOpen = ref(false)
const visitedFileChat = ref('')
watch([filesOpen, controller.treeRootChatId], ([open, id]) => { if (open) visitedFileChat.value = id })
const liteViewRef = ref<{ insertReference: (token: string) => void }>()
const conversationViewRef = ref<{ focusInput: () => void }>()
function insertFileReference(path: string, kind: 'file' | 'directory'): void {
  const token = serializeFileMention({ path, kind })
  const targetIsLite = liteViewVisible.value
  filesOpen.value = false
  if (targetIsLite) void nextTick(() => liteViewRef.value?.insertReference(token))
  else {
    controller.appendFileReference({ path, kind })
    if (conversationViewVisible.value) void nextTick(() => conversationViewRef.value?.focusInput())
    else activateNyxusInput()
  }
}
function closeContextPanel(): void {
  controller.closeContextDrawer()
  void nextTick(() => contextTrigger.value?.focus())
}
function toggleFilesWorkspace(): void {
  if (!controller.treeRootChatId.value) return
  filesOpen.value = !filesOpen.value
}
function closeFilesWorkspace(): void {
  filesOpen.value = false
}
// 抽屉打开时按 Esc 关闭。topOverlay 守卫与全局抽屉一致：settings / 历史抽屉 / 输入弹窗 /
// 会话列表任一打开时它们在上方，Esc 交给它们处理，避免双重关闭。
function onContextDrawerKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !controller.contextDrawerOpen.value) return
  if (agents.topOverlay) return
  e.preventDefault()
  e.stopImmediatePropagation()
  closeContextPanel()
}
onMounted(() => window.addEventListener('keydown', onContextDrawerKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onContextDrawerKeydown, true))
// 小组角色编制入口统一在右侧 rail 按钮（树/对话/精简三视图共用），composer 内不再内置折叠面板。
// Keep the controller surface grouped here so this orchestration SFC stays inside its line budget.
// prettier-ignore
const {
  AgentComposer, ConnectionStatusChip, ContextUsageBar,
  FOLD_ICONS, FOLD_TIPS,
  LiteView,
  MessageBranchTree,
  NYXUS_WORKBENCH_Z_INDEX,
  NyxusContentReader,
  OVERLAY_Z_INDEX, PromptSnapshotTip, RoleConfigPopover,
  activateNyxusInput, activeCommandIndex, activeCommandTab, activeRoleIndex,
  attentionCollapsed, attentionWindowOpen, currentAttentionCount,
  runtimeDiagramProps, treeProps,
  brains, branchTarget,
  cancelNyxusInput, chatId, clearBranchTarget, closeWorkbench,
  comboCommandGroups,
  commandMenuRefFn, commandMenuStyle,
  commandOptions, commandTabs,
  composerBranchDescription, composerBranchTitle,
  config, connection,
  conversationTaskBranches, conversationViewVisible,
  createSession, creating, detailBranchAvailability,
  editorRefFn, effectiveMode, error, executeSessionControl, fmtTokens,
  foldMode, foldToolOpen,
  isEmbedded, isNative, isShellless, liteViewVisible, loading,
  matchingRoleMentions,
  matchingFiles, showFileMenu, activeFileIndex, fileMenuHint,
  maxControlState,
  mediaAttachments, mediaHint,
  runtimeHint, runtimeError,
  mediaServicesByType, minimizeWorkbench, nyxusDraftActive,
  onConversationDraftInput,
  onConversationSwitchChat,
  onDialogEditorKeydown,
  onEditorInput,
  onEditorPaste,
  onEditorSelectionChange,
  onMaximizeClick,
  onMediaSelected,
  onTitlePointerDown,
  onTreeEpochChange,
  openGeneration, orderedRoleSelections, pauseWholeTask,
  presetName, primaryRole, primarySelection, removeMedia, resizeDirections,
  roleListOpen, roleListPinned, roleMenuRefFn,
  roleSelections, roleUsages,
  sidePanel, toggleSidePanel,
  readerTimeline,
  scheduleFoldToolClose, scheduleRoleListClose,
  selectBranchTarget, selectedContent, selectWorkflowContent,
  selectCommand, selectCommandTab, selectFoldMode, selectRoleMention,
  selectFileMention,
  sendFromComposer, sending,
  senseEntries, senseGroups, senseTool, senseTools,
  sessionControl, sessionControlPending,
  showCommandMenu, showFoldTool, showRoleList, showRoleMenu,
  closeSidePanel,
  contextAnalyticsDemos, contextAnalyticsInitialTaskKey,
  contextDrawerOpen, contextAnalyticsAvailable, contextAnalyticsPanelEligible, toggleContextDrawer,
  supportsTools,
  taskControlPending, taskHasRunningBranches, taskTimeline,
  taskBrowserState, closeTaskBrowser, openContextAnalyticsFromBrowser, openTaskFromBrowser, onTaskBrowserArchived,
  text, toggleRoleList,
  treeBreakdown, treeLoading, treePromptSnap, treeRootChatId,
  treeUsage, treeUsagePct,
  toggleAttentionWindow, uploading, usageClass, win, windowBlink,
  workbenchShellRef, workbenchShellStyle, workbenchWindow,
} = controller
defineExpose({ closeWorkbench: controller.closeWorkbench, toggleFilesWorkspace, closeFilesWorkspace, closeTaskBrowser: controller.closeTaskBrowser, getFilesOpen: () => filesOpen.value })
</script>
<template>
  <Transition
    :css="false"
    @before-enter="workbenchMotion.onBeforeEnter"
    @enter="workbenchMotion.onEnter"
    @leave="workbenchMotion.onLeave"
    @enter-cancelled="workbenchMotion.onEnterCancelled"
    @leave-cancelled="workbenchMotion.onLeaveCancelled"
  >
    <div
      v-if="win"
      v-show="!win.minimized"
      class="dialog-overlay is-nyxus-layout"
      :class="{
        'is-windowed-workbench': effectiveMode === 'window',
        'is-native': isNative,
        'is-embedded': isEmbedded,
      }"
      :style="{
        zIndex: OVERLAY_Z_INDEX.composer + (win.zOrder ?? 0),
        '--nx-z-canvas': NYXUS_WORKBENCH_Z_INDEX.canvas,
        '--nx-z-node-hit-target': NYXUS_WORKBENCH_Z_INDEX.nodeHitTarget,
        '--nx-z-node-overlay': NYXUS_WORKBENCH_Z_INDEX.nodeOverlay,
        '--nx-z-run-crt': NYXUS_WORKBENCH_Z_INDEX.runCrt,
        '--nx-z-composer': NYXUS_WORKBENCH_Z_INDEX.composer,
        '--nx-z-blocking-interaction': NYXUS_WORKBENCH_Z_INDEX.blockingInteraction,
        '--nx-z-chrome': NYXUS_WORKBENCH_Z_INDEX.chrome,
        '--nx-z-drawer-mask': NYXUS_WORKBENCH_Z_INDEX.drawerMask,
        '--nx-z-drawer': NYXUS_WORKBENCH_Z_INDEX.drawer,
        '--nx-z-side-popover': NYXUS_WORKBENCH_Z_INDEX.sidePopover,
        '--nx-z-connection-mask': NYXUS_WORKBENCH_Z_INDEX.connectionMask,
      }"
    >
      <section
        ref="workbenchShellRef"
        class="workbench-shell"
        :class="
          `is-${effectiveMode}` +
          (isShellless ? ' is-shellless' : '') +
          (isNative ? ' is-native' : '') +
          (liteViewVisible ? ' is-lite' : '') +
          (conversationViewVisible ? ' is-conversation' : '')
        "
        :style="workbenchShellStyle"
        aria-label="Agent 执行工作台"
      >
        <div class="nyxus-branch-top" :inert="taskBrowserState.open || undefined">
          <MessageBranchTree
            v-if="treeRootChatId && !conversationViewVisible"
            :key="treeRootChatId"
            v-bind="treeProps"
            @branch="selectBranchTarget"
            @close-side-panel="closeSidePanel"
          >
            <template #side-panel>
              <div class="workbench-side-panel">
                <RuntimeDiagram v-if="sidePanel === 'workflow'" v-bind="runtimeDiagramProps" />
                <NyxusContentReader
                  v-else-if="sidePanel === 'reader'"
                  class="workbench-content-reader"
                  :root-chat-id="treeRootChatId"
                  :timeline="readerTimeline"
                  :fold-mode="foldMode"
                  :selection="selectedContent"
                  :detail-branch-available="detailBranchAvailability.available"
                  :detail-branch-unavailable-reason="detailBranchAvailability.reason"
                  :sense-tools="senseTools"
                  @close="toggleSidePanel('reader')"
                  @select="selectWorkflowContent"
                  @branch="selectBranchTarget"
                  @generation="openGeneration"
                />
              </div>
            </template>
          </MessageBranchTree>
          <ConversationView
            v-else-if="conversationViewVisible"
            ref="conversationViewRef"
            :key="treeRootChatId"
            :window-id="windowId"
            :root-chat-id="treeRootChatId"
            :task-branches="conversationTaskBranches"
            :text="text"
            :sending="sending"
            :uploading="uploading"
            :loading="loading"
            :error="error"
            :branch-active="!!branchTarget"
            :branch-title="composerBranchTitle"
            :media-count="mediaAttachments.length"
            @switch-chat="onConversationSwitchChat"
            @send="sendFromComposer"
            @draft-input="onConversationDraftInput"
            @drop-branch="clearBranchTarget"
          />
          <!-- 待处理审批与提问：树模式左下角浮窗；对话模式直接在消息列表内作答（见 QuestionRenderer 可交互模式）。 -->
          <WorkbenchAttentionSurface
            v-if="currentAttentionCount && !attentionCollapsed"
            :key="treeRootChatId"
            class="workbench-current-attention"
            :root-chat-id="controller.attentionRootChatId.value || undefined"
            :count="currentAttentionCount"
          />
          <div v-if="!treeRootChatId" class="workbench-empty-state" aria-live="polite">
            <span>暂无历史会话</span>
            <button type="button" @click="createSession">新建会话</button>
          </div>
          <div
            v-if="treeLoading && !conversationViewVisible"
            class="workbench-tree-loading"
            aria-live="polite"
          >
            <span class="workbench-spinner" aria-hidden="true" />
            执行图加载中…
          </div>
        </div>
        <header
          v-if="!isShellless"
          class="workbench-titlebar"
          :class="{
            'is-draggable': effectiveMode === 'window',
            'has-attention': windowBlink,
            'is-native': isNative,
          }"
          @pointerdown="onTitlePointerDown"
        >
          <span class="workbench-title">{{ presetName || '节点树工作台' }}</span>
          <small>{{
            effectiveMode === 'window' ? '拖动标题栏移动 · 拖动边缘缩放' : '节点树工作台'
          }}</small>
          <ConnectionStatusChip class="workbench-conn-chip" />
          <WorkbenchViewToggle :window-id="windowId" />
          <el-tooltip :content="treeRootChatId ? '查看工作区文件与 Terminal' : '当前没有可用会话'" placement="bottom">
            <span>
              <button
                type="button"
                class="workbench-files-trigger"
                aria-label="打开文件工作区"
                :aria-pressed="filesOpen"
                :class="{ 'is-active': filesOpen }"
                :disabled="!treeRootChatId"
                @click="closeTaskBrowser(); toggleFilesWorkspace()"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h7l2 2h9v9.5H3z" /><path d="M3 6.5V5h7l2 2" /></svg>
              </button>
            </span>
          </el-tooltip>
          <WorkbenchWindowControls
            v-if="!isEmbedded"
            :max-control-state="maxControlState"
            @minimize="minimizeWorkbench"
            @maximize="onMaximizeClick"
            @close="closeWorkbench"
          />
        </header>
        <TaskBrowser
          v-if="taskBrowserState.open"
          :key="taskBrowserState.revision"
          class="workbench-task-browser"
          :window-id="windowId"
          :preset-id="presetId"
          :preset-name="presetName ?? undefined"
          :active-chat-id="chatId"
          :entry-focus="taskBrowserState.entryFocus"
          @close="closeTaskBrowser"
          @open-task="openTaskFromBrowser"
          @analytics="openContextAnalyticsFromBrowser"
          @archived="onTaskBrowserArchived"
        />
        <LiteView
          v-if="liteViewVisible"
          ref="liteViewRef"
          :inert="taskBrowserState.open || undefined"
          :window-id="windowId"
          :root-chat-id="treeRootChatId"
          :preset-name="presetName"
        />
        <WorkbenchFilesWorkspace
          v-if="treeRootChatId && visitedFileChat === treeRootChatId"
          v-show="filesOpen"
          :key="treeRootChatId"
          :chat-id="treeRootChatId"
          @reference="insertFileReference"
        />

        <div
          v-if="treeRootChatId"
          class="workbench-ctx-bar"
          :inert="taskBrowserState.open || undefined"
        >
          <ContextUsageBar :usage="treeUsage" :breakdown="treeBreakdown" variant="divider" />
        </div>

        <Transition name="nyxus-composer">
          <section
            v-if="nyxusDraftActive"
            id="nyxus-message-composer"
            class="nyxus-composer-dock"
            role="dialog"
            aria-modal="false"
            aria-label="发送新消息"
            :inert="taskBrowserState.open || undefined"
            @pointerdown.stop
            @pointermove.stop
            @pointerup.stop
            @wheel.stop
          >
            <header
              class="nyxus-composer-head"
              :class="branchTarget ? `is-${branchTarget.type}` : undefined"
            >
              <span class="nyxus-composer-status" aria-hidden="true">
                {{
                  branchTarget?.type === 'detail'
                    ? '◉'
                    : branchTarget?.type === 'continuation'
                      ? '⑂'
                      : ''
                }}
              </span>
              <span class="nyxus-composer-title">
                <strong>{{ composerBranchTitle }}</strong>
                <small> · {{ composerBranchDescription }}</small>
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
              :runtime-hint="runtimeHint"
              :runtime-error="runtimeError"
              :attachments-disabled="!!branchTarget"
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
              :matching-files="matchingFiles"
              :show-file-menu="showFileMenu"
              :active-file-index="activeFileIndex"
              :file-menu-hint="fileMenuHint"
              :editor-ref-fn="editorRefFn"
              :command-menu-ref-fn="commandMenuRefFn"
              :role-menu-ref-fn="roleMenuRefFn"
              @update:active-file-index="activeFileIndex = $event"
              @remove-media="removeMedia"
              @editor-input="onEditorInput"
              @editor-keydown="onDialogEditorKeydown"
              @editor-selection-change="onEditorSelectionChange"
              @editor-paste="onEditorPaste"
              @select-command="selectCommand"
              @select-command-tab="selectCommandTab"
              @select-role-mention="selectRoleMention"
              @select-file-mention="selectFileMention"
              @media-selected="(f: any) => onMediaSelected(f)"
              @send="sendFromComposer"
              @update:active-command-index="activeCommandIndex = $event"
              @update:active-role-index="activeRoleIndex = $event"
            />
            <footer class="nyxus-composer-hint">
              <span><kbd>/</kbd> 指令 · <kbd>@</kbd> 角色 · <kbd>&amp;</kbd> 文件</span>
              <span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
            </footer>
          </section>
        </Transition>
        <nav
          class="nyxus-side-tools"
          :class="{ 'has-open-popout': roleListOpen }"
          aria-label="节点树工作台功能工具栏"
          :inert="taskBrowserState.open || undefined"
        >
          <div class="nyxus-tool-column">
            <div class="nyxus-primary-tools" aria-label="主要操作">
              <el-tooltip
                :content="nyxusDraftActive ? '继续编辑消息' : '发送消息'"
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor is-lite-hidden">
                  <button
                    ref="contextTrigger"
                    type="button"
                    class="nyxus-rail-action is-message"
                    :class="{ 'is-active': nyxusDraftActive }"
                    :disabled="!chatId"
                    :aria-label="nyxusDraftActive ? '继续编辑消息' : '发送消息'"
                    aria-controls="nyxus-message-composer"
                    :aria-expanded="nyxusDraftActive"
                    @click="activateNyxusInput"
                  >
                    <span aria-hidden="true">↗</span>
                  </button>
                </span>
              </el-tooltip>
              <el-tooltip
                :content="
                  attentionWindowOpen
                    ? `收起待处理审批与提问窗口 · ${currentAttentionCount} 项`
                    : `展开待处理审批与提问窗口 · ${currentAttentionCount} 项`
                "
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor">
                  <button
                    type="button"
                    class="nyxus-rail-action is-attention"
                    data-view-action="attention"
                    :class="{ 'is-active': attentionWindowOpen }"
                    :aria-label="
                      attentionWindowOpen
                        ? `收起待处理审批与提问窗口，${currentAttentionCount} 项`
                        : `展开待处理审批与提问窗口，${currentAttentionCount} 项`
                    "
                    :aria-pressed="attentionWindowOpen"
                    :disabled="!currentAttentionCount"
                    @click="toggleAttentionWindow"
                  >
                    <BellFilled aria-hidden="true" />
                    <span
                      v-if="currentAttentionCount"
                      class="nyxus-attention-count"
                      aria-hidden="true"
                    >
                      {{ currentAttentionCount > 99 ? '99+' : currentAttentionCount }}
                    </span>
                  </button>
                </span>
              </el-tooltip>
              <el-tooltip
                v-if="chatId && sessionControl"
                :content="
                  sessionControlPending
                    ? '正在处理…'
                    : sessionControl.mode === 'pause'
                      ? '暂停任务树'
                      : '继续任务树'
                "
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor">
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    :class="sessionControl.mode === 'pause' ? 'is-stop' : 'is-run'"
                    :disabled="sessionControlPending"
                    :aria-label="sessionControl.mode === 'pause' ? '暂停任务树' : '继续任务树'"
                    @click="executeSessionControl"
                  >
                    <span aria-hidden="true">{{
                      sessionControl.mode === 'pause' ? '■' : '▶'
                    }}</span>
                  </button>
                </span>
              </el-tooltip>
              <el-tooltip
                v-if="
                  taskTimeline?.taskId &&
                  taskHasRunningBranches &&
                  (taskTimeline.branches?.length ?? 0) > 1
                "
                :content="taskControlPending ? '正在暂停全部分支…' : '暂停全部分支'"
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor is-lite-hidden">
                  <button
                    type="button"
                    class="nyxus-rail-action is-stop"
                    data-view-action="pause-whole"
                    :disabled="taskControlPending"
                    aria-label="暂停全部分支"
                    @click="pauseWholeTask"
                  >
                    <span aria-hidden="true">▣</span>
                  </button>
                </span>
              </el-tooltip>
            </div>
            <div class="nyxus-tool-group" role="group" aria-label="会话工具">
              <el-tooltip content="新建会话" placement="left" :show-after="200" :hide-after="0">
                <span class="nyxus-tool-tip-anchor">
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    :disabled="creating"
                    aria-label="新建会话"
                    @click="createSession"
                  >
                    <span aria-hidden="true">＋</span>
                  </button>
                </span>
              </el-tooltip>
              <!-- v1.0 icon 区分：对话模式 ↺（回看完整对话，整屏会话视图）vs 上下文 ❐（内容快照），原 ◷/◍ 双圆点过似 -->
              <!-- 会话切换入口已上移标题栏会话状态条（strip + 分页下拉，2026-09-16），rail ≡ 会话列表移除 -->
              <!-- v2.1 移除 rail「对话模式」按钮：对话模式入口统一由标题栏三档切换钮承担（精简是对话的紧凑展示），rail 不再放第二入口 -->
              <el-tooltip
                v-if="contextAnalyticsAvailable"
                :content="`查看上下文 · ${treeUsagePct}%`"
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor">
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    :class="{ 'is-active': contextDrawerOpen }"
                    :disabled="!chatId"
                    :aria-label="`查看上下文 · ${treeUsagePct}%`"
                    :aria-expanded="contextDrawerOpen"
                    aria-haspopup="dialog"
                    @click="toggleContextDrawer"
                  >
                    <span aria-hidden="true">❐</span>
                  </button>
                </span>
              </el-tooltip>
            </div>
            <div class="nyxus-tool-group is-secondary" role="group" aria-label="视图与配置工具">
              <el-tooltip content="卡牌模式" placement="left" :show-after="200" :hide-after="0">
                <span class="nyxus-tool-tip-anchor is-lite-hidden">
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    data-view-action="cards"
                    :class="{ 'is-active': sidePanel === 'cards' }"
                    :disabled="!treeRootChatId"
                    aria-label="卡牌模式"
                    :aria-pressed="sidePanel === 'cards'"
                    @click="toggleSidePanel('cards')"
                  >
                    <span aria-hidden="true">▤</span>
                  </button>
                </span>
              </el-tooltip>
              <el-tooltip content="流程图" placement="left" :show-after="200" :hide-after="0">
                <span class="nyxus-tool-tip-anchor is-lite-hidden">
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    data-view-action="workflow"
                    :class="{ 'is-active': sidePanel === 'workflow' }"
                    :disabled="!treeRootChatId"
                    aria-label="流程图"
                    :aria-pressed="sidePanel === 'workflow'"
                    @click="toggleSidePanel('workflow')"
                  >
                    <Connection aria-hidden="true" />
                  </button>
                </span>
              </el-tooltip>
              <el-tooltip
                :content="sidePanel === 'reader' ? '关闭所选内容阅读器' : '打开所选内容阅读器'"
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor is-lite-hidden">
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    data-view-action="reader"
                    :class="{ 'is-active': sidePanel === 'reader' }"
                    :disabled="!treeRootChatId"
                    :aria-label="
                      sidePanel === 'reader' ? '关闭所选内容阅读器' : '打开所选内容阅读器'
                    "
                    :aria-pressed="sidePanel === 'reader'"
                    @click="toggleSidePanel('reader')"
                  >
                    <Reading aria-hidden="true" />
                  </button>
                </span>
              </el-tooltip>
              <WorkbenchFoldTool
                :fold-mode="foldMode"
                :fold-tool-open="foldToolOpen"
                :icons="FOLD_ICONS"
                :tips="FOLD_TIPS"
                @show="showFoldTool"
                @schedule-close="scheduleFoldToolClose"
                @select="selectFoldMode"
              />
              <div
                class="nyxus-role-tool"
                @pointerenter="showRoleList"
                @focusin="showRoleList"
                @pointerleave="scheduleRoleListClose"
              >
                <button
                  type="button"
                  class="nyxus-rail-action"
                  :class="{ 'is-active': roleListOpen }"
                  aria-label="小组角色编制"
                  :aria-expanded="roleListOpen"
                  @click="toggleRoleList"
                >
                  <span aria-hidden="true">♟</span>
                </button>
              </div>
            </div>
          </div>
          <Transition
            :css="false"
            @before-enter="rolePopoutMotion.onBeforeEnter"
            @enter="rolePopoutMotion.onEnter"
            @leave="rolePopoutMotion.onLeave"
            @enter-cancelled="rolePopoutMotion.onEnterCancelled"
            @leave-cancelled="rolePopoutMotion.onLeaveCancelled"
          >
            <div
              v-if="roleListOpen"
              key="role-popout"
              class="nyxus-role-popout"
              @pointerenter="showRoleList()"
              @pointerleave="scheduleRoleListClose()"
              @pointerdown="roleListPinned = true"
            >
              <div class="nyxus-role-configs" aria-label="小组角色编制">
                <small class="role-runtime-note" role="status">
                  {{ runtimeHint && !runtimeError ? runtimeHint : '修改角色编制后，后续请求会使用新配置。' }}
                </small>
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
                              <span>上下文 {{ Math.round(roleUsages[role]!.usage * 100) }}%</span>
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
            </div>
          </Transition>
        </nav>
        <!-- 查看上下文：工作台内右侧抽屉（替代原 rail ❐ 小弹窗），从标题栏下方延伸到底部。 -->
        <Transition
          :css="false"
          @before-enter="contextDrawerMotion.onBeforeEnter"
          @enter="contextDrawerMotion.onEnter"
          @leave="contextDrawerMotion.onLeave"
          @enter-cancelled="contextDrawerMotion.onEnterCancelled"
          @leave-cancelled="contextDrawerMotion.onLeaveCancelled"
        >
          <ContextAnalyticsPanel
            v-if="contextDrawerOpen"
            key="context-analytics-demo"
            :models="contextAnalyticsDemos"
            :initial-task-key="contextAnalyticsInitialTaskKey"
            :eligible="contextAnalyticsPanelEligible"
            data-motion-panel
            @close="closeContextPanel"
          />
          <!-- eslint-disable-next-line vue/no-dupe-v-else-if -- 保留旧抽屉逻辑，供方案回退时恢复。 -->
          <div v-else-if="contextDrawerOpen" key="context-drawer" class="workbench-context-drawer">
            <div class="workbench-context-drawer-mask" @pointerdown="closeContextPanel" />
            <aside
              class="workbench-context-drawer-panel"
              role="dialog"
              aria-label="上下文快照"
              data-motion-panel
            >
              <header class="workbench-context-drawer-head">
                <span class="workbench-context-drawer-title">上下文快照</span>
                <button
                  type="button"
                  class="workbench-context-drawer-close"
                  aria-label="关闭上下文抽屉"
                  title="关闭"
                  @click="closeContextPanel"
                >
                  ✕
                </button>
              </header>
              <div class="workbench-context-drawer-body">
                <ContextUsageBar :usage="treeUsage" :breakdown="treeBreakdown" variant="inline" />
                <PromptSnapshotTip
                  v-if="treePromptSnap"
                  :system-prompt="treePromptSnap.systemPrompt"
                  :tools="treePromptSnap.tools"
                  :status="treePromptSnap.status"
                  :error="treePromptSnap.error"
                  :epochs="treePromptSnap.epochs"
                  :selected-epoch-id="treePromptSnap.selectedEpochId"
                  :active-epoch-id="treePromptSnap.activeEpochId"
                  :snapshot-quality="treePromptSnap.snapshotQuality"
                  @epoch-change="onTreeEpochChange"
                />
                <div v-else class="workbench-context-drawer-loading">重建系统提示词…</div>
                <p class="workbench-context-drawer-esc">按 Esc 关闭</p>
              </div>
            </aside>
          </div>
        </Transition>
        <WorkbenchOfflineMask
          v-if="connection.status === 'disconnected'"
          :inert="taskBrowserState.open || undefined"
          @retry="connection.reconnect()"
        />
        <template v-if="effectiveMode === 'window'">
          <span
            v-for="direction in resizeDirections"
            :key="direction"
            class="workbench-resize-handle"
            :class="`is-${direction}`"
            :aria-label="`调整窗口大小 ${direction}`"
            @pointerdown="workbenchWindow.onResizePointerDown(direction, $event)"
          />
        </template>
      </section>
    </div>
  </Transition>
</template>

<style scoped lang="less" src="./WorkbenchDialog.scoped.less"></style>
<style lang="less" src="./WorkbenchDialog.popovers.less"></style>
