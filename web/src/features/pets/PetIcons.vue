<script setup lang="ts">
/**
 * PetIcons：pet 头部右侧的 icon slot（CP5 扩展 + history 接入）。
 *
 * 两列布局：
 *   history 列（左）：本 chat 最近 5 条 HistoryItem 小气泡，按 createdAt DESC 排列。
 *     - 视觉：小圆点 + role 颜色（user=灰、assistant=橙、role/master=紫）
 *     - hover → 浮动气泡显消息预览（content 截 80 字）
 *     - 新消息进来即时加入（stream.history 是响应式；done notification finalMessage 追加末条 assistant）
 *     - 数据源：agents.streams[chatId].history（chat.get 权威重建 + done/role_reply 实时追加，按 msgId 去重）
 *
 *   approval 列（右）：pending 审批工具 icon，stack 形式。
 *     - 顶部：当前 stream.approval（实心高亮，无闪）
 *     - 下方：approvalQueue 中的项（白底橙边，按 remainingSec 频率闪烁）
 *     - click → agents.resummonApproval(chatId, approvalId)
 *     - 倒计时归零：icon 渐隐消失
 *     - 数据源：agents.streams[chatId].approval + approvalQueue
 *
 * 容器 .pet-icons pointer-events:none，内部 icon 显式 auto 收点击。
 * 位置：pet 头部右侧（继承 .pet-wrap 坐标系，与 pet 同步移动）。
 */
import { computed, ref } from "vue";
import { useAgentsStore } from "@/stores";
import type { ApprovalState, HistoryItem } from "@/stores/agents";

const props = defineProps<{
  /** chatId（数据源路由：streams[chatId].history / approval / approvalQueue） */
  chatId: string;
}>();

const agents = useAgentsStore();

// 闪烁驱动：now 每 250ms 刷新一次（与 ApprovalCard 倒计时节奏一致）。
const now = ref(Date.now());
setInterval(() => {
  now.value = Date.now();
}, 250);

const stream = computed(() => agents.streams[props.chatId]);
const history = computed<HistoryItem[]>(() => stream.value?.history ?? []);
const currentApproval = computed<ApprovalState | undefined>(() => stream.value?.approval);
const queueApprovals = computed<ApprovalState[]>(() => stream.value?.approvalQueue ?? []);

// history 列：最近 5 条（DESC），按 createdAt DESC 取前 5
const recentHistory = computed<HistoryItem[]>(() => {
  const all = history.value;
  return [...all]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 5);
});

/**
 * 剩余秒数（用于闪烁周期）。
 * waitTime=0（不超时）→ Infinity → 周期封顶 5s。
 */
function remainingSecOf(a: ApprovalState): number {
  if (a.waitTime <= 0) return Infinity;
  return Math.max(0, (a.waitTime - (now.value - a.createdAt)) / 1000);
}

/** icon 闪烁周期（秒）：剩余越少越快，封顶 [0.2, 5]s。 */
function flashPeriodOf(a: ApprovalState): number {
  const s = remainingSecOf(a);
  if (!isFinite(s)) return 5;
  return Math.max(0.2, Math.min(5, s * 0.1));
}

/** icon 是否已超时（remaining <= 0）：CSS 控制淡出 */
function isExpired(a: ApprovalState): boolean {
  return a.waitTime > 0 && remainingSecOf(a) <= 0;
}

/** approval icon 闪烁动画周期 → CSS 变量 */
function flashStyle(a: ApprovalState, isQueued: boolean): Record<string, string> {
  if (!isQueued) return {};
  return { "--flash-period": `${flashPeriodOf(a)}s` };
}

/** role → CSS class（与 MessageBubble avatar 配色对齐） */
function roleClass(item: HistoryItem): string {
  return `role-${item.role}`;
}

