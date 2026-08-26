import type { ActiveRunFact, ActiveTurnSnapshot, RunSnapshot } from '@/application/backend/public'
import type { ChatSession } from '@/application/chat/public'
import type { ExecutionNode } from './executionGraph'

export type RunCrtStatus = ActiveRunFact['status']

export interface RunCrtModel {
  /** Stable for patches and unique to one live response node. */
  id: string
  runId: string
  chatId: string
  turnId: string
  messageId: string
  anchorNodeId: string
  canonicalNodeId: string
  title: string
  status: RunCrtStatus
  main: boolean
  content: string
  thinking: string
  updatedAt: number
  actionable: boolean
}

export interface BuildRunCrtModelsInput {
  rootChatId: string
  runs: readonly ActiveRunFact[]
  /** Canonical snapshot facts can tombstone a stale transient run at render time. */
  authoritativeRuns?: readonly ActiveRunFact[]
  /** Root session plane. Optional only for compatibility with isolated model callers. */
  activeTurns?: readonly ActiveTurnSnapshot[]
  canonicalNodes: readonly ExecutionNode[]
  visibleNodes: readonly ExecutionNode[]
  sessionsById: Readonly<Record<string, ChatSession>>
}

const ACTIVE_CRT_STATUSES = new Set<ActiveRunFact['status']>(['running', 'waiting', 'paused'])

function runStatus(run: RunSnapshot): ActiveRunFact['status'] | undefined {
  const status = run.status ?? run.state
  return ACTIVE_CRT_STATUSES.has(status as ActiveRunFact['status'])
    ? (status as ActiveRunFact['status'])
    : undefined
}

function runKey(chatId: string, runId: string): string {
  return `${chatId}:${runId}`
}

/**
 * The root session plane is authoritative for live runs. Active turns fill the
 * child-agent window where turn.started arrives before run.updated. Durable
 * paused facts remain available while stale terminal facts cannot resurrect CRTs.
 */
export function effectiveRunFacts(
  rootChatId: string,
  snapshotRuns: readonly ActiveRunFact[],
  transientRuns?: readonly RunSnapshot[],
  activeTurns: readonly ActiveTurnSnapshot[] = [],
): ActiveRunFact[] {
  const eligibleSnapshot = snapshotRuns.filter((run) => ACTIVE_CRT_STATUSES.has(run.status))
  const terminalSnapshotRuns = new Set(
    snapshotRuns
      .filter(
        (run) => run.status === 'paused' || run.status === 'completed' || run.status === 'failed',
      )
      .map((run) => runKey(run.chatId, run.runId)),
  )
  if (!transientRuns && activeTurns.length === 0) return eligibleSnapshot
  const transientChatIds = new Set(
    (transientRuns ?? []).map((run) => run.chatId).filter((chatId): chatId is string => !!chatId),
  )
  const retainedSnapshot = transientRuns
    ? eligibleSnapshot.filter(
        (run) => run.status === 'paused' && !transientChatIds.has(run.chatId),
      )
    : eligibleSnapshot
  const byRun = new Map(
    retainedSnapshot.map((run) => [runKey(run.chatId, run.runId), run]),
  )
  for (const run of transientRuns ?? []) {
    if (!run.chatId) continue
    const status = runStatus(run)
    if (!status) continue
    const key = runKey(run.chatId, run.runId)
    if (terminalSnapshotRuns.has(key)) continue
    const durable = eligibleSnapshot.find(
      (candidate) => candidate.chatId === run.chatId && candidate.runId === run.runId,
    )
    byRun.set(key, {
      ...(durable ?? {}),
      rootChatId,
      chatId: run.chatId,
      runId: run.runId,
      status,
    })
  }
  for (const turn of activeTurns) {
    if (
      !turn.chatId ||
      !turn.runId ||
      turn.status === 'completed' ||
      turn.status === 'error'
    )
      continue
    const key = runKey(turn.chatId, turn.runId)
    if (terminalSnapshotRuns.has(key)) continue
    if (byRun.has(key)) continue
    byRun.set(key, {
      rootChatId,
      chatId: turn.chatId,
      runId: turn.runId,
      status: turn.status === 'paused' ? 'paused' : 'running',
      turnId: turn.turnId,
      nodeId: turn.messageId,
    })
  }
  return [...byRun.values()].sort(
    (a, b) => a.chatId.localeCompare(b.chatId) || a.runId.localeCompare(b.runId),
  )
}

function orderOf(node: ExecutionNode): number {
  return node.orderKey ?? Number.NEGATIVE_INFINITY
}

function explicitAnchor(
  run: ActiveRunFact,
  nodes: readonly ExecutionNode[],
): ExecutionNode | undefined {
  const explicitIds = [run.batchId, run.nodeId].filter((id): id is string => !!id)
  for (const id of explicitIds) {
    const exact = nodes.find((node) => node.id === id || node.sourceFact?.batchId === id)
    if (exact) return exact
  }
  return undefined
}

