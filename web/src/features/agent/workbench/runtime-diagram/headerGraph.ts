import { MarkerType, type Node } from '@vue-flow/core'
import type { ActiveTurnSnapshot } from '@/application/backend/public'
import type { HeaderLaneProjection } from './workflowProjection'
import {
  WORKFLOW_HEADER_TEMPLATE,
  headerEdgePoints,
  headerHandleId,
  headerEdgeLabelPoint,
  type HeaderTemplateNode,
  type HeaderPoint,
} from './headerTemplate'
import {
  projectHeaderState,
  type HeaderStateProjection,
  type HeaderScopeSelection,
  type HeaderSlotState,
} from './headerState'
import type { WorkflowGraphNodeData, WorkflowGraphEdge, WorkflowGraphNode } from './graphModel'
import { headerVisual, type WorkflowVisualIdentity } from './workflowVisuals'

export type HeaderSelection = {
  headerId: string
  chatId: string
  templateNodeId: string
  title: string
  scope: HeaderScopeSelection
  recorded: boolean
  complete: boolean
  slot: HeaderSlotState
  detail: string
}
export type HeaderScopeEvent = { headerId: string; scope: HeaderScopeSelection }

/** group 缩略态的步骤状态概览计数 */
export interface HeaderGroupSummary {
  running: number
  waiting: number
  succeeded: number
  failed: number
  rejected: number
  idle: number
}

export type HeaderGroupToggleEvent = { headerId: string; groupId: string }

export type HeaderChildData =
  | {
      kind: 'header-group'
      headerId: string
      groupId: string
      title: string
      summary: HeaderGroupSummary
      /** 是否缩略展示（仅标题+概览）。由 RuntimeDiagram 投影时注入。 */
      collapsed: boolean
      /** 该 group 是否含活跃（running/waiting）step。由 RuntimeDiagram 投影时注入。 */
      active: boolean
    }
  | {
      kind: 'header-step'
      headerId: string
      chatId: string
      template: HeaderTemplateNode
      slot: HeaderSlotState
      scope: HeaderScopeSelection
      recorded: boolean
      complete: boolean
      selected?: boolean
      visual: WorkflowVisualIdentity
      liveTurn?: ActiveTurnSnapshot
      /** 该 step 最近一次 occurrence 的 loop 轮次 */
      iteration: number
      /** 该 lane 累计 loop 轮次总数 */
      iterationCount: number
    }
  | { kind: 'header-calls'; headerId: string; state: HeaderStateProjection }

export interface HeaderBounds {
  x: number
  y: number
  width: number
  height: number
}
export function boundsOverlap(a: HeaderBounds, b: HeaderBounds, gap = 0): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  )
}
/** Only header bounds move; canonical content geometry is immutable here. */
export function placeHeader(
  bounds: HeaderBounds,
  obstacles: HeaderBounds[],
  gap: number,
): HeaderBounds {
  let result = { ...bounds }
  for (;;) {
    const collisions = obstacles.filter((obstacle) => boundsOverlap(result, obstacle, gap))
    if (!collisions.length) return result
    result = { ...result, x: Math.max(...collisions.map((item) => item.x + item.width + gap)) }
  }
}

export function headerTemplateNodeId(headerId: string, nodeId: string): string {
  return `${headerId}:template:${nodeId}`
}

/** 统计某 group 内各 step 的状态概览，供缩略态展示。 */
function summarizeGroup(
  slots: Record<string, HeaderSlotState>,
  groupId: string,
): HeaderGroupSummary {
  const summary: HeaderGroupSummary = {
    running: 0,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    idle: 0,
  }
  for (const node of WORKFLOW_HEADER_TEMPLATE.nodes) {
    if (node.group !== groupId) continue
    const status = slots[node.id]?.status
    if (status === 'running') summary.running += 1
    else if (status === 'waiting') summary.waiting += 1
    else if (status === 'succeeded') summary.succeeded += 1
    else if (status === 'failed') summary.failed += 1
    else if (status === 'rejected') summary.rejected += 1
    else if (status === 'idle') summary.idle += 1
  }
  return summary
}

