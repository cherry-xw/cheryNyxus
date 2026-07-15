<script setup lang="ts">
/**
 * HistoryDrawerPanel：历史抽屉单面板（从 HistoryDrawer 拆出，CP4 栈化）。
 *
 * 由 HistoryDrawer 栈容器 v-for 渲染，每实例对应栈中一个 chatId：
 * - chatId 驱动 pet/layout/history 解析 + 历史载入（经 manager.loadHistory，预留缓存层）
 * - 群消息渲染（MessageBubble）+ 上下文用量条 + 宽度拖拽
 * - jumpToSpawn：group 模式本面板内滚动定位；direct 模式（子 chat 自身）push 主 chat 到栈顶
 * - 仅栈顶面板（isTop）显示 ✕；下层同宽 + DOM 顺序在后，被完全遮盖不可交互
 *
 * 虚拟列表：使用通用 VirtualScroll。
 * - 按稳定消息 key 缓存离屏项的实测高度；动态高度变化会补偿视口锚点，避免快速滚动抖动。
 * - 长消息、思考折叠和媒体加载均由 ResizeObserver 重新量测。
 * 错误显性化（规则 12）：stream 不存在时显 loading 而非崩（getHistory ensureStream，理论不达）。
 */
import { computed, nextTick, ref, watch } from "vue";
import { motion } from "motion-v";
import { useAgentsStore } from "@/stores";
import type { HistoryItem } from "@/stores/agents";
import VirtualScroll from "@/components/VirtualScroll.vue";
import { mergeChildReplyHistory } from "@/stores/agents/historyMerge";
import MessageBubble from "./MessageBubble.vue";
import { useDrawerWidth } from "./useDrawerWidth";
import { useSubPetResolution } from "./useSubPetResolution";
import { useHistoryDrawerManager } from "./useHistoryDrawerManager";

const MotionDiv = motion.div;

/** 按消息内容估算未量测项的高度，量测完成后由 VirtualScroll 替换。 */
function estimateHeight(item: HistoryItem | undefined): number {
  if (!item) return 120;
  const role = item.role;
  if (role === "user" || role === "master") return 90;
  const hasThinking = !!item.thinking && item.thinking.trim().length > 0;
  const senseCount = item.senseCalls?.length ?? 0;
  if (hasThinking && senseCount > 0) return 320;
  if (hasThinking) return 220;
  if (senseCount > 0) return 180;
  return 130;
}

const props = defineProps<{
  /** 本面板要展示的 chat。 */
  chatId: string;
  /** 是否栈顶（唯一可交互层；仅栈顶显 ✕）。 */
  isTop: boolean;
  /** 层叠 z-index（280 + N×10 + 1，确保栈顶在上）。 */
  zIndex: number;
}>();

const agents = useAgentsStore();
const manager = useHistoryDrawerManager();

const pet = computed(() => agents.pets.find((p) => p.chatId === props.chatId));
const chatPetName = computed(() => pet.value?.name ?? "");

// 布局：子 chat（ghost 自身面板，有 parentChatId）→ direct（master 右/ghost 左 1:1）；
//        主 chat → group（群聊双头像样式）。
const layout = computed<"group" | "direct">(() => (pet.value?.parentChatId ? "direct" : "group"));
const parentPet = computed(() =>
  pet.value?.parentChatId ? agents.pets.find((p) => p.chatId === pet.value!.parentChatId) : undefined,
);
const masterPetName = computed(() =>
  layout.value === "direct" ? parentPet.value?.name ?? "" : chatPetName.value,
);

const stream = computed(() => agents.streams[props.chatId]);
const history = computed<HistoryItem[]>(() => {
  const h = stream.value?.history ?? [];
  return layout.value === "group" ? mergeChildReplyHistory(h) : h;
});
const loaded = computed<boolean>(() => stream.value?.historyLoaded ?? false);

type VirtualScrollInstance = {
  scrollToEnd: () => void;
  scrollToIndex: (
    index: number,
    options?: { align?: "start" | "center" | "end"; behavior?: ScrollBehavior },
  ) => void;
};

const virtualScrollRef = ref<VirtualScrollInstance | null>(null);

