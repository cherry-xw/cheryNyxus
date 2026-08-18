import type { ConversationRouteTrace } from '@/services/agentApi'

export interface ConversationTargetSessionLike {
  chatId: string
  lastUserActivityAt?: number
  createdAt?: number
}

/** 会话路由 Shadow 的实时状态（供 AgentDialog 路由小窗渲染）。 */
export interface RouteStatus {
  routing: boolean
  trace?: ConversationRouteTrace
  thinking: string
  content: string
}

export type { ConversationRouteTrace } from '@/services/agentApi'

export type ConversationTargetVisualState = 'manual' | 'ai-selected' | 'recommended' | 'idle'

/** 历史会话按钮的点击循环档位：idle → half → full → idle。 */
export type TargetCycleState = 'idle' | 'half' | 'full'

/** 单击循环：未选 → 指定（full）→ 半指定（half）→ 取消（未选）。 */
export function nextTargetCycleState(state: TargetCycleState): TargetCycleState {
  if (state === 'idle') return 'full'
  if (state === 'full') return 'half'
  return 'idle'
}

/** 发送目标的视觉语义：用户锁定(AI推荐的半选亦计入)优先于 AI 推荐，其他会话保持未选中。
 * 半选 = AI 推荐候选或用户手动半选（待再次点击锁定）。 */
export function conversationTargetVisualState(
  chatId: string,
  selected: string | 'new' | undefined,
  selectedSource: 'ai' | 'user' | undefined,
  recommendedIds: readonly string[],
  halfId?: string,
): ConversationTargetVisualState {
  if (selected === chatId && selectedSource === 'user') return 'manual'
  if (selected === chatId && selectedSource === 'ai') return 'ai-selected'
  if (halfId === chatId || recommendedIds.includes(chatId)) return 'recommended'
  return 'idle'
}

/**
 * 页面始终保留原本可见的最近会话；AI/用户选中的历史会话若在可见范围外，
 * 作为额外节点追加到这些历史会话之后（组件模板会在其后渲染「＋新对话」）。
 */
export function visibleConversationTargetSessions<T extends ConversationTargetSessionLike>(
  sessions: readonly T[],
  selected: string | 'new' | undefined,
  visibleLimit = 6,
): T[] {
  const ordered = [...sessions].sort(
    (a, b) =>
      (b.lastUserActivityAt ?? b.createdAt ?? 0) - (a.lastUserActivityAt ?? a.createdAt ?? 0),
  )
  const visible = ordered.slice(0, visibleLimit)
  if (!selected || selected === 'new' || visible.some((session) => session.chatId === selected)) {
    return visible
  }
  const selectedSession = ordered.find((session) => session.chatId === selected)
  return selectedSession ? [...visible, selectedSession] : visible
}
