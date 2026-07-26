<script setup lang="ts">
/**
 * SessionList：历史会话列表抽屉（CP8）。
 * - 显示驱动：agents.historyListOpen=true 滑入；false 滑出（AnimatePresence + motion.div）
 * - 打开（watch historyListOpen → true）：agents.fetchHistoryList() → chat.list(includePreview) 缓存 historyList
 * - 行：仅主 chat（!parentChatId）= 会话；显 preview（首条 user 消息截断）+ last-run（updatedAt）+ 轮次（turnCount）
 * - 点行 → agents.loadSession(chatId)（建主+子 pet 入 stage，允许 >5）
 * - 行尾 ✕ → ElMessageBox.confirm 后 agents.deleteSession(chatId)（chat.delete 真删，后端级联子 chat）
 * - hover 行显 item 高亮（表示可点击打开 pet）；标题信息走 tooltip（id/创建/更新/标题/轮次换行）
 * - 顶部搜索框：按 preview 标题实时过滤；复制按钮（⧉）复制 chatId，成功转 ✓ 1.2s 复位
 * 命名区分 HistoryDrawer（单 pet 消息史，▤）；本组件 = 会话列表（☰）。
 * motion-v：inline initial/animate/exit 字面量（同 HistoryDrawer 风格，无 TargetAndTransition 导出）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElMessageBox, ElMessage } from 'element-plus'
import { useAgentsStore } from '@/stores'
import { formatTime } from '@/utils/formatTime'
import { fmtTokens } from '../toolbar/contextBreakdown'
import { splitCommandPrompt } from '../composables/commands'
import ContextBreakdownTip from '../toolbar/ContextBreakdownTip.vue'

const MotionDiv = motion.div
const agents = useAgentsStore()

const open = computed(() => agents.historyListOpen)
// 共用单蒙层：仅当 SessionList 是栈顶 overlay 时其蒙层带 blur，否则透明（避免多层 blur 叠加）
const isTopMask = computed(() => agents.topOverlay === 'sessionList')
const loading = ref(false)
const error = ref<string | null>(null)
const pendingDelete = ref<string | null>(null)
// 搜索词（顶部输入框）：按 preview 标题实时过滤会话列表
const searchQuery = ref('')
// 复制成功的会话 chatId（短暂打勾反馈，1.2s 后复位）
const copiedChatId = ref<string | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | undefined

// 仅主 chat = 会话（子 chat 随主加载/删除，不单列）；按搜索词过滤 preview
const sessions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const all = agents.historyList.filter((c) => !c.parentChatId)
  if (!q) return all
  return all.filter((c) => (c.preview ?? '').toLowerCase().includes(q))
})

watch(open, async (v) => {
  if (!v) return
  loading.value = true
  error.value = null
  try {
    await agents.fetchHistoryList()
  } catch (e) {
    error.value = (e as Error).message
    console.error('[SessionList] fetchHistoryList 失败:', e)
  } finally {
    loading.value = false
  }
})

function close(): void {
  agents.historyListOpen = false
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

// 全局 ESC 关闭抽屉（仅在 open 且为栈顶 overlay 时生效；topOverlay 守卫避免双重关闭）。
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value && agents.topOverlay === 'sessionList') {
    e.preventDefault()
    close()
  }
}
window.addEventListener('keydown', onGlobalKeydown)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  if (copyTimer) clearTimeout(copyTimer)
})

/** contextUsage 颜色分级（与 ContextBar 对齐：<50% 绿 / 50-80% 黄 / >80% 红）。 */
function usageClass(u: number): string {
  if (u >= 0.8) return 'usage-high'
  if (u >= 0.5) return 'usage-mid'
  return 'usage-low'
}

function load(chatId: string): void {
  agents.loadSession(chatId)
}

