<script setup lang="ts">
import { fmtTokens } from '../toolbar/contextBreakdown'
import { useAgentDialogViewController } from './useAgentDialogViewController'

const props = withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false })
const {
  ElPopover,
  ElTooltip,
  RoleConfigPopover,
  AgentComposer,
  ConversationTargetPicker,
  RoutingTraceWindow,
  WorkspaceSessionBrowser,
  ContextBreakdownTip,
  shellless,
  agents,
  interactions,
  isTopMask,
  overlayMotion,
  isFloatingOverlay,
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
  matchingFiles,
  showFileMenu,
  activeFileIndex,
  fileMenuHint,
  showRoleMenu,
  activeRoleIndex,
  uploading,
  mediaHint,
  runtimeHint,
  runtimeError,
  mediaAttachments,
  sending,
  loading,
  error,
  primarySelection,
  orderedRoleSelections,
  mediaServicesByType,
  closeAgentDialog,
  handleSend,
  onEditorKeydown,
  onEditorInput,
  onEditorSelectionChange,
  onEditorPaste,
  selectCommand,
  selectCommandTab,
  selectRoleMention,
  selectFileMention,
  removeMedia,
  toggleMediaVariant,
  onMediaSelected,
  senseEntries,
  senseTool,
  brainConfig,
  supportsTools,
  targetPickerRef,
  quickTarget,
  quickRoutingPending,
  quickAutoMode,
  setQuickRoutingPending,
  clearAiQuickTarget,
  enableAiQuickTarget,
  dialogView,
  quickTargetRequired,
  quickPresetId,
  quickPresetName,
  petWorkbenchOpen,
  dialogVisible,
  rolesExpanded,
  quickSessions,
  workspaceAttentionCount,
  quickRoutingEnabled,
  routeStatus,
  traceHover,
  traceAutoHideUntil,
  traceAutoHideTimer,
  finalizedTargetChatId,
  finalizedTargetStillExists,
  showTraceWindow,
  onRouteStatus,
  onTraceHover,
  panelEl,
  panelPos,
  dragPreview,
  dragCtx,
  bindPanelEl,
  onHeaderPointerDown,
  onPanelPointerMove,
  onPanelPointerUp,
  panelStyle,
  dragPreviewStyle,
  traceWindowPos,
  commandMenuStyle,
  editorRefFn,
  commandMenuRefFn,
  roleMenuRefFn,
  selectQuickTarget,
  sendFromComposer,
  openWorkbenchForChat,
  openWorkspaceTree,
  closeDialog,
  toggleAttention,
  onDialogEditorKeydown,
  usageClass,
  roleUsages,
  workspaceInvalid,
} = useAgentDialogViewController(props)

defineExpose({
  openWorkbenchForChat,
  openWorkspaceTree,
  closeDialog,
  toggleAttention,
  getWorkspaceAttentionCount: () => workspaceAttentionCount.value,
  isAttentionView: () => dialogView.value === 'attention',
})
</script>

