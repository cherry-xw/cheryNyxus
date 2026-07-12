<script setup lang="ts">
/**
 * HistoryDrawer：右侧抽屉历史流。
 * - 显示驱动：agents.activeHistoryChatId 非空时滑入；置空时滑出（AnimatePresence + motion.div 控制进出）
 * - 打开（watch activeHistoryChatId 变化）：调 agents.getHistory(chatId) → store 触发 chat.get staged 流
 *   → routeChunk 累积到 streams[chatId].history → loaded notification 标 historyLoaded=true
 * - 宽 ~40% 视口（clamp 320-560px），右侧滑入
 * - 内容：history (HistoryItem[]) → MessageBubble；传 masterPetName + subPetName/subPetFace/subPetType（按 item.subPetChatId 查 pets）
 * - 状态：historyLoaded=false 显 loading；true 且空 → 显"暂无历史"
 * - 关闭：✕ 按钮 / 点遮罩 → agents.activeHistoryChatId = null
 * - 滚动：drawer-body 溢出滚动；history 长度变化 / loaded 切 true 后 nextTick 滚到底
 * 错误显性化（规则 12）：getHistory 抛错由 watch 上报到 Vue errorHandler；stream 不存在时显 loading 而非崩
 *   （getHistory 内部 ensureStream，理论不达；防御走 graceful）。
 * motion-v：无 TargetAndTransition 导出，inline initial/animate/exit 字面量（同 AgentDialog 风格）。
 */
import { computed, nextTick, ref, watch } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { useAgentsStore } from "@/stores";
import type { HistoryItem } from "@/stores/agents";
import { mergeChildReplyHistory } from "@/stores/agents/historyMerge";
import MessageBubble from "./MessageBubble.vue";
import { useDrawerWidth } from "./useDrawerWidth";
import { useSubPetResolution } from "./useSubPetResolution";

const MotionDiv = motion.div;

const agents = useAgentsStore();

const chatId = computed<string | null>(() => agents.activeHistoryChatId);

const pet = computed(() =>
  chatId.value ? agents.pets.find((p) => p.chatId === chatId.value) : undefined,
);

const chatPetName = computed(() => pet.value?.name ?? "");

// 布局：opened chat 为子 chat（ghost 自身抽屉，有 parentChatId）→ direct（master 右/ghost 左 1:1）；
//        主 chat → group（群聊双头像样式）。
const layout = computed<"group" | "direct">(() => (pet.value?.parentChatId ? "direct" : "group"));
// direct 模式 master 发言者 = 父主 pet（非 opened ghost）；group 模式 = opened 主 pet 自身。
// ghost 在 stage 必伴主在 stage（build/hide/load 同建同删）→ parentPet 必找到。
const parentPet = computed(() =>
  pet.value?.parentChatId ? agents.pets.find((p) => p.chatId === pet.value!.parentChatId) : undefined,
);
const masterPetName = computed(() =>
  layout.value === "direct" ? parentPet.value?.name ?? "" : chatPetName.value,
);

const stream = computed(() => (chatId.value ? agents.streams[chatId.value] : undefined));

const history = computed<HistoryItem[]>(() => {
  const h = stream.value?.history ?? [];
  return layout.value === "group" ? mergeChildReplyHistory(h) : h;
});
const loaded = computed<boolean>(() => stream.value?.historyLoaded ?? false);

const scrollRef = ref<HTMLElement | null>(null);

// 打开抽屉 → 触发历史载入（store getHistory ensureStream + emit staged chunks）
watch(
  chatId,
  (v) => {
    if (v) {
      agents.getHistory(v);
    }
  },
  { immediate: true },
);

