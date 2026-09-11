import { MarkerType, Position, type Edge, type Node } from '@vue-flow/core'
import type { WorkflowOccurrence } from '@chery/protocol'
import type { ActiveTurnSnapshot, RootTimelineSnapshot } from '@/application/backend/public'
import type { NyxusContentSelection, NyxusReaderFoldMode } from '@/features/pets/nyxus/public'
import type { WorkflowClientState } from './workflowState'
import {
  buildHeaderNodes,
  placeHeader,
  headerTemplateNodeId,
  type HeaderChildData,
  type HeaderBounds,
} from './headerGraph'
import { WORKFLOW_HEADER_TEMPLATE, type HeaderPoint } from './headerTemplate'
import type { HeaderScopeSelection, HeaderStateProjection } from './headerState'
import {
  presentResultNode,
  resultEdgeLabel,
  type ResultNodePresentation,
  type ResultNodeStatusTone,
} from './resultTreePresentation'
import { resultVisual, type WorkflowVisualIdentity } from './workflowVisuals'
import {
  WORKFLOW_HEADER_SECTIONS,
  WORKFLOW_HEADER_TEMPLATE_VERSION,
  WORKFLOW_STEP_LABELS,
  projectWorkflowScene,
  resolveWorkflowSceneSelection,
  type WorkflowHeaderSection,
  type WorkflowProjectionEdge,
  type WorkflowSceneProjection,
} from './workflowProjection'

export {
  WORKFLOW_HEADER_SECTIONS,
  WORKFLOW_HEADER_TEMPLATE_VERSION,
  WORKFLOW_STEP_LABELS,
  projectWorkflowScene,
}
export type {
  HeaderFlowProjection,
  ResultTreeProjection,
  WorkflowHeaderSection,
  WorkflowSceneProjection,
} from './workflowProjection'

export type WorkflowGraphNodeData =
  | HeaderChildData
  | {
      kind: 'occurrence'
      occurrence: WorkflowOccurrence
      statusText: string
      live: boolean
      sourceHeaderId: string
      contentTarget?: NyxusContentSelection
    }
  | {
      kind: 'content'
      node: WorkflowSceneProjection['resultTree']['nodes'][number]['node']
      title: string
      preview: string
      presentation: ResultNodePresentation
      visual: WorkflowVisualIdentity
    }
  | {
      kind: 'header'
      chatId: string
      title: string
      mode: 'full' | 'compact'
      templateVersion: typeof WORKFLOW_HEADER_TEMPLATE_VERSION
      runStatus: string
      active: WorkflowOccurrence[]
      sections: WorkflowHeaderSection[]
      calls: Array<{ id: string; name: string; status: string; current: boolean }>
      iterationCount: number
      currentIteration: number
      state: HeaderStateProjection
    }
  | {
      kind: 'unresolved'
      title: string
      detail: string
    }

export type WorkflowGraphNode = Node<WorkflowGraphNodeData>
export type WorkflowGraphEdge = Edge<{
  relation: string
  relationLabel?: string
  semantic: WorkflowProjectionEdge['semantic']
  points?: HeaderPoint[]
  labelPoint?: HeaderPoint
  evidenced?: boolean
  sourceOccurrenceId?: string
  targetOccurrenceId?: string
  targetStatus?: WorkflowOccurrence['status'] | ResultNodeStatusTone
  targetSequence?: number
  accent?: string
}>

export interface WorkflowGraphProjection {
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  activeHeaderId?: string
  activeOccurrenceId?: string
  /** 活跃 header 中正在执行/等待的 step 所属 group id 集合（驱动 group 自动展开） */
  activeGroupIds: ReadonlySet<string>
  scene: WorkflowSceneProjection
}

export const WORKFLOW_GRAPH_LAYOUT = {
  originX: 48,
  originY: 56,
  laneStride: 408,
  itemStride: 224,
  contentWidth: 176,
  contentHeight: 88,
  compactHeaderWidth: 228,
  compactHeaderHeight: 116,
  fullHeaderWidth: WORKFLOW_HEADER_TEMPLATE.width,
  fullHeaderHeight: WORKFLOW_HEADER_TEMPLATE.height,
  headerGap: 72,
} as const

function graphEdge(
  edge: WorkflowProjectionEdge,
  targets: ReadonlyMap<string, Extract<WorkflowGraphNodeData, { kind: 'content' }>>,
): WorkflowGraphEdge {
  const relationLabel = resultEdgeLabel(edge.relation)
  const target = targets.get(edge.targetId)
  return {
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    type: edge.semantic === 'fact' ? 'result' : 'step',
    markerEnd: MarkerType.ArrowClosed,
    selectable: false,
    focusable: false,
    data: {
      relation: edge.relation,
      relationLabel,
      semantic: edge.semantic,
      ...(target
        ? {
            accent: target.visual.accent,
            targetStatus: target.presentation.statusTone,
            targetSequence: target.node.orderKey ?? 0,
          }
        : {}),
    },
    sourceHandle: 'result-out',
    targetHandle: edge.semantic === 'fact' ? 'result-in' : 'header-in',
    class: `workflow-edge relation-${edge.semantic}`,
  }
}

