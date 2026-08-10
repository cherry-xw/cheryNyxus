<script setup lang="ts">
/**
 * AgentComposer：消息输入区（媒体预览 + 富文本编辑器 + 斜杠/角色菜单 + 媒体上传 + 发送）。
 * 从 AgentDialog panel 内提取，Nyxus/非 Nyxus 双挂载共用。逻辑留 useAgentDialogOptions + AgentDialog，
 * 本组件仅 UI + emit；3 个 DOM ref 经函数 ref 桥接回 composable（selectCommand/commandMenuStyle 等依赖）。
 */
import type { ComponentPublicInstance, CSSProperties } from 'vue'
import { ElPopover, ElUpload } from 'element-plus'
import type { UploadFile } from 'element-plus'
import MediaPreviewBar from './media/MediaPreviewBar.vue'
import {
  type MediaAttachment,
  type MediaKind,
  type CommandTab,
  type CommandTabOption,
  type ComboCommandGroup,
} from './useAgentDialogOptions'
import type { MessageCommand, RoleMention } from '../composables/commands'
import type { RuntimeSelection } from '@/services/agentApi'

const props = defineProps<{
  isNyxus: boolean
  nyxusDraftActive: boolean
  sending: boolean
  loading: boolean
  text: string
  error: string | null
  mediaAttachments: MediaAttachment[]
  mediaHint: string
  uploading: boolean
  primarySelection: RuntimeSelection | undefined
  supportsTools: (brain: string) => boolean
  mediaServicesByType: Record<MediaKind, string | null>
  commandOptions: MessageCommand[]
  commandTabs: CommandTabOption[]
  activeCommandTab: CommandTab
  comboCommandGroups: ComboCommandGroup[]
  showCommandMenu: boolean
  commandMenuStyle: CSSProperties
  activeCommandIndex: number
  showRoleMenu: boolean
  matchingRoleMentions: RoleMention[]
  activeRoleIndex: number
  editorRefFn: (el: HTMLElement | null) => void
  commandMenuRefFn: (el: HTMLElement | null) => void
  roleMenuRefFn: (el: HTMLElement | null) => void
  targetLocked?: boolean
}>()

type TemplateRefValue = Element | ComponentPublicInstance | null

function refElement(value: TemplateRefValue): HTMLElement | null {
  if (value instanceof HTMLElement) return value
  const root = value && '$el' in value ? value.$el : null
  return root instanceof HTMLElement ? root : null
}

function setEditorRef(value: TemplateRefValue): void {
  props.editorRefFn(refElement(value))
}

function setCommandMenuRef(value: TemplateRefValue): void {
  props.commandMenuRefFn(refElement(value))
}

function setRoleMenuRef(value: TemplateRefValue): void {
  props.roleMenuRefFn(refElement(value))
}

const emit = defineEmits<{
  removeMedia: [attachment: MediaAttachment]
  editorInput: []
  editorKeydown: [event: KeyboardEvent]
  editorSelectionChange: []
  editorPaste: [event: ClipboardEvent]
  selectCommand: [command: MessageCommand]
  selectCommandTab: [tab: CommandTab]
  selectRoleMention: [role: RoleMention]
  mediaSelected: [file: UploadFile]
  send: []
  'update:activeCommandIndex': [index: number]
  'update:activeRoleIndex': [index: number]
}>()
</script>

