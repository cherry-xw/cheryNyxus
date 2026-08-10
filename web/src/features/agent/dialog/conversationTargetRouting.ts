export interface RouteCandidateLike {
  chatId?: string | null
  confidence: number
}

export const AUTO_ROUTE_CONFIDENCE = 0.85
export const RECOMMEND_ROUTE_CONFIDENCE = 0.75

export type ConversationTargetVisualState = 'manual' | 'recommended' | 'idle'

/** 历史会话按钮的点击循环档位：idle → half → full → idle。 */
export type TargetCycleState = 'idle' | 'half' | 'full'

/** 单击循环：未选 → 半选 → 选中 → 未选（取消）。 */
export function nextTargetCycleState(state: TargetCycleState): TargetCycleState {
  if (state === 'idle') return 'half'
  if (state === 'half') return 'full'
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
  if (halfId === chatId || recommendedIds.includes(chatId)) return 'recommended'
  return 'idle'
}

export function canRequestAutomaticRoute(
  automatic: boolean,
  routingEnabled: boolean,
  draft: string,
): boolean {
  return automatic && routingEnabled && draft.trim().length >= 2
}

export function acceptedRouteCandidates<T extends RouteCandidateLike>(candidates: T[]): T[] {
  return candidates.filter(
    (candidate) => Boolean(candidate.chatId) && candidate.confidence >= RECOMMEND_ROUTE_CONFIDENCE,
  )
}

export function automaticRouteCandidate<T extends RouteCandidateLike>(candidates: T[]): T | undefined {
  return candidates.find(
    (candidate) => Boolean(candidate.chatId) && candidate.confidence >= AUTO_ROUTE_CONFIDENCE,
  )
}
