<script setup lang="ts">
/**
 * NyxusHistoryPanel：Cherry Nexus 专属历史会话面板。
 * - 显示驱动：agents.nyxusHistoryOpen=true 滑入（AnimatePresence + motion.div，inline initial/animate/exit 字面量）
 * - 定位：右侧/右上浮层卡片（区别于 SessionList 全屏左下抽屉）；全屏透明遮罩，点遮罩关闭
 * - 数据：打开时 watch → agents.fetchHistoryList()；列表 = historyList 中 root + preset=cheryNyxus，按 updatedAt 降序
 * - 头部：「Cherry Nexus 会话」+ ✕ + 「+ 新建会话」按钮
 * - 行：<PresetTag> + preview（splitCommandPrompt 渲 marker span）+ formatTime + 轮次；点击行 hydrateTree + 设 active 双 id + 关面板
 * - 翻页：>20 条简易 slice 分页（复用 IndexPaginator 不适配——IndexItem 类型耦合 TabShell popover 场景）
 * - ESC 关：仅在 topOverlay === 'nyxusHistory' 时生效（栈顶守卫，避免双重关闭）
 * - 暖橙系（#f6b73c），无 border-left 强调色条（项目规范）
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { useAgentsStore, useChatSessionsStore } from '@/stores'
import { CHERY_NYXUS_PRESET } from '@/stores/agents/data/petLifecycle'
import { splitCommandPrompt } from '@/features/agent/composables/commands'
import { formatTime } from '@/utils/formatTime'
import PresetTag from '@/features/agent/drawer/PresetTag.vue'

const MotionDiv = motion.div
const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()

const open = computed(() => agents.nyxusHistoryOpen)
const loading = ref(false)
const error = ref<string | null>(null)
const creating = ref(false)
const activatingId = ref<string | null>(null)

// 列表 = root + preset=cheryNyxus，按 updatedAt 降序
const sessions = computed(() =>
  agents.historyList
    .filter((c) => !c.parentChatId && c.preset === CHERY_NYXUS_PRESET)
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
)

// ── 简易分页（>20 条启用） ──
const PAGE_SIZE = 20
const page = ref(1)
const pageCount = computed(() => Math.max(1, Math.ceil(sessions.value.length / PAGE_SIZE)))
const pagedSessions = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE
  return sessions.value.slice(start, start + PAGE_SIZE)
})
// 列表变化（重 fetch / 新建删除）回到第一页
watch(sessions, () => {
  page.value = 1
})

watch(open, async (v) => {
  if (!v) return
  loading.value = true
  error.value = null
  try {
    await agents.fetchHistoryList()
  } catch (e) {
    error.value = (e as Error).message
    console.error('[NyxusHistoryPanel] fetchHistoryList 失败:', e)
  } finally {
    loading.value = false
  }
})

function close(): void {
  agents.nyxusHistoryOpen = false
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

// 全局 ESC：仅栈顶 overlay = nyxusHistory 时生效（topOverlay 守卫避免与其它 overlay 双重关闭）
function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open.value && agents.topOverlay === 'nyxusHistory') {
    e.preventDefault()
    close()
  }
}
window.addEventListener('keydown', onGlobalKeydown)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
})

/** 新建 Nexus 会话：create → hydrateTree → 设 active 双 id → 关面板。错误显式。 */
async function createNew(): Promise<void> {
  if (creating.value) return
  creating.value = true
  error.value = null
  try {
    const chatId = await agents.createNyxusSession()
    await chatSessions.hydrateTree(chatId)
    agents.activeNyxusChatId = chatId
    agents.activeDialogChatId = chatId
    close()
  } catch (e) {
    error.value = (e as Error).message
    console.error('[NyxusHistoryPanel] createNyxusSession 失败:', e)
  } finally {
    creating.value = false
  }
}

/** 打开会话：hydrateTree + 设 activeNyxusChatId + activeDialogChatId + 关面板。错误显式。 */
async function openSession(chatId: string): Promise<void> {
  if (activatingId.value) return
  activatingId.value = chatId
  error.value = null
  try {
    await chatSessions.hydrateTree(chatId)
    agents.activeNyxusChatId = chatId
    agents.activeDialogChatId = chatId
    close()
  } catch (e) {
    error.value = (e as Error).message
    console.error(`[NyxusHistoryPanel] hydrateTree 失败 ${chatId}:`, e)
  } finally {
    activatingId.value = null
  }
}

