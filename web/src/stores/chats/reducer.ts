/**
 * ChatSession 单写者 reducer（纯数据变更，唯一领域写入入口）。
 *
 * 不变量（见 [docs/web/pet/agent-integration.md](../../../../docs/web/pet/agent-integration.md)）：
 * - 纯函数：相同 `(session, event, ctx)` 输入产出相同结果；不调用 Date.now/random/不发 RPC/不碰 DOM。
 *   时间相关字段（retainUntil/createdAt）由 `ctx.now` 注入，store 层传 `Date.now()`。
 * - 幂等：重复应用相同 `seq`/`msgId`/`senseId` 不改变结果（WS seq + msgId 双轴去重）。
 * - 单 session：仅变更入参 `session`。跨 session 事件（role_created/role_reply/role_destroyed）
 *   的数据落点在本 session（role_created->子 session meta；role_reply->父 session role 消息），
 *   路由与副作用（建 session/pet/resume/toast）由 store action 层负责。
 *
 * 复用既有纯逻辑语义（不重复发明，镜像 [../agents/data/streamAccumulator](../agents/data/streamAccumulator.ts)
 * 与 [../agents/actions/questionBatch](../agents/actions/questionBatch.ts)），仅把数据结构从 `history[]`
 * 改为 `messagesById`+`messageOrder` 规范化投影。
 */

import type {
  ChatSession,
  ChatMessage,
  ChatEvent,
  ChatInteractionState,
} from './types'
import type {
  StreamChunkData,
  StagedChunkData,
  HistoryItem,
  ApprovalState,
  QuestionBatchState,
} from '../agents/types'
import type { RuntimeSelection, ContextBreakdown } from '@/services/agentApi'
import { extractMediaUrls } from '@/utils/markdown'
import type {
  QuestionBatchPayload,
} from '../agents/actions/questionBatch'

/** reducer 调用上下文（注入时间，保持纯函数）。 */
export interface ReduceContext {
  now: number
}

/** 就地创建/取规范化消息（按 msgId）。新消息入 messageOrder 尾部。 */
function ensureMessage(
  session: ChatSession,
  msgId: string,
  init: Omit<ChatMessage, 'msgId'>,
): ChatMessage {
  const existing = session.messagesById[msgId]
  if (existing) return existing
  const msg: ChatMessage = { msgId, ...init }
  session.messagesById[msgId] = msg
  session.messageOrder.push(msgId)
  return msg
}

/**
 * 把已成型消息 upsert 进规范化结构（共享 msgId 幂等轴）。
 * 镜像 [pushHistoryItem](../agents/data/streamAccumulator.ts)：命中 -> 就地补空字段 + senseCalls 合并；未命中 -> 新建入序。
 * 媒体抽取由调用方完成，本函数不重复抽取。
 */
