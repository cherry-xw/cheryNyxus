import { getSoulDb } from './index.js'

export interface PersistedExecutionNode extends Record<string, unknown> {
  id: string
  rootChatId: string
  sourceChatId: string
  sourceMessageId?: string
  kind: string
  orderKey: number
  createdAt: number
  updatedAt: number
}

export interface PersistedExecutionEdge extends Record<string, unknown> {
  id: string
  rootChatId: string
  fromNodeId: string
  toNodeId: string
  kind: string
  orderKey: number
}

export interface ToolCallOwnerRow {
  callId: string
  rootChatId: string
  owningNodeId?: string
  batchId?: string
  index?: number
  resolution: 'owned' | 'unknown'
  detail?: string
}

export interface ExecutionActiveRunRow {
  rootChatId: string
  chatId: string
  runId: string
  status: 'running' | 'waiting' | 'paused' | 'completed' | 'failed'
  turnId?: string
  nodeId?: string
  batchId?: string
  epochId?: string
}

type ExecutionNodeInput = Pick<
  PersistedExecutionNode,
  'id' | 'rootChatId' | 'sourceChatId' | 'sourceMessageId' | 'kind' | 'createdAt' | 'updatedAt'
> &
  Record<string, unknown> & { orderKey?: number }

type ExecutionEdgeInput = Pick<
  PersistedExecutionEdge,
  'id' | 'rootChatId' | 'fromNodeId' | 'toNodeId' | 'kind'
> &
  Record<string, unknown> & { orderKey?: number }

function allocateOrderKey(rootChatId: string): number {
  const db = getSoulDb()
  db.prepare(
    'INSERT INTO execution_graph_counters (root_chat_id, next_order_key) VALUES (?, 1) ON CONFLICT(root_chat_id) DO NOTHING',
  ).run(rootChatId)
  const row = db
    .prepare('SELECT next_order_key FROM execution_graph_counters WHERE root_chat_id = ?')
    .get(rootChatId) as { next_order_key: number }
  db.prepare(
    'UPDATE execution_graph_counters SET next_order_key = next_order_key + 1 WHERE root_chat_id = ?',
  ).run(rootChatId)
  return row.next_order_key
}

export function upsertExecutionNode(input: ExecutionNodeInput): PersistedExecutionNode {
  const db = getSoulDb()
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT order_key, payload_json FROM execution_nodes WHERE node_id = ?')
      .get(input.id) as { order_key: number; payload_json: string } | undefined
    const orderKey = existing?.order_key ?? input.orderKey ?? allocateOrderKey(input.rootChatId)
    const previous = existing
      ? (JSON.parse(existing.payload_json) as PersistedExecutionNode)
      : undefined
    // Regenerated message projection updates canonical fields while retaining
    // lifecycle annotations (termination/run/turn) written independently.
    const node = { ...previous, ...input, orderKey } as PersistedExecutionNode
    db.prepare(
      `INSERT INTO execution_nodes
        (node_id, root_chat_id, source_chat_id, source_message_id, kind, order_key, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET
         source_chat_id=excluded.source_chat_id,
         source_message_id=excluded.source_message_id,
         kind=excluded.kind,
         payload_json=excluded.payload_json,
         updated_at=excluded.updated_at`,
    ).run(
      node.id,
      node.rootChatId,
      node.sourceChatId,
      node.sourceMessageId ?? null,
      node.kind,
      orderKey,
      JSON.stringify(node),
      node.createdAt,
      node.updatedAt,
    )
    return node
  })()
}

export function upsertExecutionEdge(input: ExecutionEdgeInput): PersistedExecutionEdge {
  const db = getSoulDb()
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT order_key FROM execution_edges WHERE edge_id = ?')
      .get(input.id) as { order_key: number } | undefined
    const orderKey = existing?.order_key ?? input.orderKey ?? allocateOrderKey(input.rootChatId)
    const edge = { ...input, orderKey } as PersistedExecutionEdge
    db.prepare(
      `INSERT INTO execution_edges
        (edge_id, root_chat_id, from_node_id, to_node_id, kind, order_key, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(edge_id) DO UPDATE SET
         from_node_id=excluded.from_node_id,
         to_node_id=excluded.to_node_id,
         kind=excluded.kind,
         payload_json=excluded.payload_json,
         updated_at=excluded.updated_at`,
    ).run(
      edge.id,
      edge.rootChatId,
      edge.fromNodeId,
      edge.toNodeId,
      edge.kind,
      orderKey,
      JSON.stringify(edge),
      Date.now(),
      Date.now(),
    )
    return edge
  })()
}

export function listExecutionNodes(rootChatId: string): PersistedExecutionNode[] {
  const rows = getSoulDb()
    .prepare(
      'SELECT payload_json FROM execution_nodes WHERE root_chat_id = ? ORDER BY order_key ASC',
    )
    .all(rootChatId) as { payload_json: string }[]
  return rows.map((row) => JSON.parse(row.payload_json) as PersistedExecutionNode)
}

export function listExecutionEdges(rootChatId: string): PersistedExecutionEdge[] {
  const rows = getSoulDb()
    .prepare(
      'SELECT payload_json FROM execution_edges WHERE root_chat_id = ? ORDER BY order_key ASC',
    )
    .all(rootChatId) as { payload_json: string }[]
  return rows.map((row) => JSON.parse(row.payload_json) as PersistedExecutionEdge)
}

