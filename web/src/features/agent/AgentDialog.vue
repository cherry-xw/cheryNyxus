<script setup lang="ts">
/**
 * AgentDialog orchestrator：发消息弹窗（runtime 切换合一）。
 * 状态/逻辑下沉 useAgentDialogOptions；角色卡下沉 RoleConfigPopover；媒体区下沉 MediaWorkspace。
 */
import { AnimatePresence, motion } from "motion-v";
import RoleConfigPopover from "./dialog/RoleConfigPopover.vue";
import MediaWorkspace from "./dialog/MediaWorkspace.vue";
import { useAgentDialogOptions } from "./dialog/useAgentDialogOptions";

const MotionDiv = motion.div;

const {
  chatId, pet,
  brains, senseGroups, config, senseTools,
  roleSelections, primaryRole, text,
  uploading, mediaHint, uploadQueue, mediaAttachments,
  sending, loading, error,
  primarySelection, orderedRoleSelections,
  close, handleSend, onTextareaKeydown, onOverlayClick,
  removeMedia, onMediaSelected,
  senseEntries, senseTool, brainConfig, supportsTools,
} = useAgentDialogOptions();
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="chatId"
      key="overlay"
      class="dialog-overlay"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
      @pointerdown="onOverlayClick"
    >
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
            <span class="who">{{ pet?.name ?? "agent" }}</span>
            <span class="hint">Cmd/Ctrl+Enter 发送 · Esc 关闭</span>
          </span>
          <button type="button" class="close-btn" aria-label="关闭" @click="close">✕</button>
        </header>

        <div v-if="loading" class="loading-row">加载配置…</div>

        <div v-else class="role-configs">
          <div class="session-note">小组角色编制</div>
          <div class="role-tags" aria-label="小组角色编制">
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
                  :aria-label="`配置角色 ${role}，模型 ${(brainConfig(selection.brain)?.model ?? selection.brain) || '未选择'}，${senseEntries(selection.senseGroup).length} 项能力`"
                >
                  <span class="role-summary-main">
                    <span aria-hidden="true">{{ role === primaryRole ? "♛" : "✦" }}</span>
                    <span class="role-summary-name">{{ role }}</span>
                    <span class="role-summary-model">◈ {{ (brainConfig(selection.brain)?.model ?? selection.brain) || "—" }}</span>
                  </span>
                  <span v-if="senseEntries(selection.senseGroup).length" class="role-summary-senses" aria-label="当前能力">
                    <span v-for="entry in senseEntries(selection.senseGroup)" :key="entry" class="role-summary-sense-icon">
                      {{ senseTool(entry)?.icon ?? "⚙" }}
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

        <MediaWorkspace
          :disabled="uploading"
          :attachments="mediaAttachments"
          :hint="mediaHint"
          v-model:upload-queue="uploadQueue"
          :uploading="uploading"
          :has-primary-brain="!!primarySelection?.brain"
          @media-selected="onMediaSelected"
          @remove="removeMedia"
        />

        <div class="textarea-row">
          <el-input
            v-model="text"
            type="textarea"
            class="msg-input"
            :autosize="{ minRows: 6, maxRows: 24 }"
            placeholder="输入消息…"
            :disabled="sending"
            resize="none"
            @keydown="onTextareaKeydown"
          />
          <button
            type="button"
            class="send-btn"
            :disabled="!text.trim() || sending || loading || !primarySelection?.brain || (supportsTools(primarySelection.brain) && !primarySelection.senseGroup)"
            aria-label="发送消息"
            @click="handleSend"
          >
            <svg
              class="send-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>

        <div v-if="error" class="error-row" role="alert">{{ error }}</div>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import "./dialog/agentDialog.less";
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

.role-runtime-popper .el-popper__arrow { display: none; }
</style>
