/**
 * 精简视图执行监控 cluster 小按钮的图标映射（morphicons + lucide 图标数据）。
 *
 * 动效约定（阶段1已确认）：图标类型固定关联工具类型（六类各有专属 lucide 图标），
 * 颜色同样按工具类型区分；运行状态与成功/失败由底部状态条表达，不再把图标统一替换成状态图标。
 */
import {
  BookOpen,
  CircleDashed,
  CornerDownLeft,
  Forward,
  GitFork,
  Globe,
  PenLine,
  Sparkles,
  SquareTerminal,
  UserRound,
  Wrench,
} from 'lucide'
import type { IconInput } from 'morphicons/vue'
import type { LiteRunNode, LiteRunNodeKind, LiteToolType } from './executionMonitor'

/** 工具类型 → 本源图标（与树视图 workflowVisuals.ts 的 lucide 家族一致）。 */
const TOOL_TYPE_ICONS: Readonly<Record<LiteToolType, IconInput>> = {
  exec: SquareTerminal,
  read: BookOpen,
  write: PenLine,
  web: Globe,
  dispatch: Forward,
  other: Wrench,
}

/** 非工具节点类型 → 本源图标（cluster 中间节点也含模型响应、委派、系统事件等）。 */
const NODE_KIND_ICONS: Readonly<Record<LiteRunNodeKind, IconInput>> = {
  user: UserRound,
  'root-agent': Sparkles,
  'child-agent': Sparkles,
  tool: Wrench,
  return: CornerDownLeft,
  dispatch: Forward,
  spawn: GitFork,
  system: CircleDashed,
}

/** cluster 小按钮当前应显示的图标：工具节点始终按工具类型取本源图标，其余按节点类型。 */
export function clusterNodeIcon(
  node: Pick<LiteRunNode, 'kind' | 'toolType'>,
): IconInput {
  return (
    (node.kind === 'tool' ? TOOL_TYPE_ICONS[node.toolType ?? 'other'] : undefined) ??
    NODE_KIND_ICONS[node.kind] ??
    Wrench
  )
}
