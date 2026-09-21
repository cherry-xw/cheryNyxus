/**
 * 精简视图执行监控 cluster 行的图标映射（morphicons + lucide 图标数据）。
 *
 * - 工具 icon：按单个工具调用的类型分类（同一次 LLM 响应的多个工具各自显示，
 *   不再以「一次响应」为单位只取一个图标）；
 * - 思考标记：模型思考/正文用 brain / brain-cog 双图标，运行中由视图层做图标
 *   切换与主题色呼吸动画（见 LiteView.vue）。
 */
import { BookOpen, Brain, BrainCog, Forward, Globe, PenLine, SquareTerminal, Wrench } from 'lucide'
import type { IconInput } from 'morphicons/vue'
import { classifyToolType } from './executionMonitor'
import type { LiteToolType } from './executionMonitor'

/** 工具类型 → 本源图标（与树视图 workflowVisuals.ts 的 lucide 家族一致）。 */
const TOOL_TYPE_ICONS: Readonly<Record<LiteToolType, IconInput>> = {
  exec: SquareTerminal,
  read: BookOpen,
  write: PenLine,
  web: Globe,
  dispatch: Forward,
  other: Wrench,
}

/** 单个工具调用 → 本源图标（按该工具的类型分类）。 */
export function toolCallIcon(name: string): IconInput {
  return TOOL_TYPE_ICONS[classifyToolType(name)] ?? Wrench
}

/** 思考/正文标记图标：静止用 brain，运行中由视图层切换为 brain-cog。 */
export const THINKING_ICONS = {
  idle: Brain,
  active: BrainCog,
} as const
