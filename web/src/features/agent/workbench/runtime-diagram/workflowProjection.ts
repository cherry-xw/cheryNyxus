import type { WorkflowOccurrence, WorkflowStepKind } from '@chery/protocol'
import type { RootTimelineSnapshot } from '@/application/backend/public'
import {
  projectNyxusFoldedGraph,
  resolveNyxusRenderedNode,
  type ExecutionNode,
  type NyxusContentSelection,
  type NyxusReaderFoldMode,
} from '@/features/pets/nyxus/public'
import type { WorkflowClientState } from './workflowState'
import type { HeaderCallSource } from './headerState'

export interface WorkflowHeaderSection {
  id: string
  label: string
  kinds: WorkflowStepKind[]
}

export const WORKFLOW_HEADER_TEMPLATE_VERSION = 2 as const

export const WORKFLOW_STEP_LABELS: Record<WorkflowStepKind, string> = {
  submission: '输入接收',
  queue: '输入排队',
  context: '上下文构建',
  command: '指令注入',
  input: '输入记录',
  request: '请求准备',
  model: '模型交互',
  retry: '近端重试',
  'tool-list': '调用清单',
  'tool-validation': '参数校验',
  'tool-authorization': '权限校验',
  'tool-approval': '条件审批',
  'tool-preflight': '执行前检查',
  'tool-execution': '工具执行',
  'tool-result': '工具结果',
  checkpoint: '结果记录',
  'loop-decision': 'Loop 判断',
  dispatch: '派发子任务',
  'child-run': '子任务运行',
  'child-return': '子任务回传',
  'parent-receive': '父分支接收',
  wake: '唤醒继续',
  'compact-request': '压缩请求',
  'compact-summary': '摘要生成',
  'compact-applied': '摘要采用',
  result: '本轮结束',
  unknown: '未知步骤',
}

export const WORKFLOW_HEADER_SECTIONS: WorkflowHeaderSection[] = [
  { id: 'intake', label: '本轮接入', kinds: ['submission', 'queue', 'command', 'input'] },
  { id: 'context', label: '上下文', kinds: ['context'] },
  { id: 'request', label: '请求准备', kinds: ['request'] },
  { id: 'model', label: '模型交互', kinds: ['model', 'retry'] },
  {
    id: 'tools',
    label: '工具处理',
    kinds: [
      'tool-list',
      'tool-validation',
      'tool-authorization',
      'tool-approval',
      'tool-preflight',
      'tool-execution',
      'tool-result',
    ],
  },
  { id: 'record', label: '记录', kinds: ['checkpoint'] },
  {
    id: 'control',
    label: 'Loop 与协作',
    kinds: ['loop-decision', 'dispatch', 'child-run', 'child-return', 'parent-receive', 'wake'],
  },
  {
    id: 'compact',
    label: '上下文压缩',
    kinds: ['compact-request', 'compact-summary', 'compact-applied'],
  },
  { id: 'result', label: '结果', kinds: ['result'] },
]

export interface ResultTreeNodeProjection {
  id: `content:${string}`
  laneId: string
  order: number
  column: number
  node: ExecutionNode
  title: string
  preview: string
}

export interface WorkflowProjectionEdge {
  id: string
  sourceId: string
  targetId: string
  relation: string
  semantic: 'fact' | 'template'
}

export interface ResultTreeProjection {
  nodes: ResultTreeNodeProjection[]
  edges: WorkflowProjectionEdge[]
  laneIds: string[]
}

export type WorkflowContentSelectionResolution =
  | {
      status: 'available'
      selection: NyxusContentSelection
      renderedNodeId: `content:${string}`
      callId?: string
    }
  | {
      status: 'unavailable'
      selection: NyxusContentSelection
      reason: 'missing-anchor' | 'chat-mismatch'
    }

