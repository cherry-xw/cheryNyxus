import type { ApprovalState, QuestionItemState, SenseCallRecord } from '@/domain/chat/projectionTypes'

export type NodeInteractionState =
  | 'idle'
  | 'running'
  | 'pending'
  | 'ready'
  | 'submitting'
  | 'answered'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'error'

export interface NodeInteractionView {
  state: NodeInteractionState
  badge: string
  interactive: boolean
}

export type TerminalActionMode = 'stop' | 'run'

/** 与 PetToolbar 一致：运行中可停止；可恢复且未等待直接子会话时才可运行。 */
export function terminalActionMode(
  running: boolean,
  canResume: boolean,
  hasUnfinishedDirectChild: boolean,
): TerminalActionMode | undefined {
  if (running) return 'stop'
  if (canResume && !hasUnfinishedDirectChild) return 'run'
  return undefined
}

export function interactionView(
  call: SenseCallRecord,
  opts: {
    approval?: ApprovalState
    question?: QuestionItemState
    batchSubmitting?: boolean
    expired?: boolean
  } = {},
): NodeInteractionView {
  if (opts.approval) {
    if (opts.expired) return { state: 'expired', badge: '已过期', interactive: false }
    return { state: 'pending', badge: '待确认', interactive: true }
  }
  if (opts.question) {
    if (opts.batchSubmitting) return { state: 'submitting', badge: '提交中', interactive: false }
    if (opts.question.localStatus === 'ready')
      return { state: 'ready', badge: '待提交', interactive: true }
    return { state: 'pending', badge: '待回答', interactive: true }
  }
  if (call.status === 'running') return { state: 'running', badge: '运行中', interactive: false }
  if (call.status === 'error') return { state: 'rejected', badge: '已拒绝', interactive: false }
  if (call.name === 'ask_user_question') {
    if (call.result === '(用户取消了此问题)')
      return { state: 'cancelled', badge: '已取消', interactive: false }
    if (typeof call.result === 'string' && call.result.startsWith('用户回答: '))
      return { state: 'answered', badge: '已回答', interactive: false }
  }
  return { state: 'accepted', badge: '已完成', interactive: false }
}
