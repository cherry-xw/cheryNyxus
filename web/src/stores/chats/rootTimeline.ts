import type {
  ActiveTurnSnapshot,
  PendingInput,
  RootTimelinePatch,
  RootTimelineSnapshot,
  RunSnapshot,
} from '@/services/agentApi'
import type { ChatSession } from './types'

export type RootTimelineView = RootTimelineSnapshot['view']

export interface RootTimelineTransientState {
  pendingInputs: PendingInput[]
  activeTurns: ActiveTurnSnapshot[]
  activeRuns: RunSnapshot[]
  /** Chats whose live plane is already owned by this root subscription. */
  observedChatIds: Set<string>
}

export interface EffectiveRootLiveState {
  activeTurns: ActiveTurnSnapshot[]
  activeRuns: RunSnapshot[]
}

function belongsToRoot(
  chatId: string,
  rootChatId: string,
  sessionsById: Readonly<Record<string, ChatSession>>,
): boolean {
  let current: string | undefined = chatId
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    if (current === rootChatId) return true
    seen.add(current)
    current = sessionsById[current]?.meta.parentChatId ?? undefined
  }
  return false
}

function activeRunStatus(run: RunSnapshot): string | undefined {
  return run.status ?? run.state
}

/**
 * Builds the only live view consumed by the execution tree and CRT projector.
 * Root transient facts are authoritative when present; matching per-chat state
 * fills subscription hand-off gaps without loading history or opening sessions.
 */
export function effectiveRootLiveState(
  rootChatId: string,
  rootState: RootTimelineTransientState | undefined,
  sessionsById: Readonly<Record<string, ChatSession>>,
): EffectiveRootLiveState {
  const turns = new Map<string, ActiveTurnSnapshot>()
  const runs = new Map<string, RunSnapshot>()

  for (const session of Object.values(sessionsById)) {
    if (!belongsToRoot(session.chatId, rootChatId, sessionsById)) continue
    if (rootState?.observedChatIds.has(session.chatId)) continue
    for (const turn of session.activeTurns) {
      if (turn.status === 'completed' || turn.status === 'error') continue
      const normalized = { ...turn, chatId: turn.chatId ?? session.chatId }
      turns.set(
        `${normalized.chatId}:${normalized.runId ?? ''}:${normalized.messageId}`,
        normalized,
      )
    }
    const activeRun = session.activeRun
    if (
      activeRun?.runId &&
      (activeRunStatus(activeRun) === 'running' || activeRunStatus(activeRun) === 'waiting')
    ) {
      runs.set(`${session.chatId}:${activeRun.runId}`, { ...activeRun, chatId: session.chatId })
    }
    for (const turn of session.activeTurns) {
      if (!turn.runId || turn.status === 'completed' || turn.status === 'error') continue
      const key = `${session.chatId}:${turn.runId}`
      if (!runs.has(key)) {
        runs.set(key, { chatId: session.chatId, runId: turn.runId, status: 'running' })
      }
    }
  }

  for (const turn of rootState?.activeTurns ?? []) {
    if (!turn.chatId || turn.status === 'completed' || turn.status === 'error') continue
    turns.set(`${turn.chatId}:${turn.runId ?? ''}:${turn.messageId}`, { ...turn })
  }
  for (const run of rootState?.activeRuns ?? []) {
    if (!run.chatId || !run.runId) continue
    const status = activeRunStatus(run)
    const key = `${run.chatId}:${run.runId}`
    if (status === 'running' || status === 'waiting') runs.set(key, { ...run })
    else runs.delete(key)
  }

  return {
    activeTurns: [...turns.values()].sort(
      (a, b) =>
        (a.createdAt ?? 0) - (b.createdAt ?? 0) ||
        a.messageId.localeCompare(b.messageId),
    ),
    activeRuns: [...runs.values()].sort(
      (a, b) =>
        (a.chatId ?? '').localeCompare(b.chatId ?? '') ||
        (a.runId ?? '').localeCompare(b.runId ?? ''),
    ),
  }
}

export type RootTimelinePatchResult = 'applied' | 'duplicate' | 'missing' | 'gap'

export function runSingleFlight<K, T>(
  inFlight: Map<K, Promise<T>>,
  key: K,
  task: () => Promise<T>,
): Promise<T> {
  const current = inFlight.get(key)
  if (current) return current
  const promise = task()
  inFlight.set(key, promise)
  return promise.finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key)
  })
}

export function rootTimelineCacheKey(rootChatId: string, view: RootTimelineView): string {
  return `${rootChatId}:${view}`
}

export function readRootTimeline(
  cache: Record<string, RootTimelineSnapshot>,
  rootChatId: string,
  view: RootTimelineView,
): RootTimelineSnapshot | undefined {
  return cache[rootTimelineCacheKey(rootChatId, view)]
}

export function installRootTimeline(
  cache: Record<string, RootTimelineSnapshot>,
  snapshot: RootTimelineSnapshot,
): void {
  cache[rootTimelineCacheKey(snapshot.rootChatId, snapshot.view)] = snapshot
}