export interface HeaderStepProjection {
  id: `header-step:${string}`
  occurrenceId: string
  laneId: string
  occurrence: WorkflowOccurrence
  statusText: string
  live: boolean
  /** 所属 loop 轮次（后端 WorkflowOccurrence.iteration，缺省按 1） */
  iteration: number
  /** 该 lane 全部 occurrence 涉及的 loop 轮次总数 */
  iterationCount: number
  contentTarget?: WorkflowContentSelectionResolution
}

export interface HeaderLaneProjection {
  id: `header:${string}`
  laneId: string
  chatId: string
  title: string
  mode: 'full' | 'compact'
  templateVersion: typeof WORKFLOW_HEADER_TEMPLATE_VERSION
  runStatus: string
  sections: WorkflowHeaderSection[]
  calls: Array<HeaderCallSource & { current: boolean }>
  steps: HeaderStepProjection[]
  /** 该 lane 累计的 loop 轮次总数 */
  iterationCount: number
  /** 当前正在执行/等待的轮次（无活跃则取最后一轮） */
  currentIteration: number
}

export interface HeaderFlowProjection {
  headers: HeaderLaneProjection[]
  activeHeaderId?: `header:${string}`
  activeStepId?: `header-step:${string}`
  edges: WorkflowProjectionEdge[]
}

export interface WorkflowSceneProjection {
  resultTree: ResultTreeProjection
  headerFlow: HeaderFlowProjection
  edges: WorkflowProjectionEdge[]
  selectionTargets: Record<
    string,
    Extract<WorkflowContentSelectionResolution, { status: 'available' }>
  >
}

export function workflowSelectionKey(selection: NyxusContentSelection): string {
  return JSON.stringify([selection.sourceChatId, selection.nodeId])
}

function contentTitle(node: ExecutionNode): string {
  if (node.kind === 'tool-batch') return '工具调用'
  if (node.kind === 'fold') return '过程组'
  if (node.kind === 'pack') return `第 ${node.pack?.generationIndex ?? ''} 代历史`.trim()
  if (node.kind === 'dispatch' || node.kind === 'spawn') return '派发子任务'
  if (node.kind === 'return') return '子任务返回'
  if (node.actor.kind === 'user') return '用户输入'
  if (node.actor.kind === 'agent') return node.actor.roleType || 'Agent 消息'
  if (node.actor.kind === 'tool') return node.actor.toolName
  return '系统记录'
}

function statusText(status: WorkflowOccurrence['status'], waitReason?: string): string {
  if (status === 'running') return '正在执行'
  if (status === 'waiting') {
    if (waitReason === 'approval') return '等待审批'
    if (waitReason === 'answer') return '等待回答'
    if (waitReason === 'child') return '等待子任务'
    if (waitReason === 'retry') return '等待重试'
    if (waitReason === 'model') return '等待模型'
    return '等待执行'
  }
  if (status === 'succeeded') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'rejected') return '已拒绝'
  if (status === 'cancelled') return '已取消'
  if (status === 'interrupted') return '已中断'
  return '记录不完整'
}

function nodeLane(
  chatId: string,
  branchId: string | undefined,
  branchByChat: ReadonlyMap<string, string>,
): string {
  return branchId ?? branchByChat.get(chatId) ?? `agent:${chatId}`
}

function orderedContext(
  workflow: WorkflowClientState | undefined,
  timeline: RootTimelineSnapshot | undefined,
) {
  const occurrences = Object.values(workflow?.occurrences ?? {}).sort(
    (left, right) =>
      left.firstSequence - right.firstSequence ||
      left.occurrenceId.localeCompare(right.occurrenceId),
  )
  const branches = [...(timeline?.branches ?? [])].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.branchId.localeCompare(right.branchId),
  )
  const branchByChat = new Map(branches.map((branch) => [branch.chatId, branch.branchId]))
  const rootChatId = timeline?.rootChatId ?? workflow?.rootChatId
  const laneIds = new Set<string>()
  for (const branch of branches) laneIds.add(branch.branchId)
  for (const run of timeline?.activeRuns ?? [])
    laneIds.add(nodeLane(run.chatId, branchByChat.get(run.chatId), branchByChat))
  if (!laneIds.size && rootChatId) laneIds.add(`agent:${rootChatId}`)
  const branchOrder = new Map(branches.map((branch, index) => [branch.branchId, index]))
  const orderedLaneIds = [...laneIds].sort(
    (left, right) =>
      (branchOrder.get(left) ?? 10_000) - (branchOrder.get(right) ?? 10_000) ||
      left.localeCompare(right),
  )
  return { occurrences, branches, branchByChat, rootChatId, laneIds: orderedLaneIds }
}

