<script setup lang="ts">
import { displayDraftFiles, encodeDraftFiles } from '@/domain/chat/messageParts'
/**
 * ConversationView：工作台「对话模式」整屏会话视图。
 * 直接复用 HistoryDrawerPanel 的完整会话能力（消息气泡、分支级联切换、设为主流程、
 * 打包代际历史、工具折叠、子 Agent 显示模式、滚动 minimap 等），以 embedded 形态铺满画布区：
 *  - conversation 置位：恒显示分支级联下拉、任务分支经 taskBranches 注入、切换走 switch-chat
 *  - 根会话由工作台对话模式局部会话 conversationViewChatId 驱动（下拉切换只改局部会话，不改窗口根，
 *    树/精简视图保持窗口根；窗口根被外部切换时经 watch 同步局部会话，本组件随 prop 刷新）
 *  - root 时间线订阅使用 per-window owner：切会话释放上一根、退出对话模式（卸载）释放当前根，
 *    与树订阅（`workbench:<windowId>`）同模式，避免跨会话累积订阅
 *  - 底部输入框（精简模式同款：单行自适应 textarea + 发送钮）：草稿与树 composer 共用
 *    text（同一事实源，树端打开时经 restoreEditor 回填），发送走 sendFromComposer
 *  - 待处理提问直接在消息列表内作答（QuestionRenderer 可交互模式：call.id ↔ questionId
 *    匹配 pending 提问批，选项点选 + 补充 + 提交走 interactions.answer）；打开时刷新一次
 *    interactions store，确保列表内提问可交互（后续由 interaction.changed 事件实时更新）
 */
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { Plus, Top } from '@element-plus/icons-vue'
import { ElPopover, ElTooltip, ElUpload } from 'element-plus'
import type { UploadFile } from 'element-plus'
import HistoryDrawerPanel from '../drawer/HistoryDrawerPanel.vue'
import { useChatSessionsStore, useInteractionsStore } from '@/application/public'
import type { ConversationBranchSummary } from '@/application/backend/public'
import { useInstructionSuggestions } from '../composer/useInstructionSuggestions'
import InstructionSuggestions from '../composer/InstructionSuggestions.vue'
import MediaThumbStrip from '../composer/media/MediaThumbStrip.vue'
import type { MediaAttachment, MediaKind } from '../composer/useAgentDialogOptions'
import { splitCommandPrompt } from '../composables/commands'
import WorkbenchAgentUsageBar from './WorkbenchAgentUsageBar.vue'
import type { WorkbenchAgentUsageView } from './useWorkbenchAgentUsage'

const props = defineProps<{
  windowId: string
  rootChatId: string
  taskBranches: ConversationBranchSummary[]
  /** 输入框草稿（与树 composer 共享的事实源） */
  text: string
  sending: boolean
  uploading: boolean
  loading: boolean
  error: string | null
  /** 树端选中的分支目标（发送时创建分支；仅提示 + 可丢弃，不动草稿） */
  branchActive: boolean
  branchTitle: string
  /** 草稿携带的附件（附件状态/逻辑在工作台 controller，本视图仅展示 + 透传事件） */
  mediaAttachments: MediaAttachment[]
  mediaServicesByType: Record<MediaKind, string | null>
  /** 附件上传/移除的瞬时反馈（上传中、已附加、错误） */
  mediaHint: string
  agentUsageAgents: WorkbenchAgentUsageView[]
  agentUsageTokenSpeed: number
  taskElapsedMs: number
  canStopTask: boolean
  stoppingTask: boolean
}>()

const emit = defineEmits<{
  switchChat: [chatId: string]
  send: []
  draftInput: [value: string]
  dropBranch: []
  mediaSelected: [file: UploadFile]
  removeMedia: [attachment: MediaAttachment]
  toggleMediaVariant: [attachment: MediaAttachment, field?: 'variant' | 'usage']
  stopTask: []
}>()

