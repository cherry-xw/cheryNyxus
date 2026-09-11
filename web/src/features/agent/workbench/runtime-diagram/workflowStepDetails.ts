import type {
  WorkflowContentAnchor,
  WorkflowGap,
  WorkflowHistoryResponse,
  WorkflowOccurrence,
} from '@chery/protocol'
import type { RootTimelineSnapshot, TimelineNode } from '@/application/backend/public'
import type { NyxusContentSelection } from '@/features/pets/nyxus/public'
import type { HeaderSelection } from './headerGraph'
import { headerStatusText, projectHeaderState } from './headerState'
import type { WorkflowClientState } from './workflowState'

export type StepAnchorResolution =
  | { status: 'available'; selection: NyxusContentSelection; graphNodeId: string }
  | {
      status: 'unavailable'
      selection: NyxusContentSelection
      reason: 'missing-anchor' | 'chat-mismatch'
    }

export interface WorkflowStepDetailAnchor {
  key: string
  label: string
  selection: NyxusContentSelection
  available: boolean
  graphNodeId?: string
  unavailableReason?: string
}

export interface WorkflowStepDetailInstance {
  id: string
  label: string
  status: string
  statusText: string
  scopeText: string
  anchors: WorkflowStepDetailAnchor[]
}

export interface WorkflowStepDetailModel {
  title: string
  detail: string
  coverage: string
  scopeText: string
  instances: WorkflowStepDetailInstance[]
  gapCount: number
  legacy: boolean
}

const anchorLabels: Record<WorkflowContentAnchor['kind'], string> = {
  message: '查看消息内容',
  'tool-call': '查看工具调用',
  branch: '查看分支内容',
  compaction: '查看打包内容',
  'execution-node': '查看执行结果',
}

function scopeText(occurrence: WorkflowOccurrence): string {
  return [
    occurrence.iteration !== undefined ? `第 ${occurrence.iteration + 1} 轮` : undefined,
    occurrence.attempt !== undefined ? `尝试 ${occurrence.attempt + 1}` : undefined,
    occurrence.callId ? '工具调用' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

function relevantGaps(gaps: readonly WorkflowGap[], selection: HeaderSelection): WorkflowGap[] {
  return gaps.filter(
    (gap) =>
      (!gap.chatId || gap.chatId === selection.chatId) &&
      (!gap.runId || !selection.scope.runId || gap.runId === selection.scope.runId),
  )
}

export function projectWorkflowStepDetails(input: {
  selection: HeaderSelection
  history?: WorkflowHistoryResponse
  resolveAnchor: (selection: NyxusContentSelection) => StepAnchorResolution
}): WorkflowStepDetailModel {
  const { selection, history } = input
  const recorded = history ? history.occurrences !== undefined : selection.recorded
  const complete = history ? history.historyComplete : selection.complete
  const occurrences = history?.occurrences ?? selection.slot.occurrences
  const projected = projectHeaderState({
    chatId: selection.chatId,
    occurrences,
    calls: [],
    selection: selection.scope,
    currentRunId: selection.scope.runId,
    recorded,
    complete,
  })
  const slot = projected.slots[selection.templateNodeId] ?? selection.slot
  const instances = slot.occurrences.map((occurrence): WorkflowStepDetailInstance => ({
    id: occurrence.occurrenceId,
    label: occurrence.label,
    status: occurrence.status,
    statusText:
      occurrence.orderQuality === 'exact'
        ? headerStatusText(occurrence.status, occurrence.waitReason)
        : '记录不完整',
    scopeText: scopeText(occurrence),
    anchors: occurrence.anchors.map((anchor, index) => {
      const target = { nodeId: anchor.id, sourceChatId: anchor.chatId ?? occurrence.chatId }
      const resolution = input.resolveAnchor(target)
      return {
        key: `${occurrence.occurrenceId}:${anchor.kind}:${anchor.id}:${index}`,
        label: anchorLabels[anchor.kind],
        selection: target,
        available: resolution.status === 'available',
        ...(resolution.status === 'available'
          ? { graphNodeId: resolution.graphNodeId }
          : {
              unavailableReason:
                resolution.reason === 'chat-mismatch'
                  ? '关联内容属于其他会话，无法在当前范围打开'
                  : '关联内容尚未同步到当前时间线',
            }),
      }
    }),
  }))
  const gaps = relevantGaps(history?.gaps ?? [], selection)
  const selectedScope = [
    selection.scope.unassignedRun ? '未归属运行' : selection.scope.runId ? '所选运行' : '当前运行',
    selection.scope.iteration !== undefined ? `第 ${selection.scope.iteration + 1} 轮` : undefined,
    selection.scope.attempt !== undefined ? `尝试 ${selection.scope.attempt + 1}` : undefined,
    selection.scope.callId ? '所选工具调用' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    title: selection.title,
    detail: selection.detail,
    coverage: projected.coverage,
    scopeText: selectedScope,
    instances,
    gapCount: gaps.length,
    legacy: !!history && history.occurrences === undefined,
  }
}

function nodeMatchesAnchor(node: TimelineNode, anchor: WorkflowContentAnchor): boolean {
  const sourceChatId = anchor.chatId ?? node.sourceChatId
  if (node.sourceChatId !== sourceChatId) return false
  return (
    node.id === anchor.id ||
    node.sourceMessageId === anchor.id ||
    node.batchId === anchor.id ||
    node.toolCalls?.some((call) => call.callId === anchor.id) === true
  )
}

/** Uses only explicit workflow anchors to cut a frozen canonical timeline to a replay frame. */
export function projectReplayTimeline(
  timeline: RootTimelineSnapshot | undefined,
  workflow: WorkflowClientState | undefined,
): RootTimelineSnapshot | undefined {
  if (!timeline || !workflow) return timeline
  if (!workflow.historyComplete || workflow.gaps.length) return timeline
  const anchors = Object.values(workflow.occurrences).flatMap((occurrence) => occurrence.anchors)
  const matched = timeline.nodes.filter((node) =>
    anchors.some((anchor) => nodeMatchesAnchor(node, anchor)),
  )
  const upperOrder = matched.length ? Math.max(...matched.map((node) => node.orderKey)) : -1
  const nodes = timeline.nodes.filter((node) => node.orderKey <= upperOrder)
  const nodeIds = new Set(nodes.map((node) => node.id))
  const chatIds = new Set(nodes.map((node) => node.sourceChatId))
  return {
    ...timeline,
    nodes,
    edges: timeline.edges.filter(
      (edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId),
    ),
    branches: timeline.branches?.filter(
      (branch) => branch.chatId === timeline.rootChatId || chatIds.has(branch.chatId),
    ),
    activeRuns: [],
    pendingInputs: [],
  }
}