<template>
  <div
    v-if="!isNyxus || nyxusDraftActive"
    class="composer-wrap"
    :class="{ 'is-nyxus-composer': isNyxus }"
  >
    <MediaPreviewBar
      :attachments="mediaAttachments"
      @remove="(a) => emit('removeMedia', a)"
    />
    <div v-if="mediaHint" class="media-hint-row">
      {{ mediaHint }}
    </div>
    <div class="textarea-row">
      <div
        :ref="setEditorRef"
        class="msg-input rich-message-input"
        :class="{ 'is-disabled': sending, 'is-empty': !text }"
        :contenteditable="!sending"
        role="textbox"
        aria-multiline="true"
        aria-label="输入消息"
        data-placeholder="输入消息…（输入 / 选择指令）"
        @input="emit('editorInput')"
        @keydown="emit('editorKeydown', $event)"
        @keyup="emit('editorSelectionChange')"
        @click="emit('editorSelectionChange')"
        @paste="emit('editorPaste', $event)"
      />
      <Teleport v-if="showCommandMenu" to="body">
        <div
          :ref="setCommandMenuRef"
          class="command-menu"
          role="listbox"
          aria-label="可用指令"
          :style="commandMenuStyle"
        >
          <div class="command-tabs" role="tablist" aria-label="指令类型">
            <button
              v-for="tab in commandTabs"
              :key="tab.id"
              type="button"
              class="command-tab"
              :class="{ 'is-active': tab.id === activeCommandTab }"
              :disabled="tab.count === 0"
              role="tab"
              :aria-selected="tab.id === activeCommandTab"
              @mousedown.prevent
              @click="emit('selectCommandTab', tab.id)"
            >
              {{ tab.label }}<span class="command-tab-count">{{ tab.count }}</span>
            </button>
          </div>
          <div class="command-options-scroll">
            <template v-if="activeCommandTab === 'combo'">
              <section
                v-for="group in comboCommandGroups"
                :key="group.plugin"
                class="combo-command-group"
              >
                <div class="combo-command-group-title">
                  <span>{{ group.plugin }}</span
                  ><span>{{ group.commands.length }} 项</span>
                </div>
                <button
                  v-for="command in group.commands"
                  :key="command.id"
                  type="button"
                  class="command-option"
                  :class="{
                    'is-active': commandOptions.indexOf(command) === activeCommandIndex,
                  }"
                  role="option"
                  :aria-selected="commandOptions.indexOf(command) === activeCommandIndex"
                  @mousedown.prevent
                  @mousemove="emit('update:activeCommandIndex', commandOptions.indexOf(command))"
                  @click="emit('selectCommand', command)"
                >
                  <span class="command-option-name">{{ command.label }}</span>
                  <span class="command-option-desc">{{ command.description }}</span>
                </button>
              </section>
            </template>
            <template v-else>
              <button
                v-for="(command, index) in commandOptions"
                :key="command.id"
                type="button"
                class="command-option"
                :class="{ 'is-active': index === activeCommandIndex }"
                role="option"
                :aria-selected="index === activeCommandIndex"
                @mousedown.prevent
                @mousemove="emit('update:activeCommandIndex', index)"
                @click="emit('selectCommand', command)"
              >
                <span class="command-option-name">{{ command.label }}</span>
                <span class="command-option-desc">{{ command.description }}</span>
              </button>
            </template>
          </div>
        </div>
      </Teleport>
      <Teleport v-if="showRoleMenu" to="body">
        <div
          :ref="setRoleMenuRef"
          class="command-menu role-mention-menu"
          role="listbox"
          aria-label="可委派角色"
          :style="commandMenuStyle"
        >
          <button
            v-for="(role, index) in matchingRoleMentions"
            :key="role.name"
            type="button"
            class="command-option"
            :class="{ 'is-active': index === activeRoleIndex }"
            role="option"
            :aria-selected="index === activeRoleIndex"
            @mousedown.prevent
            @mousemove="emit('update:activeRoleIndex', index)"
            @click="emit('selectRoleMention', role)"
          >
            <span class="command-option-name">@{{ role.name }}</span>
            <span class="command-option-desc">{{ role.description }}</span>
          </button>
        </div>
      </Teleport>
      <div class="textarea-actions">
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
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                width="16"
                height="16"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </template>
          <div class="add-media-menu" @click.stop>
            <ElUpload
              :auto-upload="false"
              :show-file-list="false"
              accept="image/*"
              :disabled="uploading || !primarySelection?.brain"
              :on-change="(f: any) => emit('mediaSelected', f)"
              class="add-media-upload"
            >
              <div class="add-media-item">
                <span>🖼️</span><span>图片</span
                ><span v-if="mediaServicesByType.image" class="media-svc-tag">{{
                  mediaServicesByType.image
                }}</span
                ><span v-else class="media-svc-tag missing">未配置</span>
              </div>
            </ElUpload>
            <ElUpload
              :auto-upload="false"
              :show-file-list="false"
              accept="video/*"
              :disabled="uploading || !primarySelection?.brain"
              :on-change="(f: any) => emit('mediaSelected', f)"
              class="add-media-upload"
            >
              <div class="add-media-item">
                <span>🎬</span><span>视频</span
                ><span v-if="mediaServicesByType.video" class="media-svc-tag">{{
                  mediaServicesByType.video
                }}</span
                ><span v-else class="media-svc-tag missing">未配置</span>
              </div>
            </ElUpload>
            <ElUpload
              :auto-upload="false"
              :show-file-list="false"
              accept="audio/*"
              :disabled="uploading || !primarySelection?.brain"
              :on-change="(f: any) => emit('mediaSelected', f)"
              class="add-media-upload"
            >
              <div class="add-media-item">
                <span>🎵</span><span>音频</span
                ><span v-if="mediaServicesByType.audio" class="media-svc-tag">{{
                  mediaServicesByType.audio
                }}</span
                ><span v-else class="media-svc-tag missing">未配置</span>
              </div>
            </ElUpload>
          </div>
        </ElPopover>
        <button
          type="button"
          class="send-btn"
          :disabled="
            !text.trim() ||
            sending ||
            loading ||
            !primarySelection?.brain ||
            (supportsTools(primarySelection.brain) && !primarySelection.senseGroup)
            || targetLocked === false
          "
          aria-label="发送消息"
          @click="emit('send')"
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
    </div>
    <div v-if="error" class="error-row" :class="{ 'node-composer-error': isNyxus }" role="alert">
      {{ error }}
    </div>
  </div>
