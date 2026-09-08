<script setup lang="ts">
/**
 * AgentComposer：消息输入区（媒体预览 + 富文本编辑器 + 斜杠/角色菜单 + 媒体上传 + 发送）。
 * 从 AgentDialog panel 内提取，Nyxus/非 Nyxus 双挂载共用。逻辑留 useAgentDialogOptions + AgentDialog，
 * 本组件仅 UI + emit；3 个 DOM ref 经函数 ref 桥接回 composable（selectCommand/commandMenuStyle 等依赖）。
 */
import type { ComponentPublicInstance, CSSProperties } from 'vue'
import { computed } from 'vue'
import { ElPopover, ElTooltip, ElUpload } from 'element-plus'
import { Plus, Promotion } from '@element-plus/icons-vue'
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
import type { RuntimeSelection } from '@/application/backend/public'

const props = defineProps<{
  isNyxus: boolean
  nyxusDraftActive: boolean
  sending: boolean
  loading: boolean
  text: string
  error: string | null
  mediaAttachments: MediaAttachment[]
  mediaHint: string
  runtimeHint?: string
  runtimeError?: boolean
  attachmentsDisabled?: boolean
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

const mediaKinds = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'audio', label: '音频' },
] as const
const mediaDisabledReason = computed(() => {
  if (props.attachmentsDisabled) return '分支暂不支持附件'
  if (props.sending) return '消息正在发送'
  if (props.uploading) return '附件正在上传'
  if (!props.primarySelection?.brain) return '请先选择主角色大脑'
  return ''
})
const sendDisabledReason = computed(() => {
  if (props.sending) return '消息正在发送'
  if (props.loading) return '正在加载运行配置'
  if (props.uploading) return '请等待附件上传完成'
  if (!props.primarySelection?.brain) return '请先选择主角色大脑'
  if (props.supportsTools(props.primarySelection.brain) && !props.primarySelection.senseGroup)
    return '请先选择感官组'
  if (props.attachmentsDisabled && props.mediaAttachments.length)
    return '分支不支持附件，请移除后再发送'
  if (!props.text.trim()) return '请输入消息'
  return ''
})

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
    <MediaPreviewBar :attachments="mediaAttachments" @remove="(a) => emit('removeMedia', a)" />
    <div v-if="mediaHint" class="media-hint-row">
      {{ mediaHint }}
    </div>
    <div v-if="runtimeHint" :class="runtimeError ? 'error-row' : 'runtime-hint'" role="status">
      {{ runtimeHint }}
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
          data-desktop-hit
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
          data-desktop-hit
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
            <ElTooltip :content="mediaDisabledReason || '添加媒体'" popper-class="label-tip-popper">
              <span>
                <button
                  type="button"
                  class="add-media-btn"
                  :disabled="!!mediaDisabledReason"
                  aria-label="添加媒体附件"
                >
                  <Plus width="16" height="16" />
                </button>
              </span>
            </ElTooltip>
          </template>
          <div class="add-media-menu" @click.stop>
            <ElTooltip
              v-for="item in mediaKinds"
              :key="item.kind"
              :content="
                mediaDisabledReason ||
                (mediaServicesByType[item.kind]
                  ? item.label
                  : `当前大脑及媒体服务均不支持${item.label}`)
              "
              popper-class="label-tip-popper"
            >
              <span>
                <ElUpload
                  :auto-upload="false"
                  :show-file-list="false"
                  :accept="`${item.kind}/*`"
                  :disabled="!!mediaDisabledReason || !mediaServicesByType[item.kind]"
                  :on-change="(file: UploadFile) => emit('mediaSelected', file)"
                  class="add-media-upload"
                >
                  <div class="add-media-item">
                    <span>{{ item.label }}</span
                    ><span
                      class="media-svc-tag"
                      :class="{ missing: !mediaServicesByType[item.kind] }"
                      >{{ mediaServicesByType[item.kind] || '不可用' }}</span
                    >
                  </div>
                </ElUpload>
              </span>
            </ElTooltip>
          </div>
        </ElPopover>
        <ElTooltip :content="sendDisabledReason || '发送消息'" popper-class="label-tip-popper">
          <span>
            <button
              type="button"
              class="send-btn"
              :disabled="!!sendDisabledReason"
              aria-label="发送消息"
              @click="emit('send')"
            >
              <Promotion class="send-icon" aria-hidden="true" />
            </button>
          </span>
        </ElTooltip>
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
.runtime-hint {
  color: color-mix(in srgb, var(--ink) 76%, transparent);
  font-size: 12px;
  font-weight: 400;
  overflow-wrap: anywhere;
  margin-bottom: 6px;
}