function upsertMessage(session: ChatSession, item: Partial<ChatMessage> & { msgId: string }): void {
  const existing = session.messagesById[item.msgId]
  if (!existing) {
    const msg: ChatMessage = {
      msgId: item.msgId,
      role: item.role ?? 'assistant',
      thinking: item.thinking ?? '',
      content: item.content ?? '',
      senseCalls: item.senseCalls ? item.senseCalls.map((c) => ({ ...c })) : [],
      status: item.status ?? 'sealed',
      createdAt: item.createdAt ?? 0,
      updatedAt: item.updatedAt ?? item.createdAt ?? 0,
      agentChatId: item.agentChatId ?? session.chatId,
      ...(item.runtime ? { runtime: item.runtime } : {}),
      ...(item.mediaAssets ? { mediaAssets: item.mediaAssets.map((m) => ({ ...m })) } : {}),
      ...(item.contextCompaction ? { contextCompaction: true } : {}),
      ...(item.contextCompactionTokens !== undefined
        ? { contextCompactionTokens: item.contextCompactionTokens }
        : {}),
      ...(item.petName ? { petName: item.petName } : {}),
      ...(item.subPetChatId ? { subPetChatId: item.subPetChatId } : {}),
      ...(item.callerSubPetChatId ? { callerSubPetChatId: item.callerSubPetChatId } : {}),
      ...(item.mergedView ? { mergedView: item.mergedView } : {}),
      ...(item.spawnSenseCallId ? { spawnSenseCallId: item.spawnSenseCallId } : {}),
    }
    session.messagesById[item.msgId] = msg
    session.messageOrder.push(item.msgId)
    return
  }
  // 命中：补空字段（不覆盖已有非空）
  if (!existing.content && item.content) existing.content = item.content
  if (!existing.thinking && item.thinking) existing.thinking = item.thinking
  if (!existing.agentChatId && item.agentChatId) existing.agentChatId = item.agentChatId
  if (!existing.runtime && item.runtime) existing.runtime = item.runtime
  if (!existing.mediaAssets?.length && item.mediaAssets?.length) {
    existing.mediaAssets = item.mediaAssets.map((m) => ({ ...m }))
  }
  if (item.contextCompaction) existing.contextCompaction = true
  if (item.contextCompactionTokens !== undefined) {
    existing.contextCompactionTokens = item.contextCompactionTokens
  }
  if (item.status && existing.status === 'streaming') existing.status = item.status
  if (item.createdAt !== undefined && existing.createdAt === 0) existing.createdAt = item.createdAt
  if (item.role && existing.role !== item.role) existing.role = item.role
  if (item.senseCalls?.length) mergeSenseCalls(existing, item.senseCalls)
  // updatedAt 不在合并分支推进：实时 streaming 消息由 reduceChunk 每 delta 置 ctx.now；
  // sealed 消息 updatedAt 非关键（排序用 createdAt）。避免无 ctx 时误写。
}

/** senseCalls 按 id（旧数据按 name+args）去重合并进既有消息。 */
function mergeSenseCalls(msg: ChatMessage, calls: ChatMessage['senseCalls']): void {
  if (!calls.length) return
  const merged = [...(msg.senseCalls ?? [])]
  const fp = new Set(merged.map(senseFingerprint))
  for (const c of calls) {
    const k = senseFingerprint(c)
    if (fp.has(k)) continue
    fp.add(k)
    merged.push({ ...c })
  }
  msg.senseCalls = merged
}

function senseFingerprint(c: ChatMessage['senseCalls'][number]): string {
  if (c.id) return `id:${c.id}`
  let args = ''
  try {
    args = typeof c.args === 'string' ? c.args : JSON.stringify(c.args)
  } catch {
    args = String(c.args)
  }
  return `legacy:${c.name}:${args}`
}

/** 封口当前 streaming 消息（done/error/新轮首 delta 触发）。已非 streaming 不动。 */
function sealActive(session: ChatSession, status: ChatMessage['status'] = 'sealed'): void {
  const id = session.activeMessageId
  if (!id) return
  const msg = session.messagesById[id]
  if (msg && msg.status === 'streaming') msg.status = status
}

/**
 * 实时把工具结果写入对应 senseCall（accept/rejected/replaced 触发）。
 * 镜像 [fillSenseResultInHistory](../agents/data/streamAccumulator.ts)：倒序找 id 匹配项填 result + mediaAssets。
 */
function fillSenseResult(session: ChatSession, senseId: string, result: string): void {
  for (let i = session.messageOrder.length - 1; i >= 0; i--) {
    const msg = session.messagesById[session.messageOrder[i]!]
    if (!msg?.senseCalls) continue
    const sc = msg.senseCalls.find((s) => s.id === senseId)
    if (sc) {
      sc.result = result
      const mediaAssets = extractMediaUrls(result)
      if (mediaAssets.length > 0) sc.mediaAssets = mediaAssets
      return
    }
  }
}

// ---- 审批（镜像 approvalActions，操作 ChatInteractionState）----

