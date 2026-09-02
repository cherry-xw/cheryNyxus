import type { ExecutionFoldMember } from './executionGraph'
import { accentForTheme, skinForNode } from './nodeSkins'
import { toolBatchDetail } from './toolBatchDetails'

export type FoldTabKind = 'agent' | 'tool' | 'question' | 'interaction' | 'error'

export interface FoldTabView {
  memberId: string
  kind: FoldTabKind
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
/** 左轮导航外框宽度（FoldTabRail `.fold-wheel-navigation`），弹窗旁并排定位共用。 */
export const FOLD_WHEEL_STAGE_WIDTH = 216
/** 左轮轮盘舞台高度（不含 24px 底部计数条），侧贴锚点垂直居中用。 */
export const FOLD_WHEEL_STAGE_HEIGHT = 180
/** 左轮与弹窗/节点边缘的净距。 */
export const FOLD_WHEEL_NODE_GAP = 18

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