export function buildHeaderNodes(input: {
  header: HeaderLaneProjection
  position: HeaderPoint
  selection?: HeaderScopeSelection
  currentRunId?: string
  recorded: boolean
  complete: boolean
  activeTurns?: readonly ActiveTurnSnapshot[]
}): { nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[]; state: HeaderStateProjection } {
  const { header } = input
  const state = projectHeaderState({
    chatId: header.chatId,
    occurrences: header.steps.map((step) => step.occurrence),
    calls: header.calls,
    selection: input.selection,
    currentRunId: input.currentRunId,
    recorded: input.recorded,
    complete: input.complete,
  })
  const full = header.mode === 'full'
  const nodes: WorkflowGraphNode[] = [
    {
      id: header.id,
      type: 'header',
      position: input.position,
      width: full ? WORKFLOW_HEADER_TEMPLATE.width : 228,
      height: full ? WORKFLOW_HEADER_TEMPLATE.height : 116,
      draggable: false,
      connectable: false,
      selectable: false,
      focusable: false,
      zIndex: -2,
      data: {
        kind: 'header',
        chatId: header.chatId,
        title: header.title,
        mode: header.mode,
        templateVersion: header.templateVersion,
        runStatus: header.runStatus,
        active: state.occurrences.filter(
          (item) => item.status === 'running' || item.status === 'waiting',
        ),
        sections: header.sections,
        calls: state.calls,
        iterationCount: header.iterationCount,
        currentIteration: header.currentIteration,
        state,
      },
    },
  ]
  if (!full) return { nodes, edges: [], state }
  for (const group of WORKFLOW_HEADER_TEMPLATE.groups)
    nodes.push({
      id: `${header.id}:group:${group.id}`,
      type: 'header-group',
      parentNode: header.id,
      position: { x: group.x, y: group.y },
      width: group.width,
      height: group.height,
      draggable: false,
      connectable: false,
      selectable: false,
      focusable: false,
      zIndex: -1,
      data: {
        kind: 'header-group',
        headerId: header.id,
        groupId: group.id,
        title: group.title,
        summary: summarizeGroup(state.slots, group.id),
        // 视图态由 RuntimeDiagram 投影时决定；此处给默认值占位
        collapsed: false,
        active: false,
      },
    })
  for (const template of WORKFLOW_HEADER_TEMPLATE.nodes) {
    const group = WORKFLOW_HEADER_TEMPLATE.groups.find((item) => item.id === template.group)!
    const slot = state.slots[template.id]!
    const liveTurn =
      template.id === 'model' && slot.status === 'running'
        ? input.activeTurns
            ?.filter(
              (turn) =>
                (turn.chatId ?? header.chatId) === header.chatId &&
                turn.status !== 'completed' &&
                turn.status !== 'error' &&
                (!slot.occurrence?.runId || !turn.runId || turn.runId === slot.occurrence.runId),
            )
            .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
            .at(-1)
        : undefined
    nodes.push({
      id: headerTemplateNodeId(header.id, template.id),
      type: 'header-step',
      parentNode: `${header.id}:group:${group.id}`,
      position: { x: template.position.x - group.x, y: template.position.y - group.y },
      width: template.width,
      height: template.height,
      draggable: false,
      connectable: false,
      selectable: false,
      focusable: false,
      data: {
        kind: 'header-step',
        headerId: header.id,
        chatId: header.chatId,
        template,
        slot,
        visual: headerVisual(template),
        iteration: slot.occurrence?.iteration ?? 1,
        iterationCount: header.iterationCount,
        ...(liveTurn ? { liveTurn } : {}),
        scope: state.scope,
        recorded: input.recorded,
        complete: input.complete,
      },
    })
  }
  nodes.push({
    id: `${header.id}:calls`,
    type: 'header-calls',
    parentNode: header.id,
    position: { x: WORKFLOW_HEADER_TEMPLATE.callList.x, y: WORKFLOW_HEADER_TEMPLATE.callList.y },
    width: WORKFLOW_HEADER_TEMPLATE.callList.width,
    height: WORKFLOW_HEADER_TEMPLATE.callList.height,
    draggable: false,
    connectable: false,
    selectable: false,
    focusable: false,
    data: { kind: 'header-calls', headerId: header.id, state },
  })
  const edges: WorkflowGraphEdge[] = WORKFLOW_HEADER_TEMPLATE.edges.map((edge) => {
    const targetTemplate = WORKFLOW_HEADER_TEMPLATE.nodes.find((node) => node.id === edge.target)!
    const source = state.slots[edge.source]?.occurrence
    const target = state.slots[edge.target]?.occurrence
    // Sequence adjacency does not prove a path. Only explicit cause links do.
    const evidenced =
      !!source &&
      !!target &&
      target.causeOccurrenceId === source.occurrenceId &&
      source.orderQuality === 'exact' &&
      target.orderQuality === 'exact'
    const points = headerEdgePoints(edge).map((point) => ({
      x: point.x + input.position.x,
      y: point.y + input.position.y,
    }))
    const labelPoint = headerEdgeLabelPoint(edge)
    return {
      id: `${header.id}:edge:${edge.id}`,
      source: headerTemplateNodeId(header.id, edge.source),
      target: headerTemplateNodeId(header.id, edge.target),
      sourceHandle: headerHandleId('out', edge.sourcePort, edge.sourceOffset),
      targetHandle: headerHandleId('in', edge.targetPort, edge.targetOffset),
      type: 'header-flow',
      markerEnd: MarkerType.ArrowClosed,
      selectable: false,
      focusable: false,
      class: `workflow-edge relation-template${evidenced ? ` state-${target.status}` : ''}`,
      data: {
        semantic: 'template',
        relation: edge.role,
        relationLabel: edge.label,
        labelPoint: { x: labelPoint.x + input.position.x, y: labelPoint.y + input.position.y },
        points,
        evidenced,
        sourceOccurrenceId: source?.occurrenceId,
        targetOccurrenceId: target?.occurrenceId,
        targetStatus: target?.status,
        targetSequence: target?.lastSequence,
        accent: headerVisual(targetTemplate).accent,
      },
    }
  })
  return { nodes, edges, state }
}

export function absoluteGraphPosition(
  node: Node<WorkflowGraphNodeData>,
  nodes: Node<WorkflowGraphNodeData>[],
): HeaderPoint {
  const parent = node.parentNode ? nodes.find((item) => item.id === node.parentNode) : undefined
  const origin = parent ? absoluteGraphPosition(parent, nodes) : { x: 0, y: 0 }
  return { x: origin.x + node.position.x, y: origin.y + node.position.y }
}
