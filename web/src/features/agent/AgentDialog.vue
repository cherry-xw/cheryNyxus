<script setup lang="ts">
/**
 * AgentDialog orchestrator：发消息弹窗（runtime 切换合一）。
 * 状态/逻辑下沉 useAgentDialogOptions；角色卡下沉 RoleConfigPopover；媒体预览下沉 MediaPreviewBar。
 */
import { AnimatePresence, motion } from "motion-v";
import { ElPopover, ElUpload } from "element-plus";
import RoleConfigPopover from "./dialog/RoleConfigPopover.vue";
import MediaPreviewBar from "./dialog/media/MediaPreviewBar.vue";
import { useAgentDialogOptions } from "./dialog/useAgentDialogOptions";

const MotionDiv = motion.div;

const {
  chatId, pet,
  brains, senseGroups, config, senseTools,
  roleSelections, primaryRole, text,
  uploading, mediaHint, mediaAttachments,
  sending, loading, error,
  primarySelection, orderedRoleSelections, mediaServicesByType,
  close, handleSend, onTextareaKeydown,
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

        <div class="role-configs">
          <div class="session-note">小组角色编制</div>
          <div
            v-if="loading"
            class="role-tags role-tags-skel"
            aria-busy="true"
            aria-label="角色编制加载中"
          >
            <span
              v-for="n in 3"
              :key="n"
              class="role-skel-tile"
              aria-hidden="true"
            />
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

        <MediaPreviewBar
          :attachments="mediaAttachments"
          @remove="removeMedia"
        />

        <div v-if="mediaHint" class="media-hint-row">{{ mediaHint }}</div>

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
          <ElPopover
            trigger="click"
            placement="top-end"
            :width="160"
            popper-class="add-media-popper"
            popper-style="padding: 4px;"
          >
            <template #reference>
              <button
                type="button"
                class="add-media-btn"
                :disabled="uploading || !primarySelection?.brain"
                :title="uploading ? '上传中…' : '添加媒体'"
                aria-label="添加媒体附件"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M12 5v14M5 12h14"/></svg>
              </button>
            </template>
            <div class="add-media-menu" @click.stop>
              <ElUpload
                :auto-upload="false"
                :show-file-list="false"
                accept="image/*"
                :disabled="uploading || !primarySelection?.brain"
                :on-change="(f: any) => onMediaSelected(f)"
                class="add-media-upload"
              >
                <div class="add-media-item"><span>🖼️</span><span>图片</span><span v-if="mediaServicesByType.image" class="media-svc-tag">{{ mediaServicesByType.image }}</span><span v-else class="media-svc-tag missing">未配置</span></div>
              </ElUpload>
              <ElUpload
                :auto-upload="false"
                :show-file-list="false"
                accept="video/*"
                :disabled="uploading || !primarySelection?.brain"
                :on-change="(f: any) => onMediaSelected(f)"
                class="add-media-upload"
              >
                <div class="add-media-item"><span>🎬</span><span>视频</span><span v-if="mediaServicesByType.video" class="media-svc-tag">{{ mediaServicesByType.video }}</span><span v-else class="media-svc-tag missing">未配置</span></div>
              </ElUpload>
              <ElUpload
                :auto-upload="false"
                :show-file-list="false"
                accept="audio/*"
                :disabled="uploading || !primarySelection?.brain"
                :on-change="(f: any) => onMediaSelected(f)"
                class="add-media-upload"
              >
                <div class="add-media-item"><span>🎵</span><span>音频</span><span v-if="mediaServicesByType.audio" class="media-svc-tag">{{ mediaServicesByType.audio }}</span><span v-else class="media-svc-tag missing">未配置</span></div>
              </ElUpload>
            </div>
          </ElPopover>
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

  .el-upload { width: 100%; display: block; }
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

  &:hover { background: rgba(246, 183, 60, 0.12); }

  span:first-child { font-size: 14px; }
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
</style>
