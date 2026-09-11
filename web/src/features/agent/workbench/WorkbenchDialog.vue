<script setup lang="ts">
import { BellFilled, Reading } from '@element-plus/icons-vue'
import RuntimeDiagram from './runtime-diagram/RuntimeDiagram.vue'
import WorkbenchAttentionSurface from './WorkbenchAttentionSurface.vue'
import WorkbenchOfflineMask from './WorkbenchOfflineMask.vue'
import {
  useWorkbenchDialogController,
  type WorkbenchDialogControllerProps,
} from './useWorkbenchDialogController'
import { useOverlayTransitionHooks } from '@/composables/useOverlayAnimation'
import WorkbenchViewToggle from './WorkbenchViewToggle.vue'
import WorkbenchFoldTool from './WorkbenchFoldTool.vue'
import WorkbenchWindowControls from './WorkbenchWindowControls.vue'
const props = defineProps<WorkbenchDialogControllerProps>()
const controller = useWorkbenchDialogController(props)
const workbenchMotion = useOverlayTransitionHooks('dialog')
const rolePopoutMotion = useOverlayTransitionHooks('panel')
const sessionPopoutMotion = useOverlayTransitionHooks('panel')
const {
  AgentComposer,
  ConnectionStatusChip,
  ContextUsageBar,
  FOLD_ICONS,
  FOLD_TIPS,
  LiteView,
  NYXUS_WORKBENCH_Z_INDEX,
  NyxusContentReader,
  NyxusSessionList,
  OVERLAY_Z_INDEX,
  PromptSnapshotTip,
  RoleConfigPopover,
  activateNyxusInput,
  activeCommandIndex,
  activeCommandTab,
  activeRoleIndex,
  attentionCount,
  brains,
  branchTarget,
  cancelNyxusInput,
  chatId,
  closeWorkspaceBrowser,
  closeWorkbench,
  comboCommandGroups,
  commandMenuRefFn,
  commandMenuStyle,
  commandOptions,
  commandTabs,
  composerBranchDescription,
  composerBranchTitle,
  config,
  connection,
  createSession,
  creating,
  detailBranchAvailability,
  editorRefFn,
  effectiveMode,
  error,
  executeSessionControl,
  fmtTokens,
  foldMode,
  foldToolOpen,
  isEmbedded,
  isNative,
  isShellless,
  liteViewVisible,
  liveTimeline,
  loading,
  matchingRoleMentions,
  maxControlState,
  mediaAttachments,
  mediaHint,
  runtimeHint,
  runtimeError,
  mediaServicesByType,
  minimizeWorkbench,
  nyxusDraftActive,
  onDialogEditorKeydown,
  onEditorInput,
  onEditorPaste,
  onEditorSelectionChange,
  onMaximizeClick,
  onMediaSelected,
  onSessionDelete,
  onTitlePointerDown,
  onTreeEpochChange,
  onTreePromptSnapShow,
  openHistory,
  openGeneration,
  orderedRoleSelections,
  pauseWholeTask,
  presetName,
  primaryRole,
  primarySelection,
  removeMedia,
  resizeDirections,
  roleListOpen,
  roleListPinned,
  roleMenuRefFn,
  roleSelections,
  roleUsages,
  readerOpen,
  readerTimeline,
  rootSessions,
  scheduleFoldToolClose,
  scheduleRoleListClose,
  scheduleSessionListClose,
  selectBranchTarget,
  selectedContent,
  selectWorkflowContent,
  selectCommand,
  selectCommandTab,
  selectFoldMode,
  selectRoleMention,
  sendFromComposer,
  sending,
  senseEntries,
  senseGroups,
  senseTool,
  senseTools,
  sessionControl,
  sessionControlPending,
  sessionListLoading,
  sessionListOpen,
  showCommandMenu,
  showFoldTool,
  showRoleList,
  showRoleMenu,
  showSessionList,
  supportsTools,
  switchSession,
  taskControlPending,
  taskHasRunningBranches,
  taskTimeline,
  text,
  toggleRoleList,
  toggleSessionList,
  toggleWorkspaceBrowser,
  treeBreakdown,
  treeFocusInteractionId,
  treeFocusNonce,
  treeFocusSourceChatId,
  treeLoading,
  treePromptSnap,
  treeRootChatId,
  treeUsage,
  treeUsagePct,
  updateReplayTimeline,
  uploading,
  usageClass,
  win,
  windowBlink,
  workspaceBrowserOpen,
  focusAttentionTree,
  workbenchShellRef,
  workbenchShellStyle,
  workbenchWindow,
} = controller
defineExpose({ closeWorkbench: controller.closeWorkbench })
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
          (liteViewVisible ? ' is-lite' : '')
        "
        :style="workbenchShellStyle"
        aria-label="Agent 执行工作台"
      >
        <div class="nyxus-branch-top">
          <div
            v-if="treeRootChatId"
            class="workbench-runtime-frame"
            :class="{ 'has-reader': readerOpen }"
          >
            <RuntimeDiagram
              :chat-id="treeRootChatId"
              :timeline="liveTimeline"
              :fold-mode="foldMode"
              :reader-open="readerOpen"
              :selection="selectedContent"
              :focus-source-chat-id="treeFocusSourceChatId"
              :focus-interaction-id="treeFocusInteractionId"
              :focus-nonce="treeFocusNonce"
              :suspended="win.minimized"
              @select-content="selectWorkflowContent"
              @replay-timeline-change="updateReplayTimeline"
            />
            <NyxusContentReader
              v-if="readerOpen"
              class="workbench-content-reader"
              :root-chat-id="treeRootChatId"
              :timeline="readerTimeline"
              :fold-mode="foldMode"
              :selection="selectedContent"
              :detail-branch-available="detailBranchAvailability.available"
              :detail-branch-unavailable-reason="detailBranchAvailability.reason"
              :sense-tools="senseTools"
              @close="readerOpen = false"
              @select="selectWorkflowContent"
              @branch="selectBranchTarget"
              @generation="openGeneration"
            />
          </div>
          <div v-else class="workbench-empty-state" aria-live="polite">
            <span>暂无历史会话</span>
            <button type="button" @click="createSession">新建会话</button>
          </div>
          <div v-if="treeLoading" class="workbench-tree-loading" aria-live="polite">
            <span class="workbench-spinner" aria-hidden="true" />
            执行图加载中…
          </div>
        </div>
        <WorkbenchAttentionSurface
          v-show="workspaceBrowserOpen"
          :preset-id="presetId"
          :native="isShellless"
          @close="closeWorkspaceBrowser"
          @tree="focusAttentionTree"
        />
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
          <WorkbenchWindowControls
            :max-control-state="maxControlState"
            @minimize="minimizeWorkbench"
            @maximize="onMaximizeClick"
            @close="closeWorkbench"
          />
        </header>
        <LiteView
          v-if="liteViewVisible"
          :window-id="windowId"
          :root-chat-id="treeRootChatId"
          :preset-name="presetName"
        />

        <div v-if="treeRootChatId" class="workbench-ctx-bar">
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
                <small>{{ composerBranchDescription }}</small>
              </span>
              <el-tooltip
                v-if="branchTarget"
                :content="
                  branchTarget.type === 'detail'
                    ? '解释分支使用专用诊断角色，可读取、搜索和运行诊断命令，但不会回传或修改原任务。'
                    : '继续分支继承来源分支角色和工具；它与原流程并列，已经发生的外部副作用不会回退。'
                "
                placement="top"
              >
                <span class="nyxus-composer-info" aria-label="分支影响说明">ⓘ</span>
              </el-tooltip>
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
            <div class="role-configs nyxus-role-configs">
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
              <span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
            </footer>
          </section>
        </Transition>
        <nav
          class="nyxus-side-tools"
          :class="{ 'has-open-popout': roleListOpen || sessionListOpen }"
          aria-label="节点树工作台功能工具栏"
        >
          <div class="nyxus-tool-column">
            <div class="nyxus-primary-tools" aria-label="主要操作">
              <el-tooltip
                :content="nyxusDraftActive ? '继续编辑消息' : '发送消息'"
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor">
                  <button
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
                  attentionCount ? `待处理审批与提问 · ${attentionCount}` : '待处理审批与提问'
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
                    :class="{ 'is-active': workspaceBrowserOpen }"
                    :aria-label="
                      attentionCount ? `待处理审批与提问，${attentionCount} 项` : '待处理审批与提问'
                    "
                    :aria-pressed="workspaceBrowserOpen"
                    @click="toggleWorkspaceBrowser"
                  >
                    <BellFilled aria-hidden="true" />
                    <span v-if="attentionCount" class="nyxus-attention-count" aria-hidden="true">
                      {{ attentionCount > 99 ? '99+' : attentionCount }}
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
                <span class="nyxus-tool-tip-anchor">
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
              <div
                class="nyxus-session-tool"
                @pointerenter="showSessionList"
                @focusin="showSessionList"
                @pointerleave="scheduleSessionListClose"
              >
                <button
                  type="button"
                  class="nyxus-rail-action"
                  :class="{ 'is-active': sessionListOpen }"
                  aria-label="会话列表"
                  :aria-expanded="sessionListOpen"
                  @click="toggleSessionList"
                >
                  <span aria-hidden="true">≡</span>
                </button>
              </div>
              <!-- v1.0 icon 区分：历史 ↺（回看）vs 上下文 ❐（内容快照），原 ◷/◍ 双圆点过似 -->
              <el-tooltip content="档案" placement="left" :show-after="200" :hide-after="0">
                <span class="nyxus-tool-tip-anchor">
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    :disabled="!chatId"
                    aria-label="档案"
                    @click="openHistory"
                  >
                    <span aria-hidden="true">↺</span>
                  </button>
                </span>
              </el-tooltip>
              <el-tooltip
                :content="`查看上下文 · ${treeUsagePct}%`"
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor">
                  <el-popover
                    trigger="click"
                    placement="left"
                    :width="460"
                    popper-class="prompt-snapshot-popper"
                    @show="onTreePromptSnapShow"
                  >
                    <template #reference>
                      <button
                        type="button"
                        class="nyxus-rail-action"
                        :disabled="!chatId"
                        :aria-label="`查看上下文 · ${treeUsagePct}%`"
                      >
                        <span aria-hidden="true">❐</span>
                      </button>
                    </template>
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
                  </el-popover>
                </span>
              </el-tooltip>
            </div>
            <div class="nyxus-tool-group is-secondary" role="group" aria-label="视图与配置工具">
              <el-tooltip
                :content="readerOpen ? '关闭所选内容阅读器' : '打开所选内容阅读器'"
                placement="left"
                :show-after="200"
                :hide-after="0"
              >
                <span class="nyxus-tool-tip-anchor">
                  <button
                    type="button"
                    class="nyxus-rail-action"
                    data-view-action="reader"
                    :class="{ 'is-active': readerOpen }"
                    :disabled="!treeRootChatId"
                    :aria-label="readerOpen ? '关闭所选内容阅读器' : '打开所选内容阅读器'"
                    :aria-pressed="readerOpen"
                    @click="readerOpen = !readerOpen"
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
                  aria-label="角色配置"
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
                    readonly
                    @update:selection="roleSelections[role] = $event"
                  />
                </template>
              </div>
            </div>
          </Transition>
          <Transition
            :css="false"
            @before-enter="sessionPopoutMotion.onBeforeEnter"
            @enter="sessionPopoutMotion.onEnter"
            @leave="sessionPopoutMotion.onLeave"
            @enter-cancelled="sessionPopoutMotion.onEnterCancelled"
            @leave-cancelled="sessionPopoutMotion.onLeaveCancelled"
          >
            <div
              v-if="sessionListOpen"
              key="session-popout"
              class="nyxus-session-popout"
              @pointerenter="showSessionList()"
              @pointerleave="scheduleSessionListClose()"
            >
              <NyxusSessionList
                :sessions="rootSessions"
                :active-chat-id="chatId"
                :loading="sessionListLoading"
                @select="(id) => void switchSession(id)"
                @delete="onSessionDelete"
              />
            </div>
          </Transition>
        </nav>
        <WorkbenchOfflineMask
          v-if="connection.status === 'disconnected'"
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
