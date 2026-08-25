/**
 * useChatSessionsStore：每个 chatId 唯一前端 UI 会话实体（canonical single-writer 数据层）。
 *
 * 两个领域写入口：
 * - `replaceSnapshot(chatId, snapshot)`：chat.get/sync/attach response 权威替换。
 * - `applyEvent(chatId, event)`：WS 增量事件经 reducer 应用 + 跨 session 路由 + 副作用。
 *
 * wsClient 仍是唯一 chatSeq cursor 所有者（gap buffer + 排序在 [ws.ts](../../services/ws.ts)）；
 * 本 store 的 onChunk/onNotification 订阅经 `bindWsClient()` 挂载（迁移期由 #10 切换，避免与旧 store 双订）。
 *
 * 副作用（pet 创建/resume/toast/working）经 `bindEffects()` 注入，默认 no-op；
 * Pet 领域分离（#9）后由 pet store 注入，保持数据层与展示层单向依赖。
 *
 * 详见 [docs/web/pet/agent-integration.md](../../../docs/web/pet/agent-integration.md)。
 */

import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ChatSession, ChatSessionSnapshot, ChatEvent, ChatTimelineSnapshot } from './types'
import type { QuestionDraftAnswer } from '../agents/types'
import type {
  ChatSummary,
  ChatSendAttachment,
  ChatSessionEvent,
  ChatOpenResponse,
  PendingInput,
  TimelinePatch,
  RootTimelineSnapshot,
  RootTimelinePatch,
} from '@/services/agentApi'
import {
  createCatalogEntity,
  createEmptySession,
  applySnapshot,
  setReplaying,
  markLoaded,
} from './hydration'
import {
  reduce,
  reduceRoleCreated,
  reduceRoleReply,
  reduceConsumed,
  replaceTimeline,
  applyTimelinePatch,
  reduceSessionEvent,
  installActiveTurns,
  type ReduceContext,
} from './reducer'
import { collectDescendantChatIds } from '../agents/data/historyMerge'
import { wsClient } from '@/services/ws'
import { agentApi } from '@/services/agentApi'
import type { ChunkMessage, NotificationMessage } from '../agents/types'
import {
  applyRootPatch,
  applyRootTransientEvent,
  createRootTransientState,
  GenerationLruCache,
  installRootTimeline,
  readRootTimeline,
  runSingleFlight,
  type GenerationPayload,
  type RootTimelinePatchResult,
  type RootTimelineTransientState,
  type RootTimelineView,
} from './rootTimeline'
import { applyExecutionTimingEvent } from './executionTiming'
import { selectExecutionReadModel } from './executionReadModel'
import { useInteractionsStore } from '../interactions'
import {
  commandErrorFact,
  commandGate,
  commandGateError,
  type CommandGate,
} from '../commandLifecycle'

/** role_created notification data 形（store 层路由用）。 */
interface RoleCreatedData {
  taskId?: string
  chatId?: string
  parentChatId?: string
  type?: string
  prompt?: string
  wake?: 'immediate' | 'deferred' | 'barrier'
  brain?: string
  senseGroup?: string
  avatar?: string
}

/** role_reply notification data 形。 */
interface RoleReplyData {
  parentChatId: string
  childChatId: string
  type: string
  content: string
  spawnSenseCallId?: string
  msgId: string
}

export interface PreparedChatInput {
  chatId: string
  content: string
  attachments?: ChatSendAttachment[]
  clientMessageId: string
  commandId: string
  messageId: string
  provisionalInputId: string
  startedRun: boolean
}

/** 注入副作用（pet lifecycle / resume / toast）；默认 no-op，#9 由 pet store 注入。 */
export interface ChatSessionEffects {
  onWorkingChange?: (chatId: string, working: boolean, freezeUntil?: number) => void
  onRoleCreated?: (data: RoleCreatedData) => void
  onRoleDestroyed?: (chatId: string) => void
  onAutoCompacted?: (data: { reason?: string; usedBefore?: number; total?: number }) => void
}

const noop = (): void => {}

/**
 * 实时命令已经发起时，不能等待首个 stream/tool 事件才让 UI 进入工作态。
 * 返回值标识本次命令是否开启了新的本地 working 投影，便于失败时安全回滚。
 * 快照与 sync 回放绝不可调用此函数，它们只还原后端已有状态。
 */
export function beginLiveRun(
  session: ChatSession,
  onWorkingChange: NonNullable<ChatSessionEffects['onWorkingChange']>,
): boolean {
  const started = session.run.status !== 'running'
  session.run.status = 'running'
  session.run.error = undefined
  session.run.retainUntil = undefined
  session.ui.bubbleVisible = true
  if (started) onWorkingChange(session.chatId, true)
  return started
}

/** run.status 写者收敛（阶段 3.3，docs/web/pet/agent-integration.md）：
 * 快照/投影类写者（chat.list / chat.open / chat.attach）不得把已终态的会话
 * 回滚为 running —— 否则「暂停」后迟到的快照会让「停止」按钮复现。
 * 乐观操作（beginLiveRun 等）与严格 seq 序的 reducer 事件不走本函数。
 * 终态集合：paused / completed / failed / ended（idle 属骨架态，可被 running 覆盖）。 */
const TERMINAL_RUN_STATUSES = new Set(['paused', 'completed', 'failed', 'ended'])
export function applyRunStatus(
  session: ChatSession,
  status: ChatSession['run']['status'],
  allowRunning = false,
): void {
  if (status === 'running' && !allowRunning && TERMINAL_RUN_STATUSES.has(session.run.status)) {
    return
  }
  session.run.status = status
}

/** 仅实时 role_reply 可续跑父会话；历史回放只能恢复消息。 */
export type ChatEventProvenance = 'live' | 'replay'

/** Session-plane events that describe transient rendering state. During
 * chat.sync they are historical facts, not fresh UI deltas. The current open
 * turn is restored atomically from chat.attach.activeTurns instead. */
const REPLAY_TRANSIENT_EVENT_TYPES = new Set([
  'turn.started',
  'turn.delta',
  'turn.completed',
  'run.updated',
  'legacy.stream',
])

export function shouldResumeRoleReply(provenance: ChatEventProvenance): boolean {
  return provenance === 'live'
}

function responseError(
  response: { error?: { code?: string; message?: string } },
  fallback: string,
): Error & { code?: string } {
  const error = new Error(response.error?.message ?? fallback) as Error & { code?: string }
  if (response.error?.code) error.code = response.error.code
  return error
}

/**
 * 会话订阅中的旧通知与 V2 事件共用同一递增序号。即便旧通知仍由兼容分支消费，
 * 也必须先进入规范序号流，否则其后的 turn.delta 会被误判为缺失事件。
 */
export function toSequencedSessionEvent(
  event: NotificationMessage | ChunkMessage,
): (ChatSessionEvent & { kind: 'session' }) | undefined {
  const envelope = event as NotificationMessage & { eventSeq?: unknown; seq?: unknown }
  const eventSeq =
    typeof envelope.eventSeq === 'number'
      ? envelope.eventSeq
      : typeof envelope.seq === 'number'
        ? envelope.seq
        : undefined
  if (typeof event.chatId !== 'string' || eventSeq === undefined) return undefined
  return { ...event, kind: 'session', chatId: event.chatId, eventSeq }
}