function removeApprovalById(s: ChatInteractionState, approvalId: string): boolean {
  let removed = false
  if (s.approval?.approvalId === approvalId) {
    s.approval = undefined
    removed = true
  }
  const before = s.approvalQueue.length
  s.approvalQueue = s.approvalQueue.filter((a) => a.approvalId !== approvalId)
  if (s.approvalQueue.length !== before) removed = true
  if (!s.approval && s.approvalQueue.length > 0) s.approval = s.approvalQueue.shift()
  return removed
}

// ---- 问题批次（镜像 questionBatch，操作 ChatInteractionState）----

function toBatchState(
  payload: QuestionBatchPayload,
  previous?: QuestionBatchState,
): QuestionBatchState {
  const prevItems = new Map(previous?.questions.map((q) => [q.questionId, q]))
  return {
    batchId: payload.batchId,
    assistantMessageId: payload.assistantMessageId,
    createdAt: payload.createdAt,
    status: previous?.status ?? 'pending',
    questions: [...payload.questions]
      .sort((a, b) => a.position - b.position)
      .map((q) => {
        const old = prevItems.get(q.questionId)
        return {
          ...q,
          localStatus: old?.localStatus ?? 'pending',
          ...(old?.draftAnswer
            ? { draftAnswer: { ...old.draftAnswer, selectedLabels: [...old.draftAnswer.selectedLabels] } }
            : {}),
        }
      }),
  }
}

function ensureActiveQuestion(s: ChatInteractionState): void {
  const exists = s.questionBatches.some((b) =>
    b.questions.some((q) => q.questionId === s.activeQuestionId),
  )
  if (exists) return
  s.activeQuestionId =
    s.questionBatches
      .flatMap((b) => b.questions)
      .find((q) => q.localStatus === 'pending')?.questionId ??
    s.questionBatches[0]?.questions[0]?.questionId
}

function upsertQuestionBatch(s: ChatInteractionState, payload: QuestionBatchPayload): void {
  const idx = s.questionBatches.findIndex((b) => b.batchId === payload.batchId)
  const next = toBatchState(payload, idx >= 0 ? s.questionBatches[idx] : undefined)
  if (idx >= 0) s.questionBatches.splice(idx, 1, next)
  else s.questionBatches.push(next)
  s.questionBatches.sort((a, b) => a.createdAt - b.createdAt)
  ensureActiveQuestion(s)
}

function removeQuestionBatch(s: ChatInteractionState, batchId: string): void {
  s.questionBatches = s.questionBatches.filter((b) => b.batchId !== batchId)
  ensureActiveQuestion(s)
}

function replaceQuestionBatches(
  s: ChatInteractionState,
  payloads: QuestionBatchPayload[],
): void {
  const prev = new Map(s.questionBatches.map((b) => [b.batchId, b]))
  s.questionBatches = payloads
    .map((p) => toBatchState(p, prev.get(p.batchId)))
    .sort((a, b) => a.createdAt - b.createdAt)
  ensureActiveQuestion(s)
}

// ---- staged 回放（镜像 accumulateStaged，操作 messagesById/messageOrder）----

/**
 * staged 历史回放累积：按 row 顺序重组为 ChatMessage（msgId 幂等）。
 * 镜像 [accumulateStaged](../agents/data/streamAccumulator.ts) 的分支语义，仅数据结构规范化。
 */