</template>

<style scoped lang="less">
@import './agentDialog.less';

.composer-wrap {
  position: relative;
}

.composer-wrap.is-nyxus-composer {
  padding: 10px 12px 6px;

  :deep(.media-preview-bar) {
    padding: 0 0 8px;
  }

  :deep(.media-preview-strip) {
    padding: 0 0 3px;
    scrollbar-color: rgba(116, 173, 184, 0.34) transparent;
  }

  :deep(.media-preview-thumb) {
    border-color: rgba(116, 173, 184, 0.22);
    background: rgba(11, 22, 29, 0.92);
    box-shadow: none;
  }

  :deep(.thumb-visual) {
    background: rgba(5, 11, 16, 0.9);
  }

  :deep(.thumb-name) {
    color: rgba(220, 232, 235, 0.82);
  }

  :deep(.thumb-size) {
    color: rgba(173, 194, 199, 0.54);
  }

  .rich-message-input {
    min-height: 88px;
    max-height: min(34vh, 300px);
    padding: 12px 88px 42px 13px;
    border: 1px solid rgba(116, 173, 184, 0.3);
    border-radius: 8px;
    color: #dce8eb;
    background: rgba(5, 11, 16, 0.76);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.018);
    caret-color: #69c995;
    font-size: 13px;
    line-height: 1.55;
    transition:
      border-color 150ms ease,
      box-shadow 150ms ease,
      background-color 150ms ease;

    &.is-empty::before {
      color: rgba(173, 194, 199, 0.46);
    }

    &:focus {
      border-color: rgba(87, 199, 212, 0.68);
      background: rgba(6, 14, 20, 0.92);
      box-shadow:
        0 0 0 3px rgba(87, 199, 212, 0.08),
        inset 0 1px 0 rgba(255, 255, 255, 0.024);
    }

    &.is-disabled {
      color: rgba(180, 199, 204, 0.48);
      background: rgba(5, 11, 16, 0.9);
    }
  }

  :deep(.instruction-token) {
    background: rgba(231, 183, 107, 0.16);
    color: #f1d6a0;
  }

  :deep(.role-mention-token) {
    background: rgba(87, 199, 212, 0.14);
    color: #a8e4eb;
  }

  .textarea-actions {
    right: 10px;
    bottom: 9px;
  }

  .add-media-btn,
  .send-btn {
    width: 32px;
    height: 32px;
    border: 1px solid rgba(116, 173, 184, 0.2);
    border-radius: 7px;
    color: rgba(179, 201, 206, 0.68);
    background: rgba(116, 173, 184, 0.055);
    transition:
      transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
      color 140ms ease,
      border-color 140ms ease,
      background-color 140ms ease;

    &:active:not(:disabled) {
      transform: scale(0.97);
    }
  }

  .send-btn:not(:disabled) {
    border-color: rgba(105, 201, 149, 0.32);
    color: #9de0b9;
    background: rgba(105, 201, 149, 0.1);
  }

  .media-hint-row {
    margin-bottom: 8px;
    border: 1px solid rgba(231, 183, 107, 0.18);
    color: #dfbd7c;
    background: rgba(231, 183, 107, 0.065);
  }

  .node-composer-error {
    margin-top: 8px;
    border: 1px solid rgba(239, 113, 133, 0.26);
    color: #f1a0ad;
    background: rgba(239, 113, 133, 0.075);
  }
}

@media (hover: hover) and (pointer: fine) {
  .composer-wrap.is-nyxus-composer .add-media-btn:hover:not(:disabled) {
    border-color: rgba(87, 199, 212, 0.4);
    color: #a8e4eb;
    background: rgba(87, 199, 212, 0.1);
  }
  .composer-wrap.is-nyxus-composer .send-btn:hover:not(:disabled) {
    border-color: rgba(105, 201, 149, 0.54);
    color: #c3f1d5;
    background: rgba(105, 201, 149, 0.16);
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer-wrap.is-nyxus-composer :is(.add-media-btn, .send-btn) {
    transition:
      color 120ms ease,
      border-color 120ms ease,
      background-color 120ms ease;
  }
}
</style>
