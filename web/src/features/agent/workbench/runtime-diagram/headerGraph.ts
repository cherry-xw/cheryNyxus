import { MarkerType, type Node } from '@vue-flow/core'
import type { ActiveTurnSnapshot } from '@/application/backend/public'
import type { HeaderLaneProjection } from './workflowProjection'
import { WORKFLOW_HEADER_TEMPLATE, HEADER_LAYERS, HEADER_NODE_SIZE, type HeaderTemplateNode, type HeaderPoint, type HeaderNodePort } from './headerTemplate'
import { layoutHeader, resolveCollapsedLayers, layerAncestors, type HeaderRect } from './headerLayout'
import { projectHeaderState, type HeaderStateProjection, type HeaderScopeSelection, type HeaderSlotState } from './headerState'
import type { WorkflowGraphNodeData, WorkflowGraphEdge, WorkflowGraphNode } from './graphModel'
import { headerVisual, type WorkflowVisualIdentity } from './workflowVisuals'

export type HeaderSelection = { headerId: string; chatId: string; templateNodeId: string; title: string; scope: HeaderScopeSelection; recorded: boolean; complete: boolean; slot: HeaderSlotState; detail: string }
export type HeaderScopeEvent = { headerId: string; scope: HeaderScopeSelection }
export type HeaderGroupToggleEvent = { headerId: string; groupId: string }
export interface HeaderViewOptions {
  overrides?: Readonly<Record<string, boolean>>
  follow?: boolean
  lastActiveLayers?: Readonly<Record<string, readonly string[]>>
  protectedLayers?: ReadonlySet<string>
}
export type HeaderChildData =
  | { kind: 'header-group'; headerId: string; groupId: string; title: string; collapsed: boolean; active: boolean; ownActive: boolean; summary: string; ports: HeaderNodePort[] }
  | { kind: 'header-step'; headerId: string; chatId: string; template: HeaderTemplateNode; slot: HeaderSlotState; scope: HeaderScopeSelection; recorded: boolean; complete: boolean; selected?: boolean; visual: WorkflowVisualIdentity; liveTurn?: ActiveTurnSnapshot; iteration: number; iterationCount: number; ports: HeaderNodePort[]; summary: string }
  | { kind: 'header-calls'; headerId: string; state: HeaderStateProjection }