export function projectWorkflowScene(
  workflow: WorkflowClientState | undefined,
  timeline: RootTimelineSnapshot | undefined,
  foldMode: NyxusReaderFoldMode = 'none',
): WorkflowSceneProjection {
  const context = orderedContext(workflow, timeline)
  const contentGraph = projectNyxusFoldedGraph(timeline, foldMode, context.rootChatId)
  const contentNodes = contentGraph.nodes.filter((node) => node.kind !== 'start')
  const laneItems = new Map<string, ExecutionNode[]>()
  for (const node of contentNodes) {
    const laneId = nodeLane(node.sourceChatId, node.sourceFact?.branchId, context.branchByChat)
    const nodes = laneItems.get(laneId) ?? []
    nodes.push(node)
    laneItems.set(laneId, nodes)
    if (!context.laneIds.includes(laneId)) context.laneIds.push(laneId)
  }
  const branchOrder = new Map(context.branches.map((branch, index) => [branch.branchId, index]))
  context.laneIds.sort(
    (left, right) =>
      (branchOrder.get(left) ?? 10_000) - (branchOrder.get(right) ?? 10_000) ||
      left.localeCompare(right),
  )

  const resultNodes: ResultTreeNodeProjection[] = []
  for (const laneId of context.laneIds) {
    const nodes = (laneItems.get(laneId) ?? []).sort(
      (left, right) =>
        (left.orderKey ?? left.createdAt) - (right.orderKey ?? right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    nodes.forEach((node, order) =>
      resultNodes.push({
        id: `content:${node.id}`,
        laneId,
        order,
        column: order,
        node,
        title: contentTitle(node),
        preview: (node.content || node.thinking || '没有可显示的正文').slice(0, 96),
      }),
    )
  }
  const resultIds = new Set(resultNodes.map((node) => node.id))
  const resultEdges: WorkflowProjectionEdge[] = contentGraph.edges.flatMap((edge) => {
    const sourceId = `content:${edge.from}` as const
    const targetId = `content:${edge.to}` as const
    return resultIds.has(sourceId) && resultIds.has(targetId)
      ? [{ id: `timeline:${edge.id}`, sourceId, targetId, relation: edge.kind, semantic: 'fact' }]
      : []
  })
  const resultNodeById = new Map<string, ResultTreeNodeProjection>(
    resultNodes.map((node) => [node.id, node]),
  )
  const predecessors = new Map<string, string[]>()
  for (const edge of resultEdges) {
    const values = predecessors.get(edge.targetId) ?? []
    values.push(edge.sourceId)
    predecessors.set(edge.targetId, values)
  }
  const resolvedColumns = new Map<string, number>()
  const resolveColumn = (id: string, visiting = new Set<string>()): number => {
    const cached = resolvedColumns.get(id)
    if (cached !== undefined) return cached
    const node = resultNodeById.get(id)
    if (!node || visiting.has(id)) return node?.order ?? 0
    const nextVisiting = new Set(visiting).add(id)
    const column = Math.max(
      node.order,
      0,
      ...(predecessors.get(id) ?? []).map(
        (predecessorId) => resolveColumn(predecessorId, nextVisiting) + 1,
      ),
    )
    resolvedColumns.set(id, column)
    return column
  }
  for (const node of resultNodes) node.column = resolveColumn(node.id)
  const resultTree: ResultTreeProjection = {
    nodes: resultNodes,
    edges: resultEdges,
    laneIds: [...context.laneIds],
  }

  const selectionTargets: WorkflowSceneProjection['selectionTargets'] = {}
  const registerSelection = (
    selection: NyxusContentSelection,
    renderedNodeId: `content:${string}`,
    callId?: string,
  ) => {
    selectionTargets[workflowSelectionKey(selection)] = {
      status: 'available',
      selection,
      renderedNodeId,
      ...(callId ? { callId } : {}),
    }
  }
  for (const node of contentNodes)
    registerSelection({ nodeId: node.id, sourceChatId: node.sourceChatId }, `content:${node.id}`)
  for (const node of timeline?.nodes ?? []) {
    const selections: Array<{ selection: NyxusContentSelection; callId?: string }> = [
      { selection: { nodeId: node.id, sourceChatId: node.sourceChatId } },
      ...(node.sourceMessageId
        ? [{ selection: { nodeId: node.sourceMessageId, sourceChatId: node.sourceChatId } }]
        : []),
      ...(node.batchId
        ? [{ selection: { nodeId: node.batchId, sourceChatId: node.sourceChatId } }]
        : []),
      ...(node.toolCalls ?? []).map((call) => ({
        selection: { nodeId: call.callId, sourceChatId: node.sourceChatId },
        callId: call.callId,
      })),
    ]
    for (const candidate of selections) {
      const rendered = resolveNyxusRenderedNode(contentGraph, candidate.selection)?.node
      if (!rendered || rendered.kind === 'start') continue
      registerSelection(candidate.selection, `content:${rendered.id}`, candidate.callId)
    }
  }

  const resolveSelection = (
    selection: NyxusContentSelection,
  ): WorkflowContentSelectionResolution => {
    const exact = selectionTargets[workflowSelectionKey(selection)]
    if (exact) return exact
    const existsInAnotherChat = Object.values(selectionTargets).some(
      (candidate) => candidate.selection.nodeId === selection.nodeId,
    )
    return {
      status: 'unavailable',
      selection,
      reason: existsInAnotherChat ? 'chat-mismatch' : 'missing-anchor',
    }
  }

  const activeBranchId = context.branches.find(
    (branch) => branch.branchId === timeline?.activeBranchId && branch.kind !== 'detail',
  )?.branchId
  const toolsByLane = new Map<string, Map<string, HeaderCallSource>>()
  for (const node of timeline?.nodes ?? []) {
    const laneId = nodeLane(node.sourceChatId, node.branchId, context.branchByChat)
    const tools = toolsByLane.get(laneId) ?? new Map()
    for (const call of node.toolCalls ?? [])
      tools.set(call.callId, {
        id: call.callId,
        name: call.name,
        status: call.status,
        batchId: node.batchId,
        anchorIds: [node.id, ...(node.sourceMessageId ? [node.sourceMessageId] : [])],
      })
    toolsByLane.set(laneId, tools)
  }

  let activeHeaderId: HeaderFlowProjection['activeHeaderId']
  const activeOccurrence = context.occurrences
    .filter((occurrence) => occurrence.status === 'running' || occurrence.status === 'waiting')
    .sort(
      (left, right) =>
        left.lastSequence - right.lastSequence ||
        left.occurrenceId.localeCompare(right.occurrenceId),
    )
    .at(-1)
  const headerLaneIds = [...context.laneIds]
  for (const occurrence of context.occurrences) {
    const laneId = nodeLane(occurrence.chatId, occurrence.branchId, context.branchByChat)
    if (!headerLaneIds.includes(laneId)) headerLaneIds.push(laneId)
  }
  const headers = headerLaneIds.map((laneId): HeaderLaneProjection => {
    const branch = context.branches.find((candidate) => candidate.branchId === laneId)
    const laneContent = resultNodes.filter((node) => node.laneId === laneId)
    const laneOccurrences = context.occurrences.filter(
      (occurrence) =>
        nodeLane(occurrence.chatId, occurrence.branchId, context.branchByChat) === laneId,
    )
    const iterations = [...new Set(laneOccurrences.map((item) => item.iteration ?? 1))].sort(
      (a, b) => a - b,
    )
    const iterationCount = iterations.length
    const activeIteration = laneOccurrences
      .filter(
        (occurrence) => occurrence.status === 'running' || occurrence.status === 'waiting',
      )
      .at(-1)?.iteration
    const currentIteration = activeIteration ?? iterations.at(-1) ?? 1
    const chatId =
      branch?.chatId ??
      laneOccurrences[0]?.chatId ??
      laneContent[0]?.node.sourceChatId ??
      context.rootChatId ??
      laneId.replace(/^agent:/, '')
    const full = branch
      ? branch.branchId === activeBranchId && branch.kind !== 'detail'
      : !timeline?.taskId && !context.branches.length && chatId === context.rootChatId
    const id = `header:${laneId}` as const
    if (full) activeHeaderId = id
    const active = laneOccurrences.filter(
      (occurrence) => occurrence.status === 'running' || occurrence.status === 'waiting',
    )
    const currentCallId = active.findLast((occurrence) => occurrence.callId)?.callId
    const tools = toolsByLane.get(laneId) ?? new Map()
    return {
      id,
      laneId,
      chatId,
      title:
        branch?.title ||
        (branch
          ? branch.kind === 'detail'
            ? '解释分支'
            : branch.kind === 'original'
              ? '主 Agent'
              : '继续分支'
          : chatId === context.rootChatId
            ? '主 Agent'
            : '子 Agent'),
      mode: full ? 'full' : 'compact',
      templateVersion: WORKFLOW_HEADER_TEMPLATE_VERSION,
      runStatus:
        timeline?.activeRuns.find((run) => run.chatId === chatId)?.status ??
        (active.length ? 'running' : 'idle'),
      sections: WORKFLOW_HEADER_SECTIONS,
      calls: [...tools.values()].map((call) => ({ ...call, current: call.id === currentCallId })),
      iterationCount,
      currentIteration,
      steps: laneOccurrences.map((occurrence) => {
        const contentTargets = occurrence.anchors.map((anchor) =>
          resolveSelection({
            nodeId: anchor.id,
            sourceChatId: anchor.chatId ?? occurrence.chatId,
          }),
        )
        const contentTarget =
          contentTargets.find((target) => target.status === 'available') ?? contentTargets[0]
        return {
          id: `header-step:${occurrence.occurrenceId}`,
          occurrenceId: occurrence.occurrenceId,
          laneId,
          occurrence,
          statusText: statusText(occurrence.status, occurrence.waitReason),
          live: occurrence.status === 'running' || occurrence.status === 'waiting',
          iteration: occurrence.iteration ?? 1,
          iterationCount,
          ...(contentTarget ? { contentTarget } : {}),
        }
      }),
    }
  })
  const headerFlow: HeaderFlowProjection = {
    headers,
    activeHeaderId,
    ...(activeOccurrence
      ? { activeStepId: `header-step:${activeOccurrence.occurrenceId}` as const }
      : {}),
    edges: [],
  }
  const attachmentEdges = headers.flatMap((header): WorkflowProjectionEdge[] => {
    const last = resultNodes.filter((node) => node.laneId === header.laneId).at(-1)
    return last
      ? [
          {
            id: `head:${header.laneId}`,
            sourceId: last.id,
            targetId: header.id,
            relation: '当前头部',
            semantic: 'template',
          },
        ]
      : []
  })
  return {
    resultTree,
    headerFlow,
    edges: [...resultEdges, ...headerFlow.edges, ...attachmentEdges],
    selectionTargets,
  }
}

export function resolveWorkflowSceneSelection(
  scene: WorkflowSceneProjection,
  selection: NyxusContentSelection,
): WorkflowContentSelectionResolution {
  const exact = scene.selectionTargets[workflowSelectionKey(selection)]
  if (exact) return exact
  const existsInAnotherChat = Object.values(scene.selectionTargets).some(
    (candidate) => candidate.selection.nodeId === selection.nodeId,
  )
  return {
    status: 'unavailable',
    selection,
    reason: existsInAnotherChat ? 'chat-mismatch' : 'missing-anchor',
  }
}