export function upsertToolCallOwner(owner: ToolCallOwnerRow): void {
  getSoulDb()
    .prepare(
      `INSERT INTO tool_call_owners
        (call_id, root_chat_id, owning_node_id, batch_id, call_index, resolution, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(call_id) DO UPDATE SET
         root_chat_id=excluded.root_chat_id,
         owning_node_id=excluded.owning_node_id,
         batch_id=excluded.batch_id,
         call_index=excluded.call_index,
         resolution=excluded.resolution,
         detail=excluded.detail,
         updated_at=excluded.updated_at`,
    )
    .run(
      owner.callId,
      owner.rootChatId,
      owner.owningNodeId ?? null,
      owner.batchId ?? null,
      owner.index ?? null,
      owner.resolution,
      owner.detail ?? null,
      Date.now(),
    )
}

export function getToolCallOwner(callId: string): ToolCallOwnerRow | undefined {
  const row = getSoulDb()
    .prepare('SELECT * FROM tool_call_owners WHERE call_id = ?')
    .get(callId) as Record<string, unknown> | undefined
  if (!row) return undefined
  return {
    callId: String(row.call_id),
    rootChatId: String(row.root_chat_id),
    ...(row.owning_node_id ? { owningNodeId: String(row.owning_node_id) } : {}),
    ...(row.batch_id ? { batchId: String(row.batch_id) } : {}),
    ...(typeof row.call_index === 'number' ? { index: row.call_index } : {}),
    resolution: row.resolution === 'owned' ? 'owned' : 'unknown',
    ...(row.detail ? { detail: String(row.detail) } : {}),
  }
}

export function annotateExecutionNode(
  nodeId: string,
  patch: Record<string, unknown>,
): PersistedExecutionNode | undefined {
  const db = getSoulDb()
  const row = db
    .prepare('SELECT payload_json FROM execution_nodes WHERE node_id = ?')
    .get(nodeId) as { payload_json: string } | undefined
  if (!row) return undefined
  const current = JSON.parse(row.payload_json) as PersistedExecutionNode
  return upsertExecutionNode({ ...current, ...patch, orderKey: current.orderKey })
}

export function removeExecutionEdge(edgeId: string): boolean {
  return (
    getSoulDb().prepare('DELETE FROM execution_edges WHERE edge_id = ?').run(edgeId).changes > 0
  )
}

export function upsertExecutionActiveRun(run: ExecutionActiveRunRow): void {
  getSoulDb()
    .prepare(
      `INSERT INTO execution_active_runs
        (chat_id, run_id, root_chat_id, status, turn_id, node_id, batch_id, epoch_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, run_id) DO UPDATE SET
         root_chat_id=excluded.root_chat_id,
         status=CASE
           WHEN execution_active_runs.status IN ('paused', 'completed', 'failed')
             THEN execution_active_runs.status
           ELSE excluded.status
         END,
         turn_id=COALESCE(excluded.turn_id, execution_active_runs.turn_id),
         node_id=COALESCE(excluded.node_id, execution_active_runs.node_id),
         batch_id=COALESCE(excluded.batch_id, execution_active_runs.batch_id),
         epoch_id=COALESCE(excluded.epoch_id, execution_active_runs.epoch_id),
         updated_at=excluded.updated_at`,
    )
    .run(
      run.chatId,
      run.runId,
      run.rootChatId,
      run.status,
      run.turnId ?? null,
      run.nodeId ?? null,
      run.batchId ?? null,
      run.epochId ?? null,
      Date.now(),
    )
}

export function getExecutionActiveRun(
  chatId: string,
  runId: string,
): ExecutionActiveRunRow | undefined {
  const row = getSoulDb()
    .prepare('SELECT * FROM execution_active_runs WHERE chat_id = ? AND run_id = ?')
    .get(chatId, runId) as Record<string, unknown> | undefined
  return row ? activeRunFromRow(row) : undefined
}

/** Latest durable run per chat, including paused/completed/failed recovery state. */
export function listLatestExecutionRuns(rootChatId: string): ExecutionActiveRunRow[] {
  const rows = getSoulDb()
    .prepare(
      'SELECT * FROM execution_active_runs WHERE root_chat_id = ? ORDER BY updated_at DESC, chat_id ASC',
    )
    .all(rootChatId) as Record<string, unknown>[]
  const seen = new Set<string>()
  const latest: ExecutionActiveRunRow[] = []
  for (const row of rows) {
    const run = activeRunFromRow(row)
    if (seen.has(run.chatId)) continue
    seen.add(run.chatId)
    latest.push(run)
  }
  return latest
}

/** Latest durable run per chat across every root, used once during process recovery. */
export function listLatestExecutionRunsAcrossRoots(): ExecutionActiveRunRow[] {
  const rows = getSoulDb()
    .prepare(
      'SELECT * FROM execution_active_runs ORDER BY updated_at DESC, chat_id ASC, rowid DESC',
    )
    .all() as Record<string, unknown>[]
  const seen = new Set<string>()
  const latest: ExecutionActiveRunRow[] = []
  for (const row of rows) {
    const run = activeRunFromRow(row)
    if (seen.has(run.chatId)) continue
    seen.add(run.chatId)
    latest.push(run)
  }
  return latest
}

function activeRunFromRow(row: Record<string, unknown>): ExecutionActiveRunRow {
  return {
    rootChatId: String(row.root_chat_id),
    chatId: String(row.chat_id),
    runId: String(row.run_id),
    status: String(row.status) as ExecutionActiveRunRow['status'],
    ...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
    ...(row.node_id ? { nodeId: String(row.node_id) } : {}),
    ...(row.batch_id ? { batchId: String(row.batch_id) } : {}),
    ...(row.epoch_id ? { epochId: String(row.epoch_id) } : {}),
  }
}