export type HeaderBounds = HeaderRect
export { rectOverlaps as boundsOverlap } from './headerLayout'
export function placeHeader(bounds: HeaderBounds, obstacles: HeaderBounds[], gap: number): HeaderBounds {
  let result = { ...bounds }
  for (;;) {
    const collisions = obstacles.filter((obstacle) => result.x < obstacle.x + obstacle.width + gap && result.x + result.width + gap > obstacle.x && result.y < obstacle.y + obstacle.height + gap && result.y + result.height + gap > obstacle.y)
    if (!collisions.length) return result
    result = { ...result, x: Math.max(...collisions.map((item) => item.x + item.width + gap)) }
  }
}
export function headerTemplateNodeId(headerId: string, nodeId: string): string { return `${headerId}:template:${nodeId}` }
export function buildHeaderNodes(input: {
  header: HeaderLaneProjection; position: HeaderPoint; selection?: HeaderScopeSelection; currentRunId?: string
  recorded: boolean; complete: boolean; activeTurns?: readonly ActiveTurnSnapshot[]; view?: HeaderViewOptions
}): { nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[]; state: HeaderStateProjection; representatives: Record<string, string>; internalEdgeIds: string[] } {
  const { header } = input
  const state = projectHeaderState({ chatId: header.chatId, occurrences: header.steps.map((step) => step.occurrence), calls: header.calls, selection: input.selection, currentRunId: input.currentRunId, recorded: input.recorded, complete: input.complete })
  const active = new Set(WORKFLOW_HEADER_TEMPLATE.nodes.filter((n) => ['running', 'waiting'].includes(state.slots[n.id]?.status ?? '')).map((n) => n.group))
  const collapsed = resolveCollapsedLayers({ headerId: header.id, ...input.view, active: active.size ? active : new Set(input.view?.lastActiveLayers?.[header.id] ?? []) })
  const wholeCollapsed = input.view?.overrides?.[`${header.id}:header`] === true
  const full = header.mode === 'full' && !wholeCollapsed
  const layout = full ? layoutHeader(collapsed) : undefined
  const idFor = (id: string) => HEADER_LAYERS.some((g) => g.id === id) ? `${header.id}:group:${id}` : id === 'calls' ? `${header.id}:calls` : headerTemplateNodeId(header.id, id)
  const nodes: WorkflowGraphNode[] = [{
    id: header.id, type: 'header', position: input.position, width: layout?.width ?? HEADER_NODE_SIZE.width, height: layout?.height ?? HEADER_NODE_SIZE.height,
    draggable: false, connectable: false, selectable: false, focusable: false, zIndex: -10,
    data: { kind: 'header', chatId: header.chatId, title: header.title, mode: full ? 'full' : 'compact', expandable: header.mode === 'full', collapsed: wholeCollapsed,
      templateVersion: header.templateVersion, runStatus: header.runStatus, active: state.occurrences.filter((o) => ['running', 'waiting'].includes(o.status)), sections: header.sections, calls: state.calls, iterationCount: header.iterationCount, currentIteration: header.currentIteration, state },
  }]
  const representatives: Record<string, string> = {}
  for (const template of WORKFLOW_HEADER_TEMPLATE.nodes) representatives[headerTemplateNodeId(header.id, template.id)] = layout ? idFor(layout.representatives[template.id]!) : header.id
  if (!layout) return { nodes, edges: [], state, representatives, internalEdgeIds: WORKFLOW_HEADER_TEMPLATE.edges.map((e) => `${header.id}:edge:${e.id}`) }
  for (const item of layout.items) {
    const parent = layout.items.find((p) => p.id === item.parent)
    const common = { id: idFor(item.id), parentNode: parent ? idFor(parent.id) : header.id, position: { x: item.x - (parent?.x ?? 0), y: item.y - (parent?.y ?? 0) }, width: item.width, height: item.height, draggable: false, connectable: false, selectable: false, focusable: false }
    if (item.kind === 'group') {
      const ownActive = active.has(item.id), descendantActive = [...active].some((id) => layerAncestors(id).includes(item.id))
      const slot = WORKFLOW_HEADER_TEMPLATE.nodes.filter((n) => layerAncestors(n.group).includes(item.id)).map((n) => state.slots[n.id]!).find((s) => ['running', 'waiting'].includes(s.status))
      nodes.push({ ...common, type: 'header-group', zIndex: -9 + layerAncestors(item.id).length,
        data: { kind: 'header-group', headerId: header.id, groupId: item.id, title: HEADER_LAYERS.find((g) => g.id === item.id)!.title, collapsed: !!item.collapsed, active: descendantActive, ownActive, summary: ownActive ? slot?.statusText ?? '正在处理' : descendantActive ? '内层执行中' : '展开查看步骤', ports: layout.ports[item.id] ?? [] } })
      continue
    }
    if (item.kind === 'calls') { nodes.push({ ...common, type: 'header-calls', data: { kind: 'header-calls', headerId: header.id, state } }); continue }
    const template = WORKFLOW_HEADER_TEMPLATE.nodes.find((n) => n.id === item.id)!, slot = state.slots[item.id]!
    const liveTurn = template.id === 'model' && ['running', 'waiting'].includes(slot.status)
      ? input.activeTurns?.filter((turn) => (turn.chatId ?? header.chatId) === header.chatId && !['completed', 'error'].includes(turn.status ?? '') && (!state.scope.runId || turn.runId === state.scope.runId)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).at(-1) : undefined
    const call = state.calls.find((c) => c.id === state.selectedCallId)
    const summary = template.group === 'tools' && call ? call.name : template.group === 'retry-layer' ? `第 ${state.scope.attempt ?? 1} 次尝试` : slot.occurrence ? `第 ${slot.occurrence.iteration ?? 1} 轮` : template.match === 'unobserved' ? '结构说明' : state.coverage
    nodes.push({ ...common, type: 'header-step', data: { kind: 'header-step', headerId: header.id, chatId: header.chatId, template, slot, visual: headerVisual(template), iteration: slot.occurrence?.iteration ?? 1, iterationCount: header.iterationCount, liveTurn, scope: state.scope, recorded: input.recorded, complete: input.complete, ports: layout.ports[item.id] ?? [], summary } })
  }
  const edges: WorkflowGraphEdge[] = layout.edges.map((edge) => {
    const members = edge.memberIds.map((id) => {
      const relation = WORKFLOW_HEADER_TEMPLATE.edges.find((e) => e.id === id)!, source = state.slots[relation.source]?.occurrence, target = state.slots[relation.target]?.occurrence
      return { id: `${header.id}:edge:${id}`, label: relation.label ?? `${WORKFLOW_HEADER_TEMPLATE.nodes.find((n) => n.id === relation.source)!.title} → ${WORKFLOW_HEADER_TEMPLATE.nodes.find((n) => n.id === relation.target)!.title}`, sourceOccurrenceId: source?.occurrenceId, targetOccurrenceId: target?.occurrenceId, targetStatus: target?.status, targetSequence: target?.lastSequence, evidenced: !!source && !!target && target.causeOccurrenceId === source.occurrenceId && source.orderQuality === 'exact' && target.orderQuality === 'exact' }
    })
    const evidence = members.filter((m) => m.evidenced).sort((a, b) => (a.targetSequence ?? 0) - (b.targetSequence ?? 0)).at(-1)
    return { id: `${header.id}:edge:${edge.id}`, source: idFor(edge.source), target: idFor(edge.target), sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle, type: 'header-flow', markerEnd: MarkerType.ArrowClosed, selectable: false, focusable: false, class: 'workflow-edge relation-template', data: {
      collector: edge.collector, junction: edge.junction, labelAnchor: edge.labelAnchor, semantic: 'template', relation: edge.role, relationLabel: edge.label, members, ...evidence, evidenced: !!evidence,
      points: edge.points.map((p) => ({ x: p.x + input.position.x, y: p.y + input.position.y })), labelPoint: edge.labelPoint ? { x: edge.labelPoint.x + input.position.x, y: edge.labelPoint.y + input.position.y } : undefined,
    } }
  })
  return { nodes, edges, state, representatives, internalEdgeIds: layout.internalEdgeIds.map((id) => `${header.id}:edge:${id}`) }
}
export function absoluteGraphPosition(node: Node<WorkflowGraphNodeData>, nodes: Node<WorkflowGraphNodeData>[]): HeaderPoint {
  const parent = node.parentNode ? nodes.find((item) => item.id === node.parentNode) : undefined
  const origin = parent ? absoluteGraphPosition(parent, nodes) : { x: 0, y: 0 }
  return { x: origin.x + node.position.x, y: origin.y + node.position.y }
}