const mediaKinds = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'audio', label: '音频' },
] as const
const mediaDisabledReason = computed(() => {
  if (props.sending) return '消息正在发送'
  if (props.uploading) return '附件正在上传'
  return ''
})

const chatSessions = useChatSessionsStore()
const interactions = useInteractionsStore()
/** 本窗口对话模式的 root 订阅 owner（与树订阅 owner `workbench:<windowId>` 并列，互不干扰）。 */
const HISTORY_OWNER = `workbench:${props.windowId}:conversation`

// 切根：释放上一根的订阅（面板侧 watch 随后对新根 loadHistory 重新 acquire）。
watch(
  () => props.rootChatId,
  (rootChatId, previousRootChatId) => {
    if (previousRootChatId && previousRootChatId !== rootChatId) {
      void chatSessions.releaseRootTimeline(previousRootChatId, HISTORY_OWNER)
    }
  },
)
// 退出对话模式（卸载）：释放当前根的订阅。
onScopeDispose(() => {
  inputResizeObserver?.disconnect()
  if (props.rootChatId) void chatSessions.releaseRootTimeline(props.rootChatId, HISTORY_OWNER)
})

// ── 输入框（精简模式同款交互：Enter 发送 / Shift+Enter 换行，单行自适应增高） ──
const inputRef = ref<HTMLTextAreaElement | null>(null)
defineExpose({
  focusInput() {
    inputRef.value?.focus()
    inputRef.value?.setSelectionRange(props.text.length, props.text.length)
  },
})
const menu = useInstructionSuggestions({
  chatId: () => props.rootChatId,
  text: () => props.text,
  input: inputRef,
  update: (value) => emit('draftInput', value),
  resize: refreshInput,
})
/** 输入框展开态：默认保持 6 行（120px）上限，展开后最高到窗口一半（由 CSS is-expanded 承接）。 */
const expandedInput = ref(false)
/** 输入框当前可视行数（含自动换行）：超过 2 行才显示「展开输入框」按钮（默认隐藏）。 */
const inputLines = ref(1)
/** 行数测量缓存（字号/内距静态，首次读取后复用）。 */
let inputMetrics: { lineHeight: number; padding: number } | null = null
/**
 * 重算输入框高度 + 行数：
 * - box-sizing: border-box 下 height 需补上边框高度，否则盒子比内容矮 1px×2，
 *   空内容也会挤出右侧细滚动条。
 * - 展开态有 min-height 撑高盒子，测真实内容行数前先临时解除，避免被盒子高度误导。
 */
function refreshInput(): void {
  const element = inputRef.value
  if (!element) return
  const borders = element.offsetHeight - element.clientHeight
  const minHeight = element.style.minHeight
  element.style.minHeight = '0'
  element.style.height = 'auto'
  const contentHeight = element.scrollHeight
  element.style.height = `${contentHeight + borders}px`
  element.style.minHeight = minHeight
  if (!inputMetrics) {
    const style = window.getComputedStyle(element)
    inputMetrics = {
      lineHeight: Number.parseFloat(style.lineHeight) || 21,
      padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
    }
  }
  inputLines.value = Math.max(
    1,
    Math.round((contentHeight - inputMetrics.padding) / inputMetrics.lineHeight),
  )
  // 内容回落 2 行以内时收起展开态（按钮随之隐藏，避免「已展开却无法收起」）。
  if (inputLines.value <= 2) expandedInput.value = false
}
function toggleExpandInput(): void {
  expandedInput.value = !expandedInput.value
  // 类切换后重算高度：展开时立即给足可视高度，收起时回到内容高度（CSS 上限兜底）。
  void nextTick(refreshInput)
}
function onInputKeydown(event: KeyboardEvent): void {
  if (menu.keydown(event)) return
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  emit('send')
}
function onInput(event: Event): void {
  const value = (event.target as HTMLTextAreaElement).value
  emit('draftInput', encodeDraftFiles(value, props.mediaAttachments))
  void nextTick(menu.refresh)
  refreshInput()
}
// 外部草稿变化（树端恢复 / 发送清空）同步重算高度与行数（onInput 已同步算一次，此处兜底外部来源）。
watch(
  () => props.text,
  () => {
    void nextTick(refreshInput)
  },
)
// 容器宽度变化导致自动换行改变时重算，避免行数/高度停留在旧宽度。
let inputResizeObserver: ResizeObserver | null = null
let lastInputWidth = 0
// 打开对话模式时刷新一次交互（提问批）数据：列表内提问卡片据此进入可交互态；
// 后续变化由 interaction.changed 事件实时 upsert，无需持续轮询。
onMounted(() => {
  refreshInput()
  const element = inputRef.value
  if (element) {
    lastInputWidth = element.clientWidth
    inputResizeObserver = new ResizeObserver(() => {
      const width = element.clientWidth
      if (width !== lastInputWidth) {
        lastInputWidth = width
        refreshInput()
      }
    })
    inputResizeObserver.observe(element)
  }
  void interactions.refresh().catch((cause) => {
    console.warn('[ConversationView] refresh interactions failed:', cause)
  })
})
</script>

