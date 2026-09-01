<script setup lang="ts">
import { useWorkbenchDialogController, type FoldMode, type WorkbenchDialogControllerProps } from './useWorkbenchDialogController'
import { useOverlayTransitionHooks } from '@/composables/useOverlayAnimation'
import WorkbenchViewToggle from './WorkbenchViewToggle.vue'
const props = defineProps<WorkbenchDialogControllerProps>()
const controller = useWorkbenchDialogController(props)
const workbenchMotion = useOverlayTransitionHooks('dialog')
const rolePopoutMotion = useOverlayTransitionHooks('panel')
const sessionPopoutMotion = useOverlayTransitionHooks('panel')
const {
  AgentComposer, ConnectionStatusChip, ContextUsageBar, FOLD_ICONS, FOLD_TIPS,
  LiteView, MessageBranchTree, NYXUS_WORKBENCH_Z_INDEX, NyxusPianoStrip,
  NyxusSessionList, OVERLAY_Z_INDEX, PendingOperationsPanel, PromptSnapshotTip, RoleConfigPopover,
  activateNyxusInput, activeCommandIndex, activeCommandTab, activeRoleIndex, agents, brains,
  branchTarget, branchTreeRef, cancelNyxusInput, chatId, closePiano,
  closeWorkbench, comboCommandGroups, commandMenuRefFn, commandMenuStyle, commandOptions,
  commandTabs, composerBranchDescription, composerBranchTitle, config, connection, createSession,
  creating, detailBranchAvailability, editorRefFn,
  effectiveMode, error, executeSessionControl, fallbackToClassic, fmtTokens, foldMode, foldToolOpen,
  isEmbedded, isNative, isShellless, liteViewVisible, loading, locateInteraction,
  matchingRoleMentions, maxControlState, mediaAttachments, mediaHint, mediaServicesByType,
  minimizeWorkbench, nyxusDraftActive, onDialogEditorKeydown, onEasterEgg, onEditorInput,
  onEditorPaste, onEditorSelectionChange, onMaximizeClick, onMediaSelected, onSessionDelete,
  onTitlePointerDown, onTreeEpochChange, onTreeInteractionFocus, onTreePromptSnapShow, openHistory,
  orderedRoleSelections, paperMode, pauseWholeTask, pianoOpen, presentationMode, presetName, primaryRole,
  primarySelection, removeMedia, resizeDirections, roleListOpen, roleListPinned,
  roleMenuRefFn, roleSelections, roleUsages, rootSessions, scheduleFoldToolClose,
  scheduleRoleListClose, scheduleSessionListClose, selectBranchTarget, selectCommand,
  selectCommandTab, selectFoldMode, selectRoleMention, sendFromComposer, sending, senseEntries,
  senseGroups, senseTool, senseTools, sessionControl, sessionControlPending, sessionListLoading,
  sessionListOpen, showCommandMenu, showFoldTool, showRoleList, showRoleMenu, showSessionList,
  supportsTools, switchSession, taskControlPending, taskHasRunningBranches, taskTimeline, text,
  toggleRoleList, toggleSessionList, topologyLayout, treeBreakdown,
  treeFocusInteractionId, treeFocusSourceChatId, treeFocusedInteraction, treeLoading,
  treePromptSnap, treeRootChatId, treeUsage, treeUsagePct, uploading, usageClass, win, windowBlink,
  workbenchShellRef, workbenchShellStyle, workbenchWindow,
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
        `is-${effectiveMode}` + (isShellless ? ' is-shellless' : '') + (isNative ? ' is-native' : '') + (liteViewVisible ? ' is-lite' : '')
      "
      :style="workbenchShellStyle"
      aria-label="节点树工作台"
    >
      <div class="nyxus-branch-top">
        <MessageBranchTree
          v-if="treeRootChatId"
          ref="branchTreeRef"
          :key="treeRootChatId"
          :root-chat-id="treeRootChatId"
          :timeline-override="taskTimeline"
          :layout-mode="topologyLayout ? 'topology' : 'timeline'"
          :presentation-mode="presentationMode"
          :fold-mode="foldMode"
          :paper-mode="paperMode"
          :suspended="win.minimized"
          :focus-source-chat-id="treeFocusSourceChatId"
          :focus-interaction-id="treeFocusInteractionId"
          :full-render-threshold="agents.globalConfig?.global.tree_full_render_threshold"
          :branch-anchor-node-id="branchTarget?.nodeId"
          :branch-anchor-kind="branchTarget?.type"
          :detail-branch-available="detailBranchAvailability.available"
          :detail-branch-unavailable-reason="detailBranchAvailability.reason"
          @branch="selectBranchTarget"
          @interaction-focus="onTreeInteractionFocus"
          @easter-egg="onEasterEgg"
          @presentation-fallback="fallbackToClassic"
        />
        <div v-else class="workbench-empty-state" aria-live="polite">
          <span>暂无历史会话</span>
          <button type="button" @click="createSession">新建会话</button>
        </div>
        <div v-if="treeLoading" class="workbench-tree-loading" aria-live="polite">
          <span class="workbench-spinner" aria-hidden="true" />
          节点树加载中…
        </div>
        <!-- 钢琴彩蛋浮层：节点树视口中央悬浮（✕/点外/Esc 关闭），flex 子元素自然居中。 -->
        <NyxusPianoStrip v-if="pianoOpen" class="nyxus-piano-flyout" @close="closePiano" />
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
        <div class="workbench-window-actions" role="group" aria-label="窗口控制">
          <button
            type="button"
            class="window-control is-minimize"
            aria-label="最小化工作台"
            title="最小化"
            @click="minimizeWorkbench"
          >
            <span class="window-control-icon is-minimize" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="window-control is-maximize"
            :aria-label="maxControlState === 'restore' ? '还原窗口' : '最大化窗口'"
            :title="maxControlState === 'restore' ? '还原' : '最大化'"
            @click="onMaximizeClick"
          >
            <span
              class="window-control-icon"
              :class="maxControlState === 'restore' ? 'is-restore' : 'is-maximize'"
              aria-hidden="true"
            />
          </button>
          <button
            type="button"
            class="window-control is-close"
            aria-label="关闭节点树工作台"
            title="关闭"
            @click="closeWorkbench"
          >
            <span class="window-control-icon is-close" aria-hidden="true" />
          </button>
        </div>
      </header>

      <!-- lite 极简视图（T33 L0）：激活时替代完整视图主体（CSS .is-lite 隐藏富 UI 元素） -->
      <LiteView
        v-if="liteViewVisible"
        :window-id="windowId"
        :root-chat-id="treeRootChatId"
        :preset-name="presetName"
      />

      <div v-if="treeRootChatId" class="workbench-ctx-bar">
        <ContextUsageBar :usage="treeUsage" :breakdown="treeBreakdown" variant="divider" />
      </div>

      <!-- 待操作任务面板：常驻右上（rail 左侧），收敛全部待处理交互入口（审批 + 提问）。 -->
      <PendingOperationsPanel
        v-if="treeRootChatId"
        :root-chat-id="treeRootChatId"
        :focused-interaction="treeFocusedInteraction"
        @locate="locateInteraction"
      />

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
                  <span aria-hidden="true">{{ sessionControl.mode === 'pause' ? '■' : '▶' }}</span>
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
            <el-tooltip content="对话历史" placement="left" :show-after="200" :hide-after="0">
              <span class="nyxus-tool-tip-anchor">
                <button
                  type="button"
                  class="nyxus-rail-action"
                  :disabled="!chatId"
                  aria-label="对话历史"
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
              :content="presentationMode === 'horizontal-signal' ? '切换纵向 Classic 节点树' : '切换水平 Signal Grid'"
              placement="left"
              :show-after="200"
              :hide-after="0"
            >
              <span class="nyxus-tool-tip-anchor">
                <button
                  type="button"
                  class="nyxus-rail-action is-presentation-action"
                  data-view-action="presentation"
                  :class="{ 'is-active': presentationMode === 'horizontal-signal' }"
                  :aria-label="presentationMode === 'horizontal-signal' ? '当前水平 Signal Grid，点击切换 Classic' : '当前纵向 Classic，点击切换 Signal Grid'"
                  :aria-pressed="presentationMode === 'horizontal-signal'"
                  @click="presentationMode = presentationMode === 'horizontal-signal' ? 'vertical-classic' : 'horizontal-signal'"
                >
                  <span aria-hidden="true">⇥</span>
                </button>
              </span>
            </el-tooltip>
            <!-- v1.0 布局切换从 nav 顶部移入视图与配置组，作为组内第一个按钮
                 （三组方案：主操作 / 会话 / 视图与配置，见 workbench-multi-window.md） -->
            <el-tooltip
              :content="topologyLayout ? '按节点顺序逐行排列' : '允许并行节点同行'"
              placement="left"
              :show-after="200"
              :hide-after="0"
            >
              <span class="nyxus-tool-tip-anchor">
                <button
                  type="button"
                  class="nyxus-rail-action is-layout-action"
                  data-view-action="layout"
                  :class="{ 'is-active': topologyLayout }"
                  :aria-label="topologyLayout ? '按节点顺序逐行排列' : '允许并行节点同行'"
                  :aria-pressed="topologyLayout"
                  @click="topologyLayout = !topologyLayout"
                >
                  <svg class="nyxus-layout-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 4v5M7 9h10M7 9v4M17 9v4" />
                    <circle cx="12" cy="4" r="2" />
                    <circle cx="7" cy="15" r="2" />
                    <circle cx="17" cy="15" r="2" />
                    <path d="M7 17v3M17 17v3" />
                  </svg>
                </button>
              </span>
            </el-tooltip>
            <el-tooltip
              :content="paperMode ? '关闭卡牌阅读模式' : '打开卡牌阅读模式'"
              placement="left"
              :show-after="200"
              :hide-after="0"
            >
              <span class="nyxus-tool-tip-anchor">
                <button
                  type="button"
                  class="nyxus-rail-action"
                  data-view-action="paper"
                  :class="{ 'is-active': paperMode }"
                  :aria-label="paperMode ? '关闭卡牌阅读模式' : '打开卡牌阅读模式'"
                  :aria-pressed="paperMode"
                  @click="paperMode = !paperMode"
                >
                  <svg class="nyxus-paper-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 4h10l2 3v13H7z" />
                    <path d="M5 7v13h11M9 9h7M9 12h7M9 15h5" />
                  </svg>
                </button>
              </span>
            </el-tooltip>
            <div
              class="nyxus-fold-tool"
              :class="{ 'is-open': foldToolOpen }"
              @pointerenter="showFoldTool"
              @focusin="showFoldTool"
              @pointerleave="scheduleFoldToolClose"
            >
              <el-tooltip
                v-for="mode in ['none', 'partial', 'participant', 'full'] as FoldMode[]"
                :key="mode"
                :content="FOLD_TIPS[mode]"
                placement="top"
                :show-after="200"
                :hide-after="0"
              >
                <button
                  type="button"
                  class="nyxus-fold-part"
                  :class="{ 'is-selected': foldMode === mode }"
                  :aria-label="FOLD_TIPS[mode]"
                  :aria-pressed="foldMode === mode"
                  @click="selectFoldMode(mode)"
                >
                  <svg class="nyxus-fold-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      v-for="path in FOLD_ICONS[mode].paths"
                      :key="path"
                      class="nyxus-fold-icon-edge"
                      :d="path"
                    />
                    <circle
                      v-for="([cx, cy], index) in FOLD_ICONS[mode].nodes"
                      :key="`${cx}-${cy}-${index}`"
                      class="nyxus-fold-icon-node"
                      :cx="cx"
                      :cy="cy"
                      r="1.65"
                    />
                  </svg>
                </button>
              </el-tooltip>
              <span class="nyxus-fold-current" aria-hidden="true">
                <svg class="nyxus-fold-icon" viewBox="0 0 24 24">
                  <path
                    v-for="path in FOLD_ICONS[foldMode].paths"
                    :key="path"
                    class="nyxus-fold-icon-edge"
                    :d="path"
                  />
                  <circle
                    v-for="([cx, cy], index) in FOLD_ICONS[foldMode].nodes"
                    :key="`${cx}-${cy}-${index}`"
                    class="nyxus-fold-icon-node"
                    :cx="cx"
                    :cy="cy"
                    r="1.65"
                  />
                </svg>
              </span>
            </div>
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
                <!-- v1.0 rail 角色 popout 只读展示（🔒 只读 chip，隐藏大脑/器官组选择区）：
                     编制操作统一在发送消息角色卡（RoleConfigPopover 不传 readonly 保持可操作） -->
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
      <!-- 断连遮罩：仅 disconnected（数据不可用）时阻断操作；connecting 只亮标题栏状态不遮罩。
           native 面关闭三键在 WindowFrame 层，不受遮罩影响。 -->
      <div v-if="connection.status === 'disconnected'" class="workbench-offline-mask" role="alert">
        <div class="offline-panel">
          <span class="workbench-spinner is-large" aria-hidden="true" />
          <strong>未连接到服务器</strong>
          <span>部分功能不可用，正在自动重连…</span>
          <button type="button" class="offline-retry" @click="connection.reconnect()">
            立即重试
          </button>
        </div>
      </div>
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
