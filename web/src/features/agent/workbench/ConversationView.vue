<script setup lang="ts">
/**
 * ConversationView：工作台「对话模式」整屏会话视图。
 * 直接复用 HistoryDrawerPanel 的完整会话能力（消息气泡、分支级联切换、设为主流程、
 * 打包代际历史、工具折叠、子 Agent 显示模式、滚动 minimap 等），以 embedded 形态铺满画布区：
 *  - conversation 置位：恒显示分支级联下拉、任务分支经 taskBranches 注入、切换走 switch-chat
 *  - 根会话由工作台 treeRootChatId 驱动（切换分支/会话时工作台窗口会话同步变更，本组件随 prop 刷新）
 *  - root 时间线订阅使用 per-window owner：切会话释放上一根、退出对话模式（卸载）释放当前根，
 *    与树订阅（`workbench:<windowId>`）同模式，避免跨会话累积订阅
 *  - 底部输入框（精简模式同款：单行自适应 textarea + 发送钮）：草稿与树 composer 共用
 *    text（同一事实源，树端打开时经 restoreEditor 回填），发送走 sendFromComposer
 *  - 待处理提问直接在消息列表内作答（QuestionRenderer 可交互模式：call.id ↔ questionId
 *    匹配 pending 提问批，选项点选 + 补充 + 提交走 interactions.answer）；打开时刷新一次
 *    interactions store，确保列表内提问可交互（后续由 interaction.changed 事件实时更新）
 */
import { onMounted, onScopeDispose, ref, watch } from 'vue'
import HistoryDrawerPanel from '../drawer/HistoryDrawerPanel.vue'
import { useChatSessionsStore, useInteractionsStore } from '@/application/public'
import type { ConversationBranchSummary } from '@/application/backend/public'

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
  /** 草稿携带的附件数（随消息一并发送；附件管理在树 composer） */
  mediaCount: number
}>()

const emit = defineEmits<{
  switchChat: [chatId: string]
  send: []
  draftInput: [value: string]
  dropBranch: []
}>()

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
  if (props.rootChatId) void chatSessions.releaseRootTimeline(props.rootChatId, HISTORY_OWNER)
})

// ── 输入框（精简模式同款交互：Enter 发送 / Shift+Enter 换行，单行自适应增高） ──
const inputRef = ref<HTMLTextAreaElement | null>(null)
function autoGrow(): void {
  const element = inputRef.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 120)}px`
}
function onInputKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  emit('send')
}
function onInput(event: Event): void {
  emit('draftInput', (event.target as HTMLTextAreaElement).value)
  autoGrow()
}
// 发送成功（草稿清空）后输入框高度复位到单行。
watch(
  () => props.text,
  (value) => {
    if (!value) {
      const element = inputRef.value
      if (element) element.style.height = 'auto'
    }
  },
)
// 打开对话模式时刷新一次交互（提问批）数据：列表内提问卡片据此进入可交互态；
// 后续变化由 interaction.changed 事件实时 upsert，无需持续轮询。
onMounted(() => {
  autoGrow()
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
          <button
            type="button"
            class="conversation-chip-drop"
            aria-label="取消分支目标"
            title="取消分支目标（保留已输入内容）"
            @click="emit('dropBranch')"
          >
            ✕
          </button>
        </span>
        <span v-if="mediaCount > 0" class="conversation-chip is-media">
          📎 {{ mediaCount }} 个附件随消息发送（附件管理在树视图输入框）
        </span>
      </div>
      <div class="conversation-input-row">
        <textarea
          ref="inputRef"
          :value="text"
          class="conversation-input-box"
          rows="1"
          :placeholder="'发送消息（Enter 发送 / Shift+Enter 换行）'"
          :disabled="sending || uploading"
          aria-label="输入消息"
          @input="onInput"
          @keydown="onInputKeydown"
        />
        <button
          type="button"
          class="conversation-send-btn"
          :disabled="sending || uploading || loading || !text.trim()"
          :aria-label="sending ? '消息正在发送' : '发送消息'"
          @click="emit('send')"
        >
          {{ sending ? '发送中…' : '发送' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import '@/styles/scrollbar.less';

// 铺满 .nyxus-branch-top 内容区（该容器 pointer-events: none，本视图恢复交互）；
// 纵向布局：会话面板（flex:1）+ 底部输入区（lite 同款）。
.conversation-view {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
}
.conversation-panel {
  position: relative;
  flex: 1;
  min-height: 0;
}

// ── 底部输入区：精简模式输入框同款（单行自适应 textarea + 实心发送钮），
// 底色/边框/按钮用会话面板 token（--accent 暖金系）而非 lite 的 --el-color-primary。 ──
.conversation-input {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  border-top: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
}
.conversation-input-error {
  padding: 6px 10px;
  border: 1px solid var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 8%, var(--surface));
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.4;
}
.conversation-input-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.conversation-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 4px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  font-size: 11.5px;
  line-height: 1.3;
}
.conversation-chip.is-branch {
  border-color: color-mix(in srgb, var(--accent) 46%, var(--border));
  color: color-mix(in srgb, var(--ink) 78%, transparent);
}
.conversation-chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conversation-chip-drop {
  flex: none;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  &:hover {
    background: color-mix(in srgb, var(--ink) 12%, transparent);
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }
}
.conversation-input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.conversation-input-box {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  resize: none;
  max-height: 120px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
  color: inherit;
  font-family: inherit;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  // 自定义细滚动条：内容超高时隐藏系统滚动条上下箭头
  .inner-scrollbar();
  &::placeholder {
    color: color-mix(in srgb, var(--ink) 38%, transparent);
    font-weight: 400;
  }
  &:focus {
    outline: none;
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent) inset;
  }
  &:disabled {
    opacity: 0.6;
  }
}
.conversation-send-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 34px;
  box-sizing: border-box;
  padding: 0 16px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: var(--accent-ink);
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color 120ms ease,
    opacity 120ms ease;
  &:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
}
</style>