function reduceStaged(session: ChatSession, d: StagedChunkData | undefined): void {
  if (!d || !d.type) return

  if (d.type === 'thinking_end') {
    if (d.msgId) {
      const existing = session.messagesById[d.msgId]
      if (existing) {
        if (!existing.thinking) existing.thinking = d.thinking ?? ''
        if (d.createdAt) existing.createdAt = d.createdAt
        return
      }
    }
    ensureMessage(session, d.msgId ?? `unknown-${session.messageOrder.length}`, {
      role: 'assistant',
      thinking: d.thinking ?? '',
      content: '',
      senseCalls: [],
      status: 'sealed',
      createdAt: d.createdAt ?? 0,
      updatedAt: d.createdAt ?? 0,
      agentChatId: d.agentChatId ?? session.chatId,
    })
    return
  }

  if (d.type === 'content_end') {
    const role = d.role
    if (role === 'user') {
      const content = d.content ?? ''
      const m = /^\[(?:子agent|角色)\s+([^\]]+?)\]/.exec(content)
      const mediaAssets = extractMediaUrls(content)
      upsertMessage(session, {
        msgId: d.msgId ?? `unknown-${session.messageOrder.length}`,
        role: m ? 'role' : 'user',
        content,
        status: 'sealed',
        createdAt: d.createdAt ?? 0,
        agentChatId: d.agentChatId ?? session.chatId,
        ...(d.runtime ? { runtime: d.runtime } : {}),
        ...(m ? { petName: m[1] } : {}),
        ...(mediaAssets.length > 0 ? { mediaAssets } : {}),
      })
      return
    }
    if (role === 'assistant') {
      const content = d.content ?? ''
      const mediaAssets = extractMediaUrls(content)
      if (d.msgId) {
        const existing = session.messagesById[d.msgId]
        if (existing) {
          if (!existing.content) {
            existing.content = content
            existing.runtime = d.runtime
            existing.createdAt = d.createdAt ?? existing.createdAt
            if (mediaAssets.length > 0) existing.mediaAssets = mediaAssets
            if (d.contextCompaction) existing.contextCompaction = true
            if (d.contextCompactionTokens !== undefined) {
              existing.contextCompactionTokens = d.contextCompactionTokens
            }
          }
          return
        }
      }
      upsertMessage(session, {
        msgId: d.msgId ?? `unknown-${session.messageOrder.length}`,
        role: 'assistant',
        content,
        status: 'sealed',
        createdAt: d.createdAt ?? 0,
        agentChatId: d.agentChatId ?? session.chatId,
        ...(d.runtime ? { runtime: d.runtime } : {}),
        ...(d.contextCompaction ? { contextCompaction: true } : {}),
        ...(d.contextCompactionTokens !== undefined ? { contextCompactionTokens: d.contextCompactionTokens } : {}),
        ...(mediaAssets.length > 0 ? { mediaAssets } : {}),
      })
      return
    }
    if (role === 'sense') {
      if (!d.id) return
      fillSenseResult(session, d.id, d.content ?? '')
      return
    }
    if (role === 'role' || role === 'subagent') {
      const content = d.content ?? ''
      const m = /^\[(?:子agent|角色)\s+([^\]]+?)\]/.exec(content)
      upsertMessage(session, {
        msgId: d.msgId ?? `unknown-${session.messageOrder.length}`,
        role: 'role',
        content,
        status: 'sealed',
        createdAt: d.createdAt ?? 0,
        agentChatId: d.agentChatId ?? session.chatId,
        ...(d.runtime ? { runtime: d.runtime } : {}),
        ...(m ? { petName: m[1] } : {}),
      })
      return
    }
    return
  }

  if (d.type === 'sense_end') {
    if (d.id && session.messageOrder.some((id) => session.messagesById[id]?.senseCalls?.some((s) => s.id === d.id))) {
      return
    }
    const lastId = session.messageOrder[session.messageOrder.length - 1]
    const last = lastId ? session.messagesById[lastId] : undefined
    if (!last || last.role !== 'assistant') {
      console.warn('[chats] staged sense_end 无所属 assistant message', d)
      return
    }
    if (!last.senseCalls) last.senseCalls = []
    if (
      !d.id &&
      last.senseCalls.some((s) => s.name === (d.senseName ?? '') && s.args === d.arguments)
    ) {
      return
    }
    last.senseCalls.push({
      id: d.id,
      name: d.senseName ?? '',
      args: d.arguments,
      status: 'done',
    })
    return
  }

  // d.type === 'reverse'：撤回（reduceReverse 单独处理）
}

