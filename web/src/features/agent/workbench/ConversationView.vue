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
import { nextTick, onMounted, onScopeDispose, ref, watch } from 'vue'
import { Top } from '@element-plus/icons-vue'
import HistoryDrawerPanel from '../drawer/HistoryDrawerPanel.vue'
import { useChatSessionsStore, useInteractionsStore } from '@/application/public'
import type { ConversationBranchSummary } from '@/application/backend/public'
import { useInstructionSuggestions } from '../composer/useInstructionSuggestions'
import InstructionSuggestions from '../composer/InstructionSuggestions.vue'
import { splitCommandPrompt } from '../composables/commands'

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
 *   空内容也会挤出右侧细滚动条（本轮修复点）。
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
  emit('draftInput', value)
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
        <span v-if="mediaCount > 0" class="conversation-chip is-media">
          📎 {{ mediaCount }} 个附件随消息发送（附件管理在树视图输入框）
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
      <!-- 顶部行：提示信息居左 + 「展开输入框」按钮居右（同一行对齐）；下行：输入框 + 发送按钮。 -->
      <div class="conversation-input-top">
        <div class="conversation-input-hint">
          <kbd>/</kbd> 指令　<kbd>@</kbd> 角色　<kbd>&amp;</kbd> 文件引用　· 输入后从候选窗口选择
        </div>
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
      <div class="conversation-input-row" :class="{ 'is-expanded': expandedInput }">
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
.conversation-input-row {
  position: relative;
}
// 顶部行：提示信息居左 + 「展开输入框」按钮居右，同一行垂直居中对齐；
// 最小高度取展开按钮同高（24px），按钮隐藏/显示时提示行高度不跳动。
.conversation-input-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}
.conversation-input-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.conversation-reference-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin: 5px 0;
}
.conversation-reference-chip,
.lite-reference-chip {
  display: inline-flex;
  max-width: 100%;
  padding: 3px 7px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
  font-size: 12px;
}
.conversation-input-error {
  padding: 6px 10px;
  border: 1px solid var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 8%, var(--surface));
  color: var(--el-color-danger);
  font-size: 14px;
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
  font-size: 13.5px;
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
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  &:hover {
    background: color-mix(in srgb, var(--ink) 12%, transparent);
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }
}
// 发送钮与输入框同行贴底对齐（展开按钮已移至上方提示行右侧）；
// 展开态图标旋转 180° 表「收起」（按钮本体在 .conversation-input-top）。
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
  font-size: 14px;
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
// 展开态：输入框高度从 6 行上限提升到「至少 12 行、最高窗口一半」，长内容不再在小框中翻页滚动
// （min-height 用 min(240px, 50vh) 兜底矮窗口，避免展开后溢出视口）。
.conversation-input-row.is-expanded .conversation-input-box {
  min-height: min(240px, 50vh);
  max-height: 50vh;
}
// 展开按钮：无边框幽灵小按钮（与实心发送钮同风格家族），位于提示行右端；
// 仅在输入超过 2 行时出现（模板 v-if），展开态图标旋转 180° 表「收起」。
.conversation-expand-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  box-sizing: border-box;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
  cursor: pointer;
  transition:
    color 120ms ease,
    background-color 120ms ease;
  &:hover {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--accent);
  }
  &.is-expanded {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--accent);
  }
}
.conversation-expand-icon {
  width: 14px;
  height: 14px;
  transition: transform 160ms ease;
}
.conversation-expand-btn.is-expanded .conversation-expand-icon {
  transform: rotate(180deg);
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
  font-size: 14px;
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

// ── 对话模式可读性：整个会话列表中所有小于 12px 的文字统一提升到 12px ──
// 列表由 HistoryDrawerPanel（embedded）→ VirtualScroll → MessageBubble + 工具渲染器 组成，
// 各组件 scoped 样式里的小字号在此用 :deep + !important 覆盖（仅作用于对话模式，不影响树/浮窗）。
// 面板与气泡根：让未显式设字号的继承文字也达到 12px。
.conversation-view {
  :deep(.drawer-panel),
  :deep(.bubble) {
    font-size: 14px !important;
  }

  // 消息气泡内部小字
  :deep(.delivery-state),
  :deep(.context-divider),
  :deep(.termination-tail),
  :deep(.thinking-toggle),
  :deep(.thinking-pre),
  :deep(.content),
  :deep(.instruction-message-token),
  :deep(.sense-tag),
  :deep(.time) {
    font-size: 14px !important;
  }

  // 工具卡片根（SenseCallBox / 各专用渲染器共用形态）
  :deep(.sense-box),
  :deep(.sense-icon),
  :deep(.todo-box),
  :deep(.todo-icon),
  :deep(.cmd-box),
  :deep(.file-box),
  :deep(.file-write-box),
  :deep(.media-box),
  :deep(.search-box),
  :deep(.skill-box),
  :deep(.spawn-box) {
    font-size: 14px !important;
  }

  // 折叠开关 / 参数行 / 结果区 / 状态徽标等（跨渲染器同名类统一覆盖）
  :deep(.toggle),
  :deep(.arg-key),
  :deep(.arg-val),
  :deep(.arg-empty),
  :deep(.sense-pre),
  :deep(.todo-count),
  :deep(.todo-item .glyph),
  :deep(.todo-fallback),
  :deep(.cmd-label),
  :deep(.cmd-code),
  :deep(.cmd-meta-inline),
  :deep(.cmd-desc),
  :deep(.cmd-fallback),
  :deep(.cmd-head .copy-btn .el-icon),
  :deep(.timeout-badge),
  :deep(.error-badge),
  :deep(.output-pre),
  :deep(.output-truncated),
  :deep(.output-log),
  :deep(.file-label),
  :deep(.file-path),
  :deep(.file-range),
  :deep(.file-mode),
  :deep(.file-fallback),
  :deep(.line-count),
  :deep(.compression-badge),
  :deep(.content-pre),
  :deep(.content-truncated),
  :deep(.prompt-preview),
  :deep(.prompt-pre),
  :deep(.media-fallback),
  :deep(.search-mode),
  :deep(.search-label),
  :deep(.search-query),
  :deep(.search-badge),
  :deep(.search-fallback),
  :deep(.result-count),
  :deep(.result-file),
  :deep(.result-line),
  :deep(.result-content),
  :deep(.skill-type),
  :deep(.skill-fallback),
  :deep(.spawn-type),
  :deep(.spawn-label),
  :deep(.spawn-value),
  :deep(.spawn-prompt),
  :deep(.spawn-badge),
  :deep(.spawn-fallback),
  :deep(.spawn-detail-link) {
    font-size: 14px !important;
  }

  // 提问卡片（单选/多选）
  :deep(.q-header),
  :deep(.q-kind),
  :deep(.q-badge),
  :deep(.q-text),
  :deep(.q-option),
  :deep(.q-option-copy small),
  :deep(.q-note-tag),
  :deep(.q-note-input),
  :deep(.q-batch-hint),
  :deep(.q-submit),
  :deep(.q-error),
  :deep(.q-other-answer p),
  :deep(.q-fallback) {
    font-size: 14px !important;
  }

  // markdown 富文本内容
  :deep(.md code),
  :deep(.md pre code),
  :deep(.md table) {
    font-size: 14px !important;
  }

  // 面板 chrome（标题操作 / 加载态 / 打包代际 / 用量条）
  :deep(.copy-id-btn),
  :deep(.activate-branch-btn),
  :deep(.detail-branch-divider),
  :deep(.agent-loading-copy b),
  :deep(.agent-loading-copy small),
  :deep(.batch-loading),
  :deep(.usage-label),
  :deep(.generation-card-summary),
  :deep(.generation-card-meta),
  :deep(.generation-layer-title small) {
    font-size: 14px !important;
  }
}
</style>