<template>
  <Transition
    :css="false"
    @before-enter="overlayMotion.onBeforeEnter"
    @enter="overlayMotion.onEnter"
    @leave="overlayMotion.onLeave"
    @enter-cancelled="overlayMotion.onEnterCancelled"
    @leave-cancelled="overlayMotion.onLeaveCancelled"
  >
    <div
      v-if="dialogVisible"
      key="overlay"
      class="dialog-overlay"
      :class="{
        'is-top-mask': isTopMask,
        'is-floating': isFloatingOverlay,
        'is-embedded': embedded,
      }"
    >
      <!-- 快速发送 composer 弹窗 panel（header + 角色编制 + composer + 待处理抽屉） -->
      <div
        key="panel"
        :ref="bindPanelEl"
        class="dialog-panel"
        data-desktop-hit
        :style="panelStyle"
        role="dialog"
        :aria-modal="!shellless && isTopMask ? true : undefined"
        :aria-label="`向 ${pet?.name ?? '智能体'} 发送消息`"
      >
        <header v-if="!shellless" class="dialog-head" @pointerdown="onHeaderPointerDown">
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
                  <span v-if="workspaceInvalid" style="color: var(--danger)"> · 路径失效</span>
                </template>
                <span class="who" :class="{ 'is-ws-invalid': workspaceInvalid }">
                  <span class="who-icon">{{ workspaceInvalid ? '⚠' : '📁' }}</span
                  >{{ pet?.name ?? presetName ?? 'agent' }}
                </span>
              </el-tooltip>
              <span v-else class="who">{{ pet?.name ?? presetName ?? 'agent' }}</span>
            </span>
            <span class="hint">Enter 发送 · Shift+Enter 换行 · Esc 关闭</span>
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
                @click="toggleAttention"
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
          :grouped="shellless"
          @tree="openWorkspaceTree"
        />

        <div v-show="dialogView !== 'attention'" class="dialog-composer-content">
          <div class="role-configs" :class="{ 'is-collapsed': !rolesExpanded }">
            <button
              type="button"
              class="role-configs-toggle"
              :aria-expanded="rolesExpanded"
              aria-label="小组角色编制"
              @click="rolesExpanded = !rolesExpanded"
            >
              <span class="session-note">小组角色编制</span>
              <span
                class="role-configs-chevron"
                :class="{ 'is-open': rolesExpanded }"
                aria-hidden="true"
                >▾</span
              >
            </button>
            <template v-if="rolesExpanded">
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
                            <span v-else
                              >上下文 {{ Math.round(roleUsages[role]!.usage * 100) }}%</span
                            >
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
            </template>
          </div>

          <ConversationTargetPicker
            v-if="quickTargetRequired && quickPresetId"
            ref="targetPickerRef"
            :preset-id="quickPresetId"
            :sessions="quickSessions"
            :selected="quickTarget?.target"
            :selected-source="quickTarget?.source"
            :routing-enabled="quickRoutingEnabled"
            @select="selectQuickTarget"
            @clear-ai="clearAiQuickTarget"
            @clear-target="quickTarget = undefined"
            @enable-auto="enableAiQuickTarget"
            @routing-change="setQuickRoutingPending"
            @auto-mode-change="quickAutoMode = $event"
            @ai-status-hover="onTraceHover(true)"
            @ai-status-leave="onTraceHover(false)"
            @route-status="onRouteStatus"
          />

          <AgentComposer
            :is-nyxus="false"
            :nyxus-draft-active="false"
            :sending="sending || quickRoutingPending"
            :loading="loading"
            :text="text"
            :error="error"
            :media-attachments="mediaAttachments"
            :media-hint="mediaHint"
            :runtime-hint="runtimeHint"
            :runtime-error="runtimeError"
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
            @update:active-file-index="activeFileIndex = $event"
            :editor-ref-fn="editorRefFn"
            :command-menu-ref-fn="commandMenuRefFn"
            :role-menu-ref-fn="roleMenuRefFn"
            @remove-media="removeMedia"
            @toggle-media-variant="toggleMediaVariant"
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
        </div>
      </div>

      <!-- 拖拽占位框：拖动中仅此边框跟随鼠标（transform 驱动），松开后面板整体瞬移到位 -->
      <div
        v-if="dragPreview"
        class="dialog-drag-preview"
        :style="dragPreviewStyle"
        aria-hidden="true"
      />

      <!-- 会话路由小窗：锚定在发送面板右侧，展示 Shadow Agent 工作流程（候选+选择+思考/正文） -->
      <RoutingTraceWindow
        v-if="showTraceWindow"
        :pos="traceWindowPos"
        :routing="routeStatus.routing"
        :trace="routeStatus.trace"
        :thinking="routeStatus.thinking"
        :content="routeStatus.content"
      />
    </div>
  </Transition>
</template>

<style scoped lang="less" src="./AgentDialog.scoped.less"></style>
<style lang="less" src="./AgentDialog.popovers.less"></style>
<style lang="less" src="./AgentDialog.editor.less"></style>