.composer-wrap.is-nyxus-composer {
  padding: 10px 12px 6px;

  :deep(.media-preview-bar) {
    padding: 0 0 8px;
  }

  :deep(.media-preview-strip) {
    padding: 0 0 3px;
    scrollbar-color: color-mix(in srgb, var(--nx-border) 34%, transparent) transparent;
  }

  :deep(.media-preview-thumb) {
    border-color: color-mix(in srgb, var(--nx-border) 45%, transparent);
    background: color-mix(in srgb, var(--nx-bg) 92%, transparent);
    box-shadow: none;
  }

  :deep(.thumb-visual) {
    background: color-mix(in srgb, var(--nx-bg) 88%, transparent);
  }

  :deep(.thumb-name) {
    color: color-mix(in srgb, var(--nx-text) 82%, transparent);
  }

  :deep(.thumb-size) {
    color: color-mix(in srgb, var(--nx-text) 54%, transparent);
  }

  .rich-message-input {
    min-height: 88px;
    max-height: min(34vh, 300px);
    padding: 12px 88px 42px 13px;
    border: 1px solid color-mix(in srgb, var(--nx-border) 60%, transparent);
    border-radius: 8px;
    color: var(--nx-text);
    background: color-mix(in srgb, var(--nx-bg) 76%, transparent);
    box-shadow: inset 0 1px 0 color-mix(in srgb, var(--nx-text) 4%, transparent);
    caret-color: var(--nx-green);
    font-size: 13px;
    line-height: 1.55;
    transition:
      border-color 150ms ease,
      box-shadow 150ms ease,
      background-color 150ms ease;

    &.is-empty::before {
      color: color-mix(in srgb, var(--nx-text) 46%, transparent);
    }

    &:focus {
      border-color: color-mix(in srgb, var(--nx-cyan) 68%, transparent);
      background: color-mix(in srgb, var(--nx-bg) 92%, transparent);
      box-shadow:
        0 0 0 3px color-mix(in srgb, var(--nx-cyan) 8%, transparent),
        inset 0 1px 0 color-mix(in srgb, var(--nx-text) 5%, transparent);
    }

    &.is-disabled {
      color: color-mix(in srgb, var(--nx-text) 48%, transparent);
      background: color-mix(in srgb, var(--nx-bg) 90%, transparent);
    }
  }

  :deep(.instruction-token) {
    background: color-mix(in srgb, var(--nx-yellow) 16%, transparent);
    color: var(--nx-yellow);
  }

  :deep(.role-mention-token) {
    background: color-mix(in srgb, var(--nx-cyan) 14%, transparent);
    color: var(--nx-cyan);
  }

  .textarea-actions {
    right: 10px;
    bottom: 9px;
  }

  .add-media-btn,
  .send-btn {
    width: 32px;
    height: 32px;
    border: 1px solid color-mix(in srgb, var(--nx-border) 40%, transparent);
    border-radius: 7px;
    color: color-mix(in srgb, var(--nx-text) 68%, transparent);
    background: color-mix(in srgb, var(--nx-text) 5%, transparent);
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
    border-color: color-mix(in srgb, var(--nx-green) 32%, transparent);
    color: var(--nx-green);
    background: color-mix(in srgb, var(--nx-green) 10%, transparent);
  }

  .media-hint-row {
    margin-bottom: 8px;
    border: 1px solid color-mix(in srgb, var(--nx-yellow) 18%, transparent);
    color: var(--nx-yellow);
    background: color-mix(in srgb, var(--nx-yellow) 6.5%, transparent);
  }

  .node-composer-error {
    margin-top: 8px;
    border: 1px solid color-mix(in srgb, var(--nx-red) 26%, transparent);
    color: var(--nx-red);
    background: color-mix(in srgb, var(--nx-red) 7.5%, transparent);
  }
}

@media (hover: hover) and (pointer: fine) {
  .composer-wrap.is-nyxus-composer .add-media-btn:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--nx-cyan) 40%, transparent);
    color: var(--nx-cyan);
    background: color-mix(in srgb, var(--nx-cyan) 10%, transparent);
  }
  .composer-wrap.is-nyxus-composer .send-btn:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--nx-green) 54%, transparent);
    color: var(--nx-green);
    background: color-mix(in srgb, var(--nx-green) 16%, transparent);
  }
}
</style>