export function applyRootPatch(
  cache: Record<string, RootTimelineSnapshot>,
  patch: RootTimelinePatch,
): RootTimelinePatchResult {
  const key = rootTimelineCacheKey(patch.rootChatId, patch.view)
  const current = cache[key]
  if (!current) return 'missing'
  if (patch.revision <= current.revision) return 'duplicate'
  if (current.revision !== patch.baseRevision || patch.revision !== patch.baseRevision + 1)
    return 'gap'

  const byId = new Map(current.nodes.map((node) => [node.id, node]))
  const edgesById = new Map(current.edges.map((edge) => [edge.id, edge]))
  const runsById = new Map(current.activeRuns.map((run) => [`${run.chatId}:${run.runId}`, run]))
  const inputsById = new Map(current.pendingInputs.map((input) => [input.inputId, input]))
  for (const operation of patch.operations) {
    if (operation.type === 'upsert') byId.set(operation.node.id, operation.node)
    else if (operation.type === 'revoke') {
      const node = byId.get(operation.nodeId)
      if (node) byId.set(operation.nodeId, { ...node, status: 'revoked' })
    } else if (operation.type === 'remove') byId.delete(operation.nodeId)
    else if (operation.type === 'upsert-edge') edgesById.set(operation.edge.id, operation.edge)
    else if (operation.type === 'remove-edge') edgesById.delete(operation.edgeId)
    else if (operation.type === 'upsert-run')
      runsById.set(`${operation.run.chatId}:${operation.run.runId}`, operation.run)
    else if (operation.type === 'remove-run')
      runsById.delete(`${operation.chatId}:${operation.runId}`)
    else if (operation.type === 'upsert-input') inputsById.set(operation.input.inputId, operation.input)
    else inputsById.delete(operation.inputId)
  }
  const persistentNodeIds = new Set(byId.keys())
  for (const [inputId, input] of inputsById) {
    if (input.messageId && persistentNodeIds.has(input.messageId)) inputsById.delete(inputId)
  }
  cache[key] = {
    ...current,
    revision: patch.revision,
    nodes: [...byId.values()].sort((a, b) => a.orderKey - b.orderKey || a.id.localeCompare(b.id)),
    edges: [...edgesById.values()].sort(
      (a, b) => a.orderKey - b.orderKey || a.id.localeCompare(b.id),
    ),
    activeRuns: [...runsById.values()],
    pendingInputs: [...inputsById.values()],
    controlState: patch.controlState,
  }
  return 'applied'
}

export function createRootTransientState(
  state?: {
    pendingInputs?: PendingInput[]
    activeTurns?: ActiveTurnSnapshot[]
    runs?: RunSnapshot[]
  },
): RootTimelineTransientState {
  const pendingInputs = [...(state?.pendingInputs ?? [])]
  const activeTurns = [...(state?.activeTurns ?? [])]
  const activeRuns = [...(state?.runs ?? [])]
  return {
    pendingInputs,
    activeTurns,
    activeRuns,
    observedChatIds: new Set(
      [...pendingInputs, ...activeTurns, ...activeRuns]
        .map((item) => item.chatId)
        .filter((chatId): chatId is string => typeof chatId === 'string'),
    ),
  }
}

export function applyRootTransientEvent(
  state: RootTimelineTransientState,
  event: { chatId?: unknown; runId?: unknown; type?: unknown; data?: unknown },
): void {
  if (typeof event.chatId !== 'string' || typeof event.type !== 'string') return
  const chatId = event.chatId
  state.observedChatIds.add(chatId)
  const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<
    string,
    unknown
  >

  if (event.type === 'input.updated' && typeof data.inputId === 'string') {
    const existing = state.pendingInputs.find(
      (input) =>
        input.inputId === data.inputId ||
        (typeof data.clientMessageId === 'string' &&
          input.clientMessageId === data.clientMessageId),
    )
    const update = { ...data, chatId } as unknown as PendingInput
    if (data.state === 'cancelled' || data.state === 'rejected') {
      state.pendingInputs = state.pendingInputs.filter((input) => input.inputId !== data.inputId)
    } else if (existing) {
      Object.assign(existing, update)
    } else if (typeof data.content === 'string' && typeof data.state === 'string') {
      state.pendingInputs.push(update)
    }
    return
  }

  if (event.type === 'turn.started' && typeof data.turnId === 'string' && typeof data.messageId === 'string') {
    if (!state.activeTurns.some((turn) => turn.turnId === data.turnId)) {
      state.activeTurns.push({
        chatId,
        turnId: data.turnId,
        messageId: data.messageId,
        ...(typeof data.runId === 'string' ? { runId: data.runId } : {}),
        thinking: '',
        content: '',
        status: 'running',
        ...(typeof data.createdAt === 'number' ? { createdAt: data.createdAt } : {}),
      })
    }
    return
  }

  if (event.type === 'turn.delta' && typeof data.turnId === 'string') {
    const turn = state.activeTurns.find((item) => item.turnId === data.turnId)
    if (!turn || typeof data.delta !== 'string' || typeof data.offset !== 'number') return
    const channel = data.channel === 'thinking' ? 'thinking' : data.channel === 'content' ? 'content' : undefined
    if (!channel) return
    const current = turn[channel]
    if (data.offset === current.length) turn[channel] += data.delta
    return
  }

  if (event.type === 'turn.completed' && typeof data.turnId === 'string') {
    state.activeTurns = state.activeTurns.filter((turn) => turn.turnId !== data.turnId)
    return
  }

  if (event.type === 'run.updated' && typeof data.runId === 'string') {
    const run = { ...data, chatId } as unknown as RunSnapshot
    const status = run.status ?? run.state
    state.activeRuns = state.activeRuns.filter((item) => item.chatId !== chatId)
    if (status === 'running' || status === 'waiting') state.activeRuns.push(run)
    return
  }

  if (event.type === 'done' || event.type === 'error') {
    state.activeRuns = state.activeRuns.filter((run) => run.chatId !== chatId)
  }
}