function goPrev(): void {
  if (page.value > 1) page.value -= 1
}
function goNext(): void {
  if (page.value < pageCount.value) page.value += 1
}
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="open"
      key="nyxus-history-overlay"
      class="nyxus-overlay"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
      @pointerdown="onOverlayClick"
    >
      <MotionDiv
        key="nyxus-history-panel"
        class="nyxus-panel"
        :initial="{ opacity: 0, y: -12, scale: 0.98 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: -12, scale: 0.98 }"
        :transition="{ duration: 0.2, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        aria-label="Cherry Nexus 会话"
      >
        <header class="panel-head">
          <span class="title">Cherry Nexus 会话</span>
          <div class="head-actions">
            <button
              type="button"
              class="new-btn"
              :disabled="creating"
              @click="createNew"
            >
              {{ creating ? '…' : '+ 新建会话' }}
            </button>
            <button
              type="button"
              class="close-btn"
              aria-label="关闭"
              @click="close"
            >
              ✕
            </button>
          </div>
        </header>

        <div class="panel-body">
          <div v-if="loading" class="row-hint">载入会话…</div>
          <div v-else-if="error" class="row-hint err" role="alert">{{ error }}</div>
          <div v-else-if="sessions.length === 0" class="row-hint">暂无 Nexus 会话</div>
          <template v-else>
            <div
              v-for="s in pagedSessions"
              :key="s.chatId"
              class="session-row"
              :class="{ active: s.chatId === agents.activeNyxusChatId }"
              @click="openSession(s.chatId)"
            >
              <div class="row-main">
                <span class="preview-line">
                  <PresetTag :preset="s.preset" />
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
                </span>
                <span class="meta">
                  <span class="time">{{ formatTime(s.updatedAt) }}</span>
                  <span class="turns">{{ s.turnCount ?? 0 }} 轮</span>
                </span>
              </div>
            </div>
          </template>
        </div>

        <footer v-if="pageCount > 1" class="panel-foot">
          <button
            type="button"
            class="page-nav"
            :disabled="page <= 1"
            aria-label="上一页"
            @click="goPrev"
          >
            ‹
          </button>
          <span class="page-info">{{ page }} / {{ pageCount }}</span>
          <button
            type="button"
            class="page-nav"
            :disabled="page >= pageCount"
            aria-label="下一页"
            @click="goNext"
          >
            ›
          </button>
        </footer>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@ink: #14161a;
@accent: #f6b73c;

.nyxus-overlay {
  position: fixed;
  inset: 0;
  z-index: 275;
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  padding: 24px 28px;
  background: rgba(15, 17, 22, 0.18);
  backdrop-filter: blur(1px);
}

.nyxus-panel {
  width: clamp(300px, 32vw, 440px);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: #fbf9f4;
  border-radius: 14px;
  box-shadow:
    0 18px 48px rgba(0, 0, 0, 0.22),
    0 2px 8px rgba(0, 0, 0, 0.08);
  overflow: hidden;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  background: linear-gradient(135deg, rgba(255, 242, 195, 0.55), rgba(246, 183, 60, 0.18));

  .title {
    font-size: 13px;
    font-weight: 800;
    color: fade(@ink, 88%);
    letter-spacing: 0.2px;
  }

  .head-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
}

.new-btn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid rgba(180, 110, 20, 0.45);
  border-radius: 6px;
  background: linear-gradient(135deg, #ffd27a, @accent);
  color: #3d2606;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  transition:
    background 120ms ease,
    transform 120ms ease;

  &:hover:not(:disabled) {
    background: linear-gradient(135deg, #ffdc8a, #ffc24a);
    transform: translateY(-1px);
  }
  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
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
  &.active {
    background: rgba(246, 183, 60, 0.24);
  }

  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .preview-line {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .preview {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: fade(@ink, 86%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* marker tag（对齐 SessionList：command 琥珀 / role 蓝） */
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

  .meta {
    display: flex;
    gap: 8px;
    font-size: 10px;
    color: fade(@ink, 48%);

    .turns {
      font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    }
  }
}

.panel-foot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid rgba(36, 38, 45, 0.08);
  background: rgba(255, 255, 255, 0.5);

  .page-nav {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid rgba(36, 38, 45, 0.16);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.8);
    color: fade(@ink, 70%);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: #ffffff;
      color: fade(@ink, 90%);
    }
    &:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }

  .page-info {
    font-size: 11px;
    font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
    color: fade(@ink, 64%);
    min-width: 48px;
    text-align: center;
  }
}
</style>
