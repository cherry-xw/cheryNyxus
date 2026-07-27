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
import type {
  ChatSummary,
  ChatSendAttachment,
  ChatSessionEvent,
  ChatOpenResponse,
  PendingInput,
  TimelinePatch,
  RootTimelineSnapshot,
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
  type ReduceContext,
} from './reducer'
import { collectDescendantChatIds } from '../agents/data/historyMerge'
import { selectRecentRootIds } from './selectors'
import { wsClient } from '@/services/ws'
import { agentApi } from '@/services/agentApi'
import type { ChunkMessage, NotificationMessage } from '../agents/types'

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

/** 注入副作用（pet lifecycle / resume / toast）；默认 no-op，#9 由 pet store 注入。 */
export interface ChatSessionEffects {
  onWorkingChange?: (chatId: string, working: boolean, freezeUntil?: number) => void
  onRoleCreated?: (data: RoleCreatedData) => void
  onRoleReply?: (data: RoleReplyData) => void
  onRoleDestroyed?: (chatId: string) => void
  onAutoCompacted?: (data: { reason?: string; usedBefore?: number; total?: number }) => void
}

const noop = (): void => {}

export const useChatSessionsStore = defineStore('chatSessions', () => {
  const sessionsById = ref<Record<string, ChatSession>>({})
  /** Root-owned projection; one snapshot covers the entire recursive tree. */
  const rootTimelines = ref<Record<string, RootTimelineSnapshot>>({})
  /** requestId -> chatId（流式 RPC chunk 路由用；chunk.chatId 缺失时兜底）。 */
  const requestMap = new Map<string, string>()
  /** 每 chat hydration in-flight 去重（避免并发 loadSession 重复 sync）。 */
  const hydrating = new Map<string, Promise<void>>()
  /** V2 chat.open in-flight 去重（event gap 期间可能同时收到多个事件）。 */
  const opening = new Map<string, Promise<void>>()
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

  async function openRootTimeline(
    rootChatId: string,
    view: 'conversation' | 'tree' | 'audit' = 'conversation',
  ): Promise<RootTimelineSnapshot> {
    const current = rootTimelines.value[rootChatId]
    const snapshot = await agentApi.getRootTimeline({
      rootChatId,
      view,
      ...(current ? { knownRevision: current.revision } : {}),
    })
    rootTimelines.value[rootChatId] = snapshot
    return snapshot
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
    replaceTimeline(session, snapshot)
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

  /** V2 command ACK: stable IDs are installed before any transient event arrives. */
  async function submitInput(
    chatId: string,
    content: string,
    attachments?: ChatSendAttachment[],
  ): Promise<PendingInput> {
    const clientMessageId = makeClientId('client-msg')
    const commandId = makeClientId('command')
    const session = ensureEntity(chatId)
    // ACK 与首个 turn/stream event 之间可能跨越多轮 LLM 调用；工作视觉不能
    // 等待首个带 messageId 的 delta。请求失败时仅回滚本次自己启动的工作态。
    const wasRunning = session.run.status === 'running'
    session.run.status = 'running'
    session.run.error = undefined
    session.run.retainUntil = undefined
    session.ui.bubbleVisible = true
    if (!wasRunning) {
      ;(effects.value.onWorkingChange ?? noop)(chatId, true)
    }

    let accepted: Awaited<ReturnType<typeof agentApi.submitChatInput>>
    try {
      accepted = await agentApi.submitChatInput({
        chatId,
        commandId,
        clientMessageId,
        content,
        attachments,
      })
    } catch (error) {
      if (!wasRunning) {
        session.run.status = 'paused'
        session.run.error = error instanceof Error ? error.message : '发送失败'
        ;(effects.value.onWorkingChange ?? noop)(chatId, false)
      }
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
    const old = session.pendingInputs.findIndex((i) => i.inputId === pending.inputId)
    if (old >= 0) session.pendingInputs.splice(old, 1, pending)
    else session.pendingInputs.push(pending)
    return pending
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
      if (event.type === 'timeline.patch') {
        void openRootTimeline(rootIdOf(chatId)).catch((e) =>
          console.warn(`[chats] root timeline refresh ${chatId} 失败:`, e),
        )
      }
      if (session.sync.resyncRequired) {
        void openSession(chatId).catch((e) => console.warn(`[chats] V2 resync ${chatId} 失败:`, e))
      }
      return
    }
    // A V2 subscription supplies turn.delta with explicit offsets. Legacy stream
    // chunks are emitted in parallel during rollout; consuming both would append
    // every token twice. Staged/history chunks remain available until timeline
    // snapshot migration is complete.
    if (event.kind === 'chunk' && event.type === 'stream' && session.sync.subscriptionId) return
    if (event.kind === 'notification') {
      const type = event.type
      if (type === 'role_created') {
        handleRoleCreated(event, ctx)
        return
      }
      if (type === 'role_reply') {
        handleRoleReply(event, ctx)
        const parentChatId = ((event.data ?? {}) as { parentChatId?: string }).parentChatId
        if (parentChatId) {
          void openRootTimeline(rootIdOf(parentChatId)).catch((e) =>
            console.warn(`[chats] root timeline reply refresh 失败:`, e),
          )
        }
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
    // A newly spawned child joins the root timeline immediately. Opening its
    // session is idempotent and gives refresh/replay a source for turn events.
    void openSession(d.chatId).catch((e) =>
      console.warn(`[chats] child session open ${d.chatId} 失败:`, e),
    )
    const parent = sessionsById.value[d.parentChatId]
    if (parent && !parent.sync.replaying) {
      ;(effects.value.onRoleCreated ?? noop)(d)
    }
  }

  /** role_reply：父 session push role 消息；副作用（ghost child + resume parent）仅 live 期。 */
  function handleRoleReply(event: NotificationMessage, ctx: ReduceContext): void {
    const d = (event.data ?? {}) as RoleReplyData
    if (!d.parentChatId) {
      console.warn('[chats] role_reply: 缺 parentChatId', d)
      return
    }
    const parent = ensureEntity(d.parentChatId)
    reduceRoleReply(parent, d, ctx)
    if (!parent.sync.replaying) {
      ;(effects.value.onRoleReply ?? noop)(d)
    }
  }

  /**
   * 乐观临时用户消息 rekey：sendMessage 创建 temp msgId 入 messageOrder；
   * consumed/send-Response 携真实 msgId 到达时，按 requestId 关联移除 temp，由 reduceConsumed upsert 真实项。
   */
  function rekeyOptimisticUser(
    chatId: string,
    requestId: string | undefined,
    messages: Array<{ id: string }>,
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
    session.run.error = undefined
    session.run.retainUntil = undefined
    session.ui.bubbleVisible = true

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
      session.run.status = 'paused'
      session.run.error = e instanceof Error ? e.message : '连接中断'
      ;(effects.value.onWorkingChange ?? noop)(chatId, false)
    }
  }

  async function resumeAgent(chatId: string): Promise<void> {
    const session = ensureEntity(chatId)
    session.run.error = undefined
    const { requestId, done } = agentApi.resumeChat(chatId)
    trackRequest(requestId, chatId)
    try {
      const response = await done
      if (response.success) {
        const data = (response.data ?? {}) as { runId?: string }
        if (data.runId) session.run.activeRunId = data.runId
      }
    } catch (e) {
      session.run.status = 'paused'
      session.run.error = e instanceof Error ? e.message : '连接中断'
    }
  }

  async function abortAgent(chatId: string): Promise<void> {
    const session = ensureEntity(chatId)
    await agentApi.abortAgent(chatId, session.run.activeRunId)
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
    session.interaction.approvalQueue.push(session.interaction.approval)
    session.interaction.approval = undefined
    if (session.interaction.approvalQueue.length > 0) {
      session.interaction.approval = session.interaction.approvalQueue.shift()
    }
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

  function setActiveQuestion(chatId: string, questionId: string | undefined): void {
    const session = sessionsById.value[chatId]
    if (session) session.interaction.activeQuestionId = questionId
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
   * 启动 hydration：chat.list(includePreview) 建 catalog -> 最近 5 个 root + 后代完整 hydrate。
   * 其余 catalog-only，loadSession 时原位升级。与旧 initFromChats 并行（双订阅无害：旧 store 仍供消费端，新 store 待 #10 切换）。
   */
  async function startup(): Promise<void> {
    if (started) return
    started = true
    try {
      const summaries = await agentApi.listChats(true)
      initCatalog(summaries)
      const rootIds = selectRecentRootIds(sessionsById.value, 5)
      await Promise.all(
        rootIds.map((id) =>
          hydrateTree(id).catch((e) => console.warn(`[chats] hydrateTree ${id} 失败:`, e)),
        ),
      )
    } catch (e) {
      // 失败不保留 started 位，下次 connected 可重试（对齐旧 initFromChats 语义）
      started = false
      throw e
    }
  }

  /**
   * 瞬断重连：仅对已 hydrated 且仍 running 的 session 执行 attach->sync(lastSeq)。
   * 不自动 resume paused chat（统一暂停语义：paused 显继续入口交用户）。
   */
  async function reconnect(): Promise<void> {
    const running = Object.values(sessionsById.value).filter((s) => s.sync.loaded && s.meta.running)
    await Promise.all(
      running.map(async (s) => {
        try {
          const res = await agentApi.attachChat(s.chatId)
          if (res.running) await syncOne(s.chatId, true)
        } catch (e) {
          console.warn(`[chats] reconnect ${s.chatId} 失败:`, e)
        }
      }),
    )
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
      const chatId = n.chatId ?? (n.requestId ? requestMap.get(n.requestId) : undefined)
      // role_created/role_reply/role_destroyed 携自身 chatId（data.chatId / data.parentChatId）；
      // 路由优先用 envelope chatId，缺失时由 handler 内部从 data 取
      const target = chatId ?? ''
      const { kind: _kind, ...notificationData } = n
      void _kind
      applyEvent(target, { kind: 'notification', ...notificationData } as ChatEvent)
    })
    unbindEvent = wsClient.onEvent((raw) => {
      const e = raw as Partial<ChatSessionEvent> | null
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
    // 实体管理
    ensureEntity,
    ensureCatalogEntity,
    initCatalog,
    deleteSession,
    openRootTimeline,
    // 写入口
    replaceSnapshot,
    replaceTimelineSnapshot,
    applyTimelinePatchEvent,
    openSession,
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
    setActiveQuestion,
    submitQuestionBatch,
    // 绑定
    bindWsClient,
    unbindWsClient,
    bindEffects,
  }
})
