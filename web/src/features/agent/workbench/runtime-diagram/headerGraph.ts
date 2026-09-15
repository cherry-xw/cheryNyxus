import { MarkerType, type Node } from '@vue-flow/core'
import type { ActiveTurnSnapshot } from '@/application/backend/public'
import type { HeaderLaneProjection } from './workflowProjection'
import {
  WORKFLOW_HEADER_TEMPLATE,
  HEADER_LAYERS,
  HEADER_NODE_SIZE,
  type HeaderTemplateNode,
  type HeaderPoint,
  type HeaderNodePort,
} from './headerTemplate'
import { layoutHeader, layerAncestors, type HeaderRect, type HeaderTerminal } from './headerLayout'
import {
  projectHeaderState,
  type HeaderStateProjection,
  type HeaderScopeSelection,
  type HeaderSlotState,
} from './headerState'
import type { WorkflowGraphNodeData, WorkflowGraphEdge, WorkflowGraphNode } from './graphModel'
import { headerVisual, type WorkflowVisualIdentity } from './workflowVisuals'
import { projectHeaderEdgeEvidence } from './headerEdgeEvidence'

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
export type HeaderGroupToggleEvent = { headerId: string; groupId: string }
export interface HeaderViewOptions {
  live?: boolean
  liveRuns?: readonly { chatId?: string; runId: string }[]
  boards?: Readonly<Record<string, string>>
  expanded?: Readonly<Record<string, readonly string[]>>
  follow?: boolean
  overrides?: Readonly<Record<string, boolean>>
}
export type HeaderTerminalEvent = { headerId: string; terminal: HeaderTerminal }
export type HeaderChildData =
  | { kind: 'header-terminal'; headerId: string; terminal: HeaderTerminal; ports: HeaderNodePort[] }
  | {
      kind: 'header-group'
      headerId: string
      groupId: string
      title: string
      collapsed: boolean
      active: boolean
      ownActive: boolean
      summary: string
      status: string
      ports: HeaderNodePort[]
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
      participated?: boolean
      call?: HeaderStateProjection['calls'][number]
      iteration: number
      iterationCount: number
      ports: HeaderNodePort[]
    }
