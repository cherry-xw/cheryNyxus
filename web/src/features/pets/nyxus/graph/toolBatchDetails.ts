import type { GraphToolCall, TerminationFact, TimelineActor } from '@/services/agentApi'
import type { SenseCallRecord } from '@/stores/agents'
import type { ExecutionNode } from './executionGraph'

export type ToolBatchVisualStatus = 'active' | 'pending' | 'completed' | 'error' | 'rejected'

export interface ToolBatchDetail {
  batchId: string
  calls: ToolBatchCallDetail[]
  status: ToolBatchVisualStatus
  spawn: boolean
  batchCount: number
  terminations: Array<{ batchId: string; code: TerminationFact['code']; detail?: string }>
}

export interface ToolBatchCallDetail extends GraphToolCall {
  batchId: string
  batchOrderKey: number
}

export interface AnchoredPopoverPosition {
  left: number
  top: number
  placement: 'left' | 'right'
}

export function oppositePopoverPlacement(placement: 'left' | 'right'): 'left' | 'right' {
  return placement === 'left' ? 'right' : 'left'
}

const SPAWN_TOOL_NAMES = new Set(['spawn_role', 'spawn_agent'])

export function orderedToolCalls(calls: readonly GraphToolCall[] = []): GraphToolCall[] {
  return calls.slice().sort((a, b) => a.index - b.index || a.callId.localeCompare(b.callId))
}

export function toolBatchVisualStatus(calls: readonly GraphToolCall[]): ToolBatchVisualStatus {
  if (calls.some((call) => call.status === 'error')) return 'error'
  if (calls.some((call) => call.status === 'rejected')) return 'rejected'
  if (calls.some((call) => call.status === 'accepted')) return 'active'
  if (calls.some((call) => call.status === 'pending')) return 'pending'
  return 'completed'
}

export function isSpawnCall(call: GraphToolCall): boolean {
  return SPAWN_TOOL_NAMES.has(call.name) || typeof call.childChatId === 'string'
}

export function toolBatchDetail(node: ExecutionNode): ToolBatchDetail | undefined {
  if (node.kind === 'fold' && node.fold) {
    const children = node.fold.members
      .map((member) => member.displayNode)
      .sort(
        (a, b) =>
          (a.orderKey ?? Number.MAX_SAFE_INTEGER) - (b.orderKey ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id),
      )
    const calls = children.flatMap((child) =>
      orderedToolCalls(child.sourceFact?.toolCalls).map((call) => ({
        ...call,
        batchId: child.sourceFact?.batchId ?? child.id,
        batchOrderKey: child.orderKey ?? Number.MAX_SAFE_INTEGER,
      })),
    )
    const statuses = children.map((child) => toolBatchDetail(child)?.status ?? 'completed')
    return {
      batchId: node.id,
      calls,
      status: statuses.includes('active')
        ? 'active'
        : statuses.includes('pending')
          ? 'pending'
          : statuses.includes('error')
            ? 'error'
            : statuses.includes('rejected')
              ? 'rejected'
              : 'completed',
      spawn: false,
      batchCount: children.length,
      terminations: children.flatMap((child) => {
        const termination = child.sourceFact?.termination
        return termination
          ? [
              {
                batchId: child.sourceFact?.batchId ?? child.id,
                code: termination.code,
                ...(termination.detail ? { detail: termination.detail } : {}),
              },
            ]
          : []
      }),
    }
  }
  if (node.kind !== 'tool-batch' || !node.sourceFact) return undefined
  const batchId = node.sourceFact.batchId ?? node.id
  const calls = orderedToolCalls(node.sourceFact.toolCalls).map((call) => ({
    ...call,
    batchId,
    batchOrderKey: node.orderKey ?? Number.MAX_SAFE_INTEGER,
  }))
  return {
    batchId,
    calls,
    status:
      node.activeRuns.some((run) => run.status === 'running') &&
      toolBatchVisualStatus(calls) === 'pending'
        ? 'active'
        : toolBatchVisualStatus(calls),
    spawn: calls.some(isSpawnCall),
    batchCount: 1,
    terminations: node.sourceFact.termination
      ? [
          {
            batchId,
            code: node.sourceFact.termination.code,
            ...(node.sourceFact.termination.detail
              ? { detail: node.sourceFact.termination.detail }
              : {}),
          },
        ]
      : [],
  }
}

export function toolBatchUsesTabs(calls: readonly GraphToolCall[]): boolean {
  return calls.length >= 2
}

export function selectedToolCall<T extends GraphToolCall>(
  calls: readonly T[],
  selectedCallId?: string,
): T | undefined {
  return (
    calls.find((call) => call.callId === selectedCallId) ??
    calls.find((call) => call.status === 'pending' || call.status === 'accepted') ??
    calls[0]
  )
}

export function graphToolCallToSenseCall(call: GraphToolCall): SenseCallRecord {
  return {
    id: call.callId,
    name: call.name,
    args: call.arguments,
    ...(call.result === undefined ? {} : { result: call.result }),
    status:
      call.status === 'completed'
        ? 'done'
        : call.status === 'rejected' || call.status === 'error'
          ? 'error'
          : 'running',
  }
}

export function actorDetail(actor: TimelineActor | undefined): string {
  if (!actor) return '未知'
  if (actor.kind === 'user') return actor.displayName?.trim() || '用户'
  if (actor.kind === 'agent') return actor.roleType?.trim() || actor.chatId
  if (actor.kind === 'tool') return actor.toolName
  return '系统'
}

/** Position a node detail beside its icon while reserving the piano strip at the viewport bottom. */
export function anchoredPopoverPosition(input: {
  anchor: { x: number; y: number }
  viewport: { width: number; height: number }
  panel: { width: number; height: number }
  gap?: number
  margin?: number
  reservedBottom?: number
}): AnchoredPopoverPosition {
  const gap = input.gap ?? 24
  const margin = input.margin ?? 10
  const usableBottom = Math.max(
    margin,
    input.viewport.height - (input.reservedBottom ?? 0) - margin,
  )
  const fitsRight = input.anchor.x + gap + input.panel.width <= input.viewport.width - margin
  const placement = fitsRight ? 'right' : 'left'
  const idealLeft =
    placement === 'right' ? input.anchor.x + gap : input.anchor.x - gap - input.panel.width
  const maxLeft = Math.max(margin, input.viewport.width - margin - input.panel.width)
  const maxTop = Math.max(margin, usableBottom - input.panel.height)
  return {
    left: Math.min(maxLeft, Math.max(margin, idealLeft)),
    top: Math.min(maxTop, Math.max(margin, input.anchor.y - 44)),
    placement,
  }
}
