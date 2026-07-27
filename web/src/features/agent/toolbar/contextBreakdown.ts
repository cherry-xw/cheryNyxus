/**
 * 上下文用量分段显示共享工具（6 段：系统/用户系统提示词·记忆·技能·工具定义·用户对话）。
 * 供 AgentDialog / SessionList（chip 悬浮）与 HistoryDrawerPanel / ContextBar（分段条）共用。
 */
import type { ContextBreakdown, ContextSegment } from '@/services/agentApi'

/** 段 key（ContextBreakdown 的 6 个分段字段）。 */
export type BreakdownKey = 'system' | 'userSystem' | 'memory' | 'skills' | 'tools' | 'conversation'

/** 6 段元数据：渲染顺序、标签、类别色（区别于整体用量的严重度三档色）。 */
export interface BreakdownSegmentMeta {
  key: BreakdownKey
  label: string
  color: string
}

export const BREAKDOWN_SEGMENTS: BreakdownSegmentMeta[] = [
  { key: 'system', label: '系统提示词', color: '#6366f1' },
  { key: 'userSystem', label: '用户系统提示词', color: '#a855f7' },
  { key: 'memory', label: '记忆', color: '#ec4899' },
  { key: 'skills', label: '技能', color: '#f59e0b' },
  { key: 'tools', label: '工具定义', color: '#10b981' },
  { key: 'conversation', label: '用户对话', color: '#3b82f6' },
]

/** token 数格式化：<1000 直显，>=1000 缩为 1.2K / 12K。 */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 10000) return `${(n / 1000).toFixed(1)}K`
  return `${Math.round(n / 1000)}K`
}

/** 单段视图（悬浮 tooltip + 分段条渲染用）。pct = 相对 total 的占比（0-100，1 位小数；total=0 则 0）。 */
export interface BreakdownSegmentView {
  key: BreakdownKey
  label: string
  color: string
  tokens: number
  count?: number
  /** 用户对话段 thinking 拆分（仅 conversation；已含在 tokens 内，注脚展示用）。 */
  thinking?: number
  pct: number
}

/** 把 ContextBreakdown 展开为有序段视图（按 BREAKDOWN_SEGMENTS 顺序）。bd 缺省 → []。 */
export function breakdownSegments(bd: ContextBreakdown | undefined): BreakdownSegmentView[] {
  if (!bd) return []
  const total = bd.total
  return BREAKDOWN_SEGMENTS.map((meta) => {
    const seg: ContextSegment = bd[meta.key]
    return {
      key: meta.key,
      label: meta.label,
      color: meta.color,
      tokens: seg?.tokens ?? 0,
      count: seg?.count,
      thinking: seg?.thinking,
      pct: total > 0 ? Math.round(((seg?.tokens ?? 0) / total) * 1000) / 10 : 0,
    }
  })
}

/** 段的条目数文本（记忆条数 / skill 数 / tool 数 / 消息条数）；系统/用户系统提示词段无 count → 空串。 */
export function segmentCountText(view: BreakdownSegmentView): string {
  if (view.count === undefined) return ''
  const unit: Record<BreakdownKey, string> = {
    system: '',
    userSystem: '',
    memory: '条',
    skills: '个',
    tools: '个',
    conversation: '条',
  }
  return `${view.count}${unit[view.key]}`
}

/**
 * conversation 段思考注脚文本：thinking>0 返 `(含思考 N)`，否则空串。
 * 供 ContextBar title / ContextBreakdownTip / HistoryDrawerPanel 统一展示（思考 token 已含在段 tokens 合计内，仅拆分提示）。
 */
export function segmentThinkingNote(view: BreakdownSegmentView): string {
  if (view.key !== 'conversation') return ''
  if (!view.thinking || view.thinking <= 0) return ''
  return `(含思考 ${fmtTokens(view.thinking)})`
}
