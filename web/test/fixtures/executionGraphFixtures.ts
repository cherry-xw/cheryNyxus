import type {
  ExecutionEdgeFact,
  GraphToolCall,
  PendingInput,
  RootTimelineSnapshot,
  TerminationFact,
  TimelineNode,
} from '../../src/services/agentApi'

function node(
  rootChatId: string,
  id: string,
  orderKey: number,
  sourceChatId = rootChatId,
  patch: Partial<TimelineNode> = {},
): TimelineNode {
  return {
    id,
    rootChatId,
    sourceChatId,
    sourceMessageId: id,
    kind: 'message',
    actor: { kind: 'agent', chatId: sourceChatId },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: id,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
    ...patch,
  }
}

function edge(
  rootChatId: string,
  id: string,
  orderKey: number,
  fromNodeId: string,
  toNodeId: string,
  kind: ExecutionEdgeFact['kind'],
  patch: Partial<ExecutionEdgeFact> = {},
): ExecutionEdgeFact {
  return {
    id,
    rootChatId,
    fromNodeId,
    toNodeId,
    kind,
    orderKey,
    sourceChatId: rootChatId,
    targetChatId: rootChatId,
    ...patch,
  }
}

function snapshot(
  rootChatId: string,
  nodes: TimelineNode[],
  edges: ExecutionEdgeFact[] = [],
): RootTimelineSnapshot {
  return {
    rootChatId,
    view: 'tree',
    revision: 1,
    capturedEventSeq: 1,
    nodes,
    edges,
    activeRuns: [],
    pendingInputs: [],
    generations: [],
  }
}

export function topologyMatrixSnapshot(): RootTimelineSnapshot {
  const rootChatId = 'root'
  const nodes = [
    node(rootChatId, 'root-spawn-batch', 1, rootChatId, {
      kind: 'tool-batch',
      direction: 'internal',
      visibility: 'detail',
      batchId: 'root-spawn-batch',
      toolCalls: [
        {
          callId: 'spawn-a',
          index: 0,
          name: 'spawn_role',
          arguments: '{}',
          status: 'completed',
          childChatId: 'child-a',
        },
        {
          callId: 'spawn-b',
          index: 1,
          name: 'spawn_role',
          arguments: '{}',
          status: 'completed',
          childChatId: 'child-b',
        },
      ],
    }),
    node(rootChatId, 'child-a-start', 2, 'child-a'),
    node(rootChatId, 'child-b-start', 3, 'child-b'),
    node(rootChatId, 'root-continue', 4),
    node(rootChatId, 'child-a-spawn-batch', 5, 'child-a', {
      kind: 'tool-batch',
      direction: 'internal',
      visibility: 'detail',
      batchId: 'child-a-spawn-batch',
      toolCalls: [
        {
          callId: 'spawn-grandchild',
          index: 0,
          name: 'spawn_role',
          arguments: '{}',
          status: 'completed',
          childChatId: 'grandchild',
        },
      ],
    }),
    node(rootChatId, 'grandchild-start', 6, 'grandchild'),
    node(rootChatId, 'grandchild-output', 7, 'grandchild'),
    node(rootChatId, 'grandchild-return', 8, 'grandchild', {
      kind: 'return',
      actor: { kind: 'agent', chatId: 'grandchild' },
      target: { kind: 'agent', chatId: 'child-a' },
      direction: 'child-to-parent',
    }),
    node(rootChatId, 'child-a-continue', 9, 'child-a'),
    node(rootChatId, 'child-a-return', 10, 'child-a', {
      kind: 'return',
      actor: { kind: 'agent', chatId: 'child-a' },
      target: { kind: 'agent', chatId: rootChatId },
      direction: 'child-to-parent',
    }),
    node(rootChatId, 'root-after-return', 11),
    node(rootChatId, 'root-dispatch', 12, rootChatId, {
      kind: 'dispatch',
      target: { kind: 'agent', chatId: 'child-b' },
      direction: 'parent-to-child',
      visibility: 'internal',
    }),
    node(rootChatId, 'child-b-next', 13, 'child-b'),
    node(rootChatId, 'child-b-terminated', 14, 'child-b', {
      status: 'revoked',
      termination: { actor: 'system', code: 'system_stop', at: 14 },
    }),
  ]
  const edges = [
    edge(rootChatId, 'edge-spawn-a', 101, 'root-spawn-batch', 'child-a-start', 'spawn', {
      targetChatId: 'child-a',
      callId: 'spawn-a',
    }),
    edge(rootChatId, 'edge-spawn-b', 102, 'root-spawn-batch', 'child-b-start', 'spawn', {
      targetChatId: 'child-b',
      callId: 'spawn-b',
    }),
    edge(rootChatId, 'edge-root-continue', 103, 'root-spawn-batch', 'root-continue', 'continue'),
    edge(rootChatId, 'edge-child-a-sequence', 104, 'child-a-start', 'child-a-spawn-batch', 'sequence', {
      sourceChatId: 'child-a',
      targetChatId: 'child-a',
    }),
    edge(rootChatId, 'edge-grandchild-spawn', 105, 'child-a-spawn-batch', 'grandchild-start', 'spawn', {
      sourceChatId: 'child-a',
      targetChatId: 'grandchild',
      callId: 'spawn-grandchild',
    }),
    edge(rootChatId, 'edge-grandchild-sequence', 106, 'grandchild-start', 'grandchild-output', 'sequence', {
      sourceChatId: 'grandchild',
      targetChatId: 'grandchild',
    }),
    edge(rootChatId, 'edge-grandchild-return', 107, 'grandchild-output', 'grandchild-return', 'return', {
      sourceChatId: 'grandchild',
      targetChatId: 'child-a',
    }),
    edge(rootChatId, 'edge-grandchild-continuation', 108, 'grandchild-return', 'child-a-continue', 'return-continuation', {
      sourceChatId: 'grandchild',
      targetChatId: 'child-a',
    }),
    edge(rootChatId, 'edge-child-a-return', 109, 'child-a-continue', 'child-a-return', 'return', {
      sourceChatId: 'child-a',
    }),
    edge(rootChatId, 'edge-child-a-continuation', 110, 'child-a-return', 'root-after-return', 'return-continuation', {
      sourceChatId: 'child-a',
    }),
    edge(rootChatId, 'edge-root-sequence', 111, 'root-continue', 'root-after-return', 'sequence'),
    edge(rootChatId, 'edge-root-dispatch-sequence', 112, 'root-after-return', 'root-dispatch', 'sequence'),
    edge(rootChatId, 'edge-dispatch', 113, 'root-dispatch', 'child-b-next', 'dispatch', {
      targetChatId: 'child-b',
    }),
    edge(rootChatId, 'edge-child-b-sequence', 114, 'child-b-start', 'child-b-next', 'sequence', {
      sourceChatId: 'child-b',
      targetChatId: 'child-b',
    }),
    edge(rootChatId, 'edge-child-b-terminated', 115, 'child-b-next', 'child-b-terminated', 'sequence', {
      sourceChatId: 'child-b',
      targetChatId: 'child-b',
    }),
  ]
  const result = snapshot(rootChatId, nodes, edges)
  result.activeRuns = [
    {
      rootChatId,
      chatId: 'child-b',
      runId: 'run-child-b',
      status: 'paused',
      nodeId: 'child-b-terminated',
    },
  ]
  return result
}

