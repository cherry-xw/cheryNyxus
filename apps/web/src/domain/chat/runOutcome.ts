import {
  ErrorSourceSchema,
  RunOutcomeNotificationDataSchema,
  RunOutcomeReasonCode,
  UserFeedbackSchema,
  type FeedbackAction,
  type RunOutcomeNotificationData,
  type UserFeedback,
} from '@chery/protocol'

const TRACE_PREFIX = /^\[[0-9a-f]{8}\]\s*/i
const MAX_DETAIL_LENGTH = 200

function normalizeLegacyDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > MAX_DETAIL_LENGTH
    ? `${normalized.slice(0, MAX_DETAIL_LENGTH - 1)}…`
    : normalized
}

export function parseRunOutcome(value: unknown): RunOutcomeNotificationData | undefined {
  const parsed = RunOutcomeNotificationDataSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export function legacyErrorOutcome(
  data: Record<string, unknown>,
  fallbackTracingId: string,
  now: number,
): RunOutcomeNotificationData {
  const parsedFeedback = UserFeedbackSchema.safeParse(data.feedback)
  const code = typeof data.code === 'string' && data.code ? data.code : 'RUN_UNKNOWN_FAILED'
  const canResume = data.canResume === true
  const retryable = data.retryable === true
  const detail = normalizeLegacyDetail(data.detail)
  const parsedSource = ErrorSourceSchema.safeParse(data.source)
  const source = parsedSource.success ? parsedSource.data : 'system'
  const tracingId =
    typeof data.tracingId === 'string' && data.tracingId ? data.tracingId : fallbackTracingId
  const rawMessage =
    typeof data.message === 'string' && data.message ? data.message : '本轮运行意外中断'
  const loopLimit = code === RunOutcomeReasonCode.LOOP_LIMIT_REACHED
  const fallbackTitle = loopLimit ? '已达到循环上限' : '本轮运行意外中断'
  const fallbackActions: FeedbackAction[] = canResume
    ? [{ type: 'resume_run' }]
    : [{ type: 'resend_input' }]
  if (detail) fallbackActions.push({ type: 'view_details' })
  const feedback: UserFeedback = parsedFeedback.success
    ? parsedFeedback.data
    : {
        code,
        severity: loopLimit ? 'warning' : 'error',
        source,
        title: fallbackTitle,
        description: rawMessage.replace(TRACE_PREFIX, '').trim() || fallbackTitle,
        guidance: canResume ? '检查当前状态后，可以继续运行。' : '请检查输入或配置后重试。',
        actions: fallbackActions,
        retention: 'history',
        tracingId,
        ...(detail ? { detail } : {}),
      }
  return {
    status: loopLimit ? 'paused' : 'failed',
    reasonCode: code,
    canResume,
    retryable,
    occurredAt: now,
    feedback,
  }
}

export const FEEDBACK_ACTION_LABEL: Record<FeedbackAction['type'], string> = {
  resume_run: '继续运行',
  retry: '重试',
  reconnect: '重新连接',
  open_settings: '打开设置',
  select_chat: '选择会话',
  resend_input: '重新发送',
  view_details: '查看详情',
  dismiss: '知道了',
}
