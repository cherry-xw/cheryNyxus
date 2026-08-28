import type {
  ActiveTurnSnapshot,
  GenerationEntry,
  PendingInput,
  RootTimelinePatch,
  RootTimelineSnapshot,
  RunSnapshot,
  TimelineNode,
  ExecutionEdgeFact,
  ExecutionStep,
} from '@/services/agentApi'
import type { ChatSession } from '../types'
import { applyExecutionTimingEvent } from './executionTiming'

export type RootTimelineView = RootTimelineSnapshot['view']

/** 代际图缓存条目（chat.timeline.generation.get 响应体）。 */
export interface GenerationPayload {
  generation: GenerationEntry
  nodes: TimelineNode[]
  edges: ExecutionEdgeFact[]
}

/** 每个代际是只读的不可变历史：缓存命中直接复用，LRU 上限约束内存。 */
const GENERATION_CACHE_LIMIT = 4

/** LRU Map（同 drainBase LogClusterCache 模式）：get 命中即提升为新近项。 */
export class GenerationLruCache extends Map<number, GenerationPayload> {
  override get(key: number): GenerationPayload | undefined {
    const value = super.get(key)
    if (value !== undefined) {
      super.delete(key)
      super.set(key, value)
    }
    return value
  }

  override set(key: number, value: GenerationPayload): this {
    if (super.has(key)) super.delete(key)
    super.set(key, value)
    while (this.size > GENERATION_CACHE_LIMIT) {
      const oldestKey = this.keys().next().value
      if (oldestKey === undefined) break
      super.delete(oldestKey)
    }
    return this
  }
}

export interface RootTimelineTransientState {
  pendingInputs: PendingInput[]
  activeTurns: ActiveTurnSnapshot[]
  activeRuns: RunSnapshot[]
  /** 每个 chat 最近一次 run（含终态），用于总状态与总计时派生。 */
  runStates: RunSnapshot[]
  /** currentState 快照与实时事件共享的当前执行窗口。 */
  executionSteps: ExecutionStep[]
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
    const activeRun = session.activeRun
    const sessionRunStatus = activeRun ? activeRunStatus(activeRun) : undefined
    const runIsLive = sessionRunStatus === 'running' || sessionRunStatus === 'waiting'
    for (const turn of session.activeTurns) {
      if (turn.status === 'completed' || turn.status === 'error') continue
      // A terminal snapshot for this exact run is authoritative. Hydration can
      // briefly leave the corresponding turn marked running after run.updated
      // completed, but it must not resurrect the tree's live projection.
      if (turn.runId && activeRun?.runId === turn.runId && !runIsLive) continue
      const normalized = { ...turn, chatId: turn.chatId ?? session.chatId }
      turns.set(
        `${normalized.chatId}:${normalized.runId ?? ''}:${normalized.messageId}`,
        normalized,
      )
    }
    if (activeRun?.runId && runIsLive) {
      runs.set(`${session.chatId}:${activeRun.runId}`, { ...activeRun, chatId: session.chatId })
    }
    for (const turn of session.activeTurns) {
      if (!turn.runId || turn.status === 'completed' || turn.status === 'error') continue
      if (activeRun?.runId === turn.runId && !runIsLive) continue
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
  // revision 单调即应用：消息写与图回填并行 bump 使 baseRevision 跳号是常态，
  // 严格链校验会把每次跳号误判 gap → 全量刷新风暴（主线程打满、CSS 动画卡死）。
  // 增量正确性依赖事件流有序前缀（WS 有序 + 断线 chat.sync 重放 + 重连 chat.open 全量），
  // 错过 emit 由重连链路兜底；真实增量缺失表现为 revision 落后、经全量拉取补齐。

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
    run?: RunSnapshot
    runs?: RunSnapshot[]
    executionSteps?: ExecutionStep[]
  },
): RootTimelineTransientState {
  const pendingInputs = [...(state?.pendingInputs ?? [])]
  const activeTurns = [...(state?.activeTurns ?? [])]
  const runStates = [...(state?.runs ?? []), ...(state?.run ? [state.run] : [])].map((run) => ({
    ...run,
  }))
  const activeRuns = runStates.filter((run) => {
    const status = activeRunStatus(run)
    return status === 'running' || status === 'waiting'
  })
  const executionSteps = (state?.executionSteps ?? []).map((step) => ({ ...step }))
  return {
    pendingInputs,
    activeTurns,
    activeRuns,
    runStates,
    executionSteps,
    observedChatIds: new Set(
      [...pendingInputs, ...activeTurns, ...runStates, ...executionSteps]
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
  const eventRunId =
    typeof data.runId === 'string'
      ? data.runId
      : typeof event.runId === 'string'
        ? event.runId
        : undefined
  const latestRunId =
    eventRunId ??
    state.activeRuns.find((run) => run.chatId === chatId)?.runId ??
    state.runStates.find((run) => run.chatId === chatId)?.runId
  state.executionSteps = applyExecutionTimingEvent(state.executionSteps, {
    chatId,
    ...(latestRunId ? { runId: latestRunId } : {}),
    type: event.type,
    data,
  })

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

  if (
    (event.type === 'turn.completed' || event.type === 'turn.cancelled') &&
    typeof data.turnId === 'string'
  ) {
    state.activeTurns = state.activeTurns.filter((turn) => turn.turnId !== data.turnId)
    return
  }

  if (event.type === 'run.updated' && typeof data.runId === 'string') {
    const previous = state.runStates.find(
      (item) => item.chatId === chatId && item.runId === data.runId,
    )
    const run = { ...previous, ...data, chatId } as unknown as RunSnapshot
    const status = run.status ?? run.state
    state.runStates = state.runStates.filter((item) => item.chatId !== chatId)
    state.runStates.push(run)
    state.activeRuns = state.activeRuns.filter((item) => item.chatId !== chatId)
    if (status === 'running' || status === 'waiting') state.activeRuns.push(run)
    else {
      state.activeTurns = state.activeTurns.filter(
        (turn) => turn.chatId !== chatId || (!!eventRunId && turn.runId !== eventRunId),
      )
    }
    return
  }

  if (event.type === 'done' || event.type === 'error') {
    if (latestRunId) {
      const previous = state.runStates.find(
        (run) => run.chatId === chatId && run.runId === latestRunId,
      )
      const completedAt =
        typeof data.completedAt === 'number'
          ? data.completedAt
          : typeof data.at === 'number'
            ? data.at
            : undefined
      state.runStates = state.runStates.filter((run) => run.chatId !== chatId)
      state.runStates.push({
        ...previous,
        chatId,
        runId: latestRunId,
        status:
          event.type === 'error'
            ? 'failed'
            : data.canResume === true
              ? 'paused'
              : 'completed',
        ...(completedAt !== undefined ? { at: completedAt, completedAt } : {}),
      })
    }
    state.activeRuns = state.activeRuns.filter((run) => run.chatId !== chatId)
    state.activeTurns = state.activeTurns.filter(
      (turn) => turn.chatId !== chatId || (!!eventRunId && turn.runId !== eventRunId),
    )
  }
}
