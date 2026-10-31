import { nextTick } from 'vue'
import type { SourceContextItem } from '../../../packages/protocol/src/sourceManagement'

type Gap = Extract<SourceContextItem, { type: 'gap' }>
export const sourceGapHeading = (reason: Gap['reason']) => ({
  history_start: '本地记录起点',
  omitted_from_context: '未纳入本次输入的消息',
  reception_unconfirmed: '接收情况未确认',
  source_deleted: '来源已删除',
}[reason])
export const hasRangeSources = (item: Gap) => item.reason === 'omitted_from_context' && (item.knownMessageCount ?? 0) > 0

type ReadingTarget = Pick<HTMLElement, 'isConnected' | 'focus' | 'scrollIntoView'>
export async function revealSourceTarget(target: () => ReadingTarget | null | undefined, isCurrent: () => boolean) {
  await nextTick()
  const element = target()
  if (!isCurrent() || !element?.isConnected) return
  element.focus({ preventScroll: true })
  element.scrollIntoView({ block: 'nearest', behavior: 'instant' })
}
