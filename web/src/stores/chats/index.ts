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
  installRootTimeline,
  readRootTimeline,
  runSingleFlight,
  type RootTimelinePatchResult,
  type RootTimelineTransientState,
  type RootTimelineView,
} from './rootTimeline'

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

/** 仅实时 role_reply 可续跑父会话；历史回放只能恢复消息。 */
export function shouldResumeRoleReply(session: ChatSession): boolean {
  return !session.sync.replaying
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
  /** requestId -> chatId（流式 RPC chunk 路由用；chunk.chatId 缺失时兜底）。 */
  const requestMap = new Map<string, string>()
  /** 每 chat hydration in-flight 去重（避免并发 loadSession 重复 sync）。 */
  const hydrating = new Map<string, Promise<void>>()
  /** V2 chat.open in-flight 去重（event gap 期间可能同时收到多个事件）。 */
  const opening = new Map<string, Promise<void>>()
  /** Root event-stream resync guard. View revision gaps never reopen subscriptions. */
  const rootResyncing = new Map<string, Promise<void>>()
  /** One protocol subscription per root. Timeline views share this flight. */
  const rootSubscriptionOpening = new Map<
    string,
    Promise<{ opened: boolean; conversation?: RootTimelineSnapshot }>
  >()
  /** Snapshot reads are independent from the root subscription and dedupe per view. */
  const rootViewOpening = new Map<string, Promise<RootTimelineSnapshot>>()
  /** Latest root selected by the UI. A late response from an older selection
   * is closed instead of being allowed to take subscription ownership back. */
  let observedRootChatId: string | undefined
  let rootObservationEpoch = 0
  /** startup 幂等守卫（首次成功后不再重跑；F5 重连由 reconnect 处理）。 */
  let started = false
  const effects = ref<ChatSessionEffects>({})

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

  async function closeStaleRootSubscriptions(rootChatId: string): Promise<void> {
    const stale = Object.entries(rootSubscriptions.value).filter(([id]) => id !== rootChatId)
    for (const [id, subscription] of stale) {
      delete rootSubscriptions.value[id]
      await agentApi.closeChat(subscription.subscriptionId).catch(() => undefined)
    }
  }

  /** Stop observing one root without touching its Agent runtime. Cached durable
   * nodes remain available for an instant stale-while-revalidate reopen. */
  async function closeRootTimeline(rootChatId: string): Promise<void> {
    if (observedRootChatId === rootChatId) {
      observedRootChatId = undefined
      rootObservationEpoch += 1
    }
    const subscription = rootSubscriptions.value[rootChatId]
    if (!subscription) return
    delete rootSubscriptions.value[rootChatId]
    await agentApi.closeChat(subscription.subscriptionId).catch(() => undefined)
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
      installActiveTurns(session, session.activeTurns, Date.now())
      const run = response.state.runs?.find((candidate) => candidate.chatId === chatId)
      session.activeRun = run
      session.run.activeRunId = run?.runId
      session.run.status = run ? 'running' : 'idle'
      session.sync.loaded = true
    }
  }

  async function ensureRootSubscription(
    rootChatId: string,
  ): Promise<{ opened: boolean; conversation?: RootTimelineSnapshot }> {
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
      rootSubscriptions.value[rootChatId] = {
        subscriptionId: opened.subscriptionId,
        eventSeq: opened.eventSeq,
      }
      const localTransient = rootTimelineStates.value[rootChatId]
      const openedTransient = createRootTransientState(opened.state)
      if (localTransient) {
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
      return { opened: true, conversation: opened.rootTimeline }
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

  /** Observe one visible Nexus root. UI supplies only the selected root/view;
   * this message-layer controller owns subscription replacement and snapshots. */
  async function observeRootTimeline(
    rootChatId: string,
    view: 'conversation' | 'tree' | 'audit' = 'conversation',
  ): Promise<RootTimelineSnapshot> {
    if (observedRootChatId !== rootChatId) {
      observedRootChatId = rootChatId
      rootObservationEpoch += 1
    }
    const observationEpoch = rootObservationEpoch
    await closeStaleRootSubscriptions(rootChatId)
    const subscription = await ensureRootSubscription(rootChatId)
    if (observedRootChatId !== rootChatId || observationEpoch !== rootObservationEpoch) {
      await closeRootTimeline(rootChatId)
      throw new Error(`Root observation superseded: ${rootChatId}`)
    }
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
    const cachedViews = [...new Set(views)].filter((view) => Boolean(rootTimeline(rootChatId, view)))
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

  function applyRootSubscriptionEvent(event: {
    rootChatId?: unknown
    rootEventSeq?: unknown
    eventSeq?: unknown
    subscriptionId?: unknown
    type?: unknown
    data?: unknown
  }): boolean {
    if (
      typeof event.rootChatId !== 'string' ||
      typeof (event.rootEventSeq ?? event.eventSeq) !== 'number' ||
      typeof event.subscriptionId !== 'string'
    )
      return false
    const rootEventSeq = (event.rootEventSeq ?? event.eventSeq) as number
    const subscription = rootSubscriptions.value[event.rootChatId]
    if (!subscription || subscription.subscriptionId !== event.subscriptionId) return false
    if (rootEventSeq <= subscription.eventSeq) return true
    if (rootEventSeq !== subscription.eventSeq + 1) {
      void reopenRootSubscription(event.rootChatId).catch((e) =>
        console.warn(`[chats] root subscription resync ${event.rootChatId} 失败:`, e),
      )
      return true
    }
    subscription.eventSeq = rootEventSeq
    const transient = (rootTimelineStates.value[event.rootChatId] ??= createRootTransientState())
    applyRootTransientEvent(transient, event)
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
    installActiveTurns(session, session.activeTurns, Date.now())
    session.activeRun = response.state.run
    if (response.state.run) {
      session.run.activeRunId = response.state.run.runId
      const runState = response.state.run.status ?? response.state.run.state
      session.run.status =
        runState === 'running' || runState === 'waiting'
          ? 'running'
          : runState === 'paused'
            ? 'paused'
            : 'ended'
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

  /** Synchronously transfer the editor draft into the root queue projection.
   * Runtime selection and the command RPC may still be pending afterwards. */
  function prepareInput(chatId: string, content: string): PreparedChatInput {
    const clientMessageId = makeClientId('client-msg')
    const commandId = makeClientId('command')
    const messageId = makeClientId('message')
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
    }
    session.messageOrder.push(optimisticId)

    const rootChatId = rootIdOf(chatId)
    const rootState = (rootTimelineStates.value[rootChatId] ??= createRootTransientState())
    const provisionalInputId = `optimistic-input:${clientMessageId}`
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
    delete session.messagesById[prepared.messageId]
    session.messageOrder = session.messageOrder.filter((id) => id !== prepared.messageId)
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

  /** V2 command ACK: stable IDs are installed before any transient event arrives. */
  async function submitInput(
    chatId: string,
    content: string,
    attachments?: ChatSendAttachment[],
    preparedInput?: PreparedChatInput,
  ): Promise<PendingInput> {
    const prepared = preparedInput ?? prepareInput(chatId, content)
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
        attachments,
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
    if (optimistic) optimistic.msgId = accepted.messageId
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
  function applyEvent(chatId: string, event: ChatEvent): void {
    const ctx: ReduceContext = { now: Date.now() }
    const session = ensureEntity(chatId)

    if (event.kind === 'session') {
      reduceSessionEvent(session, event, ctx)
      resyncOrClear(chatId, session)
      return
    }
    // A V2 subscription supplies turn.delta with explicit offsets. Legacy stream
    // chunks are emitted in parallel during rollout; consuming both would append
    // every token twice. Staged/history chunks remain available until timeline
    // snapshot migration is complete.
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
        handleRoleCreated(event, ctx)
        return
      }
      if (type === 'role_reply') {
        handleRoleReply(event, ctx)
        return
      }
      if (type === 'role_destroyed') {
        const d = (event.data ?? {}) as { chatId?: string }
        const target = d.chatId ?? chatId
        if (target) {
          deleteSession(target)
          ;(effects.value.onRoleDestroyed ?? noop)(target)
        }
        return
      }
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
        if (!session.sync.replaying) {
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
  function handleRoleCreated(event: NotificationMessage, _ctx: ReduceContext): void {
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
    if (!rootActive && !parent?.sync.replaying) {
      void openSession(d.chatId).catch((e) =>
        console.warn(`[chats] child session open ${d.chatId} 失败:`, e),
      )
    }
    if (parent && !parent.sync.replaying) {
      ;(effects.value.onRoleCreated ?? noop)(d)
    }
  }

  /** role_reply：实时事件写父消息后续跑父会话；回放仅恢复消息，不得重新启动。 */
  function handleRoleReply(event: NotificationMessage, ctx: ReduceContext): void {
    const d = (event.data ?? {}) as RoleReplyData
    if (!d.parentChatId) {
      console.warn('[chats] role_reply: 缺 parentChatId', d)
      return
    }
    const parent = ensureEntity(d.parentChatId)
    reduceRoleReply(parent, d, ctx)
    if (shouldResumeRoleReply(parent)) {
      void resumeAgent(parent.chatId).catch((error) =>
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
      const response = await done
      requestMap.delete(requestId)
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

  async function resumeAgent(chatId: string): Promise<void> {
    const session = ensureEntity(chatId)
    const started = beginLiveRun(session, effects.value.onWorkingChange ?? noop)
    try {
      const { requestId, done } = agentApi.resumeChat(chatId)
      trackRequest(requestId, chatId)
      const response = await done
      if (!response.success) {
        throw new Error(response.error?.message ?? '恢复执行失败')
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
  }

  async function abortAgent(chatId: string): Promise<void> {
    const session = ensureEntity(chatId)
    await agentApi.abortAgent(chatId, session.run.activeRunId, makeClientId('pause'))
    session.run.status = 'paused'
    session.run.activeRunId = undefined
    session.interaction.runningTools = []
    ;(effects.value.onWorkingChange ?? noop)(chatId, false)
  }

  async function submitApproval(
    chatId: string,
    approvalId: string,
    action: 'accept' | 'reject',
  ): Promise<void> {
    await agentApi.approval(approvalId, action)
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
      const response = await agentApi.answerQuestionBatch(
        chatId,
        batch.batchId,
        batch.questions.map((item) => ({
          questionId: item.questionId,
          selectedLabels: [...item.draftAnswer!.selectedLabels],
          ...(item.draftAnswer!.freeText ? { freeText: item.draftAnswer!.freeText } : {}),
          ...(item.draftAnswer!.cancelled ? { cancelled: true } : {}),
        })),
      )
      session!.interaction.questionBatches = session!.interaction.questionBatches.filter(
        (item) => item.batchId !== batch.batchId,
      )
      if (response.shouldResume) await resumeAgent(chatId)
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
      freeText?: string
      cancelled?: boolean
    }>,
  ): Promise<void> {
    await agentApi.answerQuestionBatch(chatId, batchId, answers)
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
      const summaries = await agentApi.listChats(false)
      initCatalog(summaries)
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
          const res = await agentApi.attachChat(s.chatId)
          if (res.running) await syncOne(s.chatId, true)
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

  function bindWsClient(): void {
    if (wsBound) return
    wsBound = true
    unbindChunk = wsClient.onChunk((chunk) => {
      const c = chunk as ChunkMessage | null
      if (!c) return
      const chatId = c.chatId ?? (c.requestId ? requestMap.get(c.requestId) : undefined)
      if (!chatId) return
      const { kind: _kind, ...chunkData } = c
      void _kind
      applyEvent(chatId, { kind: 'chunk', ...chunkData } as ChatEvent)
    })
    unbindNotif = wsClient.onNotification((notif) => {
      const n = notif as NotificationMessage | null
      if (!n?.type) return
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
        if (sessionEvent) applyEvent(sessionEvent.chatId, sessionEvent)
      }
      const { kind: _kind, ...notificationData } = n
      void _kind
      applyEvent(target, { kind: 'notification', ...notificationData } as ChatEvent)
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
    observeRootTimeline,
    resyncRootTimeline,
    closeRootTimeline,
    rootTimeline,
    applyRootTimelinePatch,
    // 写入口
    replaceSnapshot,
    replaceTimelineSnapshot,
    applyTimelinePatchEvent,
    openSession,
    prepareInput,
    rollbackPreparedInput,
    closeSession,
    submitInput,
    applyEvent,
    trackRequest,
    // hydration
    hydrateTree,
    syncOne,
    startup,
    reconnect,
    // 命令
    sendMessage,
    resumeAgent,
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