/** reverse 撤回：按 messageIds 标 revoked（展示 selector 排除）。 */
function reduceReverse(session: ChatSession, ids: string[]): void {
  for (const id of ids) {
    const msg = session.messagesById[id]
    if (msg) msg.status = 'revoked'
  }
}

// ---- 主入口 ----

/**
 * 单 session 纯数据变更。store 层 `applyEvent(chatId, event)` 解析 chatId 后调用本函数。
 * 重复应用相同 seq/msgId/senseId 不改变结果。
 */
export function reduce(session: ChatSession, event: ChatEvent, ctx: ReduceContext): void {
  if (event.kind === 'chunk') {
    reduceChunk(session, event, ctx)
    return
  }
  reduceNotification(session, event, ctx)
}

function reduceChunk(session: ChatSession, chunk: ChatEvent & { kind: 'chunk' }, ctx: ReduceContext): void {
  if (!chunk.requestId) return
  if (chunk.runId && !session.run.activeRunId) session.run.activeRunId = chunk.runId

  if (chunk.type === 'staged') {
    const d = chunk.data as StagedChunkData | undefined
    if (d?.type === 'reverse') {
      reduceReverse(session, d.id ? [d.id] : [])
      return
    }
    reduceStaged(session, d)
    return
  }

  // stream chunk：实时增量
  // 回放期（chat.sync 历史回放）的 stream delta 不得建 streaming 消息或累加 content——否则
  // 气泡会显历史内容。replaying=true 时直接 return，历史内容由 staged chunk 累积进 messages。
  if (session.sync.replaying) return
  const data = (chunk.data as StreamChunkData | undefined) ?? {}
  if (!data.msgId) return // 协议保证必带 msgId；缺失 fail-loud 跳过

  // 新 msgId 首次到达：封口旧 active -> 建空 streaming -> 切 active（不变式 5）
  if (session.activeMessageId !== data.msgId) {
    sealActive(session, 'sealed')
    ensureMessage(session, data.msgId, {
      role: 'assistant',
      thinking: '',
      content: '',
      senseCalls: [],
      status: 'streaming',
      createdAt: data.createdAt ?? 0,
      updatedAt: data.createdAt ?? 0,
      agentChatId: session.chatId,
    })
    session.activeMessageId = data.msgId
  }
  const active = session.messagesById[data.msgId]!
  if (data.thinking) active.thinking += data.thinking
  if (data.content) {
    active.content += data.content
    const mediaAssets = extractMediaUrls(active.content)
    if (mediaAssets.length > 0) active.mediaAssets = mediaAssets
  }
  active.updatedAt = ctx.now
  session.run.status = 'running'
  session.run.error = undefined
  session.ui.bubbleVisible = true
}