/** Converts the pure workflow scene into Vue Flow records without changing canonical ordering. */
export function projectWorkflowGraph(
  workflow: WorkflowClientState | undefined,
  timeline: RootTimelineSnapshot | undefined,
  foldMode: NyxusReaderFoldMode = 'none',
  headerSelections: Readonly<Record<string, HeaderScopeSelection>> = {},
  activeTurns: readonly ActiveTurnSnapshot[] = [],
): WorkflowGraphProjection {
  const scene = projectWorkflowScene(workflow, timeline, foldMode)
  const laneIndex = new Map(scene.headerFlow.headers.map((header, index) => [header.laneId, index]))
  const nodes: WorkflowGraphNode[] = scene.resultTree.nodes.map((item) => {
    const presentation = presentResultNode(item.node, item.title, item.preview)
    return {
      id: item.id,
      type: 'content',
      position: {
        x: WORKFLOW_GRAPH_LAYOUT.originX + item.column * WORKFLOW_GRAPH_LAYOUT.itemStride,
        y:
          WORKFLOW_GRAPH_LAYOUT.originY +
          (laneIndex.get(item.laneId) ?? 0) * WORKFLOW_GRAPH_LAYOUT.laneStride,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      connectable: false,
      selectable: true,
      focusable: false,
      width: WORKFLOW_GRAPH_LAYOUT.contentWidth,
      height: WORKFLOW_GRAPH_LAYOUT.contentHeight,
      class: `workflow-result-node node-${presentation.visualKind}`,
      data: {
        kind: 'content',
        node: item.node,
        title: item.title,
        preview: item.preview,
        presentation,
        visual: resultVisual(presentation.visualKind),
      },
    }
  })

  const obstacles: HeaderBounds[] = nodes.map((node) => ({
    ...node.position,
    width: Number(node.width),
    height: Number(node.height),
  }))
  const contentTargets = new Map<
    string,
    Extract<WorkflowGraphNodeData, { kind: 'content' }>
  >()
  for (const node of nodes) {
    if (node.data?.kind === 'content') contentTargets.set(node.id, node.data)
  }
  const headerEdges: WorkflowGraphEdge[] = []
  const activeGroupIds = new Set<string>()
  let activeOccurrenceId: string | undefined
  // Place the full head first, then compact heads in stable branch order.
  const headers = [...scene.headerFlow.headers].sort(
    (a, b) => Number(b.mode === 'full') - Number(a.mode === 'full'),
  )
  for (const header of headers) {
    const lastColumn = Math.max(
      -1,
      ...scene.resultTree.nodes
        .filter((node) => node.laneId === header.laneId)
        .map((node) => node.column),
    )
    const x = Math.max(
      280,
      WORKFLOW_GRAPH_LAYOUT.originX +
        (lastColumn + 1) * WORKFLOW_GRAPH_LAYOUT.itemStride +
        WORKFLOW_GRAPH_LAYOUT.headerGap,
    )
    const bounds = placeHeader(
      {
        x,
        y:
          WORKFLOW_GRAPH_LAYOUT.originY +
          (laneIndex.get(header.laneId) ?? 0) * WORKFLOW_GRAPH_LAYOUT.laneStride,
        width:
          header.mode === 'full'
            ? WORKFLOW_GRAPH_LAYOUT.fullHeaderWidth
            : WORKFLOW_GRAPH_LAYOUT.compactHeaderWidth,
        height:
          header.mode === 'full'
            ? WORKFLOW_GRAPH_LAYOUT.fullHeaderHeight
            : WORKFLOW_GRAPH_LAYOUT.compactHeaderHeight,
      },
      obstacles,
      WORKFLOW_GRAPH_LAYOUT.headerGap,
    )
    obstacles.push(bounds)
    const built = buildHeaderNodes({
      header,
      position: { x: bounds.x, y: bounds.y },
      selection: headerSelections[header.id],
      currentRunId: timeline?.activeRuns.find((run) => run.chatId === header.chatId)?.runId,
      recorded: !!workflow,
      complete:
        !!workflow?.historyComplete &&
        !workflow?.hasEarlier &&
        !workflow?.gaps.some((gap) => !gap.chatId || gap.chatId === header.chatId),
      activeTurns,
    })
    nodes.push(...built.nodes)
    headerEdges.push(...built.edges)
    const activeSlot = Object.values(built.state.slots)
      .filter((slot) => slot.occurrence && ['running', 'waiting'].includes(slot.status))
      .at(-1)
    if (header.id === scene.headerFlow.activeHeaderId) {
      for (const slot of Object.values(built.state.slots)) {
        if (!slot.occurrence || !['running', 'waiting'].includes(slot.status)) continue
        const template = WORKFLOW_HEADER_TEMPLATE.nodes.find((node) => node.id === slot.nodeId)
        if (template) activeGroupIds.add(template.group)
      }
    }
    if (header.id === scene.headerFlow.activeHeaderId && activeSlot)
      activeOccurrenceId = headerTemplateNodeId(header.id, activeSlot.nodeId)
    else if (
      !activeOccurrenceId &&
      header.steps.some((step) => step.id === scene.headerFlow.activeStepId)
    )
      activeOccurrenceId = header.id
  }

  return {
    nodes,
    edges: [...scene.edges.map((edge) => graphEdge(edge, contentTargets)), ...headerEdges],
    activeHeaderId: scene.headerFlow.activeHeaderId,
    activeOccurrenceId,
    activeGroupIds,
    scene,
  }
}

export function resolveWorkflowGraphSelection(
  projection: WorkflowGraphProjection,
  selection: NyxusContentSelection,
) {
  const resolution = resolveWorkflowSceneSelection(projection.scene, selection)
  return resolution.status === 'available'
    ? { ...resolution, graphNodeId: resolution.renderedNodeId }
    : resolution
}