export const useChatSessionsStore = defineStore('chatSessions', () => {
  const sessionsById = ref<Record<string, ChatSession>>({})
  /** Root-owned projection; one snapshot covers the entire recursive tree. */
  const rootTimelines = ref<Record<string, RootTimelineSnapshot>>({})
  /** Root-owned transient plane, shared by every view of the same root. */
  const rootTimelineStates = ref<Record<string, RootTimelineTransientState>>({})
  /** Root subscription cursor; one subscription covers all descendants. */
  const rootSubscriptions = ref<Record<string, { subscriptionId: string; eventSeq: number }>>({})
  type RootTransientEvent = {
    chatId?: unknown
    runId?: unknown
    type?: unknown
    data?: unknown
  }
  /** Root deltas may arrive far above display refresh rate; preserve protocol order.
   * The tree/card projection is paint-heavy, so 64ms keeps streaming responsive
   * while leaving most display frames free for scrolling and pointer interaction. */
  const ROOT_DELTA_FRAME_MS = 64
  const pendingRootDeltas = new Map<string, RootTransientEvent[]>()
  const rootDeltaTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Visible owners of a root subscription. A root closes only after its final owner leaves. */
  const rootSubscriptionOwners = new Map<string, Set<string>>()
  /** Deleted roots reject late async snapshots so stale requests cannot resurrect UI. */
  const evictedRoots = new Set<string>()
  /** requestId -> chatId（流式 RPC chunk 路由用；chunk.chatId 缺失时兜底）。 */
  const requestMap = new Map<string, string>()
  /** chat.sync 会通过普通 notification 通道回放兼容事件；按请求标记其历史来源，
   * 不能再从被路由到的 parent session 当前 replaying 状态反推。 */
  const replayRequestIds = new Set<string>()
  /** 每 chat hydration in-flight 去重（避免并发 loadSession 重复 sync）。 */
  const hydrating = new Map<string, Promise<void>>()
  /** V2 chat.open in-flight 去重（event gap 期间可能同时收到多个事件）。 */
  const opening = new Map<string, Promise<void>>()
  /** Root event-stream resync guard. View revision gaps never reopen subscriptions. */
  const rootResyncing = new Map<string, Promise<void>>()
  /** resumeAgent 单飞（连续双击「继续」只发起一次 resumeChat；S7）。 */
  const resumingChats = new Map<string, Promise<void>>()
  /** Workbench tree resume single-flight, keyed by the durable pause operation. */
  const resumingTrees = new Map<string, Promise<void>>()
  /** One protocol subscription per root. Timeline views share this flight. */
  const rootSubscriptionOpening = new Map<
    string,
    Promise<{ opened: boolean; conversation?: RootTimelineSnapshot }>
  >()
  /** Snapshot reads are independent from the root subscription and dedupe per view. */
  const rootViewOpening = new Map<string, Promise<RootTimelineSnapshot>>()
  /** startup 幂等守卫（首次成功后不再重跑；F5 重连由 reconnect 处理）。 */
  let started = false
  const effects = ref<ChatSessionEffects>({})

  function flushRootDeltas(rootChatId: string): void {
    const timer = rootDeltaTimers.get(rootChatId)
    if (timer) clearTimeout(timer)
    rootDeltaTimers.delete(rootChatId)
    const events = pendingRootDeltas.get(rootChatId)
    pendingRootDeltas.delete(rootChatId)
    if (!events?.length) return
    const transient = rootTimelineStates.value[rootChatId]
    if (!transient) return
    for (const event of events) applyRootTransientEvent(transient, event)
  }

  function queueRootDelta(rootChatId: string, event: RootTransientEvent): void {
    const pending = pendingRootDeltas.get(rootChatId) ?? []
    pending.push(event)
    pendingRootDeltas.set(rootChatId, pending)
    if (rootDeltaTimers.has(rootChatId)) return
    rootDeltaTimers.set(
      rootChatId,
      setTimeout(() => flushRootDeltas(rootChatId), ROOT_DELTA_FRAME_MS),
    )
  }

  // ---- 实体管理 ----

  function ensureEntity(chatId: string, meta?: Partial<ChatSession['meta']>): ChatSession {
    let s = sessionsById.value[chatId]
    if (!s) {
      s = createEmptySession(chatId, meta)
      sessionsById.value[chatId] = s
    } else if (meta) {
      Object.assign(s.meta, meta)
    }
    return s
  }

  function ensureCatalogEntity(summary: ChatSummary): ChatSession {
    const existing = sessionsById.value[summary.chatId]
    if (existing) {
      Object.assign(existing.meta, {
        parentChatId: summary.parentChatId ?? existing.meta.parentChatId,
        agentType: summary.agentType ?? existing.meta.agentType,
        avatar: summary.avatar ?? existing.meta.avatar,
        updatedAt: summary.updatedAt ?? existing.meta.updatedAt,
        finished: summary.finished ?? existing.meta.finished,
        running: summary.running ?? existing.meta.running,
        wake: summary.wake ?? existing.meta.wake,
        preset: summary.preset ?? existing.meta.preset,
        workspace: summary.workspace ?? existing.meta.workspace,
        workspaceValid: summary.workspaceValid ?? existing.meta.workspaceValid,
        preview: summary.preview ?? existing.meta.preview,
        turnCount: summary.turnCount ?? existing.meta.turnCount,
      })
      if (summary.canResume !== undefined) existing.context.canResume = summary.canResume
      // A loaded session owns its event-derived run state. Catalog-only entities instead need
      // the chat.list projection so Workbench/Pet expose Pause vs Resume before hydration.
      if (!existing.sync.loaded) {
        existing.run.status = summary.running
          ? 'running'
          : summary.canResume
            ? 'paused'
            : summary.finished
              ? 'ended'
              : 'idle'
      }
      return existing
    }
    const s = createCatalogEntity(summary)
    sessionsById.value[summary.chatId] = s
    return s
  }

  /** chat.list(includePreview=true) 后建全部 catalog 实体 + 索引。 */
  function initCatalog(summaries: ChatSummary[]): void {
    for (const summary of summaries) ensureCatalogEntity(summary)
  }

  function deleteSession(chatId: string): void {
    delete sessionsById.value[chatId]
    hydrating.delete(chatId)
  }

  /**
   * Permanently evict deleted chats from every client-side session plane.
   * This is intentionally stronger than closeSession/closeRootTimeline: deleted
   * history must not be able to reappear from a durable or transient cache.
   */
  async function evictSessions(chatIds: readonly string[]): Promise<void> {
    const removed = new Set(chatIds)
    if (removed.size === 0) return

    const affectedRoots = new Set<string>()
    for (const chatId of removed) affectedRoots.add(rootIdOf(chatId))
    for (const rootChatId of affectedRoots) evictedRoots.add(rootChatId)

    await Promise.all([...affectedRoots].map((rootChatId) => closeRootTimeline(rootChatId, true)))

    for (const rootChatId of affectedRoots) {
      flushRootDeltas(rootChatId)
      const timer = rootDeltaTimers.get(rootChatId)
      if (timer) clearTimeout(timer)
      rootDeltaTimers.delete(rootChatId)
      pendingRootDeltas.delete(rootChatId)
      rootSubscriptionOwners.delete(rootChatId)
      rootResyncing.delete(rootChatId)
      rootSubscriptionOpening.delete(rootChatId)
      generationsCache.delete(rootChatId)
      delete rootTimelineStates.value[rootChatId]
      delete rootSubscriptions.value[rootChatId]
      for (const key of Object.keys(rootTimelines.value)) {
        if (key.startsWith(`${rootChatId}:`)) delete rootTimelines.value[key]
      }
      for (const key of rootViewOpening.keys()) {
        if (key.startsWith(`${rootChatId}:`)) rootViewOpening.delete(key)
      }
      for (const key of generationsOpening.keys()) {
        if (key.startsWith(`${rootChatId}:`)) generationsOpening.delete(key)
      }
    }

    for (const chatId of removed) {
      deleteSession(chatId)
      opening.delete(chatId)
    }
    for (const [requestId, chatId] of requestMap) {
      if (!removed.has(chatId)) continue
      requestMap.delete(requestId)
      replayRequestIds.delete(requestId)
    }
  }

  function rootIdOf(chatId: string): string {
    let current = sessionsById.value[chatId]
    const seen = new Set<string>()
    while (current?.meta.parentChatId && !seen.has(current.chatId)) {
      seen.add(current.chatId)
      current = sessionsById.value[current.meta.parentChatId]
    }
    return current?.chatId ?? chatId
  }

  function rootTimeline(
    rootChatId: string,
    view: RootTimelineView = 'conversation',
  ): RootTimelineSnapshot | undefined {
    return readRootTimeline(rootTimelines.value, rootChatId, view)
  }

  function commandAvailability(chatId: string | undefined): CommandGate {
    const rootChatId = chatId ? rootIdOf(chatId) : undefined
    const session = rootChatId ? sessionsById.value[rootChatId] : undefined
    const hasTimeline = rootChatId
      ? Boolean(
          rootTimeline(rootChatId, 'conversation') ??
          rootTimeline(rootChatId, 'tree') ??
          rootTimeline(rootChatId, 'audit'),
        )
      : false
    return commandGate({
      connectionStatus: wsClient.getStatus(),
      rootChatId,
      hydrated: Boolean(session?.sync.loaded || hasTimeline),
      hydrating: Boolean(
        rootChatId &&
        (hydrating.has(rootChatId) ||
          opening.has(rootChatId) ||
          rootSubscriptionOpening.has(rootChatId)),
      ),
    })
  }

  /** Stop observing one root without touching its Agent runtime. Cached durable
   * nodes remain available for an instant stale-while-revalidate reopen. */
  async function closeRootTimeline(rootChatId: string, force = false): Promise<void> {
    if (!force && (rootSubscriptionOwners.get(rootChatId)?.size ?? 0) > 0) return
    flushRootDeltas(rootChatId)
    const subscription = rootSubscriptions.value[rootChatId]
    if (!subscription) return
    delete rootSubscriptions.value[rootChatId]
    await agentApi.closeChat(subscription.subscriptionId).catch(() => undefined)
  }

  async function acquireRootTimeline(
    rootChatId: string,
    ownerId: string,
    view: 'conversation' | 'tree' | 'audit' = 'conversation',
  ): Promise<RootTimelineSnapshot> {
    const owners = rootSubscriptionOwners.get(rootChatId) ?? new Set<string>()
    owners.add(ownerId)
    rootSubscriptionOwners.set(rootChatId, owners)
    try {
      return await observeRootTimeline(rootChatId, view)
    } catch (cause) {
      owners.delete(ownerId)
      if (owners.size === 0) rootSubscriptionOwners.delete(rootChatId)
      throw cause
    }
  }

  async function releaseRootTimeline(rootChatId: string, ownerId: string): Promise<void> {
    const owners = rootSubscriptionOwners.get(rootChatId)
    if (!owners) return
    owners.delete(ownerId)
    if (owners.size > 0) return
    rootSubscriptionOwners.delete(rootChatId)
    // 最后观察者离开：代际图缓存随订阅一并释放（LRU 之外的内存上界）。
    generationsCache.delete(rootChatId)
    await closeRootTimeline(rootChatId, true)
  }

  function installRootOpenState(response: ChatOpenResponse): void {
    const chatIds = response.state.chatIds ?? [response.chatId]
    for (const chatId of chatIds) {
      const session = ensureEntity(chatId)
      session.pendingInputs = response.state.pendingInputs
        .filter((input) => input.chatId === chatId)
        .map((input) => ({ ...input }))
      session.activeTurns = response.state.activeTurns
        .filter((turn) => turn.chatId === chatId)
        .map((turn) => ({ ...turn }))
      if (response.state.executionSteps !== undefined) {
        session.executionSteps = response.state.executionSteps
          .filter((step) => step.chatId === chatId)
          .map((step) => ({ ...step }))
      }
      installActiveTurns(session, session.activeTurns, Date.now())
      const run = response.state.runs?.find((candidate) => candidate.chatId === chatId)
      session.activeRun = run
      session.run.activeRunId = run?.runId
      // 快照写者不覆盖已终态为 running（applyRunStatus 收敛，见 3.3）
      applyRunStatus(session, run ? 'running' : 'idle')
      session.sync.loaded = true
    }
  }

  async function ensureRootSubscription(
    rootChatId: string,
  ): Promise<{ opened: boolean; conversation?: RootTimelineSnapshot }> {
    if (evictedRoots.has(rootChatId)) throw new Error(`root timeline ${rootChatId} was deleted`)
    if (rootSubscriptions.value[rootChatId]) return { opened: false }
    const existing = rootSubscriptionOpening.get(rootChatId)
    if (existing) return existing
    const promise = (async () => {
      // A different view may have installed the shared subscription while this
      // call was waiting for the previous observed root to close.
      if (rootSubscriptions.value[rootChatId]) return { opened: false }
      const conversation = rootTimeline(rootChatId, 'conversation')
      const opened = await agentApi.openChat({
        rootChatId,
        knownTimelineRevision: conversation?.revision,
        knownEventSeq: conversation?.capturedEventSeq,
      })
      if (evictedRoots.has(rootChatId)) {
        await agentApi.closeChat(opened.subscriptionId).catch(() => undefined)
        throw new Error(`root timeline ${rootChatId} was deleted`)
      }
      rootSubscriptions.value[rootChatId] = {
        subscriptionId: opened.subscriptionId,
        eventSeq: opened.eventSeq,
      }
      const localTransient = rootTimelineStates.value[rootChatId]
      const openedTransient = createRootTransientState(opened.state)
      if (localTransient) {
        if (opened.state.executionSteps === undefined) {
          openedTransient.executionSteps = localTransient.executionSteps.map((step) => ({
            ...step,
          }))
        }
        for (const input of localTransient.pendingInputs) {
          if (
            input.inputId.startsWith('optimistic-input:') &&
            !openedTransient.pendingInputs.some(
              (candidate) => candidate.clientMessageId === input.clientMessageId,
            )
          ) {
            openedTransient.pendingInputs.push(input)
          }
        }
        for (const run of localTransient.activeRuns) {
          if (
            typeof run.runId === 'string' &&
            run.runId.startsWith('command-') &&
            !openedTransient.activeRuns.some((candidate) => candidate.chatId === run.chatId)
          ) {
            openedTransient.activeRuns.push(run)
          }
        }
      }
      rootTimelineStates.value[rootChatId] = openedTransient
      installRootOpenState(opened)
      if (opened.rootTimeline) installRootTimeline(rootTimelines.value, opened.rootTimeline)
      // timelineUnchanged 短路：服务端省略 rootTimeline，本地 conversation 缓存仍权威。
      const conversationSnapshot =
        opened.rootTimeline ?? (opened.timelineUnchanged ? conversation : undefined)
      return { opened: true, conversation: conversationSnapshot }
    })()
    rootSubscriptionOpening.set(rootChatId, promise)
    try {
      return await promise
    } finally {
      if (rootSubscriptionOpening.get(rootChatId) === promise) {
        rootSubscriptionOpening.delete(rootChatId)
      }
    }
  }

  async function loadRootTimelineView(
    rootChatId: string,
    view: 'conversation' | 'tree' | 'audit' = 'conversation',
  ): Promise<RootTimelineSnapshot> {
    const key = `${rootChatId}:${view}`
    const existing = rootViewOpening.get(key)
    if (existing) return existing
    const current = rootTimeline(rootChatId, view)
    const promise = agentApi
      .getRootTimeline({
        rootChatId,
        view,
        ...(current ? { knownRevision: current.revision } : {}),
      })
      .then((snapshot) => {
        if (evictedRoots.has(rootChatId)) throw new Error(`root timeline ${rootChatId} was deleted`)
        // knownRevision 短路：服务端确认客户端快照仍最新，保留现有缓存不覆盖。
        if (!snapshot) {
          if (!current) throw new Error(`root timeline ${key} unchanged 短路但本地无缓存`)
          return current
        }
        installRootTimeline(rootTimelines.value, snapshot)
        return snapshot
      })
    rootViewOpening.set(key, promise)
    try {
      return await promise
    } finally {
      if (rootViewOpening.get(key) === promise) rootViewOpening.delete(key)
    }
  }

  // ---- 代际图按需缓存（LRU 上限 4/root；root 订阅释放时整棵清空） ----
  const generationsCache = new Map<string, GenerationLruCache>()
  const generationsOpening = new Map<string, Promise<GenerationPayload>>()

  /** 拉取（或命中缓存）单个已打包代际的完整图，树二层弹窗与历史抽屉二层共用。 */
  async function loadGeneration(
    rootChatId: string,
    generationIndex: number,
  ): Promise<GenerationPayload> {
    const cacheKey = `${rootChatId}:${generationIndex}`
    return runSingleFlight(generationsOpening, cacheKey, async () => {
      const cache = generationsCache.get(rootChatId) ?? new GenerationLruCache()
      const cached = cache.get(generationIndex)
      if (cached) return cached
      const payload = await agentApi.getTimelineGeneration({ rootChatId, generationIndex })
      if (evictedRoots.has(rootChatId)) throw new Error(`root timeline ${rootChatId} was deleted`)
      cache.set(generationIndex, {
        generation: payload.generation,
        nodes: payload.nodes,
        edges: payload.edges,
      })
      generationsCache.set(rootChatId, cache)
      return cache.get(generationIndex)!
    })
  }

  /** Observe a visible Nyxus root. UI supplies root/view; this message-layer
   * controller establishes an independent per-root subscription and returns the
   * snapshot. Multiple different roots may be observed concurrently. */
  async function observeRootTimeline(
    rootChatId: string,
    view: 'conversation' | 'tree' | 'audit' = 'conversation',
  ): Promise<RootTimelineSnapshot> {
    const subscription = await ensureRootSubscription(rootChatId)
    if (view === 'conversation' && subscription.conversation) return subscription.conversation
    const current = rootTimeline(rootChatId, view)
    // An already-open subscription keeps installed views current through root
    // patches. A newly opened subscription must refresh non-conversation views.
    if (!subscription.opened && current) return current
    return loadRootTimelineView(rootChatId, view)
  }

  function applyRootTimelinePatch(patch: RootTimelinePatch): RootTimelinePatchResult {
    return applyRootPatch(rootTimelines.value, patch)
  }

  /** Refresh only cached projections. A view revision gap must not interrupt live turn events. */
  async function refreshRootTimelineViews(
    rootChatId: string,
    views: readonly RootTimelineView[],
  ): Promise<void> {
    const cachedViews = [...new Set(views)].filter((view) =>
      Boolean(rootTimeline(rootChatId, view)),
    )
    await Promise.all(cachedViews.map((view) => loadRootTimelineView(rootChatId, view)))
  }

  /** Reopen only when the root-wide event cursor has a real gap or the socket reconnects. */
  async function reopenRootSubscription(rootChatId: string): Promise<void> {
    return runSingleFlight(rootResyncing, rootChatId, async () => {
      const old = rootSubscriptions.value[rootChatId]
      delete rootSubscriptions.value[rootChatId]
      if (old) await agentApi.closeChat(old.subscriptionId).catch(() => undefined)
      const cachedViews = new Set<RootTimelineView>(
        (['conversation', 'tree', 'audit'] as const).filter((view) =>
          Boolean(rootTimeline(rootChatId, view)),
        ),
      )
      rootSubscriptionOpening.delete(rootChatId)
      for (const key of rootViewOpening.keys()) {
        if (key.startsWith(`${rootChatId}:`)) rootViewOpening.delete(key)
      }
      const subscription = await ensureRootSubscription(rootChatId)
      await Promise.all(
        [...cachedViews]
          .filter((view) => view !== 'conversation' || !subscription.conversation)
          .map((view) => loadRootTimelineView(rootChatId, view)),
      )
    })
  }

  async function resyncRootTimeline(rootChatId: string): Promise<void> {
    await reopenRootSubscription(rootChatId)
  }

  /** 终态事件判定：done/error/turn.completed/run.updated{paused|completed|failed}。
   * 终态事件对 transient 是幂等清理；栅栏丢弃分支据此决定是否重拉权威快照。 */
  function isTerminalRootEvent(event: { type?: unknown; data?: unknown }): boolean {
    if (event.type === 'turn.completed') return true
    if (event.type === 'done' || event.type === 'error') return true
    if (event.type === 'run.updated') {
      const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<
        string,
        unknown
      >
      const status = data.status ?? data.state
      return status === 'paused' || status === 'completed' || status === 'failed'
    }
    return false
  }

  /** 终态事件在 transient 中是否仍有对应残留（有残留 → 静默丢弃会让 run/turn
   * 永久卡 running，需重拉自愈；已清理则无需无谓重拉）。 */
  function terminalEventHasResidual(
    rootChatId: string,
    event: { type?: unknown; data?: unknown; chatId?: unknown; runId?: unknown },
  ): boolean {
    const transient = rootTimelineStates.value[rootChatId]
    if (!transient) return false
    const chatId = event.chatId
    const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<
      string,
      unknown
    >
    if (event.type === 'done' || event.type === 'error') {
      return typeof chatId === 'string' && transient.activeRuns.some((run) => run.chatId === chatId)
    }
    if (event.type === 'turn.completed' && typeof data.turnId === 'string') {
      return transient.activeTurns.some((turn) => turn.turnId === data.turnId)
    }
    if (event.type === 'run.updated' && typeof data.runId === 'string') {
      return typeof chatId === 'string' && transient.activeRuns.some((run) => run.chatId === chatId)
    }
    return false
  }

  function applyRootSubscriptionEvent(event: {
    rootChatId?: unknown
    rootEventSeq?: unknown
    eventSeq?: unknown
    subscriptionId?: unknown
    type?: unknown
    data?: unknown
  }): boolean {
    if (typeof event.rootChatId === 'string' && evictedRoots.has(event.rootChatId)) return true
    if (
      typeof event.rootChatId !== 'string' ||
      typeof (event.rootEventSeq ?? event.eventSeq) !== 'number' ||
      typeof event.subscriptionId !== 'string'
    )
      return false
    const rootEventSeq = (event.rootEventSeq ?? event.eventSeq) as number
    const subscription = rootSubscriptions.value[event.rootChatId]
    if (!subscription || subscription.subscriptionId !== event.subscriptionId) return false
    if (rootEventSeq <= subscription.eventSeq) {
      // 重复/乱序事件：快照已覆盖，常规直接丢弃。但终态事件若指向 transient
      // 仍残留的 run/turn（跨窗并发下 cursor 漂移，该终态曾被跳过未应用），
      // 静默丢弃会让 CRT/工作台恒显「执行中」。此时 flush 待处理 deltas 后
      // 重拉权威快照（openChat 的 state.runs 已空自愈）。
      if (isTerminalRootEvent(event) && terminalEventHasResidual(event.rootChatId, event)) {
        flushRootDeltas(event.rootChatId)
        void reopenRootSubscription(event.rootChatId).catch((e) =>
          console.warn(`[chats] root subscription terminal resync ${event.rootChatId} 失败:`, e),
        )
      }
      return true
    }
    if (rootEventSeq !== subscription.eventSeq + 1) {
      flushRootDeltas(event.rootChatId)
      void reopenRootSubscription(event.rootChatId).catch((e) =>
        console.warn(`[chats] root subscription resync ${event.rootChatId} 失败:`, e),
      )
      return true
    }
    subscription.eventSeq = rootEventSeq
    const transient = (rootTimelineStates.value[event.rootChatId] ??= createRootTransientState())
    if (event.type === 'turn.delta') queueRootDelta(event.rootChatId, event)
    else {
      // Structural/terminal events must observe all preceding deltas first.
      flushRootDeltas(event.rootChatId)
      applyRootTransientEvent(transient, event)
    }
    if (event.type === 'timeline.patch') {
      const patchData = event.data as
        { rootPatch?: RootTimelinePatch; rootPatches?: RootTimelinePatch[] } | undefined
      const patches = patchData?.rootPatches ?? (patchData?.rootPatch ? [patchData.rootPatch] : [])
      const results = patches.map((patch) => ({ patch, result: applyRootTimelinePatch(patch) }))
      const gapViews = results
        .filter(({ result }) => result === 'gap')
        .map(({ patch }) => patch.view)
      if (gapViews.length > 0) {
        void refreshRootTimelineViews(event.rootChatId, gapViews).catch((e) =>
          console.warn(`[chats] root timeline view refresh ${event.rootChatId} 失败:`, e),
        )
      }
      const committedIds = new Set(
        results
          .filter(({ result }) => result === 'applied' || result === 'duplicate')
          .flatMap(({ patch }) =>
            patch.operations.flatMap((operation) =>
              operation.type === 'upsert' ? [operation.node.id] : [],
            ),
          ),
      )
      transient.pendingInputs = transient.pendingInputs.filter(
        (input) => !input.messageId || !committedIds.has(input.messageId),
      )
    }
    return true
  }

  // ---- 两个领域写入口 ----

  /** snapshot 权威替换（chat.get/sync/attach response）。 */
  function replaceSnapshot(chatId: string, snapshot: ChatSessionSnapshot): void {
    const s = ensureEntity(chatId)
    applySnapshot(s, snapshot, Date.now())
  }

  /** V2 timeline snapshot: backend owns message assembly; replace canonical entities atomically. */
  function replaceTimelineSnapshot(chatId: string, snapshot: ChatTimelineSnapshot): void {
    const session = ensureEntity(chatId)
    const activeTurns = [...session.activeTurns]
    replaceTimeline(session, snapshot)
    installActiveTurns(session, activeTurns, Date.now())
    session.sync.resyncRequired = false
    session.sync.loaded = true
  }

  /** chat.attach 的 session-plane 快照：当前未完成回复整体替换，不经过
   * turn.delta reducer，因此连接恢复只产生一次可见文本更新。 */
  function applyAttachRunSnapshot(
    chatId: string,
    snapshot: Awaited<ReturnType<typeof agentApi.attachChat>>,
  ): void {
    const session = ensureEntity(chatId)
    applySnapshot(
      session,
      {
        chatId,
        snapshotSeq: snapshot.snapshotSeq,
        ...(snapshot.currentState ? { currentState: snapshot.currentState } : {}),
        pendingQuestionBatches:
          snapshot.pendingQuestionBatches as ChatSessionSnapshot['pendingQuestionBatches'],
      },
      Date.now(),
    )
    session.activeTurns = (snapshot.activeTurns ?? []).map((turn) => ({
      ...turn,
      nextThinkingOffset: turn.nextThinkingOffset ?? turn.thinkingOffset ?? turn.thinking.length,
      nextContentOffset: turn.nextContentOffset ?? turn.contentOffset ?? turn.content.length,
    }))
    session.activeMessageId = undefined
    installActiveTurns(session, session.activeTurns, Date.now())
    session.run.activeRunId = snapshot.runId
    if (snapshot.runId) {
      session.activeRun = {
        ...(session.activeRun?.runId === snapshot.runId ? session.activeRun : {}),
        chatId,
        runId: snapshot.runId,
        status: snapshot.running ? 'running' : session.context.canResume ? 'paused' : 'completed',
      }
    }
    // 快照写者收敛（3.3）：快照 running 不得把已终态（含用户刚暂停）回滚为 running；
    // 且仅当快照 seq 不倒退已观察事件（getHighestSeenSeq <= snapshotSeq）才可信。
    const seqFresh = wsClient.getHighestSeenSeq(chatId) <= snapshot.snapshotSeq
    if (snapshot.running && seqFresh) {
      applyRunStatus(session, 'running', false)
    } else {
      applyRunStatus(session, session.context.canResume ? 'paused' : 'idle')
    }
    session.meta.running = snapshot.running
    session.sync.loaded = true
    // attach snapshot is authoritative through snapshotSeq. Drop replayable
    // events at/before that boundary; only later live deltas may reach the Pet.
    wsClient.resetChatSeq(chatId, snapshot.snapshotSeq)
  }

  /** V2 revision patch. A false return marks the session for authoritative refetch. */
  function applyTimelinePatchEvent(chatId: string, patch: TimelinePatch): boolean {
    const session = ensureEntity(chatId)
    const applied = applyTimelinePatch(session, patch)
    if (!applied) {
      session.sync.resyncRequired = true
      return false
    }
    session.sync.resyncRequired = false
    return true
  }

  function applyOpenSnapshot(chatId: string, response: ChatOpenResponse): void {
    const session = ensureEntity(chatId)
    session.sync.subscriptionId = response.subscriptionId
    session.sync.eventSeq = response.eventSeq
    session.sync.lastSeq = Math.max(session.sync.lastSeq, response.eventSeq)
    // chat.open captures an atomic boundary. Advance the transport cursor before
    // releasing buffered events so events <= boundary cannot replay into state.
    wsClient.resetChatSeq(chatId, response.eventSeq)
    session.sync.timelineRevision = response.timelineRevision
    session.sync.resyncRequired = false
    session.pendingInputs = [...(response.state.pendingInputs ?? [])]
    session.activeTurns = (response.state.activeTurns ?? []).map((turn) => ({
      ...turn,
      nextThinkingOffset: turn.nextThinkingOffset ?? turn.thinkingOffset ?? turn.thinking.length,
      nextContentOffset: turn.nextContentOffset ?? turn.contentOffset ?? turn.content.length,
    }))
    if (response.state.executionSteps !== undefined) {
      session.executionSteps = response.state.executionSteps.map((step) => ({ ...step }))
    }
    installActiveTurns(session, session.activeTurns, Date.now())
    session.activeRun = response.state.run
    if (response.state.run) {
      session.run.activeRunId = response.state.run.runId
      const runState = response.state.run.status ?? response.state.run.state
      // 快照写者不覆盖已终态为 running（applyRunStatus 收敛，见 3.3）
      applyRunStatus(
        session,
        runState === 'running' || runState === 'waiting'
          ? 'running'
          : runState === 'paused'
            ? 'paused'
            : 'ended',
      )
    } else {
      session.activeRun = undefined
      session.run.activeRunId = undefined
      applyRunStatus(session, session.context.canResume ? 'paused' : 'idle')
    }
    session.sync.loaded = true
  }

  /** V2 atomic open: establish subscription, then fetch timeline only if revision changed. */
  async function openSession(chatId: string): Promise<void> {
    const previous = opening.get(chatId)
    if (previous) return previous
    const promise = openSessionOnce(chatId)
    opening.set(chatId, promise)
    try {
      await promise
    } finally {
      opening.delete(chatId)
    }
  }

  async function openSessionOnce(chatId: string): Promise<void> {
    const session = ensureEntity(chatId)
    const response = await agentApi.openChat({
      chatId,
      knownTimelineRevision: session.sync.timelineRevision,
      knownEventSeq: session.sync.eventSeq ?? wsClient.getLastSeq(chatId),
    })
    applyOpenSnapshot(chatId, response)
    if (response.timelineChanged || session.sync.timelineRevision === undefined) {
      const timeline = await agentApi.getTimeline({
        chatId,
        knownRevision: session.sync.timelineRevision,
      })
      replaceTimelineSnapshot(chatId, timeline)
    }
  }

  async function closeSession(chatId: string): Promise<void> {
    const subscriptionId = sessionsById.value[chatId]?.sync.subscriptionId
    if (!subscriptionId) return
    await agentApi.closeChat(subscriptionId)
    const session = sessionsById.value[chatId]
    if (session) session.sync.subscriptionId = undefined
  }

  function makeClientId(prefix: string): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  function cloneAttachments(
    attachments: ChatSendAttachment[] | undefined,
  ): ChatSendAttachment[] | undefined {
    return attachments?.map((attachment) => ({ ...attachment }))
  }

  /** Synchronously transfer the editor draft into the root queue projection.
   * Runtime selection and the command RPC may still be pending afterwards. */
  function prepareInput(chatId: string, content: string): PreparedChatInput {
    const clientMessageId = makeClientId('client-msg')
    const commandId = makeClientId('command')
    const messageId = makeClientId('message')
    const provisionalInputId = `optimistic-input:${clientMessageId}`
    const session = ensureEntity(chatId)
    // ACK 与首个 turn/stream event 之间可能跨越多轮 LLM 调用；工作视觉不能
    // 等待首个带 messageId 的 delta。请求失败时仅回滚本次自己启动的工作态。
    const started = beginLiveRun(session, effects.value.onWorkingChange ?? noop)
    const optimisticId = messageId
    const optimisticNow = Date.now()
    session.messagesById[optimisticId] = {
      msgId: optimisticId,
      role: 'user',
      thinking: '',
      content,
      senseCalls: [],
      status: 'sealed',
      createdAt: optimisticNow,
      updatedAt: optimisticNow,
      agentChatId: chatId,
      delivery: {
        status: 'sending',
        commandId,
        clientMessageId,
        provisionalInputId,
      },
    }
    session.messageOrder.push(optimisticId)

    const rootChatId = rootIdOf(chatId)
    const rootState = (rootTimelineStates.value[rootChatId] ??= createRootTransientState())
    if (rootState) {
      rootState.pendingInputs.push({
        chatId,
        inputId: provisionalInputId,
        clientMessageId,
        messageId,
        content,
        state: 'accepted',
        acceptedAt: optimisticNow,
        createdAt: optimisticNow,
      })
      rootState.activeRuns = rootState.activeRuns.filter((run) => run.chatId !== chatId)
      rootState.activeRuns.push({ chatId, runId: commandId, status: 'running' })
    }

    return {
      chatId,
      content,
      clientMessageId,
      commandId,
      messageId,
      provisionalInputId,
      startedRun: started,
    }
  }

  function rollbackPreparedInput(prepared: PreparedChatInput, error?: unknown): void {
    const session = sessionsById.value[prepared.chatId]
    if (!session) return
    const message = session.messagesById[prepared.messageId]
    if (
      message?.delivery?.commandId === prepared.commandId &&
      message.delivery.status === 'committed'
    ) {
      return
    }
    if (message?.delivery?.commandId === prepared.commandId) {
      message.delivery.status = 'failed'
      message.delivery.error = commandErrorFact(error, '发送失败')
      message.updatedAt = Date.now()
    }
    const rootState = rootTimelineStates.value[rootIdOf(prepared.chatId)]
    if (rootState) {
      rootState.pendingInputs = rootState.pendingInputs.filter(
        (input) => input.inputId !== prepared.provisionalInputId,
      )
      rootState.activeRuns = rootState.activeRuns.filter(
        (run) => run.chatId !== prepared.chatId || run.runId !== prepared.commandId,
      )
    }
    if (prepared.startedRun) {
      session.run.status = error ? 'paused' : 'idle'
      session.run.error = error instanceof Error ? error.message : error ? '发送失败' : undefined
      ;(effects.value.onWorkingChange ?? noop)(prepared.chatId, false)
    }
  }

  /** Retry one failed optimistic message with the original idempotency keys. */
  async function retryInput(
    chatId: string,
    messageId: string,
    attachments?: ChatSendAttachment[],
  ): Promise<PendingInput> {
    const session = sessionsById.value[chatId]
    const message = session?.messagesById[messageId]
    if (!session || !message?.delivery || message.delivery.status !== 'failed') {
      const error = new Error('只有发送失败的消息可以重试') as Error & { code: string }
      error.code = 'MESSAGE_NOT_RETRYABLE'
      throw error
    }
    const startedRun = beginLiveRun(session, effects.value.onWorkingChange ?? noop)
    message.delivery.status = 'sending'
    delete message.delivery.error
    const retryAttachments = cloneAttachments(attachments ?? message.delivery.attachments)
    const prepared: PreparedChatInput = {
      chatId,
      content: message.content,
      ...(retryAttachments ? { attachments: cloneAttachments(retryAttachments) } : {}),
      clientMessageId: message.delivery.clientMessageId,
      commandId: message.delivery.commandId,
      messageId,
      provisionalInputId: message.delivery.provisionalInputId,
      startedRun,
    }
    const rootState = (rootTimelineStates.value[rootIdOf(chatId)] ??= createRootTransientState())
    if (!rootState.pendingInputs.some((input) => input.inputId === prepared.provisionalInputId)) {
      rootState.pendingInputs.push({
        chatId,
        inputId: prepared.provisionalInputId,
        clientMessageId: prepared.clientMessageId,
        messageId,
        content: message.content,
        state: 'accepted',
        acceptedAt: Date.now(),
      })
    }
    return submitInput(chatId, message.content, retryAttachments, prepared)
  }

  /** Failed local messages have no durable server entity and may be removed safely. */
  function removeFailedInput(chatId: string, messageId: string): boolean {
    const session = sessionsById.value[chatId]
    const message = session?.messagesById[messageId]
    if (!session || message?.delivery?.status !== 'failed') return false
    delete session.messagesById[messageId]
    session.messageOrder = session.messageOrder.filter((id) => id !== messageId)
    const rootState = rootTimelineStates.value[rootIdOf(chatId)]
    if (rootState) {
      rootState.pendingInputs = rootState.pendingInputs.filter(
        (input) =>
          input.messageId !== messageId &&
          input.clientMessageId !== message.delivery?.clientMessageId,
      )
    }
    return true
  }

  /** V2 command ACK: stable IDs are installed before any transient event arrives. */
  async function submitInput(
    chatId: string,
    content: string,
    attachments?: ChatSendAttachment[],
    preparedInput?: PreparedChatInput,
  ): Promise<PendingInput> {
    const prepared = preparedInput ?? prepareInput(chatId, content)
    const submittedAttachments = cloneAttachments(attachments ?? prepared.attachments)
    prepared.attachments = cloneAttachments(submittedAttachments)
    const preparedMessage = sessionsById.value[chatId]?.messagesById[prepared.messageId]
    if (preparedMessage?.delivery?.commandId === prepared.commandId) {
      preparedMessage.delivery.attachments = cloneAttachments(submittedAttachments)
    }
    const gate = commandAvailability(chatId)
    if (!gate.allowed) {
      const cause = commandGateError(gate)
      rollbackPreparedInput(prepared, cause)
      throw cause
    }
    if (prepared.chatId !== chatId || prepared.content !== content) {
      rollbackPreparedInput(prepared)
      throw new Error('预备输入与提交内容不一致')
    }
    const { clientMessageId, commandId, messageId } = prepared
    const session = ensureEntity(chatId)
    const rootState = rootTimelineStates.value[rootIdOf(chatId)]

    let accepted: Awaited<ReturnType<typeof agentApi.submitChatInput>>
    try {
      accepted = await agentApi.submitChatInput({
        chatId,
        commandId,
        clientMessageId,
        messageId,
        content,
        attachments: submittedAttachments,
      })
    } catch (error) {
      rollbackPreparedInput(prepared, error)
      throw error
    }
    const pending: PendingInput = {
      inputId: accepted.inputId,
      clientMessageId: accepted.clientMessageId || clientMessageId,
      messageId: accepted.messageId,
      content,
      state: accepted.state === 'started' ? 'accepted' : accepted.state,
      queueSequence: accepted.queueSequence,
      acceptedAt: accepted.acceptedAt,
    }
    const optimistic = session.messagesById[messageId]
    if (optimistic) {
      if (optimistic.delivery) {
        optimistic.delivery.status = 'committed'
        delete optimistic.delivery.error
      }
      if (accepted.messageId !== messageId) {
        optimistic.msgId = accepted.messageId
        session.messagesById[accepted.messageId] = optimistic
        delete session.messagesById[messageId]
        const messageIndex = session.messageOrder.indexOf(messageId)
        if (messageIndex >= 0) session.messageOrder[messageIndex] = accepted.messageId
      }
    }
    const old = session.pendingInputs.findIndex((i) => i.inputId === pending.inputId)
    if (old >= 0) session.pendingInputs.splice(old, 1, pending)
    else session.pendingInputs.push(pending)
    if (rootState) {
      const rootPending = { ...pending, chatId }
      const pendingIndex = rootState.pendingInputs.findIndex(
        (input) =>
          input.inputId === pending.inputId || input.clientMessageId === pending.clientMessageId,
      )
      if (pendingIndex >= 0) rootState.pendingInputs.splice(pendingIndex, 1, rootPending)
      else rootState.pendingInputs.push(rootPending)
      if (accepted.runId) {
        rootState.activeRuns = rootState.activeRuns.filter((run) => run.chatId !== chatId)
        rootState.activeRuns.push({ chatId, runId: accepted.runId, status: 'running' })
      }
    }
    return pending
  }

  /** Root 订阅活跃时，per-chat seq 因 root 流不推进而频发 false gap；此时 root 流权威，
   *  resync 不应开 per-session 订阅与 root observer 竞态，仅清态并重置 seq。 */
  function resyncOrClear(chatId: string, session: ChatSession): void {
    if (!session.sync.resyncRequired) return
    if (rootSubscriptions.value[rootIdOf(chatId)]) {
      session.sync.resyncRequired = false
      session.sync.eventSeq = undefined
      return
    }
    void openSession(chatId).catch((e) => console.warn(`[chats] V2 resync ${chatId} 失败:`, e))
  }

  /**
   * WS 事件应用：单 session 数据经 reducer；跨 session 事件（role_created/role_reply/role_destroyed）
   * 路由 + 副作用（gated by session.sync.replaying）。
   */
  function applyEvent(
    chatId: string,
    event: ChatEvent,
    provenance: ChatEventProvenance = 'live',
  ): void {
    const ctx: ReduceContext = { now: Date.now() }
    const session = ensureEntity(chatId)

    if (event.kind === 'session') {
      // chat.sync replays the original turn deltas one envelope at a time.
      // Advance the canonical event cursor, but do not rebuild transient UI
      // from those historical deltas; chat.attach supplies one activeTurns block.
      const reducedEvent =
        provenance === 'replay' && REPLAY_TRANSIENT_EVENT_TYPES.has(event.type)
          ? { ...event, type: 'replay.ignored' }
          : event
      const currentEventSeq = session.sync.eventSeq ?? 0
      if (reducedEvent !== event && event.eventSeq === currentEventSeq + 1) {
        const data =
          event.data && typeof event.data === 'object'
            ? (event.data as Record<string, unknown>)
            : (event as unknown as Record<string, unknown>)
        const runId =
          typeof data.runId === 'string'
            ? data.runId
            : typeof event.runId === 'string'
              ? event.runId
              : (session.activeRun?.runId ?? session.run.activeRunId)
        session.executionSteps = applyExecutionTimingEvent(session.executionSteps, {
          chatId,
          ...(runId ? { runId } : {}),
          type: event.type,
          data,
        })
      }
      reduceSessionEvent(session, reducedEvent, ctx)
      resyncOrClear(chatId, session)
      return
    }
    // A V2 subscription supplies turn.delta with explicit offsets. Legacy stream
    // chunks are emitted in parallel during rollout; consuming both would append
    // every token twice. Staged/history chunks remain available until timeline
    // snapshot migration is complete.
    if (event.kind === 'chunk' && event.type === 'stream' && provenance === 'replay') {
      const sequenced = toSequencedSessionEvent(event)
      if (sequenced) {
        reduceSessionEvent(session, { ...sequenced, type: 'replay.ignored' }, ctx)
        resyncOrClear(chatId, session)
      }
      return
    }
    if (event.kind === 'chunk' && event.type === 'stream' && session.sync.subscriptionId) {
      const sequenced = toSequencedSessionEvent(event)
      if (sequenced) {
        reduceSessionEvent(session, { ...sequenced, type: 'legacy.stream' }, ctx)
      } else {
        // V2 迁移期 stream chunk 无 eventSeq（createChunk 不注入），toSequencedSessionEvent
        // 返回 undefined 致整段丢弃 -> activeMessage 不累积 -> CRT 空、树无 streaming 节点。
        // fallback 走 reduceChunk（建/续 activeMessage + 累积 thinking/content）；V2 turn 事件
        // 就绪（带 eventSeq）后走 sequenced 分支，此处不触发，无重复累积风险。
        reduce(session, event, ctx)
      }
      resyncOrClear(chatId, session)
      return
    }
    if (event.kind === 'notification') {
      const type = event.type
      if (type === 'role_created') {
        handleRoleCreated(event, ctx, provenance)
        return
      }
      if (type === 'role_reply') {
        handleRoleReply(event, ctx, provenance)
        return
      }
      if (type === 'role_destroyed') {
        const d = (event.data ?? {}) as { chatId?: string }
        const target = d.chatId ?? chatId
        if (target) {
          deleteSession(target)
          if (provenance === 'live') {
            ;(effects.value.onRoleDestroyed ?? noop)(target)
          }
        }
        return
      }
      // All remaining compatibility notifications from chat.sync are
      // historical. Staged chunks/timeline patches restore durable messages;
      // replayed done/error/consumed must not mutate live run or bubble state.
      // Exception: terminal facts (done/error) must survive event-gap replay —
      // a replayed terminal notification is idempotent (seal run.status), and
      // swallowing it leaves canonical run.status stuck at running (no resync
      // path repairs canonical sessions). Historical chat.sync replay is still
      // fully skipped via session.sync.replaying.
      const terminalReplay = !session.sync.replaying && (type === 'done' || type === 'error')
      if (provenance === 'replay' && !terminalReplay) return
      if (type === 'consumed') {
        const d = (event.data ?? {}) as {
          messages?: Array<{
            id: string
            role: 'user'
            content: string
            createdAt: number
            updateAt: number
          }>
        }
        if (d.messages?.length) {
          // 乐观临时项 rekey：requestId 关联的 temp msgId 先移除，再 upsert 真实 msgId
          rekeyOptimisticUser(chatId, event.requestId, d.messages)
          reduceConsumed(session, d.messages)
        }
        return
      }
      if (type === 'auto_compacted') {
        if (provenance === 'live' && !session.sync.replaying) {
          ;(effects.value.onAutoCompacted ?? noop)(
            (event.data ?? {}) as { reason?: string; usedBefore?: number; total?: number },
          )
        }
        return
      }
    }

    // 单 session 数据变更
    const prevStatus = session.run.status
    reduce(session, event, ctx)

    // 工作态副作用：run.status 跨 running 阈值时通知 pet。
    // V2 发送经 chatSessions，setWorking 不再由 agents.store 驱动 → 经 effect 注入。
    // 回放期（chat.sync 历史）不触发实时 pet 动画。
    if (
      provenance === 'live' &&
      !session.sync.replaying &&
      session.run.status !== prevStatus &&
      (prevStatus === 'running' || session.run.status === 'running')
    ) {
      if (session.run.status === 'running') {
        ;(effects.value.onWorkingChange ?? noop)(chatId, true)
      } else {
        ;(effects.value.onWorkingChange ?? noop)(chatId, false, session.run.retainUntil)
      }
    }
  }

  /** role_created：建子 catalog 实体 + meta；副作用（createPet）仅 live 期触发。 */
  function handleRoleCreated(
    event: NotificationMessage,
    _ctx: ReduceContext,
    provenance: ChatEventProvenance,
  ): void {
    const d = (event.data ?? {}) as RoleCreatedData
    if (!d.chatId || !d.parentChatId || !d.type) {
      console.warn('[chats] role_created: 字段残缺', d)
      return
    }
    const child = ensureEntity(d.chatId, {
      chatId: d.chatId,
      parentChatId: d.parentChatId,
      agentType: d.type,
      avatar: d.avatar,
      wake: d.wake,
    })
    reduceRoleCreated(child, d)
    const parent = sessionsById.value[d.parentChatId]
    // Root subscription covers the whole tree's transient plane (turn/input/run
    // via applyRootTransientEvent); opening a per-session subscription is redundant
    // when root is active. Replay (hydrateTree) fills per-chat canonical via syncOne;
    // only live non-root spawns need openSession as the turn-event source.
    const rootActive = Boolean(rootSubscriptions.value[rootIdOf(d.chatId)])
    if (provenance === 'live' && !rootActive && !parent?.sync.replaying) {
      void openSession(d.chatId).catch((e) =>
        console.warn(`[chats] child session open ${d.chatId} 失败:`, e),
      )
    }
    if (provenance === 'live' && parent && !parent.sync.replaying) {
      ;(effects.value.onRoleCreated ?? noop)(d)
    }
  }

  /** role_reply：实时事件写父消息后续跑父会话；回放仅恢复消息，不得重新启动。 */
  function handleRoleReply(
    event: NotificationMessage,
    ctx: ReduceContext,
    provenance: ChatEventProvenance,
  ): void {
    const d = (event.data ?? {}) as RoleReplyData
    if (!d.parentChatId) {
      console.warn('[chats] role_reply: 缺 parentChatId', d)
      return
    }
    const parent = ensureEntity(d.parentChatId)
    reduceRoleReply(parent, d, ctx)
    if (shouldResumeRoleReply(provenance) && !parent.sync.replaying) {
      void resumeAgent(parent.chatId, { skipGate: true }).catch((error) =>
        console.error(`[chats] role_reply resume ${parent.chatId} 失败:`, error),
      )
    }
  }

  /**
   * 乐观临时用户消息 rekey：sendMessage 创建 temp msgId 入 messageOrder；
   * consumed/send-Response 携真实 msgId 到达时，按 requestId 关联移除 temp，由 reduceConsumed upsert 真实项。
   */
  function rekeyOptimisticUser(
    chatId: string,
    requestId: string | undefined,
    _messages: Array<{ id: string }>,
  ): void {
    const tempId = requestId ? requestMap.get(`optimistic:${requestId}`) : undefined
    if (!tempId) return
    const session = sessionsById.value[chatId]
    if (!session) return
    delete session.messagesById[tempId]
    session.messageOrder = session.messageOrder.filter((id) => id !== tempId)
    requestMap.delete(`optimistic:${requestId}`)
  }

  function trackRequest(requestId: string, chatId: string): void {
    if (requestId) requestMap.set(requestId, chatId)
  }

  // ---- hydration 内核（attach -> sync；启动/加载/重连共用）----

  /**
   * hydrate root + 全部后代。running chat 先 attach 重定向，再 sync(0/lastSeq) 回放。
   * 冷启动 / 显式 loadSession / 重连共用本内核；无 drawer 专属加载逻辑（不变式 4）。
   */
  async function hydrateTree(rootChatId: string): Promise<void> {
    const existing = hydrating.get(rootChatId)
    if (existing) return existing
    const promise = (async () => {
      const chats = Object.values(sessionsById.value).map((s) => ({
        chatId: s.chatId,
        parentChatId: s.meta.parentChatId,
      }))
      const descendantIds = collectDescendantChatIds(chats, rootChatId)
      const allIds = [rootChatId, ...descendantIds]

      // 1. running chat 先 attach（仅重定向；不提前跳 cursor，sync 从当前 cursor 回放）
      const runningIds = new Set<string>()
      for (const id of allIds) {
        const s = sessionsById.value[id]
        if (!s?.meta.running) continue
        try {
          const res = await agentApi.attachChat(id)
          if (res.running) runningIds.add(id)
        } catch (e) {
          console.warn(`[chats] attachChat 失败 ${id}:`, e)
        }
      }

      // 2. 逐 chat sync 回放（顺序：先 root 后 descendants，保证父消息先就位）
      for (const id of allIds) {
        await syncOne(id, runningIds.has(id))
      }
    })()
    hydrating.set(rootChatId, promise)
    try {
      await promise
    } finally {
      hydrating.delete(rootChatId)
    }
  }

  /**
   * 工作台打开即恢复提问快照（防止"无卡片无按钮"硬死锁，见 docs/web/pet/agent-integration.md）。
   * 提问态只活在前端事件流（question_batch_requested）；重启后非 running 会话不 attach，
   * 工作台的 acquireRootTimeline/getTaskTimeline 均不带 pendingQuestionBatches，必须经 syncOne
   * 快照恢复。running 会话靠 live 事件驱动不重复回放；已 hydration 且已有批次即就绪。
   */
  async function ensureQuestionHydrated(rootChatId: string): Promise<void> {
    const session = sessionsById.value[rootChatId]
    if (session?.meta.running) return
    if (session?.sync.loaded && session.interaction.questionBatches.length > 0) return
    await hydrateTree(rootChatId)
  }

  /**
   * 单 chat sync 回放。replaying 一律 true（含非运行 chat）：历史 role_reply/done 不得触发
   * resumeAgent/retainUntil，历史 stream delta 不得累加进气泡。回放结束清 false，running 保留实时态。
   * 注：question snapshot 推进致 snapshotSeq 前移的二次回放边界（旧 syncOneChat 2-attempt）暂单次处理，
   * 该边界由后端保证持久化一致；如遇 question 批次缺失需补，后续按 needsQuestionReplay 加循环。
   */
  async function syncOne(chatId: string, running: boolean): Promise<void> {
    const session = ensureEntity(chatId)
    setReplaying(session, true)
    let afterSeq = wsClient.getLastSeq(chatId)
    for (let attempt = 0; attempt < 2; attempt++) {
      const { requestId, done } = agentApi.syncChat(chatId, afterSeq)
      trackRequest(requestId, chatId)
      replayRequestIds.add(requestId)
      const response = await done.finally(() => {
        requestMap.delete(requestId)
        replayRequestIds.delete(requestId)
      })
      if (!response.success) break
      const data = (response.data ?? {}) as {
        latestSeq?: number
        snapshotSeq?: number
        pendingQuestionBatches?: ChatSessionSnapshot['pendingQuestionBatches']
        currentState?: ChatSessionSnapshot['currentState']
        runtime?: ChatSessionSnapshot['runtime']
        preset?: string
        canResume?: boolean
        contextUsage?: number
        contextUsed?: number
        contextTotal?: number
        contextBreakdown?: ChatSessionSnapshot['contextBreakdown']
        commandConfig?: ChatSessionSnapshot['commandConfig']
        workspace?: string
        workspaceValid?: boolean
      }
      // snapshot 在 snapshotSeq 边界权威 replace；latestSeq 推进 wsClient cursor（drop 已回放事件）
      replaceSnapshot(chatId, {
        chatId,
        ...(data.runtime ? { runtime: data.runtime } : {}),
        ...(data.preset !== undefined ? { preset: data.preset } : {}),
        ...(data.canResume !== undefined ? { canResume: data.canResume } : {}),
        ...(data.currentState !== undefined ? { currentState: data.currentState } : {}),
        ...(data.contextUsage !== undefined ? { contextUsage: data.contextUsage } : {}),
        ...(data.contextUsed !== undefined ? { contextUsed: data.contextUsed } : {}),
        ...(data.contextTotal !== undefined ? { contextTotal: data.contextTotal } : {}),
        ...(data.contextBreakdown ? { contextBreakdown: data.contextBreakdown } : {}),
        ...(data.commandConfig ? { commandConfig: data.commandConfig } : {}),
        ...(data.workspace !== undefined ? { workspace: data.workspace } : {}),
        ...(data.workspaceValid !== undefined ? { workspaceValid: data.workspaceValid } : {}),
        ...(data.snapshotSeq !== undefined ? { snapshotSeq: data.snapshotSeq } : {}),
        ...(data.pendingQuestionBatches !== undefined
          ? { pendingQuestionBatches: data.pendingQuestionBatches }
          : {}),
      })
      if (typeof data.latestSeq === 'number') {
        wsClient.resetChatSeq(chatId, data.latestSeq)
      }
      // question snapshot 未推进则结束；推进则按 snapshotSeq 二次回放
      if (typeof data.snapshotSeq !== 'number' || data.snapshotSeq <= afterSeq) break
      afterSeq = data.snapshotSeq
    }
    setReplaying(session, false)
    markLoaded(session, wsClient.getLastSeq(chatId))
    if (running && session.run.status !== 'ended' && session.run.status !== 'paused') {
      // sync 回放若已消费 done/error，reducer 已写入 ended/paused；不能再用 attach
      // 前的旧 running 标记把会话反向改回 running。
      session.run.status = 'running'
      ;(effects.value.onWorkingChange ?? noop)(chatId, true)
    }
  }

  // ---- 命令 actions（消费层 #10 调用；委托 agentApi，事件经 wsClient -> applyEvent 回流）----

  /** 发送消息：乐观 push user 消息 + 流式 send。 */
  async function sendMessage(
    chatId: string,
    text: string,
    attachments?: ChatSendAttachment[],
  ): Promise<void> {
    const session = ensureEntity(chatId)
    // 清上一轮残留：封口 active + 清 error + 重置 run
    if (session.activeMessageId) {
      const am = session.messagesById[session.activeMessageId]
      if (am && am.status === 'streaming') am.status = 'sealed'
      session.activeMessageId = undefined
    }
    const started = beginLiveRun(session, effects.value.onWorkingChange ?? noop)

    const { requestId, done } = agentApi.sendMessage(chatId, text, attachments)
    trackRequest(requestId, chatId)
    // 乐观 user 消息（temp msgId；consumed/Response 到达后 rekey 为真实 msgId）
    const optimisticId = `optimistic-${requestId}`
    requestMap.set(`optimistic:${requestId}`, optimisticId)
    session.messagesById[optimisticId] = {
      msgId: optimisticId,
      role: 'user',
      thinking: '',
      content: text,
      senseCalls: [],
      status: 'sealed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentChatId: chatId,
    }
    session.messageOrder.push(optimisticId)

    try {
      const response = await done
      if (response.success) {
        const data = (response.data ?? {}) as { userMsgId?: string; runId?: string }
        if (data.runId) session.run.activeRunId = data.runId
        // Response 携 userMsgId -> 原地 rekey 乐观项为真实 msgId（consumed 未到也不残留 temp）。
        // 若 consumed 已先到并 rekey 过（opt 已删），此处 opt=undefined 跳过。
        if (data.userMsgId && data.userMsgId !== optimisticId) {
          const opt = session.messagesById[optimisticId]
          if (opt) {
            opt.msgId = data.userMsgId
            session.messagesById[data.userMsgId] = opt
            delete session.messagesById[optimisticId]
            const idx = session.messageOrder.indexOf(optimisticId)
            if (idx >= 0) session.messageOrder[idx] = data.userMsgId
          }
          requestMap.delete(`optimistic:${requestId}`)
        }
      }
    } catch (e) {
      if (started) {
        session.run.status = 'paused'
        session.run.error = e instanceof Error ? e.message : '连接中断'
        session.run.activeRunId = undefined
        ;(effects.value.onWorkingChange ?? noop)(chatId, false)
      }
    }
  }

  async function resumeAgent(chatId: string, options: { skipGate?: boolean } = {}): Promise<void> {
    if (!options.skipGate) {
      const gate = commandAvailability(chatId)
      if (!gate.allowed) throw commandGateError(gate)
    }
    // 重入保护：连续双击「继续」只发起一次 resumeChat（复用 runSingleFlight，S7）。
    // 重入的调用方拿到同一个进行中的 promise；失败由首发起方回滚并抛错。
    return runSingleFlight(resumingChats, chatId, async () => {
      const session = ensureEntity(chatId)
      const started = beginLiveRun(session, effects.value.onWorkingChange ?? noop)
      try {
        const { requestId, done } = agentApi.resumeChat(chatId)
        trackRequest(requestId, chatId)
        const response = await done
        if (!response.success) {
          throw responseError(response, '恢复执行失败')
        }
        const data = (response.data ?? {}) as { runId?: string }
        if (data.runId) session.run.activeRunId = data.runId
      } catch (e) {
        if (started) {
          session.run.status = 'paused'
          session.run.error = e instanceof Error ? e.message : '连接中断'
          session.run.activeRunId = undefined
          ;(effects.value.onWorkingChange ?? noop)(chatId, false)
        }
        throw e
      }
    })
  }

  async function abortAgent(chatId: string): Promise<void> {
    const gate = commandAvailability(chatId)
    if (!gate.allowed) throw commandGateError(gate)
    const session = ensureEntity(chatId)
    const response = await agentApi.abortAgent(
      chatId,
      session.run.activeRunId,
      makeClientId('pause'),
    )
    // 级联（统一暂停语义）：后端已递归暂停主+全部后代（results 含每 chat 终态）。
    // 前端同步各 session 运行态 + canResume 镜像，子 pet 视觉立即解除工作态（不等 WS 通知）。
    // outcome=unchanged 的 idle/paused 项本非 running，置 paused 幂等无害。
    for (const r of response?.results ?? []) {
      const s = sessionsById.value[r.chatId]
      if (!s) continue
      const wasRunning = s.run.status === 'running'
      s.run.status = 'paused'
      s.run.activeRunId = undefined
      s.interaction.approval = undefined
      s.interaction.approvalQueue = []
      s.interaction.runningTools = []
      // canResume 镜像：暂停即可续，但存在待答提问时仍不可续（computeCanResume 短路一致，
      // 由 questionBatches 覆盖「继续」判定为「回答提问」）。
      s.context.canResume = s.interaction.questionBatches.length === 0
      if (wasRunning || r.outcome === 'stopped') {
        ;(effects.value.onWorkingChange ?? noop)(r.chatId, false)
      }
    }
  }

  async function resumeTree(rootChatId: string, pauseId: string): Promise<void> {
    const gate = commandAvailability(rootChatId)
    if (!gate.allowed) throw commandGateError(gate)
    const operationKey = `${rootChatId}:${pauseId}`
    return runSingleFlight(resumingTrees, operationKey, async () => {
      await agentApi.resumeTree(rootChatId, pauseId, makeClientId('resume-tree'))
    })
  }

  async function submitApproval(
    chatId: string,
    approvalId: string,
    action: 'accept' | 'reject',
  ): Promise<void> {
    const interactions = useInteractionsStore()
    let record = interactions.records[approvalId]
    if (!record) {
      await interactions.refresh()
      record = interactions.records[approvalId]
    }
    if (!record || record.kind !== 'approval') throw new Error('审批待办不存在或已结束')
    await interactions.decide(record, action)
    // 即时清 pending（不等 accept/rejected notification 回来）
    const session = sessionsById.value[chatId]
    if (session) {
      if (session.interaction.approval?.approvalId === approvalId) {
        session.interaction.approval = undefined
        if (session.interaction.approvalQueue.length > 0) {
          session.interaction.approval = session.interaction.approvalQueue.shift()
        }
      }
    }
  }

  function dismissApproval(chatId: string): void {
    const session = sessionsById.value[chatId]
    if (!session) return
    session.interaction.approval = undefined
    if (session.interaction.approvalQueue.length > 0) {
      session.interaction.approval = session.interaction.approvalQueue.shift()
    }
  }

  function dismissApprovalToQueue(chatId: string): void {
    const session = sessionsById.value[chatId]
    if (!session?.interaction.approval) return
    const current = session.interaction.approval
    session.interaction.approval = session.interaction.approvalQueue.shift()
    session.interaction.approvalQueue.push(current)
  }

  function resummonApproval(chatId: string, approvalId: string): void {
    const session = sessionsById.value[chatId]
    if (!session) return
    const idx = session.interaction.approvalQueue.findIndex((a) => a.approvalId === approvalId)
    if (idx < 0) return
    const target = session.interaction.approvalQueue[idx]
    if (!target) return
    if (session.interaction.approval)
      session.interaction.approvalQueue.push(session.interaction.approval)
    session.interaction.approvalQueue.splice(idx, 1)
    session.interaction.approval = target
  }

  function expireApproval(chatId: string, approvalId: string): void {
    const session = sessionsById.value[chatId]
    if (!session) return
    if (session.interaction.approval?.approvalId === approvalId) {
      dismissApproval(chatId)
      return
    }
    session.interaction.approvalQueue = session.interaction.approvalQueue.filter(
      (approval) => approval.approvalId !== approvalId,
    )
  }

  function setActiveQuestion(chatId: string, questionId: string | undefined): void {
    const session = sessionsById.value[chatId]
    if (session) session.interaction.activeQuestionId = questionId
  }

  function updateQuestionDraft(
    chatId: string,
    questionId: string,
    draft?: QuestionDraftAnswer,
  ): void {
    const session = sessionsById.value[chatId]
    const question = session?.interaction.questionBatches
      .flatMap((batch) => batch.questions)
      .find((item) => item.questionId === questionId)
    if (!question) return
    if (draft) question.draftAnswer = draft
    else delete question.draftAnswer
  }

  async function advanceQuestion(
    chatId: string,
    questionId: string,
    draft: QuestionDraftAnswer,
  ): Promise<void> {
    const session = sessionsById.value[chatId]
    const batch = session?.interaction.questionBatches.find((item) =>
      item.questions.some((question) => question.questionId === questionId),
    )
    const question = batch?.questions.find((item) => item.questionId === questionId)
    if (!batch || !question || batch.status === 'submitting') return
    question.draftAnswer = draft
    question.localStatus = 'ready'
    const next = batch.questions.find((item) => item.localStatus === 'pending')
    if (next) {
      session!.interaction.activeQuestionId = next.questionId
      return
    }
    batch.status = 'submitting'
    try {
      const interactions = useInteractionsStore()
      let interaction = interactions.records[batch.batchId]
      if (!interaction) {
        await interactions.refresh()
        interaction = interactions.records[batch.batchId]
      }
      if (!interaction || interaction.kind !== 'question_batch') {
        throw new Error('问题待办不存在或已结束')
      }
      await interactions.answer(
        interaction,
        batch.questions.map((item) => ({
          questionId: item.questionId,
          selectedLabels: [...item.draftAnswer!.selectedLabels],
          ...(item.draftAnswer!.optionNotes ? { optionNotes: item.draftAnswer!.optionNotes } : {}),
          ...(item.draftAnswer!.freeText ? { freeText: item.draftAnswer!.freeText } : {}),
          ...(item.draftAnswer!.cancelled ? { cancelled: true } : {}),
        })),
      )
      session!.interaction.questionBatches = session!.interaction.questionBatches.filter(
        (item) => item.batchId !== batch.batchId,
      )
    } catch (error) {
      batch.status = 'pending'
      throw error
    }
  }

  async function cancelQuestion(chatId: string, questionId: string): Promise<void> {
    await advanceQuestion(chatId, questionId, { selectedLabels: [], cancelled: true })
  }

  function backQuestion(chatId: string, questionId: string): void {
    const session = sessionsById.value[chatId]
    const batch = session?.interaction.questionBatches.find((item) =>
      item.questions.some((question) => question.questionId === questionId),
    )
    const current = batch?.questions.find((item) => item.questionId === questionId)
    if (!batch || !current || batch.status === 'submitting') return
    const sorted = [...batch.questions].sort((a, b) => a.position - b.position)
    const index = sorted.findIndex((item) => item.questionId === questionId)
    const previous = index > 0 ? sorted[index - 1] : undefined
    if (!previous) return
    if (current.localStatus === 'ready') current.localStatus = 'pending'
    session!.interaction.activeQuestionId = previous.questionId
  }

  async function submitQuestionBatch(
    chatId: string,
    batchId: string,
    answers: Array<{
      questionId: string
      selectedLabels: string[]
      /** 每选项补充描述：label → note（可选，向后兼容；仅已选选项生效）。 */
      optionNotes?: Record<string, string>
      freeText?: string
      cancelled?: boolean
    }>,
  ): Promise<void> {
    const interactions = useInteractionsStore()
    let interaction = interactions.records[batchId]
    if (!interaction) {
      await interactions.refresh()
      interaction = interactions.records[batchId]
    }
    if (!interaction || interaction.chatId !== chatId || interaction.kind !== 'question_batch') {
      throw new Error('问题待办不存在或已结束')
    }
    await interactions.answer(interaction, answers)
  }

  // ---- 启动 / 重连（与旧 store 并行；迁移桥接，非破坏）----

  /**
   * 启动只建立轻量 catalog。完整 timeline/session state 必须由用户打开对应
   * root 时按需加载；后台运行状态来自 chat.list 摘要，不在首页回放历史事件。
   */
  async function startup(): Promise<void> {
    if (started) return
    started = true
    try {
      const summaries = await agentApi.listChats({ scope: 'stage' })
      initCatalog(summaries)
      // Catalog is intentionally lightweight. Running chats additionally need
      // one atomic attach snapshot so Pet receives the already-produced portion
      // in a single assignment rather than replaying historical turn.delta.
      await Promise.all(
        summaries
          .filter((summary) => summary.running)
          .map(async (summary) => {
            const snapshot = await agentApi.attachChat(summary.chatId)
            applyAttachRunSnapshot(summary.chatId, snapshot)
          }),
      )
    } catch (e) {
      // 失败不保留 started 位，下次 connected 可重试（对齐旧 initFromChats 语义）
      started = false
      throw e
    }
  }

  /**
   * 瞬断重连：root subscription 必须用最后确认的 revision/eventSeq 重开；
   * direct 兼容视图仍对 hydrated running session 执行 attach->sync(lastSeq)。
   * 不自动 resume paused chat（统一暂停语义：paused 显继续入口交用户）。
   */
  async function reconnect(): Promise<void> {
    const roots = Object.keys(rootSubscriptions.value)
    const running = Object.values(sessionsById.value).filter((s) => s.sync.loaded && s.meta.running)
    await Promise.all([
      ...roots.map((rootChatId) =>
        reopenRootSubscription(rootChatId).catch((e) =>
          console.warn(`[chats] root reconnect ${rootChatId} 失败:`, e),
        ),
      ),
      ...running.map(async (s) => {
        try {
          const snapshot = await agentApi.attachChat(s.chatId)
          applyAttachRunSnapshot(s.chatId, snapshot)
        } catch (e) {
          console.warn(`[chats] reconnect ${s.chatId} 失败:`, e)
        }
      }),
    ])
  }

  // ---- wsClient 订阅（迁移期 #10 由本方法挂载，替代旧 store 订阅）----

  let wsBound = false
  let unbindChunk: (() => void) | undefined
  let unbindNotif: (() => void) | undefined
  let unbindEvent: (() => void) | undefined

  /** Root subscription snapshots fence events at eventSeq. Compatibility notifications at or
   * before that boundary are historical even though they arrive on the same callback as live data. */
  function notificationProvenance(
    notification: NotificationMessage & {
      requestId?: string
      rootChatId?: unknown
      rootEventSeq?: unknown
      eventSeq?: unknown
      subscriptionId?: unknown
    },
  ): ChatEventProvenance {
    if (wsClient.isReplayEvent(notification)) return 'replay'
    if (notification.requestId && replayRequestIds.has(notification.requestId)) return 'replay'
    if (
      typeof notification.rootChatId === 'string' &&
      typeof notification.subscriptionId === 'string'
    ) {
      const subscription = rootSubscriptions.value[notification.rootChatId]
      const rootEventSeq = notification.rootEventSeq ?? notification.eventSeq
      if (
        subscription?.subscriptionId === notification.subscriptionId &&
        typeof rootEventSeq === 'number'
      ) {
        return rootEventSeq === subscription.eventSeq + 1 ? 'live' : 'replay'
      }
    }
    return 'live'
  }

  function bindWsClient(): void {
    if (wsBound) return
    wsBound = true
    unbindChunk = wsClient.onChunk((chunk) => {
      const c = chunk as ChunkMessage | null
      if (!c) return
      const chatId = c.chatId ?? (c.requestId ? requestMap.get(c.requestId) : undefined)
      if (!chatId) return
      const provenance: ChatEventProvenance = wsClient.isReplayEvent(c) ? 'replay' : 'live'
      const { kind: _kind, ...chunkData } = c
      void _kind
      applyEvent(chatId, { kind: 'chunk', ...chunkData } as ChatEvent, provenance)
    })
    unbindNotif = wsClient.onNotification((notif) => {
      const n = notif as (NotificationMessage & { background?: boolean }) | null
      if (!n?.type) return
      if (n.background) return
      const provenance = notificationProvenance(n)
      const isRootEvent = applyRootSubscriptionEvent(n)
      const chatId = n.chatId ?? (n.requestId ? requestMap.get(n.requestId) : undefined)
      // role_created/role_reply/role_destroyed 携自身 chatId（data.chatId / data.parentChatId）；
      // 路由优先用 envelope chatId，缺失时由 handler 内部从 data 取
      const target = chatId ?? ''
      // 旧 consumed/done 等通知与 turn.delta 共用 V2 的连续 eventSeq；先推进
      // canonical reducer 的序号，再走下面的兼容通知处理，避免下一条 delta 跳号被丢弃。
      // Root snapshot only fences the root cursor, not every source chat cursor.
      // Feeding sourceEventSeq into the per-chat reducer creates a false gap and
      // opens a direct subscription that races the authoritative root observer.
      if (!isRootEvent) {
        const sessionEvent = toSequencedSessionEvent(n)
        if (sessionEvent) applyEvent(sessionEvent.chatId, sessionEvent, provenance)
      }
      const { kind: _kind, ...notificationData } = n
      void _kind
      applyEvent(target, { kind: 'notification', ...notificationData } as ChatEvent, provenance)
    })
    unbindEvent = wsClient.onEvent((raw) => {
      // notification 已由 onNotification 统一推进 session 序号并处理兼容逻辑，
      // 不在泛事件订阅中重复应用。
      if ((raw as { kind?: unknown } | null)?.kind === 'notification') return
      const e = raw as Partial<ChatSessionEvent> | null
      const isRootEvent = e ? applyRootSubscriptionEvent(e) : false
      if (isRootEvent) return
      const eventSeq =
        e && typeof e.eventSeq === 'number'
          ? e.eventSeq
          : e && typeof (e as { seq?: unknown }).seq === 'number'
            ? (e as { seq: number }).seq
            : undefined
      if (!e?.type || eventSeq === undefined || typeof e.chatId !== 'string') return
      // Legacy notifications/chunks have no dotted V2 type; V2 events are kept
      // on a distinct reducer path and never mutate the staged history reducer.
      if (!e.type.includes('.')) return
      applyEvent(e.chatId, { ...e, kind: 'session', eventSeq } as ChatEvent)
    })
  }

  function unbindWsClient(): void {
    unbindChunk?.()
    unbindNotif?.()
    unbindEvent?.()
    wsBound = false
  }

  function bindEffects(e: ChatSessionEffects): void {
    effects.value = e
  }

  return {
    sessionsById,
    rootTimelines,
    rootTimelineStates,
    rootSubscriptions,
    // 实体管理
    ensureEntity,
    ensureCatalogEntity,
    initCatalog,
    deleteSession,
    evictSessions,
    observeRootTimeline,
    acquireRootTimeline,
    releaseRootTimeline,
    resyncRootTimeline,
    closeRootTimeline,
    rootTimeline,
    commandAvailability,
    applyRootTimelinePatch,
    loadGeneration,
    // 写入口
    replaceSnapshot,
    replaceTimelineSnapshot,
    applyTimelinePatchEvent,
    openSession,
    prepareInput,
    rollbackPreparedInput,
    retryInput,
    removeFailedInput,
    closeSession,
    submitInput,
    applyEvent,
    trackRequest,
    // hydration
    hydrateTree,
    ensureQuestionHydrated,
    syncOne,
    startup,
    reconnect,
    /** transient 实时权威运行态：error/done/run.updated 经 applyRootTransientEvent 即时清理，
     *  不受 rootTimeline 快照残留影响（快照在 acquire 时含 running run，终态事件不更新它）。 */
    rootLiveActiveRuns: (rootChatId: string) =>
      rootTimelineStates.value[rootChatId]?.activeRuns ?? [],
    /** 完整工作台与 Lite 共用的无副作用执行监控投影。 */
    executionReadModel: (rootChatId: string) =>
      selectExecutionReadModel({
        rootChatId,
        sessionsById: sessionsById.value,
        timeline:
          rootTimeline(rootChatId, 'conversation') ??
          rootTimeline(rootChatId, 'tree') ??
          rootTimeline(rootChatId, 'audit'),
        transient: rootTimelineStates.value[rootChatId],
      }),
    // 命令
    sendMessage,
    resumeAgent,
    resumeTree,
    abortAgent,
    submitApproval,
    dismissApproval,
    dismissApprovalToQueue,
    resummonApproval,
    expireApproval,
    setActiveQuestion,
    updateQuestionDraft,
    advanceQuestion,
    cancelQuestion,
    backQuestion,
    submitQuestionBatch,
    // 绑定
    bindWsClient,
    unbindWsClient,
    bindEffects,
  }
})