function reduceNotification(
  session: ChatSession,
  n: ChatEvent & { kind: 'notification' },
  ctx: ReduceContext,
): void {
  const type = n.type
  const replaying = session.sync.replaying
  const d = (n.data ?? {}) as Record<string, unknown>

  if (type === 'done' || type === 'error') {
    // run 结束：无 runId 或 runId 匹配当前活跃 run -> 清 activeRunId（与旧 routeNotification 一致）
    if (!n.runId || n.runId === session.run.activeRunId) session.run.activeRunId = undefined
    session.interaction.runningTools = []

    if (type === 'done') {
      // finalMessage 幂等补全并 seal
      const fm = (d.finalMessage as
        | {
            msgId: string
            role: 'assistant'
            content: string
            thinking?: string
            createdAt: number
            agentChatId?: string
            contextCompaction?: boolean
            contextCompactionTokens?: number
          }
        | undefined)
      if (fm) {
        upsertMessage(session, {
          msgId: fm.msgId,
          role: 'assistant',
          content: fm.content,
          status: 'sealed',
          createdAt: fm.createdAt,
          agentChatId: fm.agentChatId ?? session.chatId,
          ...(fm.thinking ? { thinking: fm.thinking } : {}),
          ...(fm.contextCompaction ? { contextCompaction: true } : {}),
          ...(fm.contextCompactionTokens !== undefined ? { contextCompactionTokens: fm.contextCompactionTokens } : {}),
        })
        if (session.activeMessageId === fm.msgId) session.activeMessageId = undefined
      }
      const canResume = typeof d.canResume === 'boolean' ? d.canResume : undefined
      session.run.status = canResume ? 'paused' : 'ended'
      if (!replaying) session.run.retainUntil = ctx.now + 20000
      if (typeof d.contextUsage === 'number') session.context.contextUsage = d.contextUsage
      if (typeof d.used === 'number') session.context.contextUsed = d.used
      if (typeof d.total === 'number') session.context.contextTotal = d.total
      if (d.contextBreakdown) session.context.contextBreakdown = d.contextBreakdown as ContextBreakdown
      if (typeof canResume === 'boolean') session.context.canResume = canResume
      if (d.finished === true) session.meta.finished = true
    } else {
      // error：AI 报错归 paused（可重试）；active 消息标 error 保留已到部分
      session.run.status = 'paused'
      session.run.error = typeof d.message === 'string' ? d.message : '系统出了点小问题'
      if (!replaying) session.run.retainUntil = ctx.now + 30000
      if (session.activeMessageId) {
        const am = session.messagesById[session.activeMessageId]
        if (am && am.status === 'streaming') am.status = 'error'
      }
      if (typeof d.canResume === 'boolean') session.context.canResume = d.canResume
    }
    return
  }

  if (type === 'loaded') {
    session.sync.loaded = true
    return
  }

  if (type === 'interrupt') {
    const approvalId = d.approvalId as string | undefined
    const senseName = d.senseName as string | undefined
    if (!approvalId || !senseName) return
    const newApproval: ApprovalState = {
      approvalId,
      senseName,
      args: d.arguments,
      waitTime: typeof d.waitTime === 'number' ? d.waitTime : 0,
      createdAt: typeof d.createdAt === 'number' ? d.createdAt : ctx.now,
    }
    if (session.interaction.approval) session.interaction.approvalQueue.push(newApproval)
    else session.interaction.approval = newApproval
    return
  }

  if (type === 'sense_started') {
    const id = d.id as string | undefined
    const senseName = d.senseName as string | undefined
    if (!id || !senseName) return
    if (!session.interaction.runningTools.some((t) => t.id === id)) {
      session.interaction.runningTools.push({ id, name: senseName })
    }
    return
  }

  if (type === 'accept' || type === 'rejected' || type === 'replaced') {
    const id = d.approvalId as string | undefined
    if (id) {
      removeApprovalById(session.interaction, id)
      session.interaction.runningTools = session.interaction.runningTools.filter((t) => t.id !== id)
    }
    if (type === 'accept' && typeof d.result === 'string') {
      fillSenseResult(session, id ?? '', d.result)
    } else if (type === 'rejected' && typeof d.reason === 'string') {
      fillSenseResult(session, id ?? '', `被拒绝: ${d.reason}`)
    } else if (type === 'replaced' && typeof d.content === 'string' && typeof d.id === 'string') {
      fillSenseResult(session, d.id, d.content)
    }
    return
  }

  if (type === 'question_batch_requested') {
    const payload = d as unknown as Partial<QuestionBatchPayload>
    if (
      typeof payload.batchId === 'string' &&
      typeof payload.assistantMessageId === 'string' &&
      typeof payload.createdAt === 'number' &&
      Array.isArray(payload.questions)
    ) {
      upsertQuestionBatch(session.interaction, payload as QuestionBatchPayload)
    }
    return
  }

  if (type === 'question_batch_completed') {
    if (typeof d.batchId === 'string') removeQuestionBatch(session.interaction, d.batchId)
    return
  }

  // question_requested / question_answered：旧逐题事件，权威批次快照已覆盖，忽略
  // auto_compacted：纯 toast 副作用，无数据态变更，由 store action 层处理
  // role_created / role_reply / role_destroyed：跨 session，由 store action 层路由
  //   role_created -> 子 session meta（reduceChildMeta）；role_reply -> 父 session role 消息（下方）
}