export function legacyRelationSnapshot(): RootTimelineSnapshot {
  const rootChatId = 'legacy-root'
  return snapshot(rootChatId, [
    node(rootChatId, 'legacy-root-message', 1),
    node(rootChatId, 'legacy-child-message', 2, 'legacy-child', {
      kind: 'tool-group' as TimelineNode['kind'],
      parentNodeId: 'legacy-root-message',
      causationId: 'legacy-root-message',
    }),
  ])
}

export function foldLifecycleSnapshot(): RootTimelineSnapshot {
  const rootChatId = 'root-fold'
  const result = snapshot(rootChatId, [
    node(rootChatId, 'message:user-upstream', 1, rootChatId, {
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: rootChatId },
      direction: 'user-to-agent',
    }),
    node(rootChatId, 'batch:assistant-a', 2, rootChatId, {
      kind: 'tool-batch',
      direction: 'internal',
      visibility: 'detail',
      batchId: 'batch:assistant-a',
      toolCalls: [
        {
          callId: 'call:assistant-a',
          index: 0,
          name: 'read_file',
          arguments: '{}',
          result: 'done',
          status: 'completed',
        },
      ],
    }),
    node(rootChatId, 'batch:assistant-b', 3, rootChatId, {
      kind: 'tool-batch',
      direction: 'internal',
      visibility: 'detail',
      batchId: 'batch:assistant-b',
      toolCalls: [
        {
          callId: 'call:assistant-b',
          index: 0,
          name: 'write_file',
          arguments: '{}',
          status: 'accepted',
        },
      ],
    }),
  ])
  result.activeRuns = [
    {
      rootChatId,
      chatId: rootChatId,
      runId: 'run:assistant-b',
      batchId: 'batch:assistant-b',
      status: 'running',
    },
  ]
  return result
}

export function inputLifecycleFixture(): { pending: PendingInput; entity: TimelineNode } {
  const rootChatId = 'root-input'
  const messageId = 'message:input-1'
  return {
    pending: {
      chatId: rootChatId,
      inputId: 'input-1',
      messageId,
      content: 'continue',
      state: 'queued',
      queueSequence: 1,
      acceptedAt: 10,
    },
    entity: node(rootChatId, messageId, 11, rootChatId, {
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: rootChatId },
      direction: 'user-to-agent',
    }),
  }
}

export function invalidGraphSnapshot(): RootTimelineSnapshot {
  const rootChatId = 'root-invalid'
  return snapshot(
    rootChatId,
    [node(rootChatId, 'valid-node', 1)],
    [edge(rootChatId, 'edge-missing-target', 2, 'valid-node', 'missing-node', 'sequence')],
  )
}

export function terminationFacts(): TerminationFact[] {
  return [
    { actor: 'user', code: 'user_abort', at: 1, detail: 'audit only' },
    { actor: 'system', code: 'system_stop', at: 2, detail: 'audit only' },
    { actor: 'system', code: 'watchdog', at: 3, detail: 'audit only' },
    { actor: 'system', code: 'error', at: 4, detail: 'audit only' },
    { actor: 'agent', code: 'agent_redirect', at: 5, detail: 'audit only' },
    { actor: 'system', code: 'limit_reached', at: 6, detail: 'audit only' },
  ]
}

export function toolBatchLifecycleFixture(): {
  batchId: string
  streamStates: [GraphToolCall[], GraphToolCall[]]
} {
  const first: GraphToolCall = {
    callId: 'spawn-first',
    index: 0,
    name: 'spawn_role',
    arguments: '{}',
    status: 'accepted',
  }
  return {
    batchId: 'batch:streaming-spawn',
    streamStates: [
      [first],
      [
        { ...first, status: 'completed', childChatId: 'child-a' },
        {
          callId: 'spawn-second',
          index: 1,
          name: 'spawn_role',
          arguments: '{}',
          status: 'accepted',
        },
      ],
    ],
  }
}