function previewOf(item: HistoryItem): string {
  const text = (item.content ?? "").trim();
  if (!text) return "(空消息)";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function toolIconOf(a: ApprovalState): string {
  return agents.iconForTool(a.senseName);
}

/** approval 列 icon 点击：从 queue 中把该项移到 approval（重新唤起气泡）。 */
function clickApproval(a: ApprovalState): void {
  if (currentApproval.value?.approvalId === a.approvalId) return;
  agents.resummonApproval(props.chatId, a.approvalId);
}
</script>

<template>
  <div class="pet-icons" aria-label="pet history and pending approvals">
    <!-- history 列：5 个最近 history item icon -->
    <div class="col history-col" aria-label="最近历史">
      <div
        v-for="(item, idx) in recentHistory"
        :key="`hist-${item.createdAt ?? idx}-${idx}`"
        class="icon history-icon"
        :class="[roleClass(item), { 'has-thinking': !!item.thinking }]"
        :aria-label="`${item.role} message preview`"
      >
        <span class="dot" aria-hidden="true" />
        <div class="hover-bubble" role="tooltip">
          <div class="bubble-head">
            <span class="role-tag" :class="roleClass(item)">{{ item.role }}</span>
            <span v-if="item.thinking" class="thinking-tag">+thinking</span>
          </div>
          <div class="bubble-content">{{ previewOf(item) }}</div>
        </div>
      </div>
    </div>

    <!-- approval 列：current + queue stack -->
    <div class="col approval-col" aria-label="待审批">
      <!-- 当前展示中的审批（顶部，实心高亮，无闪） -->
      <div
        v-if="currentApproval"
        class="icon approval-icon is-current"
        :aria-label="`审批中 ${currentApproval.senseName}`"
      >
        <span class="tool-icon" aria-hidden="true">{{ toolIconOf(currentApproval) }}</span>
      </div>
      <!-- 队列中的审批（白底橙边，闪烁） -->
      <div
        v-for="a in queueApprovals"
        :key="`apr-${a.approvalId}`"
        class="icon approval-icon is-queued"
        :class="{ expired: isExpired(a) }"
        :style="flashStyle(a, true)"
        :aria-label="`已关闭审批 ${a.senseName}，点击重新唤起`"
        role="button"
        tabindex="0"
        @click="clickApproval(a)"
        @keydown.enter.space.prevent="clickApproval(a)"
      >
        <span class="tool-icon" aria-hidden="true">{{ toolIconOf(a) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.pet-icons {
  position: absolute;
  right: -10px;
  top: 0;
  display: inline-flex;
  align-items: flex-start;
  gap: 2px;
  pointer-events: none;
  z-index: 5;
  .history-col {
    margin-top: 20px;
    margin-left: 6px;
  }
}

.col {
  display: inline-flex;
  flex-direction: column;
  gap: 1.5px;
  align-items: center;
}

.icon {
  position: relative;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
  user-select: none;
  cursor: default;
  flex-shrink: 0;
  border: 1px solid transparent;
  transition: opacity 280ms ease;
}

/* history 列：role 着色 + 极小 dot */
.history-icon {
  background: rgba(255, 255, 255, 0.92);
  border-color: rgba(36, 38, 45, 0.18);

  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: fade(@ink, 50%);
  }

  &.role-user .dot { background: #8a8f98; }
  &.role-assistant .dot { background: #f6b73c; }
  &.role-subagent .dot { background: #7c3aed; }
  &.role-role .dot { background: #7c3aed; }
  &.role-master .dot { background: #f6b73c; }

  &.has-thinking::after {
    content: "";
    position: absolute;
    inset: -1.5px;
    border: 1px dashed rgba(124, 58, 237, 0.55);
    border-radius: 50%;
    pointer-events: none;
  }

  &:hover .hover-bubble {
    display: block;
  }
}

.hover-bubble {
  display: none;
  position: absolute;
  left: calc(100% + 6px);
  top: -4px;
  z-index: 30;
  width: max-content;
  max-width: 210px;
  padding: 5px 7px;
  border-radius: 6px;
  background: #ffffff;
  border: 1px solid rgba(36, 38, 45, 0.16);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
  font-size: 9.5px;
  line-height: 1.35;
  color: fade(@ink, 84%);
  pointer-events: none;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble-head {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 2px;
}

.role-tag {
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 8.5px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: #fff;

  &.role-user { background: #6b7280; }
  &.role-assistant { background: #f6b73c; color: #3b2b12; }
  &.role-subagent, &.role-role { background: #7c3aed; }
  &.role-master { background: #f6b73c; color: #3b2b12; }
}

.thinking-tag {
  font-size: 8.5px;
  font-weight: 700;
  color: #7c3aed;
}

.bubble-content {
  white-space: pre-wrap;
}

/* approval 列 */
.approval-icon {
  font-size: 9px;
  font-weight: 800;
  cursor: pointer;
  border: 1px solid #ea580c;

  .tool-icon {
    font-size: 8px;
    line-height: 1;
  }

  &.is-current {
    background: #ea580c;
    color: #fff;
    box-shadow: 0 0 0 1.5px rgba(234, 88, 12, 0.2);
    cursor: default;
  }

  &.is-queued {
    background: rgba(255, 255, 255, 0.92);
    color: #ea580c;
    animation: approval-flash var(--flash-period, 1s) ease-in-out infinite alternate;
  }

  &.expired {
    opacity: 0;
    pointer-events: none;
    transition: opacity 600ms ease;
  }

  &:hover {
    transform: scale(1.12);
  }

  &:focus-visible {
    outline: 2px solid #ea580c;
    outline-offset: 1px;
  }
}

@keyframes approval-flash {
  from { opacity: 0.35; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1.05); }
}
</style>