/** 复制 chatId 到剪贴板（降级 execCommand 兼容非 HTTPS / 旧 Electron webview）。 */
async function copyChatId(chatId: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(chatId)
    } else {
      const ta = document.createElement('textarea')
      ta.value = chatId
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    copiedChatId.value = chatId
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copiedChatId.value = null
    }, 1200)
  } catch (e) {
    console.warn('[SessionList] 复制 chatId 失败', e)
    ElMessage.warning({ message: '复制失败', duration: 2000, offset: 24 })
  }
}

/** 删除确认文案池：8 种风格随机抽一，icon=应景 emoji（替代 element-plus 状态图标）。删除本身恒为危险操作，按钮保持 danger。 */
type DeletePromptStyle = {
  icon: string
  title: string
  body: string
}
const DELETE_PROMPTS: readonly DeletePromptStyle[] = [
  {
    icon: '⚛️',
    title: '量子遗忘？',
    body: '本次操作将坍缩所有平行时间轴上的对话痕迹，确认启动记忆清除程序？',
  },
  {
    icon: '🤖',
    title: '数据清洗？',
    body: '所有比特记忆将永久格式化，缓存区彻底归零，是否继续执行？',
  },
  { icon: '🌫️', title: '如烟？', body: '让这场对话如晨雾般悄然散去，再不寻来路，你当真舍得？' },
  {
    icon: '🥀',
    title: '告别？',
    body: '那些字句曾温暖过寂寥的时光，如今要亲手将它们埋葬，只余空白与回响。',
  },
  {
    icon: '🕯️',
    title: '忘却？',
    body: '记忆是存在的影子，删除便是让影子消逝于光中，你确定要踏入无痕之境？',
  },
  {
    icon: '🐟',
    title: '失忆？',
    body: '一键开启金鱼模式，所有聊天记录统统蒸发，确定要这么绝情吗？',
  },
  { icon: '🌊', title: '相忘？', body: '此间言语，尽付东流，从此江湖不见，君意若何？' },
  {
    icon: '🕊️',
    title: '放下？',
    body: '让这段对话随风飘远，像从未发生过一样，你准备好轻装前行了吗？',
  },
]
function pickDeletePrompt(): DeletePromptStyle {
  return DELETE_PROMPTS[Math.floor(Math.random() * DELETE_PROMPTS.length)]!
}

