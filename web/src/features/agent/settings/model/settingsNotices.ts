import type { ConfigApplyState, ConfigImpact } from '@chery/protocol'
import { applyHeadline, impactLabel, impactNextStep } from '../config/applyPresentation'

export type NoticeKind = 'message' | 'warning' | 'error'
export interface SettingsNotice {
  id: string
  kind: NoticeKind
  text: string
  impact?: ConfigImpact
}

/** Each entry is rendered once; capsule counts come from the same list. */
export function settingsNotices(input: {
  state?: ConfigApplyState | null
  savedHint?: string | null
  warnings?: string[] | null
  error?: string | null
  applyError?: string | null
  actionError?: string
  externalChange?: boolean
}): SettingsNotice[] {
  const notices: SettingsNotice[] = []
  const { state } = input
  if (input.savedHint) notices.push({ id: 'saved', kind: 'message', text: input.savedHint })
  if (input.externalChange)
    notices.push({
      id: 'external',
      kind: 'warning',
      text: '其他窗口或外部程序保存了新设置。当前未保存草稿仍保留，继续保存会被拒绝，以免覆盖新值。',
    })
  input.warnings?.forEach((text, index) =>
    notices.push({ id: `warning-${index}`, kind: 'warning', text }),
  )
  state?.impacts
    .filter((impact) => impact.status !== 'applied')
    .forEach((impact, index) =>
      notices.push({
        id: `impact-${index}`,
        kind:
          impact.status === 'failed'
            ? 'error'
            : impact.status === 'applied'
              ? 'message'
              : 'warning',
        text: `${impactLabel(impact)}：${impact.reason || impactNextStep(impact)}`,
        impact,
      }),
    )
  if (state?.restart.required)
    notices.push({
      id: 'restart',
      kind: state.restart.status === 'failed' ? 'error' : 'warning',
      text: state.restart.status === 'failed' ? '重启未完成' : '等待重启生效',
    })
  for (const [id, text] of Object.entries({
    operation: input.error,
    connection: input.applyError,
    action: input.actionError,
  })) {
    if (text) notices.push({ id, kind: 'error', text })
  }
  if (state && !state.impacts.length && state.status !== 'applied')
    notices.push({
      id: 'apply-summary',
      kind: state.status === 'failed' ? 'error' : 'warning',
      text: applyHeadline(state),
    })
  return notices
}