export type HeaderBounds = HeaderRect
export { rectOverlaps as boundsOverlap } from './headerLayout'
export function placeHeader(
  bounds: HeaderBounds,
  obstacles: HeaderBounds[],
  gap: number,
): HeaderBounds {
  let result = { ...bounds }
  for (;;) {
    const collisions = obstacles.filter(
      (obstacle) =>
        result.x < obstacle.x + obstacle.width + gap &&
        result.x + result.width + gap > obstacle.x &&
        result.y < obstacle.y + obstacle.height + gap &&
        result.y + result.height + gap > obstacle.y,
    )
    if (!collisions.length) return result
    result = { ...result, x: Math.max(...collisions.map((item) => item.x + item.width + gap)) }
  }
}
export function headerTemplateNodeId(headerId: string, nodeId: string): string {
  return `${headerId}:template:${nodeId}`
}
export function buildHeaderNodes(input: {
  header: HeaderLaneProjection
  position: HeaderPoint
  selection?: HeaderScopeSelection
  currentRunId?: string
  recorded: boolean
  complete: boolean
  activeTurns?: readonly ActiveTurnSnapshot[]
  view?: HeaderViewOptions
}): {
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  state: HeaderStateProjection
  liveTurn?: ActiveTurnSnapshot
  representatives: Record<string, string>
  internalEdgeIds: string[]
} {
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
  const wholeCollapsed = input.view?.overrides?.[`${header.id}:header`] === true
  const full = header.mode === 'full' && !wholeCollapsed
  const liveTurn =
    input.view?.live !== false && !state.selection.unassignedRun
      ? input.activeTurns
          ?.filter(
            (turn) =>
              (turn.chatId ?? header.chatId) === header.chatId &&
              (!turn.status || turn.status === 'running') &&
              (!state.scope.runId || turn.runId === state.scope.runId) &&
              (state.selection.iteration === undefined ||
                state.selection.iteration === header.currentIteration) &&
              (state.selection.attempt === undefined ||
                state.selection.attempt === state.attempts.at(-1)),
          )
          .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
          .at(-1)
      : undefined
  const active = new Set(
    WORKFLOW_HEADER_TEMPLATE.nodes
      .filter((n) => ['running', 'waiting'].includes(state.slots[n.id]?.status ?? ''))
      .map((n) => n.group),
  )
  if (liveTurn) active.add('model-layer')
  const expanded = input.view?.follow
    ? HEADER_LAYERS.map((layer) => layer.id)
    : (input.view?.expanded?.[header.id] ?? input.view?.boards?.[header.id] ?? [])
  const layout = full ? layoutHeader(expanded) : undefined

  const idFor = (id: string) =>
    HEADER_LAYERS.some((g) => g.id === id)
      ? `${header.id}:group:${id}`
      : headerTemplateNodeId(header.id, id)
  const nodes: WorkflowGraphNode[] = [
    {
      id: header.id,
      type: 'header',
      position: input.position,
      width: layout?.width ?? HEADER_NODE_SIZE.width,
      height: layout?.height ?? HEADER_NODE_SIZE.height,
      draggable: false,
      connectable: false,
      selectable: false,
      focusable: false,
      zIndex: -10,
      data: {
        kind: 'header',
        chatId: header.chatId,
        title: header.title,
        mode: full ? 'full' : 'compact',
        expandable: header.mode === 'full',
        collapsed: wholeCollapsed,
        boardId: layout?.boardId ?? 'overview',
        templateVersion: header.templateVersion,
        runStatus: header.runStatus,
        active: state.occurrences.filter((o) => ['running', 'waiting'].includes(o.status)),
        sections: header.sections,
        calls: state.calls,
        iterationCount: header.iterationCount,
        currentIteration: header.currentIteration,
        state,
      },
    },
  ]
  const representatives: Record<string, string> = {}
  for (const template of WORKFLOW_HEADER_TEMPLATE.nodes)
    representatives[headerTemplateNodeId(header.id, template.id)] = layout?.representatives[
      template.id
    ]
      ? idFor(layout.representatives[template.id]!)
      : header.id
  for (const layer of HEADER_LAYERS) {
    const visible = layerAncestors(layer.id).find((id) =>
      layout?.items.some((item) => item.id === id),
    )
    representatives[idFor(layer.id)] = visible ? idFor(visible) : header.id
  }
  if (!layout)
    return {
      nodes,
      edges: [],
      state,
      liveTurn,
      representatives,
      internalEdgeIds: WORKFLOW_HEADER_TEMPLATE.edges.map((e) => `${header.id}:edge:${e.id}`),
    }
  for (const item of layout.items) {
    const parent = layout.items.find((p) => p.id === item.parent)
    const common = {
      id: idFor(item.id),
      parentNode: parent ? idFor(parent.id) : header.id,
      position: { x: item.x - (parent?.x ?? 0), y: item.y - (parent?.y ?? 0) },
      width: item.width,
      height: item.height,
      draggable: false,
      connectable: false,
      selectable: false,
      focusable: false,
    }
    if (item.kind === 'terminal') {
      nodes.push({
        ...common,
        type: 'header-terminal',
        data: {
          kind: 'header-terminal',
          headerId: header.id,
          terminal: item.terminal!,
          ports: layout.ports[item.id] ?? [],
        },
      })
      continue
    }
    if (item.kind === 'group') {
      const ownActive = active.has(item.id),
        descendantActive = [...active].some((id) => layerAncestors(id).includes(item.id))
      const slot = WORKFLOW_HEADER_TEMPLATE.nodes
        .filter((n) => layerAncestors(n.group).includes(item.id))
        .map((n) => state.slots[n.id]!)
        .filter(Boolean)
        .sort(
          (a, b) =>
            Number(['running', 'waiting'].includes(b.status)) -
            Number(['running', 'waiting'].includes(a.status)),
        )
        .find((s) => ['running', 'waiting', 'failed', 'rejected'].includes(s.status))
      nodes.push({
        ...common,
        type: 'header-group',
        zIndex: -9 + layerAncestors(item.id).length,
        data: {
          kind: 'header-group',
          headerId: header.id,
          groupId: item.id,
          title: HEADER_LAYERS.find((g) => g.id === item.id)!.title,
          collapsed: !!item.collapsed,
          active: descendantActive,
          ownActive,
          summary: slot ? `内部${slot.statusText}` : '已封装 · 进入查看内部',
          status:
            slot?.status ??
            (state.occurrences.some(
              (o) =>
                o.status === 'succeeded' &&
                WORKFLOW_HEADER_TEMPLATE.nodes.some(
                  (n) =>
                    layerAncestors(n.group).includes(item.id) &&
                    state.slots[n.id]?.occurrence?.occurrenceId === o.occurrenceId,
                ),
            )
              ? 'succeeded'
              : 'idle'),
          ports: layout.ports[item.id] ?? [],
        },
      })
      continue
    }
    const template = WORKFLOW_HEADER_TEMPLATE.nodes.find((n) => n.id === item.id)!,
      slot = state.slots[item.id]!
    // 实时输出同时点亮“模型请求”与“大模型响应”：liveTurn 只表示正在返回数据的模型 turn，
    // 不伪造已提交的 occurrence；提交后由响应 occurrence 承接 succeeded 状态。
    const liveStepTurn =
      template.id === 'model' || template.id === 'response' ? liveTurn : undefined
    nodes.push({
      ...common,
      type: 'header-step',
      data: {
        kind: 'header-step',
        headerId: header.id,
        chatId: header.chatId,
        template,
        slot,
        visual: headerVisual(template),
        iteration: slot.occurrence?.iteration ?? 1,
        iterationCount: header.iterationCount,
        liveTurn: liveStepTurn,
        call:
          template.group === 'tools' && slot.occurrence?.callId
            ? state.calls.find((call) => call.id === slot.occurrence?.callId)
            : undefined,
        scope: state.scope,
        recorded: input.recorded,
        complete: input.complete,
        ports: layout.ports[item.id] ?? [],
      },
    })
  }
  const edgeEvidence = projectHeaderEdgeEvidence(
    state,
    header.steps.map((step) => step.occurrence),
  )
  const visited = new Set([...edgeEvidence.keys()].flatMap((id) => {
    const edge = WORKFLOW_HEADER_TEMPLATE.edges.find((item) => item.id === id)!
    return [edge.source, edge.target]
  }))
  for (const node of nodes) {
    if (node.data?.kind === 'header-step')
      node.data.participated = !!node.data.slot.occurrence || visited.has(node.data.template.id)
  }
  const edges: WorkflowGraphEdge[] = layout.edges.map((edge) => {
    const members = edge.memberIds.map((id) => {
      const relation = WORKFLOW_HEADER_TEMPLATE.edges.find((e) => e.id === id)!
      return {
        id: `${header.id}:edge:${id}`,
        label:
          relation.label ??
          `${WORKFLOW_HEADER_TEMPLATE.nodes.find((n) => n.id === relation.source)!.title} → ${WORKFLOW_HEADER_TEMPLATE.nodes.find((n) => n.id === relation.target)!.title}`,
        ...edgeEvidence.get(id),
        evidenced: edgeEvidence.has(id),
      }
    })
    const evidence = members
      .filter((m) => m.evidenced)
      .sort((a, b) => (a.targetSequence ?? 0) - (b.targetSequence ?? 0))
      .at(-1)
    return {
      id: `${header.id}:edge:${edge.id}`,
      source: idFor(edge.source),
      target: idFor(edge.target),
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: 'header-flow',
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: evidence ? 'var(--accent)' : 'var(--workflow-edge-idle)',
      },
      selectable: false,
      focusable: false,
      class: 'workflow-edge relation-template',
      data: {
        collector: edge.collector,
        junction: edge.junction,
        labelAnchor: edge.labelAnchor,
        semantic: 'template',
        relation: edge.role,
        relationLabel: edge.label,
        members,
        ...evidence,
        evidenced: !!evidence,
        points: edge.points.map((p) => ({ x: p.x + input.position.x, y: p.y + input.position.y })),
        labelPoint: edge.labelPoint
          ? { x: edge.labelPoint.x + input.position.x, y: edge.labelPoint.y + input.position.y }
          : undefined,
      },
    }
  })
  return {
    nodes,
    edges,
    state,
    liveTurn,
    representatives,
    internalEdgeIds: [...layout.internalEdgeIds, ...layout.externalEdgeIds].map(
      (id) => `${header.id}:edge:${id}`,
    ),
  }
}
export function absoluteGraphPosition(
  node: Node<WorkflowGraphNodeData>,
  nodes: Node<WorkflowGraphNodeData>[],
): HeaderPoint {
  const parent = node.parentNode ? nodes.find((item) => item.id === node.parentNode) : undefined
  const origin = parent ? absoluteGraphPosition(parent, nodes) : { x: 0, y: 0 }
  return { x: origin.x + node.position.x, y: origin.y + node.position.y }
}
