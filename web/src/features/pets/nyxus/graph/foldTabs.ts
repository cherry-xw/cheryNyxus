import type { GraphToolCall } from '@/application/backend/public'
import type { ExecutionFoldMember } from './executionGraph'
import { accentForTheme, skinForNode } from './nodeSkins'
import { toolBatchDetail } from './toolBatchDetails'

export type FoldTabKind = 'agent' | 'tool' | 'question' | 'interaction' | 'error'

/**
 * 弹链轮盘（FoldTabRail）子弹样式判定（2026-09-02 返工，判定收敛在数据层可测，
 * 组件只消费）：kind 之上的内容类型细分——tool 尖头弹 / file 双切角平头弹 /
 * skill 阶梯尾弹 / question 空尖弹 / interaction 半芯弹 / error 断壳曳光弹 /
 * agent 平头凹槽弹。规格见 docs/web/pet/rendering.md「过程组左轮」。
 */
export type FoldBulletKind =
  | 'tool'
  | 'file'
  | 'skill'
  | 'question'
  | 'interaction'
  | 'error'
  | 'agent'

export interface FoldTabView {
  memberId: string
  kind: FoldTabKind
  bulletKind: FoldBulletKind
  glyph: string
  accent: string
  label: string
  status: string
}

export type FoldWheelSlotId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'
export type FoldWheelSlotRole = 'active' | 'adjacent' | 'transition' | 'back'

export interface FoldWheelSlot<T> {
  id: FoldWheelSlotId
  role: FoldWheelSlotRole
  item: T
  itemIndex: number
  interactive: boolean
  realContent: boolean
  x: number
  y: number
  z: number
  opacity: number
  zIndex: number
}

export interface FoldWheelView<T> {
  slots: FoldWheelSlot<T>[]
  selectedIndex: number
  layerIndex: number
  layerCount: number
  itemCount: number
}

const QUESTION_TOOLS = new Set(['ask_user_question', 'request_user_input'])

/** 与 toolArgumentFields 的 path 字段判定同源：出现路径参数即视为文件类工具。 */
const PATH_ARGUMENT_KEY = /^(path|cwd|file|filePath|root)$/i

function argumentsRecord(call: GraphToolCall | undefined): Record<string, unknown> {
  if (!call || typeof call.arguments !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(call.arguments)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function bulletKindFor(
  kind: FoldTabKind,
  call: GraphToolCall | undefined,
): FoldBulletKind {
  if (kind === 'error') return 'error'
  if (kind === 'question') return 'question'
  if (kind === 'interaction') return 'interaction'
  if (kind === 'agent' || !call) return 'agent'
  if (call.name === 'skill') return 'skill'
  if (/file|read|write/i.test(call.name)) return 'file'
  const args = argumentsRecord(call)
  if (Object.keys(args).some((key) => PATH_ARGUMENT_KEY.test(key))) return 'file'
  return 'tool'
}

interface FoldWheelSlotSpec {
  id: FoldWheelSlotId
  angle: number
  offset: number
  role: FoldWheelSlotRole
}

const FOLD_WHEEL_SLOT_SPECS: readonly FoldWheelSlotSpec[] = [
  { id: 'E', angle: 0, offset: 0, role: 'active' },
  { id: 'C', angle: -45, offset: -1, role: 'adjacent' },
  { id: 'G', angle: 45, offset: 1, role: 'adjacent' },
  { id: 'A', angle: -90, offset: -2, role: 'transition' },
  { id: 'H', angle: 90, offset: 2, role: 'transition' },
  { id: 'B', angle: -135, offset: -3, role: 'back' },
  { id: 'F', angle: 135, offset: 3, role: 'back' },
  { id: 'D', angle: 180, offset: -4, role: 'back' },
]
export const FOLD_WHEEL_LAYER_CAPACITY = FOLD_WHEEL_SLOT_SPECS.length

export function foldTabForMember(member: ExecutionFoldMember, theme: 'light' | 'dark' = 'dark'): FoldTabView {
  const node = member.displayNode
  const skin = skinForNode(node)
  const batch = toolBatchDetail(node)
  const firstCall = batch?.calls[0]
  const question = !!firstCall && QUESTION_TOOLS.has(firstCall.name)
  const error = batch?.status === 'error' || node.sourceFact?.termination?.code === 'error'
  const interaction = batch?.status === 'pending' || batch?.status === 'rejected'
  const kind: FoldTabKind = error
    ? 'error'
    : question
      ? 'question'
      : interaction
        ? 'interaction'
        : batch
          ? 'tool'
          : 'agent'
  const statusAccent =
    theme === 'light'
      ? { error: '#d6455d', question: '#6d5bd6', interaction: '#b7791f' }
      : { error: '#ff718c', question: '#b7a7ff', interaction: '#ffca73' }
  return {
    memberId: member.id,
    kind,
    bulletKind: bulletKindFor(kind, firstCall),
    glyph: error ? '!' : question ? '?' : interaction ? '◷' : skin.glyph,
    accent: error
      ? statusAccent.error
      : question
        ? statusAccent.question
        : interaction
          ? statusAccent.interaction
          : accentForTheme(theme, skin.key),
    label:
      (firstCall ? '工具执行' : undefined) ||
      (node.actor.kind === 'agent' ? node.actor.roleType?.trim() || skin.label : skin.label),
    status:
      batch?.status === 'active'
        ? '执行中'
        : batch?.status === 'pending'
          ? '等待中'
          : batch?.status === 'error'
            ? '执行失败'
            : batch?.status === 'rejected'
              ? '已拒绝'
              : node.status === 'revoked'
                ? '已撤回'
                : '已完成',
  }
}

function circularIndex(index: number, length: number): number {
  return ((index % length) + length) % length
}

/**
 * Maps logical Fold members onto the confirmed side-view ellipse:
 * E > C/G > A/H > B/F > D. Only C/E/G expose member content or hit targets.
 */
export function foldWheelView<T>(items: readonly T[], selectedIndex: number): FoldWheelView<T> {
  if (items.length === 0) {
    return { slots: [], selectedIndex: 0, layerIndex: 0, layerCount: 0, itemCount: 0 }
  }
  const selected = Math.max(0, Math.min(selectedIndex, items.length - 1))
  const used = new Set<number>()
  const slots = FOLD_WHEEL_SLOT_SPECS.flatMap<FoldWheelSlot<T>>((spec) => {
    const itemIndex = circularIndex(selected + spec.offset, items.length)
    if (used.has(itemIndex)) return []
    used.add(itemIndex)
    const radians = (spec.angle * Math.PI) / 180
    const depth = Math.cos(radians)
    const realContent = spec.role === 'active' || spec.role === 'adjacent'
    return [
      {
        id: spec.id,
        role: spec.role,
        item: items[itemIndex]!,
        itemIndex,
        interactive: realContent,
        realContent,
        x: Math.round(depth * 42),
        y: Math.round(Math.sin(radians) * 42),
        z: Math.round(depth * 112),
        opacity:
          spec.role === 'active'
            ? 1
            : spec.role === 'adjacent'
              ? 0.92
              : spec.role === 'transition'
                ? 0.48
                : spec.id === 'D'
                  ? 0.12
                  : 0.24,
        zIndex: Math.round((depth + 1) * 100),
      },
    ]
  })
  return {
    slots,
    selectedIndex: selected,
    layerIndex: Math.floor(selected / FOLD_WHEEL_LAYER_CAPACITY),
    layerCount: Math.ceil(items.length / FOLD_WHEEL_LAYER_CAPACITY),
    itemCount: items.length,
  }
}