async function remove(chatId: string): Promise<void> {
  // 二次确认：ElMessageBox（会话级删除后果重，用居中 modal）；pendingDelete 防 ✕ 重复点
  if (pendingDelete.value) return
  try {
    const prompt = pickDeletePrompt()
    await ElMessageBox.confirm(prompt.body, `${prompt.icon} ${prompt.title}`, {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      confirmButtonClass: 'el-button--danger',
    })
  } catch {
    return // 用户取消
  }
  pendingDelete.value = chatId
  try {
    await agents.deleteSession(chatId)
  } catch (e) {
    error.value = (e as Error).message
    console.error('[SessionList] deleteSession 失败:', e)
  } finally {
    pendingDelete.value = null
  }
}
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="open"
      key="session-overlay"
      class="session-overlay"
      :class="{ 'is-top-mask': isTopMask }"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
      @pointerdown="onOverlayClick"
    >
      <MotionDiv
        key="session-panel"
        class="session-panel"
        :initial="{ x: '100%' }"
        :animate="{ x: 0 }"
        :exit="{ x: '100%' }"
        :transition="{ duration: 0.24, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        aria-label="历史会话列表"
      >
        <header class="session-head">
          <span class="title">历史会话</span>
          <button type="button" class="close-btn" aria-label="Close" @click="close">✕</button>
        </header>

        <div class="session-search">
          <input
            v-model="searchQuery"
            type="search"
            class="search-input"
            placeholder="搜索会话标题…"
            aria-label="搜索会话标题"
          />
        </div>

        <div class="session-body">
          <div v-if="loading" class="row-hint">载入会话…</div>
          <div v-else-if="error" class="row-hint err" role="alert">{{ error }}</div>
          <div v-else-if="sessions.length === 0" class="row-hint">
            {{ searchQuery.trim() ? '无匹配会话' : '暂无历史会话' }}
          </div>
          <template v-else>
            <div v-for="s in sessions" :key="s.chatId" class="session-row" @click="load(s.chatId)">
              <div class="row-main">
                <span class="preview-line">
                  <span class="preview">
                  <template
                    v-for="(seg, i) in splitCommandPrompt(s.preview || '(无消息)')"
                    :key="`${seg.type}-${i}`"
                  >
                    <span v-if="seg.type === 'role'" class="marker-tag marker-role">{{
                      seg.value
                    }}</span>
                    <span v-else-if="seg.type === 'command'" class="marker-tag marker-cmd">{{
                      seg.value
                    }}</span>
                    <template v-else>{{ seg.value }}</template>
                  </template>
                </span>
                  <el-tooltip placement="top" :show-after="300" :hide-after="0">
                    <template #content>
                      <div class="row-tip">
                        <div>id: {{ s.chatId }}</div>
                        <div>创建: {{ formatTime(s.createdAt) }}</div>
                        <div>更新: {{ formatTime(s.updatedAt) }}</div>
                        <div>标题: {{ s.preview || '(无消息)' }}</div>
                        <div>轮次: {{ s.turnCount ?? 0 }}</div>
                      </div>
                    </template>
                    <button
                      type="button"
                      class="copy-btn"
                      :class="{ copied: copiedChatId === s.chatId }"
                      :aria-label="copiedChatId === s.chatId ? '已复制' : '复制 chatId'"
                      @click.stop="copyChatId(s.chatId)"
                    >
                      {{ copiedChatId === s.chatId ? '✓' : '⧉' }}
                    </button>
                  </el-tooltip>
                </span>
                <span class="meta">
                  <span class="time">{{ formatTime(s.updatedAt) }}</span>
                  <span class="turns">{{ s.turnCount ?? 0 }} 轮</span>
                  <el-tooltip
                    v-if="typeof s.contextUsage === 'number'"
                    placement="top"
                    :show-after="200"
                    :hide-after="0"
                  >
                    <template #content>
                      <ContextBreakdownTip
                        v-if="s.contextBreakdown"
                        :breakdown="s.contextBreakdown"
                      />
                      <span v-else>上下文 {{ Math.round(s.contextUsage * 100) }}%</span>
                    </template>
                    <span class="usage" :class="usageClass(s.contextUsage)">
                      <span
                        v-if="
                          typeof s.contextUsed === 'number' &&
                          typeof s.contextTotal === 'number' &&
                          s.contextTotal > 0
                        "
                        class="usage-detail"
                      >
                        {{ fmtTokens(s.contextUsed) }}/{{ fmtTokens(s.contextTotal) }}
                      </span>
                      <span class="usage-pct">{{ Math.round(s.contextUsage * 100) }}%</span>
                    </span>
                  </el-tooltip>
                </span>
              </div>
              <button
                type="button"
                class="del-btn"
                aria-label="删除会话"
                :disabled="pendingDelete === s.chatId"
                @click.stop="remove(s.chatId)"
              >
                ✕
              </button>
            </div>
          </template>
        </div>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@ink: #14161a;

.session-overlay {
  position: fixed;
  inset: 0;
  z-index: 270;
  display: flex;
  justify-content: flex-end;
  background: transparent; // 默认透明（非栈顶，不叠加 blur）
  backdrop-filter: none;
}
.session-overlay.is-top-mask {
  // 栈顶 overlay：带 blur 遮罩盖住下层
  background: rgba(15, 17, 22, 0.36);
  backdrop-filter: blur(2px);
}

.session-panel {
  width: clamp(300px, 34vw, 480px);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fbf9f4;
  border-left: 1px solid rgba(36, 38, 45, 0.12);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.18);
}

.session-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.1);
  background: rgba(255, 255, 255, 0.6);

  .title {
    font-size: 13px;
    font-weight: 800;
    color: fade(@ink, 86%);
  }
}

