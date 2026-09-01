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
import { computed, watch } from 'vue'
import { useAgentsStore, useChatSessionsStore, type StreamState } from '@/application/public'
import type { ApprovalState, HistoryItem } from '@/domain/chat/projectionTypes'
import { previewOf } from '../utils/historyPreview'
import { flashPeriodOf, isExpired } from '../utils/approvalTiming'
import { useNow } from '../composables/useNow'

const props = defineProps<{
  /** chatId（数据源路由：streams[chatId].history / approval / approvalQueue） */
  chatId: string
  /** ChatSession 投影；PetIcons 不再自行读取 legacy agents.streams。 */
  stream?: StreamState
  /** 当前预设下所有根会话/子节点的待确认与待回答总数。 */
  attentionCount?: number
}>()
const emit = defineEmits<{ attention: [] }>()

const agents = useAgentsStore()
const chatSessions = useChatSessionsStore()

// 闪烁驱动：now 每 250ms 刷新一次（与 ApprovalCard 倒计时节奏一致）。
const now = useNow()

const stream = computed(() => props.stream)
const history = computed<HistoryItem[]>(() => stream.value?.history ?? [])
const currentApproval = computed<ApprovalState | undefined>(() => stream.value?.approval)
const queueApprovals = computed<ApprovalState[]>(() => stream.value?.approvalQueue ?? [])

// history 列：最近 5 条（DESC），按 createdAt DESC 取前 5
const recentHistory = computed<HistoryItem[]>(() =>
  [...history.value]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .filter((item) => item.role === 'user')
    .slice(0, 3),
)

watch(now, () => {
  const approvals = [currentApproval.value, ...queueApprovals.value].filter(
    (item): item is ApprovalState => !!item,
  )
  for (const approval of approvals) {
    if (isExpired(approval, now.value))
      chatSessions.expireApproval(props.chatId, approval.approvalId)
  }
})

/** approval icon 闪烁动画周期 → CSS 变量 */
function flashStyle(a: ApprovalState, isQueued: boolean): Record<string, string> {
  if (!isQueued) return {}
  return { '--flash-period': `${flashPeriodOf(a, now.value)}s` }
}

/** role → CSS class（与 MessageBubble avatar 配色对齐） */
function roleClass(item: HistoryItem): string {
  return `role-${item.role}`
}

function toolIconOf(a: ApprovalState): string {
  return agents.iconForTool(a.senseName)
}

/** approval 列 icon 点击：从 queue 中把该项移到 approval（重新唤起气泡）。 */
function clickApproval(a: ApprovalState): void {
  if (currentApproval.value?.approvalId === a.approvalId) return
  chatSessions.resummonApproval(props.chatId, a.approvalId)
}
</script>

<template>
  <div class="pet-icons" aria-label="pet history and pending approvals">
    <button
      v-if="attentionCount"
      type="button"
      class="attention-badge"
      :aria-label="`${attentionCount} 项来自其他会话的待处理交互`"
      title="查看待处理交互"
      @click.stop="emit('attention')"
    >
      {{ attentionCount > 99 ? '99+' : attentionCount }}
    </button>
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
          <div class="bubble-content">{{ previewOf(item, agents) }}</div>
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
        :class="{ expired: isExpired(a, now) }"
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
@ink: var(--ink);

.pet-icons {
  position: absolute;
  right: -15px;
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
.attention-badge {
  position: absolute;
  right: 1px;
  top: -12px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid var(--surface);
  border-radius: 999px;
  background: #dc2626;
  color: #7c3aed;
  font-size: 9px;
  font-weight: 800;
  line-height: 16px;
  pointer-events: auto;
  cursor: pointer;
  box-shadow: 0 2px 7px color-mix(in srgb, var(--danger) 35%, transparent);
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
  background: var(--surface-soft);
  border-color: var(--border-strong);

  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--ink) 50%, transparent);
  }

  &.role-user .dot {
    background: var(--accent);
  }
  &.role-assistant .dot {
    background: #7c3aed;
  }
  &.role-subagent .dot {
    background: #7c3aed;
  }
  &.role-role .dot {
    background: var(--accent);
  }
  &.role-master .dot {
    background: #ffffff;
  }

  &.has-thinking::after {
    content: '';
    position: absolute;
    inset: -1.5px;
    border: 1px dashed color-mix(in srgb, var(--neon-indigo) 55%, transparent);
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
  background: var(--panel);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
  font-size: 9.5px;
  line-height: 1.35;
  color: color-mix(in srgb, var(--ink) 84%, transparent);
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
  color: var(--ink);

  &.role-user {
    background: var(--accent);
  }
  &.role-assistant {
    background: #7c3aed;
    color: var(--ink);
  }
    color: #3b2b12;
  &.role-subagent,
  &.role-role {
    background: var(--accent);
  }
  &.role-master {
    background: var(--accent);
    color: var(--accent-ink);
  }
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
  border: 1px solid var(--accent);

  .tool-icon {
    font-size: 8px;
    line-height: 1;
  }

  &.is-current {
    background: #ea580c;
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--accent) 20%, transparent);
    cursor: default;
  }

  &.is-queued {
    background: var(--surface-soft);
    color: var(--ink);
    color: #ea580c;
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
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
}

@keyframes approval-flash {
  from {
    opacity: 0.35;
    transform: scale(0.9);
  }
  to {
    opacity: 1;
    transform: scale(1.05);
  }
}
</style>
