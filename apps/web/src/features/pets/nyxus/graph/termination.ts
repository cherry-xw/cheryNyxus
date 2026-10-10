import type { TerminationFact } from '@/application/backend/public'

export type TerminationTone = 'user' | 'system' | 'warning' | 'error' | 'redirect'

const TERMINATION_COPY: Record<TerminationFact['code'], { label: string; tone: TerminationTone }> =
  {
    user_abort: { label: '用户手动截断', tone: 'user' },
    system_stop: { label: '系统停止', tone: 'system' },
    watchdog: { label: '看门狗超时停止', tone: 'warning' },
    error: { label: '执行错误终止', tone: 'error' },
    agent_redirect: { label: '主 Agent 已重定向任务', tone: 'redirect' },
    limit_reached: { label: '达到保护性限制，已暂停', tone: 'warning' },
  }

/** User-facing copy intentionally excludes the audit-only detail field. */
export function terminationDisplay(termination: TerminationFact): {
  label: string
  tone: TerminationTone
} {
  return TERMINATION_COPY[termination.code]
}
