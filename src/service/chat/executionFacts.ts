import { bumpTimelineRevision, getChat, getRootChatId } from '@/db/chat.js'
import {
  annotateExecutionNode,
  getExecutionActiveRun,
  listExecutionNodes,
  upsertExecutionActiveRun,
  upsertExecutionEdge,
  upsertExecutionNode,
} from '@/db/executionGraph.js'
import type { TerminationFact, TimelineActor, TimelineNode } from '../message/types.js'

export function recordRunFact(input: {
  chatId: string
  runId: string
  status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed'
  turnId?: string
  nodeId?: string
  batchId?: string
}): void {
  // streamMapper is also used as a protocol-only unit in tests; durable facts
  // are meaningful only after the owning chat has been created.
  if (!getChat(input.chatId)) return
  upsertExecutionActiveRun({ rootChatId: getRootChatId(input.chatId), ...input })
}

export function recordTerminationFact(input: {
  chatId: string
  runId: string
  actor: TerminationFact['actor']
  code: TerminationFact['code']
  detail?: string
  controlOperationId?: string
}): TimelineNode {
  const rootChatId = getRootChatId(input.chatId)
  const active = getExecutionActiveRun(input.chatId, input.runId)
  const termination: TerminationFact = {
    actor: input.actor,
    code: input.code,
    at: Date.now(),
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.controlOperationId ? { controlOperationId: input.controlOperationId } : {}),
  }
  const annotated = active?.nodeId
    ? annotateExecutionNode(active.nodeId, { termination })
    : undefined
  const node =
    annotated ??
    upsertExecutionNode(
      active?.nodeId
        ? {
            id: active.nodeId,
            rootChatId,
            sourceChatId: input.chatId,
            sourceMessageId: active.nodeId,
            kind: 'message',
            actor: { kind: 'agent', chatId: input.chatId } satisfies TimelineActor,
            direction: 'agent-to-user',
            visibility: 'conversation',
            content: '',
            runId: input.runId,
            ...(active.turnId ? { turnId: active.turnId } : {}),
            termination,
            createdAt: termination.at,
            updatedAt: termination.at,
            status: 'committed',
          }
        : {
            id: `termination:${input.runId}:${input.code}`,
            rootChatId,
            sourceChatId: input.chatId,
            kind: 'system',
            actor: { kind: 'system' } satisfies TimelineActor,
            direction: 'internal',
            visibility: 'internal',
            content: '',
            runId: input.runId,
            ...(active?.turnId ? { turnId: active.turnId } : {}),
            termination,
            createdAt: termination.at,
            updatedAt: termination.at,
            status: 'committed',
          },
    )
  upsertExecutionActiveRun({
    rootChatId,
    chatId: input.chatId,
    runId: input.runId,
    status: input.code === 'error' ? 'failed' : 'paused',
    ...(active?.turnId ? { turnId: active.turnId } : {}),
    nodeId: node.id,
    ...(active?.batchId ? { batchId: active.batchId } : {}),
  })
  bumpTimelineRevision(input.chatId)
  return node as unknown as TimelineNode
}

/** CP2 internal entry point; user-facing redispatch commands are deferred to CP8. */
export function recordDispatchFact(input: {
  rootChatId: string
  parentChatId: string
  targetChatId: string
  commandId: string
  targetNodeId: string
  content: string
  actor: TimelineActor
  target: TimelineActor
  createdAt?: number
}): TimelineNode {
  const at = input.createdAt ?? Date.now()
  const node = upsertExecutionNode({
    id: `dispatch:${input.commandId}`,
    rootChatId: input.rootChatId,
    sourceChatId: input.parentChatId,
    kind: 'dispatch',
    actor: input.actor,
    target: input.target,
    direction: 'parent-to-child',
    visibility: 'conversation',
    content: input.content,
    targetChatId: input.targetChatId,
    createdAt: at,
    updatedAt: at,
    status: 'committed',
  })
  upsertExecutionEdge({
    id: `edge:dispatch:${node.id}:${input.targetNodeId}`,
    rootChatId: input.rootChatId,
    fromNodeId: node.id,
    toNodeId: input.targetNodeId,
    kind: 'dispatch',
    sourceChatId: input.parentChatId,
    targetChatId: input.targetChatId,
  })
  bumpTimelineRevision(input.parentChatId)
  return node as unknown as TimelineNode
}

