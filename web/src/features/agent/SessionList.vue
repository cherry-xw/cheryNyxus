<script setup lang="ts">
/**
 * SessionList：历史会话列表抽屉（CP8）。
 * - 显示驱动：agents.historyListOpen=true 滑入；false 滑出（AnimatePresence + motion.div）
 * - 打开（watch historyListOpen → true）：agents.fetchHistoryList() → chat.list(includePreview) 缓存 historyList
 * - 行：仅主 chat（!parentChatId）= 会话；显 preview（首条 user 消息截断）+ last-run（updatedAt）+ 轮次（turnCount）
 * - 点行 → agents.loadSession(chatId)（建主+子 pet 入 stage，允许 >5）
 * - 行尾 ✕ → ElMessageBox.confirm 后 agents.deleteSession(chatId)（chat.delete 真删，后端级联子 chat）
 * - hover 行显 chatId + 创建时间（title）
 * 命名区分 HistoryDrawer（单 pet 消息史，▤）；本组件 = 会话列表（☰）。
 * motion-v：inline initial/animate/exit 字面量（同 HistoryDrawer 风格，无 TargetAndTransition 导出）。
 */
import { computed, ref, watch } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { ElMessageBox } from "element-plus";
import { useAgentsStore } from "@/stores";
import { formatTime } from "@/utils/formatTime";

const MotionDiv = motion.div;
const agents = useAgentsStore();

const open = computed(() => agents.historyListOpen);
const loading = ref(false);
const error = ref<string | null>(null);
const pendingDelete = ref<string | null>(null);

// 仅主 chat = 会话（子 chat 随主加载/删除，不单列）
const sessions = computed(() => agents.historyList.filter((c) => !c.parentChatId));

watch(open, async (v) => {
  if (!v) return;
  loading.value = true;
  error.value = null;
  try {
    await agents.fetchHistoryList();
  } catch (e) {
    error.value = (e as Error).message;
    console.error("[SessionList] fetchHistoryList 失败:", e);
  } finally {
    loading.value = false;
  }
});

function close(): void {
  agents.historyListOpen = false;
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

function load(chatId: string): void {
  agents.loadSession(chatId);
}

async function remove(chatId: string): Promise<void> {
  // 二次确认：ElMessageBox（会话级删除后果重，用居中 modal）；pendingDelete 防 ✕ 重复点
  if (pendingDelete.value) return;
  try {
    await ElMessageBox.confirm(
      "删除该会话？主 chat 及其所有子 chat 将永久删除，不可恢复。",
      "确认删除",
      {
        type: "warning",
        confirmButtonText: "删除",
        cancelButtonText: "取消",
        confirmButtonClass: "el-button--danger",
      },
    );
  } catch {
    return; // 用户取消
  }
  pendingDelete.value = chatId;
  try {
    await agents.deleteSession(chatId);
  } catch (e) {
    error.value = (e as Error).message;
    console.error("[SessionList] deleteSession 失败:", e);
  } finally {
    pendingDelete.value = null;
  }
}
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="open"
      key="session-overlay"
      class="session-overlay"
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

        <div class="session-body">
          <div v-if="loading" class="row-hint">载入会话…</div>
          <div v-else-if="error" class="row-hint err" role="alert">{{ error }}</div>
          <div v-else-if="sessions.length === 0" class="row-hint">暂无历史会话</div>
          <template v-else>
            <div
              v-for="s in sessions"
              :key="s.chatId"
              class="session-row"
              :title="`chatId: ${s.chatId}\n创建: ${formatTime(s.createdAt)}`"
              @click="load(s.chatId)"
            >
              <div class="row-main">
                <span class="preview">{{ s.preview || "(无消息)" }}</span>
                <span class="meta">
                  <span class="time">{{ formatTime(s.updatedAt) }}</span>
                  <span class="turns">{{ s.turnCount ?? 0 }} 轮</span>
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
    background: rgba(255, 255, 255, 0.7);
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
  }

  .meta {
    display: flex;
    gap: 8px;
    font-size: 10px;
    color: fade(@ink, 48%);

    .turns {
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
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
