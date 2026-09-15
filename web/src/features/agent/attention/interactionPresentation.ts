import type { InteractionRecord } from '@/application/backend/public'
import { createApprovalPresentation } from '@/utils/approvalPresentation'

/** 单条提问的展示模型（与后端 payload.questions 结构一致）。 */
export interface PanelQuestion {
  questionId: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

export function payload(item: InteractionRecord): Record<string, unknown> {
  return item.payload ?? {}
}

export function questionsOf(item: InteractionRecord): PanelQuestion[] {
  return Array.isArray(payload(item).questions)
    ? (payload(item).questions as PanelQuestion[])
    : []
}

export function titleOf(item: InteractionRecord): string {
  if (item.kind === 'approval') {
    return createApprovalPresentation(payload(item).senseName, payload(item).arguments).title
  }
  const questions = questionsOf(item)
  return questions[0]?.header || questions[0]?.question || '回答 Agent 提问'
}

export function statusOf(item: InteractionRecord): string {
  return (
    {
      pending: '待处理',
      resolving: '处理中',
      blocked: '恢复失败',
      completed: '已完成',
      expired: '审批超时，未执行',
      cancelled: '已取消',
    } as Record<string, string>
  )[item.status] ?? item.status
}

export function timeOf(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : ''
}

/** 审批倒计时：approval 且带 deadlineAt 时返回剩余毫秒与是否超时；否则 total=0（不显示）。 */
export function countdownOf(
  item: InteractionRecord,
  now: number,
): { total: number; remaining: number; expired: boolean } {
  const deadline = item.deadlineAt
  if (item.kind !== 'approval' || typeof deadline !== 'number') {
    return { total: 0, remaining: 0, expired: false }
  }
  const remaining = Math.max(0, deadline - now)
  return { total: deadline, remaining, expired: remaining <= 0 }
}

export function kindLabel(item: InteractionRecord): string {
  return item.kind === 'approval' ? '需确认' : '需回答'
}