.close-btn {
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 70%);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;

  &:hover {
    background: #ffffff;
    color: fade(@ink, 88%);
  }
}

.session-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.session-search {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.1);
  background: rgba(255, 255, 255, 0.5);

  .search-input {
    width: 100%;
    height: 28px;
    padding: 0 10px;
    border: 1px solid rgba(36, 38, 45, 0.16);
    border-radius: 6px;
    background: #ffffff;
    color: fade(@ink, 86%);
    font-size: 12px;
    outline: none;
    transition: border-color 120ms ease;

    &::placeholder {
      color: fade(@ink, 40%);
    }
    &:focus {
      border-color: fade(@ink, 48%);
    }
    // 去掉原生 search 取消按钮
    &::-webkit-search-cancel-button {
      display: none;
    }
  }
}

// tooltip 内多行信息（id/创建/更新/标题/轮次）
.row-tip {
  line-height: 1.6;
  font-size: 12px;

  > div {
    white-space: nowrap;
  }
}

.row-hint {
  padding: 24px 8px;
  text-align: center;
  color: fade(@ink, 48%);
  font-size: 12px;
  font-style: italic;

  &.err {
    color: #b91c1c;
    font-style: normal;
  }
}

.session-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 120ms ease;

  &:hover {
    background: rgba(246, 183, 60, 0.14);
  }

  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .preview {
    font-size: 13px;
    font-weight: 600;
    color: fade(@ink, 86%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  /* 会话预览内联 marker tag（对齐 MessageBubble .instruction-message-token：command 琥珀 / role 蓝） */
  .marker-tag {
    display: inline-block;
    margin: 0 3px 0 0;
    padding: 0 5px;
    border: 1px solid rgba(190, 132, 28, 0.28);
    border-radius: 4px;
    background: linear-gradient(135deg, rgba(255, 242, 195, 0.94), rgba(246, 183, 60, 0.14));
    color: #76500e;
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 700;
    line-height: 1.5;
    vertical-align: baseline;
  }

  .marker-role {
    border-color: rgba(70, 126, 202, 0.28);
    background: linear-gradient(135deg, rgba(224, 239, 255, 0.94), rgba(70, 126, 202, 0.14));
    color: #2f6fae;
  }

  .preview-line {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .copy-btn {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    border: 1px solid rgba(36, 38, 45, 0.16);
    border-radius: 5px;
    background: transparent;
    color: fade(@ink, 60%);
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition:
      opacity 120ms ease,
      color 120ms ease,
      background 120ms ease;

    &:hover {
      background: rgba(255, 255, 255, 0.9);
      color: fade(@ink, 88%);
    }
    &.copied {
      opacity: 1;
      color: #16a34a;
      border-color: rgba(34, 197, 94, 0.4);
    }
  }

  // 行 hover 时显复制按钮（触屏无 hover 始终显）
  &:hover .copy-btn {
    opacity: 1;
  }

  .usage {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 700;
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    padding: 1px 6px;
    border-radius: 4px;
    line-height: 1.3;

    &.usage-low {
      background: rgba(34, 197, 94, 0.14);
      color: #16a34a;
    }
    &.usage-mid {
      background: rgba(234, 179, 8, 0.16);
      color: #a16207;
    }
    &.usage-high {
      background: rgba(239, 68, 68, 0.16);
      color: #b91c1c;
    }

    .usage-detail {
      opacity: 0.78;
      font-weight: 500;
    }

    .usage-pct {
      font-weight: 800;
    }
  }

  .meta {
    display: flex;
    gap: 8px;
    font-size: 10px;
    color: fade(@ink, 48%);

    .turns {
      font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    }
  }

  .del-btn {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid rgba(185, 28, 28, 0.24);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.7);
    color: #b91c1c;
    font-size: 11px;
    line-height: 1;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: #fee2e2;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
}
</style>