function getHistoryItemKey(item: HistoryItem, index: number): string {
  return item.msgId ?? `idx-${index}`;
}

// 面板挂载 / chatId 变 → 载入历史（经 manager.loadHistory，预留缓存层）
watch(
  () => props.chatId,
  (v) => {
    if (v) void manager.loadHistory(v);
  },
  { immediate: true },
);

function scrollToBottom(): void {
  void nextTick(() => virtualScrollRef.value?.scrollToEnd());
}

/** 把 idx 项对齐到视口（start 顶部 / center 中部 / end 底部）。
 *  - jump-to-sensecall 用中心对齐 + smooth：柔和落位，避免硬切
 *  - scrollToBottom 仍走 scrollTop 直接赋值（聊天累积即时跟随更顺手）
 *  - 滚动边界由 VirtualScroll 统一处理。 */
function scrollToItem(idx: number, align: "start" | "center" | "end"): void {
  void nextTick(() => virtualScrollRef.value?.scrollToIndex(idx, { align, behavior: "smooth" }));
}

// 历史长度变化（流式累积）→ 滚到底
watch(() => history.value.length, scrollToBottom);
// loaded 切 true（首批 staged 回放完成）→ 滚到底
watch(loaded, (v) => {
  if (v) scrollToBottom();
});

// 宽度拖拽 + 持久化（localStorage，所有面板共享同一 key → 同宽）
const { panelStyle, onHandlePointerDown, onHandlePointerMove, onHandlePointerUp } = useDrawerWidth();

// 合并宽度变量 + 层叠 z-index
const panelFullStyle = computed<Record<string, string>>(() => ({
  ...panelStyle.value,
  zIndex: String(props.zIndex),
}));

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
  const idx = history.value.findIndex((item) =>
    item.senseCalls?.some((sc) => sc.id === senseCallId),
  );
  if (idx < 0) return;
  scrollToItem(idx, "center");
}

// F：MessageBubble @jump-to-spawn handler
function onJumpToSpawn(payload: { senseCallId: string }): void {
  const { senseCallId } = payload;
  if (!senseCallId) return;
  // 当前面板是主 chat 合并视图 → 直接滚到对应 sense call 框
  if (layout.value === "group") {
    scrollToSenseCall(senseCallId);
    return;
  }
  // 当前面板是子 chat 自身（direct）→ push 主 chat 到栈顶（覆盖本面板）+ 待滚
  const subPet = agents.pets.find((p) => p.chatId === props.chatId);
  const parentChatId = subPet?.parentChatId;
  if (parentChatId) {
    manager.drillChild(parentChatId);
    agents.pendingScrollSenseCallId = senseCallId;
  }
}

// F：监听 store 跨面板滚动请求（push 主 chat 后，主面板挂载时 pending 已设 → immediate 触发滚动）
watch(
  () => agents.pendingScrollSenseCallId,
  (sid) => {
    if (sid && layout.value === "group") {
      scrollToSenseCall(sid);
      // 一次性标记，滚动完成即清空，避免后续 history 变化误触发
      agents.pendingScrollSenseCallId = null;
    }
  },
  { immediate: true },
);

const titleText = computed(() => {
  const name = chatPetName.value;
  if (name) return `${name} 的历史`;
  return `历史 · ${props.chatId.slice(0, 8)}…`;
});