/**
 * role_created 数据落点：写入子 session meta + runtime（store 层 ensureCatalogEntity 后调用）。
 */
export function reduceRoleCreated(
  child: ChatSession,
  data: {
    parentChatId?: string
    type?: string
    avatar?: string
    wake?: 'immediate' | 'deferred' | 'barrier'
    brain?: string
    senseGroup?: string
  },
): void {
  if (data.parentChatId) child.meta.parentChatId = data.parentChatId
  if (data.type) child.meta.agentType = data.type
  if (data.avatar) child.meta.avatar = data.avatar
  if (data.wake) child.meta.wake = data.wake
  if (data.brain !== undefined || data.senseGroup !== undefined) {
    const rt: RuntimeSelection = {
      brain: data.brain ?? '',
      senseGroup: data.senseGroup ?? '',
      mcpServers: [],
    }
    child.context.runtime = rt
  }
}

/**
 * role_reply 数据落点：父 session push role 消息（msgId 幂等）。
 * 子 session 转 ghost / 主 resume 为副作用，由 store action 层处理。
 */
export function reduceRoleReply(
  parent: ChatSession,
  data: {
    childChatId: string
    type: string
    content: string
    spawnSenseCallId?: string
    msgId: string
  },
  ctx: ReduceContext,
): void {
  upsertMessage(parent, {
    msgId: data.msgId,
    role: 'role',
    content: data.content ?? '',
    status: 'sealed',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    agentChatId: data.childChatId,
    petName: data.type,
    subPetChatId: data.childChatId,
    callerSubPetChatId: parent.chatId,
    mergedView: 'child-to-master',
    ...(data.spawnSenseCallId ? { spawnSenseCallId: data.spawnSenseCallId } : {}),
  })
}

/** consumed 数据落点：按真实 msgId upsert user 消息（乐观临时项由 store action 层 rekey/移除）。 */
export function reduceConsumed(
  session: ChatSession,
  messages: Array<{
    id: string
    role: 'user'
    content: string
    createdAt: number
    updateAt: number
  }>,
): void {
  for (const m of messages) {
    upsertMessage(session, {
      msgId: m.id,
      role: 'user',
      content: m.content,
      status: 'sealed',
      createdAt: m.createdAt,
      updatedAt: m.updateAt,
      agentChatId: session.chatId,
    })
  }
}

/** HistoryItem -> ChatMessage 转换（getHistory 旧路径回退 / 合成回填用）。 */
export function upsertHistoryItem(session: ChatSession, item: HistoryItem): void {
  upsertMessage(session, {
    msgId: item.msgId ?? `legacy-${session.messageOrder.length}`,
    role: item.role === 'subagent' ? 'role' : item.role,
    content: item.content,
    thinking: item.thinking ?? '',
    status: 'sealed',
    createdAt: item.createdAt ?? 0,
    updatedAt: item.createdAt ?? 0,
    agentChatId: item.agentChatId ?? session.chatId,
    senseCalls: item.senseCalls,
    ...(item.runtime ? { runtime: item.runtime } : {}),
    ...(item.mediaAssets ? { mediaAssets: item.mediaAssets } : {}),
    ...(item.contextCompaction ? { contextCompaction: true } : {}),
    ...(item.contextCompactionTokens !== undefined ? { contextCompactionTokens: item.contextCompactionTokens } : {}),
    ...(item.petName ? { petName: item.petName } : {}),
    ...(item.subPetChatId ? { subPetChatId: item.subPetChatId } : {}),
    ...(item.callerSubPetChatId ? { callerSubPetChatId: item.callerSubPetChatId } : {}),
    ...(item.mergedView ? { mergedView: item.mergedView } : {}),
    ...(item.spawnSenseCallId ? { spawnSenseCallId: item.spawnSenseCallId } : {}),
  })
}

export { replaceQuestionBatches, upsertQuestionBatch, removeQuestionBatch }
