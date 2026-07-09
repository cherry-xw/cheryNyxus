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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { AnimatePresence, motion } from "motion-v";
import { useAgentsStore } from "@/stores";
import type { HistoryItem } from "@/stores/agents";
import type { PetInstance } from "@/features/pets/types";
import MessageBubble from "./MessageBubble.vue";

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
  console.log("[HistoryDrawer] history computed 触发", {
    chatId: chatId.value,
    historyLength: h.length,
    subagentCount: h.filter(item => item.role === "subagent").length,
  });
  return h;
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

/** 子 pet 查询（master/subagent 合并式按 subPetChatId 查 pets；注入式 subagent 无 chatId → undefined） */
function subPetOf(item: HistoryItem): PetInstance | undefined {
  if (!item.subPetChatId) return undefined;
  return agents.pets.find((p) => p.chatId === item.subPetChatId);
}
/** 子 pet name（pet.name；注入式 fallback item.petName=type） */
function subPetName(item: HistoryItem): string {
  return subPetOf(item)?.name ?? item.petName ?? "";
}
/** 子 pet face.calm emoji（缺则空 → MessageBubble 内 🤖 fallback） */
function subPetFace(item: HistoryItem): string {
  return subPetOf(item)?.face.calm ?? "";
}
/** 子 pet agentType（senseGroups[0]；注入式 fallback item.petName） */
function subPetType(item: HistoryItem): string {
  return subPetOf(item)?.runtime?.senseGroups?.[0] ?? item.petName ?? "";
}

// 每个子 pet（subPetChatId）最后一条 subagent 回复的 createdAt；
// 仅这些条目显示主 pet 引用徽章（"回复给主 pet" 标识，中间回复不重复引用）。
const lastSubReplyAt = computed<Map<string, number>>(() => {
  const m = new Map<string, number>();
  for (const item of history.value) {
    if (item.role !== "subagent" || !item.subPetChatId) continue;
    const t = item.createdAt ?? 0;
    if (t > (m.get(item.subPetChatId) ?? -1)) m.set(item.subPetChatId, t);
  }
  return m;
});
/** 该 subagent 是否为其子 pet 的最后一条回复（决定是否显示主 pet 引用徽章） */
function isLastSubReply(item: HistoryItem): boolean {
  if (item.role !== "subagent" || !item.subPetChatId) return false;
  return (lastSubReplyAt.value.get(item.subPetChatId) ?? -1) === (item.createdAt ?? 0);
}

function close(): void {
  agents.activeHistoryChatId = null;
}

function onOverlayClick(e: MouseEvent): void {
  if (e.target === e.currentTarget) close();
}

/**
 * 宽度拖拽 + 持久化（localStorage）。
 * - drawerWidth：null → CSS clamp(320,40vw,560) 默认；number → CSS 变量 --drawer-w 覆盖
 * - 边界 [MIN_W=320, maxWidth=innerWidth*2/3]（max=屏幕 2/3）；加载/拖拽/resize 均 clamp
 * - 拖拽：handle pointerdown setPointerCapture（沿用 pet 模块惯例）→ pointermove 改宽 → pointerup 写 localStorage
 * - 失败显性化（规则 12）：读 localStorage 失败回落默认（null）；写失败 console.warn 不阻塞拖拽
 */
const WIDTH_KEY = "cheryclaw:history-drawer:width";
const MIN_W = 320;
const maxWidth = (): number => Math.floor(window.innerWidth * (2 / 3));
const clampWidth = (w: number): number => Math.max(MIN_W, Math.min(w, maxWidth()));

function loadWidth(): number | null {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    if (!raw) return null;
    const w = Number(raw);
    return Number.isFinite(w) && w > 0 ? clampWidth(w) : null;
  } catch {
    return null;
  }
}
function saveWidth(w: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch (e) {
    console.warn("[HistoryDrawer] 写宽度 localStorage 失败:", e);
  }
}

const drawerWidth = ref<number | null>(loadWidth());
const panelStyle = computed<Record<string, string>>(() =>
  drawerWidth.value != null ? { "--drawer-w": `${drawerWidth.value}px` } : {},
);

// 拖拽态（非响应式：仅拖拽期内部用，宽度变更经 drawerWidth ref 驱动渲染）
let dragging = false;
let startX = 0;
let startW = 0;

function onHandlePointerDown(e: PointerEvent): void {
  const handle = e.currentTarget as HTMLElement;
  const panel = handle.parentElement;
  if (!panel) return;
  dragging = true;
  startX = e.clientX;
  startW = panel.offsetWidth;
  handle.setPointerCapture(e.pointerId);
  document.body.style.userSelect = "none";
  document.body.style.cursor = "col-resize";
}
function onHandlePointerMove(e: PointerEvent): void {
  if (!dragging) return;
  drawerWidth.value = clampWidth(startW - (e.clientX - startX));
}
function onHandlePointerUp(e: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  if (drawerWidth.value != null) saveWidth(drawerWidth.value);
}

// 窗口缩小：存储宽超当前 2/3 → clamp 保约束
function onWindowResize(): void {
  if (drawerWidth.value != null) drawerWidth.value = clampWidth(drawerWidth.value);
}
onMounted(() => window.addEventListener("resize", onWindowResize));
onUnmounted(() => {
  window.removeEventListener("resize", onWindowResize);
  // 防御：拖拽中卸载（理论不达）还原 body 样式，避免残留 col-resize
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});

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
              :show-master-badge="isLastSubReply(item)"
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