<template>
  <div class="conversation-view" data-view-action="conversation">
    <div class="conversation-panel">
      <HistoryDrawerPanel
        :chat-id="rootChatId"
        :is-top="true"
        embedded
        :can-go-back="false"
        :z-index="1"
        conversation
        :task-branches="taskBranches"
        :history-owner="HISTORY_OWNER"
        :on-switch-chat="(cid: string) => emit('switchChat', cid)"
      />
    </div>

    <div class="conversation-input">
      <div v-if="error" class="conversation-input-error" role="alert">{{ error }}</div>
      <div class="conversation-input-chips">
        <span v-if="branchActive" class="conversation-chip is-branch">
          <span class="conversation-chip-text">{{ branchTitle }}</span>
          <el-tooltip
            content="取消分支目标（保留已输入内容）"
            placement="top"
            :show-after="150"
            :hide-after="0"
          >
            <button
              type="button"
              class="conversation-chip-drop"
              aria-label="取消分支目标"
              @click="emit('dropBranch')"
            >
              ✕
            </button>
          </el-tooltip>
        </span>
      </div>
      <div
        v-if="splitCommandPrompt(text).some((segment) => segment.type === 'file')"
        class="conversation-reference-preview"
        aria-label="文件引用"
      >
        <span
          v-for="(segment, index) in splitCommandPrompt(text).filter(
            (item) => item.type === 'file',
          )"
          :key="index"
          class="conversation-reference-chip"
          >&amp;{{ segment.value }}</span
        >
      </div>
      <div v-if="mediaHint" class="conversation-media-hint" role="status">
        {{ mediaHint }}
      </div>
      <!-- 顶部行：左侧小缩略图 + 提示信息（选图后提示被顶到右侧）；右侧「+」选媒体 + 展开输入框按钮。 -->
      <div class="conversation-input-top">
        <div class="conversation-media-group">
          <MediaThumbStrip
            :attachments="mediaAttachments"
            @remove="(a) => emit('removeMedia', a)"
            @toggle="(a, field) => emit('toggleMediaVariant', a, field)"
          />
          <div class="conversation-input-hint">/ 指令 · @ 角色 · &amp; 文件引用</div>
        </div>
        <div class="conversation-input-actions">
          <ElPopover
            trigger="click"
            placement="top-end"
            :width="160"
            popper-class="add-media-popper"
            popper-style="padding: 4px;"
          >
            <template #reference>
              <span class="conversation-add-media-wrap">
                <ElTooltip
                  :content="mediaDisabledReason || '添加文件'"
                  popper-class="label-tip-popper"
                >
                  <span>
                    <button
                      type="button"
                      class="conversation-add-media-btn"
                      :disabled="!!mediaDisabledReason"
                      aria-label="添加文件"
                    >
                      <Plus width="16" height="16" />
                    </button>
                  </span>
                </ElTooltip>
              </span>
            </template>
            <div class="add-media-menu" @click.stop>
              <ElUpload :auto-upload="false" :show-file-list="false" multiple :disabled="!!mediaDisabledReason" :on-change="(file: UploadFile) => emit('mediaSelected', file)"><button type="button" :disabled="!!mediaDisabledReason">添加任意文件</button></ElUpload>
              <ElTooltip
                v-for="item in mediaKinds"
                :key="item.kind"
                :content="
                  mediaDisabledReason ||
                  item.label
                "
                popper-class="label-tip-popper"
              >
                <span>
                  <ElUpload
                    :auto-upload="false"
                    :show-file-list="false"
                    :accept="`${item.kind}/*`"
                    multiple
                    :disabled="!!mediaDisabledReason"
                    :on-change="(file: UploadFile) => emit('mediaSelected', file)"
                    class="add-media-upload"
                  >
                    <div class="add-media-item">
                      <span>{{ item.label }}</span
                      ><span
                        class="media-svc-tag"
                        :class="{ missing: !mediaServicesByType[item.kind] }"
                        >{{ mediaServicesByType[item.kind] || '可仅附文件' }}</span
                      >
                    </div>
                  </ElUpload>
                </span>
              </ElTooltip>
            </div>
          </ElPopover>
          <el-tooltip
            :content="expandedInput ? '收起输入框' : '展开输入框（最高半屏）'"
            placement="top"
            :show-after="150"
            :hide-after="0"
          >
            <button
              type="button"
              class="conversation-expand-btn"
              :class="{ 'is-expanded': expandedInput }"
              :aria-pressed="expandedInput"
              :aria-label="expandedInput ? '收起输入框' : '展开输入框（最高半屏）'"
              @click="toggleExpandInput"
            >
              <Top class="conversation-expand-icon" aria-hidden="true" />
            </button>
          </el-tooltip>
        </div>
      </div>
      <div class="conversation-input-row" :class="{ 'is-expanded': expandedInput }">
        <textarea
          ref="inputRef"
          :value="displayDraftFiles(text, mediaAttachments)"
          class="conversation-input-box"
          rows="1"
          :placeholder="'发送消息（Enter 发送 / Shift+Enter 换行）'"
          :disabled="sending || uploading"
          aria-label="输入消息"
          @input="onInput"
          @keydown="onInputKeydown"
          @click="menu.refresh"
          @keyup.left="menu.refresh"
          @keyup.right="menu.refresh"
        />
        <InstructionSuggestions
          :items="menu.suggestions.value"
          :active-index="menu.activeIndex.value"
          :message="menu.message.value"
          :opened="menu.opened.value"
          :tabs="menu.tabs.value"
          :active-tab="menu.activeTab.value"
          @select="menu.choose"
          @select-tab="menu.selectTab"
        />
        <button
          type="button"
          class="conversation-send-btn"
          :disabled="sending || uploading || loading || (!text.trim() && !mediaAttachments.length) || mediaAttachments.some(a => a.status === 'failed')"
          :aria-label="sending ? '消息正在发送' : '发送消息'"
          @click="emit('send')"
        >
          {{ sending ? '发送中…' : '发送' }}
        </button>
      </div>
      <WorkbenchAgentUsageBar
        class="conversation-agent-usage"
        :agents="agentUsageAgents"
        :token-speed="agentUsageTokenSpeed"
        :task-elapsed-ms="taskElapsedMs"
        :can-stop="canStopTask"
        :stopping="stoppingTask"
        variant="divider"
        @stop="emit('stopTask')"
      />
    </div>
  </div>
</template>

<style scoped lang="less" src="./ConversationView.scoped.less"></style>