/** 格式化 token 数：< 1000 直显，≥ 1000 缩写为 1.2K/12K 等。 */
function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n / 1000)}K`;
}

/** contextUsage 颜色分级（与 ContextBar / SessionList 对齐：<50% 绿 / 50-80% 黄 / >80% 红）。 */
function usageClass(u: number): string {
  if (u >= 0.8) return "usage-high";
  if (u >= 0.5) return "usage-mid";
  return "usage-low";
}

const usagePct = computed(() => (pet.value ? Math.round(pet.value.contextUsage * 100) : 0));
const usageDetail = computed(() => {
  if (!pet.value) return null;
  const { contextUsed, contextTotal } = pet.value;
  if (typeof contextUsed !== "number" || typeof contextTotal !== "number" || contextTotal <= 0) return null;
  return { used: contextUsed, total: contextTotal };
});
</script>

<template>
  <MotionDiv
    class="drawer-panel"
    :style="panelFullStyle"
    :initial="{ x: '100%' }"
    :animate="{ x: 0 }"
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
      <button v-if="isTop" type="button" class="close-btn" aria-label="Close" @click="manager.closeTop()">✕</button>
    </header>
    <div v-if="usageDetail" class="usage-bar-wrap" :class="usageClass(pet?.contextUsage ?? 0)">
      <div class="usage-bar-row">
        <span class="usage-label">上下文</span>
        <span class="usage-values">
          <span class="usage-used">{{ fmtTokens(usageDetail.used) }}</span>
          <span class="usage-sep">/</span>
          <span class="usage-total">{{ fmtTokens(usageDetail.total) }}</span>
          <span class="usage-pct">{{ usagePct }}%</span>
        </span>
      </div>
      <div class="usage-track">
        <div class="usage-fill" :style="{ width: `${Math.min(100, usagePct)}%` }"></div>
      </div>
    </div>

    <div class="drawer-body">
      <div v-if="!loaded" class="loading-row">载入历史…</div>
      <div v-else-if="history.length === 0" class="empty-row">暂无历史</div>
      <VirtualScroll
        v-else
        ref="virtualScrollRef"
        class="history-list"
        :items="history"
        :item-key="getHistoryItemKey"
        :estimate-size="estimateHeight"
        :default-render-count="12"
      >
        <template #default="{ index }">
          <MessageBubble
            :item="history[index]!"
            :layout="layout"
            :master-pet-name="masterPetName"
            :sub-pet-name="subPetName(history[index]!)"
            :sub-pet-face="subPetFace(history[index]!)"
            :sub-pet-type="subPetType(history[index]!)"
            :caller-pet-face="callerPetFace(history[index]!)"
            :caller-pet-name="callerPetName(history[index]!)"
            :caller-is-master="callerIsMaster(history[index]!)"
            :show-master-badge="isLastSubReply(history[index]!)"
            @jump-to-spawn="onJumpToSpawn"
          />
        </template>
      </VirtualScroll>
    </div>
  </MotionDiv>
</template>

<style scoped lang="less">
@ink: #14161a;

// 面板绝对定位叠加（栈中多面板同位置 right:0，靠 z-index + DOM 顺序层叠）
.drawer-panel {
  position: absolute;
  top: 0;
  right: 0;
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
  padding: 12px 0 18px 14px;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.loading-row,
.empty-row {
  padding: 16px 8px;
  text-align: center;
  color: fade(@ink, 48%);
  font-size: 12px;
  font-style: italic;
}

.history-list {
  flex: 1;
  min-height: 0;
  padding-right: 8px;
  --virtual-scroll-gap: 10px;
}

.usage-bar-wrap {
  padding: 6px 14px 8px;
  border-bottom: 1px solid rgba(36, 38, 45, 0.08);
  background: rgba(255, 255, 255, 0.4);
  display: flex;
  flex-direction: column;
  gap: 4px;

  &.usage-low { --usage-color: #22c55e; --usage-bg: rgba(34, 197, 94, 0.18); }
  &.usage-mid { --usage-color: #eab308; --usage-bg: rgba(234, 179, 8, 0.22); }
  &.usage-high { --usage-color: #ef4444; --usage-bg: rgba(239, 68, 68, 0.22); }

  .usage-bar-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .usage-label {
    font-size: 10px;
    color: fade(@ink, 52%);
    letter-spacing: 0.02em;
  }

  .usage-values {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 600;
    color: fade(@ink, 78%);

    .usage-used {
      color: var(--usage-color);
      font-weight: 800;
    }

    .usage-sep {
      opacity: 0.5;
    }

    .usage-total {
      opacity: 0.7;
    }

    .usage-pct {
      margin-left: 6px;
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--usage-bg);
      color: var(--usage-color);
      font-weight: 800;
      font-size: 10px;
    }
  }

  .usage-track {
    height: 3px;
    border-radius: 2px;
    background: rgba(36, 38, 45, 0.08);
    overflow: hidden;

    .usage-fill {
      height: 100%;
      background: var(--usage-color);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
  }
}
</style>