function scrollToBottom(): void {
  void nextTick(() => {
    const el = scrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

// 历史长度变化（流式累积）→ 滚到底
watch(() => history.value.length, scrollToBottom);
// loaded 切 true（首批 staged 回放完成）→ 滚到底
watch(loaded, (v) => {
  if (v) scrollToBottom();
});

// 宽度拖拽 + 持久化（localStorage）
const { panelStyle, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp } = useDrawerWidth();

// 子 pet 解析辅助函数
const {
  subPetName,
  subPetFace,
  subPetType,
  callerPetFace,
  callerPetName,
  callerIsMaster,
  isLastSubReply,
} = useSubPetResolution(history);

// F：smooth scroll 到指定 sense call 框（被唤起 agent 头像点击跳转用）
function scrollToSenseCall(senseCallId: string): void {
  void nextTick(() => {
    const el = scrollRef.value?.querySelector(`#sensecall-${CSS.escape(senseCallId)}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// F：MessageBubble @jump-to-spawn handler
function onJumpToSpawn(payload: { senseCallId: string }): void {
  const { senseCallId } = payload;
  if (!senseCallId) return;
  // 当前 drawer 是主 chat 合并视图 → 直接滚到对应 sense call 框
  if (layout.value === "group") {
    scrollToSenseCall(senseCallId);
    return;
  }
  // 当前 drawer 是子 chat 自身（direct，ghost 自身抽屉）→ 切到主 chat drawer + 滚动
  // 跨 chat 跳转：找到该 role 的子 pet，再用其 parentChatId 切到主 drawer
  // props.item 在 direct 模式下无 callerSubPetChatId 上下文，无法定位主 chat；退化用 sub pet 的 parentChatId
  const subPet = agents.pets.find((p) => p.chatId === chatId.value);
  const parentChatId = subPet?.parentChatId;
  if (parentChatId) {
    agents.activeHistoryChatId = parentChatId;
    // 跨 drawer 跳转：等主 drawer 加载完 history 后再滚（pendingScrollSenseCallId 监听器触发）
    agents.pendingScrollSenseCallId = senseCallId;
  }
}
// F：监听 store 跨 drawer 滚动请求（direct 模式点击 → 切到主 drawer 后执行滚动）
watch(
  () => agents.pendingScrollSenseCallId,
  (sid) => {
    if (sid && layout.value === "group") {
      scrollToSenseCall(sid);
      // 一次性标记，滚动完成即清空，避免后续 history 变化误触发
      agents.pendingScrollSenseCallId = null;
    }
  },
);

function close(): void {
  agents.activeHistoryChatId = null;
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

const titleText = computed(() => {
  if (!chatId.value) return "";
  const name = chatPetName.value;
  if (name) return `${name} 的历史`;
  return `历史 · ${chatId.value.slice(0, 8)}…`;
});
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="chatId"
      key="history-overlay"
      class="drawer-overlay"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
      @pointerdown="onOverlayClick"
    >
      <MotionDiv
        key="history-panel"
        class="drawer-panel"
        :style="panelStyle"
        :initial="{ x: '100%' }"
        :animate="{ x: 0 }"
        :exit="{ x: '100%' }"
        :transition="{ duration: 0.24, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        :aria-label="titleText"
      >
        <div
          class="resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖拽调整宽度"
          @pointerdown="onHandlePointerDown"
          @pointermove="onHandlePointerMove"
          @pointerup="onHandlePointerUp"
        />
        <header class="drawer-head">
          <div class="title-block">
            <span class="title">{{ titleText }}</span>
            <span class="chat-id">{{ chatId }}</span>
          </div>
          <button type="button" class="close-btn" aria-label="Close" @click="close">✕</button>
        </header>

        <div ref="scrollRef" class="drawer-body">
          <div v-if="!loaded" class="loading-row">载入历史…</div>
          <template v-else>
            <div v-if="history.length === 0" class="empty-row">暂无历史</div>
            <MessageBubble
              v-for="(item, idx) in history"
              :key="idx"
              :item="item"
              :layout="layout"
              :master-pet-name="masterPetName"
              :sub-pet-name="subPetName(item)"
              :sub-pet-face="subPetFace(item)"
              :sub-pet-type="subPetType(item)"
              :caller-pet-face="callerPetFace(item)"
              :caller-pet-name="callerPetName(item)"
              :caller-is-master="callerIsMaster(item)"
              :show-master-badge="isLastSubReply(item)"
              @jump-to-spawn="onJumpToSpawn"
            />
          </template>
        </div>
      </MotionDiv>
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@ink: #14161a;

.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 280;
  display: flex;
  justify-content: flex-end;
  background: rgba(15, 17, 22, 0.36);
  backdrop-filter: blur(2px);
}

.drawer-panel {
  position: relative;
  width: var(--drawer-w, clamp(320px, 40vw, 560px));
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fbf9f4;
  border-left: 1px solid rgba(36, 38, 45, 0.12);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.18);
}

.resize-handle {
  position: absolute;
  top: 0;
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  background: transparent;
  transition: background 0.15s;

  &:hover,
  &:active {
    background: rgba(36, 38, 45, 0.18);
  }
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.1);
  background: rgba(255, 255, 255, 0.6);

  .title-block {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .title {
    font-size: 13px;
    font-weight: 800;
    color: fade(@ink, 86%);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-id {
    font-size: 10px;
    color: fade(@ink, 44%);
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  flex-shrink: 0;

  &:hover {
    background: #ffffff;
    color: fade(@ink, 88%);
  }
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.loading-row,
.empty-row {
  padding: 16px 8px;
  text-align: center;
  color: fade(@ink, 48%);
  font-size: 12px;
  font-style: italic;
}
</style>