function latestChatAnchor(
  run: ActiveRunFact,
  nodes: readonly ExecutionNode[],
): ExecutionNode | undefined {
  return nodes
    .filter((node) => node.sourceChatId === run.chatId && node.kind !== 'start')
    .sort((a, b) => orderOf(b) - orderOf(a) || b.id.localeCompare(a.id))[0]
}

/** Maps a canonical node into the current Fold projection without leaving stale anchors. */
export function visibleCrtAnchorId(
  canonicalNodeId: string,
  visibleNodes: readonly ExecutionNode[],
): string | undefined {
  const exact = visibleNodes.find((node) => node.id === canonicalNodeId)
  if (exact) return exact.id
  return visibleNodes.find((node) =>
    node.fold?.projectionNodes.some((member) => member.id === canonicalNodeId),
  )?.id
}

function labelFor(node: ExecutionNode, session: ChatSession | undefined): string {
  return session?.meta.agentType?.trim() || session?.meta.preset?.trim() || 'Agent'
}

/**
 * Projects canonical runtime facts into one CRT per active response node. Rebuilding
 * after every patch updates that node's keyed Vue card instead of reusing a run card.
 */
export function buildRunCrtModels(input: BuildRunCrtModelsInput): RunCrtModel[] {
  const models = new Map<string, RunCrtModel>()
  const terminalAuthoritativeRuns = new Set(
    (input.authoritativeRuns ?? [])
      .filter(
        (run) => run.status === 'paused' || run.status === 'completed' || run.status === 'failed',
      )
      .map((run) => runKey(run.chatId, run.runId)),
  )
  const runs = new Map(input.runs.map((run) => [runKey(run.chatId, run.runId), run]))
  for (const turn of input.activeTurns ?? []) {
    if (
      !turn.chatId ||
      !turn.runId ||
      turn.status === 'completed' ||
      turn.status === 'error'
    )
      continue
    const key = runKey(turn.chatId, turn.runId)
    if (runs.has(key)) continue
    runs.set(key, {
      rootChatId: input.rootChatId,
      chatId: turn.chatId,
      runId: turn.runId,
      status: turn.status === 'paused' ? 'paused' : 'running',
      turnId: turn.turnId,
      nodeId: turn.messageId,
    })
  }
  for (const run of runs.values()) {
    // CRTs are live output monitors, so they must disappear as soon as the
    // authoritative run leaves the running state. Waiting/paused facts remain
    // useful to the execution graph, but should not keep a monitor on screen.
    if (run.status !== 'running') continue
    if (terminalAuthoritativeRuns.has(runKey(run.chatId, run.runId))) continue
    const session = input.sessionsById[run.chatId]
    const turns = (input.activeTurns ?? session?.activeTurns ?? [])
      .filter(
        (candidate) =>
          (!candidate.chatId || candidate.chatId === run.chatId) &&
          (!candidate.runId || candidate.runId === run.runId) &&
          candidate.status !== 'completed' &&
          candidate.status !== 'error',
      )
      .sort(
        (a, b) =>
          (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.messageId.localeCompare(b.messageId),
      )
    for (const turn of turns) {
      // turn.started normally creates an exact transient node immediately. The
      // fallback only covers the accepted-input interval during hydration.
      const explicit = explicitAnchor(run, input.canonicalNodes)
      const canonical =
        input.visibleNodes.find((node) => node.id === turn.messageId) ??
        input.canonicalNodes.find(
          (node) => node.id === turn.messageId || node.sourceFact?.sourceMessageId === turn.messageId,
        ) ??
        (explicit?.kind === 'message' || explicit?.kind === 'input' ? explicit : undefined) ??
        latestChatAnchor(run, input.canonicalNodes) ??
        latestChatAnchor(run, input.visibleNodes)
      if (!canonical || canonical.status === 'revoked') continue
      const anchorNodeId = visibleCrtAnchorId(canonical.id, input.visibleNodes)
      if (!anchorNodeId) continue
      const message = session?.messagesById[turn.messageId]
      const id = `crt:${run.chatId}:${run.runId}:${turn.messageId}`
      models.set(id, {
        id,
        runId: run.runId,
        chatId: run.chatId,
        turnId: turn.turnId,
        messageId: turn.messageId,
        anchorNodeId,
        canonicalNodeId: canonical.id,
        title: labelFor(canonical, session),
        status: run.status,
        main: run.chatId === input.rootChatId,
        content: turn.content ?? message?.content ?? canonical.content ?? '',
        thinking: turn.thinking ?? message?.thinking ?? canonical.sourceFact?.thinking ?? '',
        updatedAt: Math.max(
          canonical.sourceFact?.updatedAt ?? 0,
          message?.updatedAt ?? 0,
          turn.createdAt ?? 0,
        ),
        actionable: false,
      })
    }
  }
  return [...models.values()].sort(
    (a, b) =>
      Number(b.actionable) - Number(a.actionable) ||
      a.updatedAt - b.updatedAt ||
      a.id.localeCompare(b.id),
  )
}
