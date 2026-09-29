import type { ComputedRef, Ref } from 'vue'
import type { RootTimelineSnapshot, TimelineNode } from '@/application/backend/public'
import type {
  ExecutionEdge,
  ExecutionFoldMember,
  ExecutionGraph,
  ExecutionNode,
} from '../graph/executionGraph'
import type { ExecutionLayoutMode, PositionedExecutionNode } from '../graph/executionLayout'
import type { ExecutionPresentationMode } from '../graph/executionPresentation'
import type { CrtPlacement } from '../graph/crtLayout'
import type { RunCrtModel } from '../graph/crtModel'
import type { DefaultNodePopover } from '../graph/nodePopoverModel'
import type { PaperStackEntry } from '../paper/paperStackModel'
import type { useNyxusHost } from '../application/host'
import type { useTreeCanvas } from '../composables/useTreeCanvas'
import AnchoredRunCrt from './AnchoredRunCrt.vue'
import ExecutionNodePopover from './ExecutionNodePopover.vue'
import RoundNodePopover from './RoundNodePopover.vue'
import FoldTabRail from './FoldTabRail.vue'
import GenerationTreeDialog from './GenerationTreeDialog.vue'
import NodePaperStack from './NodePaperStack.vue'

export type MessageBranchTreeControllerProps = {
  rootChatId: string
  timelineOverride?: RootTimelineSnapshot
  branchAnchorNodeId?: string
  branchAnchorKind?: 'detail' | 'continuation'
  detailBranchAvailable?: boolean
  detailBranchUnavailableReason?: string
  layoutMode?: ExecutionLayoutMode
  presentationMode?: ExecutionPresentationMode
  foldMode?: 'none' | 'partial' | 'round' | 'participant'
  focusSourceChatId?: string
  focusInteractionId?: string
  /** 节点数≤此值跳过视口裁剪全量渲染（消除平移卡顿）。undefined → 用默认阈值。 */
  fullRenderThreshold?: number
  paperMode?: boolean
  /** Auxiliary workbench panel occupies the right drawer while the tree stays full width. */
  sidePanelOpen?: boolean
  /** 侧边抽屉标题（工作台按 sidePanel 传入：卡牌模式/流程图/阅读器）。 */
  sidePanelTitle?: string
  /** Parent workbench is minimized/hidden; keep state but suspend GPU work. */
  suspended?: boolean
  /** 静态历史视图（代际二层弹窗）：挂断 live 投影（输入/流式/CRT），仅渲染 timelineOverride。 */
  staticView?: boolean
}
export type MessageBranchTreeControllerEmits = {
  branch: [
    payload: {
      type: 'detail' | 'continuation'
      nodeId: string
      sourceRootChatId: string
      ordinary?: boolean
    },
  ]
  /** 用户点击待处理节点：交由工作台左下角统一审核窗口处理。 */
  interactionFocus: [focus: { chatId: string; interactionId?: string; anchorNodeId?: string }]
  /** 钢琴彩蛋连点序列触发 → 父级（工作台）打开钢琴浮层。 */
  'easter-egg': []
  'presentation-fallback': [message: string]
  /** 右侧抽屉 ✕ / 遮罩点击 → 父级关闭侧栏（sidePanel 置回 none）。 */
  'close-side-panel': []
}
export type ControllerEmit<T> = <K extends keyof T>(
  event: K,
  ...args: T[K] extends unknown[] ? T[K] : never
) => void

/** 默认节点悬浮窗的布局条目（由 defaultPopoverPlacements 推断，未单独导出）。 */
export type DefaultPopoverPlacement = {
  id: string
  anchor: { x: number; y: number }
  panel: { width: number; height: number }
  main: boolean
  actionable: boolean
  pinned: boolean
  order: number
  left: number
  top: number
  placement: 'left' | 'right' | 'below'
}

/** 默认节点悬浮窗的视图条目（defaultPopoverViews 元素）。 */
export type DefaultPopoverView = {
  placement: DefaultPopoverPlacement
  model: DefaultNodePopover
  anchor: ExecutionNode
  display: ExecutionNode
  relatedEdges: ExecutionEdge[]
}

/** 详情弹窗的定位结果（detailPlacement 值）。 */
export type DetailPlacement = {
  style: { left: string; top: string; width?: string; height?: string }
  nodeOffset: { x: number; y: number }
  railSide: 'left' | 'right'
  placement: 'left' | 'right' | 'below'
}

/** 运行 CRT 窗口的定位条目（crtPlacements / overlayPlacements 元素）：在 CrtPlacement 基础上带窗口叠放层级。 */
export type RunCrtPlacement = CrtPlacement & { windowZ: number }

/**
 * 控制器返回对象类型。
 *
 * 该返回对象字段多、类型复杂，若依赖自动推断，vue-tsc 在消费端
 * （MessageBranchTree.vue 的 controller 使用）会陷入类型推断循环
 * （TS7022/TS7023）。这里为返回对象建立显式类型边界，返回对象字面量
 * 仍受 `return {…}` 的赋值校验兜底，字段变化会在此处报错提示同步。
 */