/** Persist the child-side anchor even when tool-call ownership has not resolved yet. */
export function recordSpawnTargetFact(input: {
  rootChatId: string
  parentChatId: string
  childChatId: string
  taskId: string
  callId?: string
  content: string
}): TimelineNode {
  const id = `spawn-target:${input.taskId}`
  const existing = (listExecutionNodes(input.rootChatId) as unknown as TimelineNode[]).find(
    (node) => node.id === id,
  )
  const at = existing?.createdAt ?? Date.now()
  const node = upsertExecutionNode({
    id,
    rootChatId: input.rootChatId,
    sourceChatId: input.childChatId,
    kind: 'dispatch',
    actor: { kind: 'agent', chatId: input.parentChatId },
    target: { kind: 'agent', chatId: input.childChatId },
    direction: 'parent-to-child',
    visibility: 'internal',
    content: input.content,
    targetChatId: input.childChatId,
    taskId: input.taskId,
    ...(input.callId ? { callId: input.callId } : {}),
    createdAt: at,
    updatedAt: Date.now(),
    status: 'committed',
  })
  bumpTimelineRevision(input.parentChatId)
  return node as unknown as TimelineNode
}

/** Attach a previously durable spawn target after the owning batch is known. */
export function recordSpawnEdgeFact(input: {
  rootChatId: string
  parentChatId: string
  childChatId: string
  taskId: string
  callId: string
  batchId: string
}): void {
  const targetNodeId = `spawn-target:${input.taskId}`
  upsertExecutionEdge({
    id: `edge:spawn:${input.batchId}:${targetNodeId}`,
    rootChatId: input.rootChatId,
    fromNodeId: input.batchId,
    toNodeId: targetNodeId,
    kind: 'spawn',
    sourceChatId: input.parentChatId,
    targetChatId: input.childChatId,
    callId: input.callId,
  })
  bumpTimelineRevision(input.parentChatId)
}

/** Stable task terminal used when a spawned child ends before producing output. */
export function recordSpawnTerminationFact(input: {
  rootChatId: string
  parentChatId: string
  childChatId: string
  taskId: string
  runId?: string
  code: TerminationFact['code']
  detail?: string
  predecessorNodeId?: string
}): TimelineNode {
  const id = `termination:spawn-task:${input.taskId}:${input.code}`
  const existingNodes = listExecutionNodes(input.rootChatId) as unknown as TimelineNode[]
  const existing = existingNodes.find((node) => node.id === id)
  const at = existing?.createdAt ?? Date.now()
  const termination: TerminationFact = existing?.termination ?? {
    actor: 'system',
    code: input.code,
    at,
    ...(input.detail ? { detail: input.detail } : {}),
  }
  const node = upsertExecutionNode({
    id,
    rootChatId: input.rootChatId,
    sourceChatId: input.childChatId,
    kind: 'system',
    actor: { kind: 'system' } satisfies TimelineActor,
    target: { kind: 'agent', chatId: input.parentChatId },
    direction: 'internal',
    visibility: 'internal',
    content: '',
    taskId: input.taskId,
    termination,
    createdAt: at,
    updatedAt: existing?.updatedAt ?? at,
    status: 'committed',
  }) as unknown as TimelineNode
  if (input.runId) {
    const active = getExecutionActiveRun(input.childChatId, input.runId)
    upsertExecutionActiveRun({
      rootChatId: input.rootChatId,
      chatId: input.childChatId,
      runId: input.runId,
      status: input.code === 'error' ? 'failed' : 'paused',
      ...(active?.turnId ? { turnId: active.turnId } : {}),
      nodeId: node.id,
      ...(active?.batchId ? { batchId: active.batchId } : {}),
    })
  }
  const predecessor = input.predecessorNodeId
    ? existingNodes.find((candidate) => candidate.id === input.predecessorNodeId)
    : existingNodes
        .filter(
          (candidate) =>
            candidate.sourceChatId === input.childChatId &&
            candidate.id !== id &&
            candidate.kind !== 'return',
        )
        .at(-1)
  if (predecessor) {
    upsertExecutionEdge({
      id: `edge:lifecycle-sequence:${predecessor.id}:${id}`,
      rootChatId: input.rootChatId,
      fromNodeId: predecessor.id,
      toNodeId: id,
      kind: 'sequence',
      sourceChatId: input.childChatId,
      targetChatId: input.childChatId,
    })
  }
  bumpTimelineRevision(input.childChatId)
  return node
}
