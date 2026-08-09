<script setup lang="ts">
/**
 * AgentComposer：消息输入区（媒体预览 + 富文本编辑器 + 斜杠/角色菜单 + 媒体上传 + 发送）。
 * 从 AgentDialog panel 内提取，Nyxus/非 Nyxus 双挂载共用。逻辑留 useAgentDialogOptions + AgentDialog，
 * 本组件仅 UI + emit；3 个 DOM ref 经函数 ref 桥接回 composable（selectCommand/commandMenuStyle 等依赖）。
 */
import type { CSSProperties } from 'vue'
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

defineProps<{
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
}>()

const emit = defineEmits<{
  removeMedia: [attachment: MediaAttachment]
  cancel: []
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
  <MediaPreviewBar
    v-if="!isNyxus || nyxusDraftActive"
    :attachments="mediaAttachments"
    @remove="(a) => emit('removeMedia', a)"
  />

  <div v-if="(!isNyxus || nyxusDraftActive) && mediaHint" class="media-hint-row">
    {{ mediaHint }}
  </div>

  <div
    v-if="!isNyxus || nyxusDraftActive"
    class="composer-wrap"
    :class="{ 'is-node-terminal': isNyxus }"
  >
    <button
      v-if="isNyxus"
      type="button"
      class="composer-close-btn"
      aria-label="关闭未发送输入"
      title="关闭未发送输入"
      :disabled="sending"
      @click="emit('cancel')"
    >
      ×
    </button>
    <div class="textarea-row">
      <div
        :ref="editorRefFn"
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
          :ref="commandMenuRefFn"
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
          :ref="roleMenuRefFn"
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
  </div>

  <div v-if="error" class="error-row" :class="{ 'node-composer-error': isNyxus }" role="alert">
    {{ error }}
  </div>
</template>

<style scoped lang="less">
@import './agentDialog.less';
</style>