export interface MessageBranchTreeController {
  AnchoredRunCrt: typeof AnchoredRunCrt
  ExecutionNodePopover: typeof ExecutionNodePopover
  RoundNodePopover: typeof RoundNodePopover
  FoldTabRail: typeof FoldTabRail
  GenerationTreeDialog: typeof GenerationTreeDialog
  NodePaperStack: typeof NodePaperStack
  activateNode: (node: PositionedExecutionNode) => void
  agents: ReturnType<typeof useNyxusHost>['agents']
  canvas: ReturnType<typeof useTreeCanvas>
  closeCrt: (id: string) => void
  closeGenerationView: () => void
  closeNodeDetail: () => void
  crtById: ComputedRef<Map<string, RunCrtModel>>
  crtPlacements: ComputedRef<RunCrtPlacement[]>
  crtVisibility: ComputedRef<{ visible: Set<string>; hiddenPassive: number }>
  defaultPopoverAnchorIds: ComputedRef<Set<string>>
  defaultPopoverViews: ComputedRef<DefaultPopoverView[]>
  detailAnchorEl: Ref<HTMLElement | undefined>
  detailAnchorStyle: ComputedRef<DetailPlacement['style'] | undefined>
  detailDisplayNode: ComputedRef<ExecutionNode | undefined>
  detailFoldMember: ComputedRef<ExecutionFoldMember | undefined>
  detailRoundSections: ComputedRef<
    | { opening: ExecutionNode; reply: ExecutionNode }
    | undefined
  >
  detailMaxHeight: ComputedRef<number>
  detailNode: ComputedRef<PositionedExecutionNode | undefined>
  detailPinned: ComputedRef<boolean>
  detailWrap: Ref<boolean>
  detailPlacement: ComputedRef<DetailPlacement | undefined>
  detailRelatedEdges: ComputedRef<ExecutionEdge[]>
  dragActionPopover: (id: string, delta: { x: number; y: number }) => void
  dragCrt: (id: string, delta: { x: number; y: number }) => void
  dragDetailPopover: (delta: { x: number; y: number }) => void
  finishDetailDrag: () => void
  cycleDetailSize: () => void
  detailSizeLabel: ComputedRef<string>
  toggleDetailWrap: () => void
  focusCrt: (id: string) => void
  focusNode: (node: PositionedExecutionNode) => void
  focusRelativeNode: (
    nodeId: string,
    direction: -1 | 1 | 'first' | 'last' | 'up' | 'down' | 'left' | 'right',
  ) => void
  foldRailSide: ComputedRef<'left' | 'right'>
  generationDialogIndex: Ref<number | undefined>
  generationDialogRootChatId: Ref<string | undefined>
  gpuNodeAccent: (node: PositionedExecutionNode) => string
  gpuNodeHitStyle: (node: PositionedExecutionNode) => Record<string, string>
  gpuRenderError: Ref<string>
  graph: ComputedRef<ExecutionGraph>
  hasNewTail: Ref<boolean>
  hideNodeDetail: (node: PositionedExecutionNode) => void
  keepNodeDetailOpen: () => void
  leaveNodeDetail: () => void
  nodeAriaLabel: (node: PositionedExecutionNode) => string
  nodeTitle: (node: ExecutionNode) => string
  onFoldRailInteraction: (foldId: string, active: boolean) => void
  onNodePointerDown: (event: PointerEvent, node: PositionedExecutionNode) => void
  overlayPlacements: ComputedRef<RunCrtPlacement[]>
  paperCurrentIndex: ComputedRef<number>
  paperEntries: ComputedRef<PaperStackEntry[]>
  paperGraph: ComputedRef<ExecutionGraph>
  paperHasNewTail: Ref<boolean>
  persistentGraph: ComputedRef<ExecutionGraph>
  pinCrt: (id: string) => void
  pinnedCrtIds: Ref<Set<string>>
  pixiMountRef: Ref<HTMLElement | null>
  recordActionPopoverHeight: (id: string) => (height: number) => void
  recoverGraph: () => Promise<void>
  recoveringGraph: Ref<boolean>
  recoveryError: Ref<string>
  requestBranch: (type: 'detail' | 'continuation', nodeId: string) => void
  resetLayout: () => boolean
  returnToBottom: () => void
  returnToLatestPaper: () => void
  selectActionCall: (modelId: string, callId: string) => void
  selectFoldMember: (foldId: string, memberId: string) => void
  selectPaperIndex: (index: number) => void
  selectedActionCall: (model: DefaultNodePopover) => string | undefined
  selectedCallId: Ref<string | undefined>
  showNodeDetail: (node: PositionedExecutionNode) => void
  stepFoldDetail: (delta: number) => void
  unpinCrt: (id: string) => void
  unreadFoldMembers: Ref<Map<string, number>>
  vMeasureHeight: {
    mounted(el: HTMLElement, binding: { value: (height: number) => void }): void
    updated(el: HTMLElement, binding: { value: (height: number) => void }): void
    unmounted(el: HTMLElement): void
  }
  viewportRef: Ref<HTMLElement | null>
  viewportSize: Ref<{ width: number; height: number }>
  visibleInteractiveNodes: ComputedRef<PositionedExecutionNode[]>
  taskPlanMarkerNodes: ComputedRef<PositionedExecutionNode[]>
  taskPlanForNode: (
    node: PositionedExecutionNode,
  ) => NonNullable<TimelineNode['todoPlan']> | undefined
  taskPlanMarkerStyle: (node: PositionedExecutionNode) => Record<string, string>
  actorLabel: (node: ExecutionNode) => string
}
