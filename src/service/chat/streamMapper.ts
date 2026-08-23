import {
  createChunk,
  createNotification,
  type Chunk,
  type Notification,
  type StreamChunkData,
  type StagedChunkData,
} from '../message/types.js'
import type {
  MiddlewareChunk,
  SenseTriggerChunk,
  SenseStartedChunk,
  SenseAcceptChunk,
  SenseRejectChunk,
  StagedChunk,
  ConsumedChunk,
  MessageCreatedChunk,
  MessageUpdatedChunk,
  ErrorChunk,
} from '@/core/middleware/types'
import { SupervisionLevel } from '@/core/config'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import { COMPLIANT_TRACE_PATTERN, friendlyMessage, newTracingId } from '@/utils/error.js'
import { breakdownUsed } from '@/utils/token.js'
import { computeContextBreakdown } from './contextUsage.js'
import { maybeAutoCompactAfterDone } from './autoCompact.js'
import { computeContextUsage } from '@/utils/token.js'
import {
  getChat,
  getLastMessage,
  getTimelineRevision,
  markPendingInputsConsumed,
} from '@/db/chat.js'
import { safeJsonParse } from '@/utils/json.js'
import { computeCanResume } from './canResume.js'
import { finalizeSpawnChildIfDone } from './spawnFinalize.js'
import { isAgentAbortError } from '@/core/middleware/errors.js'
import config from '@/utils/config.js'
import { recordRunFact, recordTerminationFact } from './executionFacts.js'

/**
 * 将 agent generator 的 MiddlewareChunk 转换为 WebSocket 协议的 Chunk/Notification
 * （P2-1 从 send.ts 拆出）。handleChatSend 和 handleChatResume 共用。
 *
 * chatId 用于 done notification 时计算 contextUsage（CP7）：跑完一轮 loop 后实时
 * 重算 chat 总 token / brain.contextLimit 推送给前端，ContextBar 随每轮更新。
 *
 * 统一暂停语义：error（loop 失败 / retry 耗尽 / max loop 超限）与 done 都不再代表
 * "失败/成功"终态，而是下发权威 canResume（computeCanResume 派生）让前端据末条消息
 * 判定 paused（显继续按钮）/ ended（无按钮）。AI 报错归 paused，可 resume 重试。
 */
export async function* streamAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  rid: string,
  chatId: string,
  runId: string,
): AsyncGenerator<Chunk | Notification, void, unknown> {
  // 失败守卫：error chunk 已出现时抑制后续 done notification（不让 loop 失败路径下发 done）。
  // runChain 内 ErrorChunk 是「流失败」信号；done 仅代表 loop 正常完成。
  let errored = false
  // 终态已发的守卫：error chunk 分支 / done 分支 / catch 均置 true；finally 据此判断
  // 「generator 未发任何终态就结束」的兜底路径。
  let terminated = false
  const turnStarted = new Set<string>()
  const completedTurns = new Set<string>()
  const offsets = new Map<string, { thinking: number; content: number }>()
  const runStartedAt = Date.now()
  recordRunFact({ chatId, runId, status: 'running' })
  // A run is active before the provider emits its first token. Consumers must
  // not infer working state from turn.started/assistant output.
  yield createNotification(
    'run.updated',
    rid,
    { runId, status: 'running', at: runStartedAt, startedAt: runStartedAt },
    { chatId, runId },
  )
  try {
    for await (const chunk of generator) {
      if (chunk.type === 'stream') {
        if (!chunk.msgId || typeof chunk.createdAt !== 'number') {
          throw new Error('stream chunk missing checkpoint msgId/createdAt')
        }
        const streamData: StreamChunkData = {
          msgId: chunk.msgId,
          createdAt: chunk.createdAt,
        }
        if (chunk.thinkingDelta) {
          streamData.thinking = chunk.thinkingDelta
        }
        if (chunk.contentDelta) {
          streamData.content = chunk.contentDelta
        }
        if (chunk.senseDelta && chunk.senseDelta.length > 0) {
          streamData.senseCall = chunk.senseDelta
        }
        const turnId = chunk.msgId
        const state = offsets.get(turnId) ?? { thinking: 0, content: 0 }
        if (!turnStarted.has(turnId)) {
          turnStarted.add(turnId)
          recordRunFact({ chatId, runId, status: 'running', turnId, nodeId: turnId })
          yield createNotification(
            'turn.started',
            rid,
            { turnId, messageId: turnId, runId, createdAt: chunk.createdAt },
            { chatId, runId },
          )
        }
        // The checkpoint emits one empty stream item before invoking the provider
        // so the response node and CRT exist immediately. Only real provider data
        // is mirrored to the legacy chunk channel.
        if (
          chunk.thinkingDelta ||
          chunk.contentDelta ||
          (chunk.senseDelta && chunk.senseDelta.length > 0)
        ) {
          yield createChunk('stream', rid, streamData, { chatId, runId })
        }
        if (chunk.thinkingDelta) {
          const offset = state.thinking
          state.thinking += chunk.thinkingDelta.length
          yield createNotification(
            'turn.delta',
            rid,
            { turnId, messageId: turnId, channel: 'thinking', offset, delta: chunk.thinkingDelta },
            { chatId, runId },
          )
        }
        if (chunk.contentDelta) {
          const offset = state.content
          state.content += chunk.contentDelta.length
          yield createNotification(
            'turn.delta',
            rid,
            { turnId, messageId: turnId, channel: 'content', offset, delta: chunk.contentDelta },
            { chatId, runId },
          )
        }
        offsets.set(turnId, state)
      } else if (chunk.type === 'staged') {
        const staged = chunk as StagedChunk
        const stagedData: StagedChunkData = {
          type: staged.stagedType,
        }
        if (staged.thinking) {
          stagedData.thinking = staged.thinking
        }
        if (staged.content) {
          stagedData.content = staged.content
        }
        if (staged.senseName) {
          stagedData.senseName = staged.senseName
        }
        if (staged.senseArguments) {
          stagedData.arguments = staged.senseArguments
        }
        if (staged.id) {
          stagedData.id = staged.id
        }
        // 实时路径预分配 msgId（= 落库 id），供前端实时累积与 done.finalMessage/chat.get 同 id 去重
        if (staged.msgId) {
          stagedData.msgId = staged.msgId
        }
        if (staged.role) {
          stagedData.role = staged.role as StagedChunkData['role']
        }
        if (staged.createdAt) {
          stagedData.createdAt = staged.createdAt
        }
        logger.event('staged', {
          stagedType: staged.stagedType,
          senseName: staged.senseName,
          senseCallId: staged.id,
          contentLen: staged.content.length,
          thinkingLen: staged.thinking.length,
        })
        yield createChunk('staged', rid, stagedData, { chatId, runId })
      } else if (chunk.type === 'sense_end') {
        const sc = chunk as SenseTriggerChunk
        const needsApproval = sc.supervisionLevel > SupervisionLevel.auto
        logger.event('sense.trigger', {
          senseCallId: sc.id,
          name: sc.name,
          supervisionLevel: sc.supervisionLevel,
          needsApproval,
          arguments: sc.arguments, // 完整参数（JSON字符串）
        })

        // smart/manual（needsApproval）→ interrupt（前端弹审核卡 + 倒计时）。
        // sense_started 不再在模型生成调用时产生；由 middleware 在真实执行边界单独 yield。
        // approval_timeout 缺省 → waitTime=0（不超时，前端不显倒计时）。
        if (needsApproval) {
          yield createNotification(
            'interrupt',
            rid,
            {
              approvalId: sc.id,
              senseName: sc.name,
              arguments: sc.arguments,
              supervisionLevel: sc.supervisionLevel,
              needsApproval,
              waitTime: config.global.approval_timeout ?? 0,
              createdAt: Date.now(),
              security: sc.security,
            },
            { chatId, runId },
          )
        }
      } else if (chunk.type === 'sense_started') {
        const sc = chunk as SenseStartedChunk
        yield createNotification(
          'sense_started',
          rid,
          {
            id: sc.id,
            senseName: sc.name,
            arguments: sc.arguments,
            startedAt: sc.startedAt,
          },
          { chatId, runId },
        )
      } else if (chunk.type === 'sense_accept') {
        const sc = chunk as SenseAcceptChunk
        logger.event('sense.result', {
          senseCallId: sc.id,
          name: sc.name,
          resultLen: sc.result.length,
          hash: sc.hash,
        })
        yield createNotification(
          'accept',
          rid,
          {
            approvalId: sc.id,
            senseName: sc.name,
            result: sc.result,
            completedAt: Date.now(),
          },
          { chatId, runId },
        )
      } else if (chunk.type === 'sense_reject') {
        const sc = chunk as SenseRejectChunk
        logger.event('sense.rejected', {
          senseCallId: sc.id,
          name: sc.name,
          reason: sc.reason,
        })
        yield createNotification(
          'rejected',
          rid,
          {
            approvalId: sc.id,
            senseName: sc.name,
            reason: sc.reason,
            completedAt: Date.now(),
          },
          { chatId, runId },
        )
      } else if (chunk.type === 'consumed') {
        const consumed = chunk as ConsumedChunk
        const messages = (consumed.messages ?? []).map((message) => {
          if (
            message.role !== 'user' ||
            typeof message.content !== 'string' ||
            typeof message.createdAt !== 'number'
          ) {
            throw new Error('consumed message missing user content/createdAt')
          }
          return {
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
            updateAt: message.updateAt ?? message.createdAt,
            ...(message.inputId ? { inputId: message.inputId } : {}),
            ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
            ...(message.commandId ? { commandId: message.commandId } : {}),
          }
        })
        if (messages.length !== consumed.count) {
          throw new Error('consumed message count mismatch')
        }
        markPendingInputsConsumed(
          chatId,
          messages.flatMap((message) => (message.inputId ? [message.inputId] : [])),
        )
        logger.event('input.consumed', { count: consumed.count })
        yield createNotification(
          'consumed',
          rid,
          { count: consumed.count, messages },
          { chatId, runId },
        )
        for (const message of messages) {
          if (!message.inputId) continue
          yield createNotification(
            'input.updated',
            rid,
            {
              inputId: message.inputId,
              clientMessageId: message.clientMessageId,
              messageId: message.id,
              state: 'consumed',
            },
            { chatId, runId },
          )
        }
      } else if (chunk.type === 'error') {
        const e = chunk as ErrorChunk
        const info = e.errors[0]
        // 原始 message 进日志；用户面按友好文案出（见 [docs/error-conventions.md](../../../docs/error-conventions.md)）。
        const raw = info?.message
        logger.event(
          'chat.run.error',
          { message: raw, category: info?.category, source: info?.source },
          LogLevel.error,
        )
        // 合规（已前置 tracingId，如终态 throwUserFacing 错误）→ 原样；否则按 userMessage / friendlyMessage 出，前置 tracingId。
        const message =
          raw && COMPLIANT_TRACE_PATTERN.test(raw)
            ? raw
            : `[${newTracingId()}] ${info?.userMessage ?? friendlyMessage(info?.category ?? 'unknown', info?.source ?? 'system')}`
        errored = true
        terminated = true
        const terminationBaseRevision = getTimelineRevision(chatId)
        const terminationNode = recordTerminationFact({
          chatId,
          runId,
          actor: 'system',
          code: 'error',
          detail: raw ?? info?.userMessage,
        })
        const rootRevision = getTimelineRevision(terminationNode.rootChatId)
        // AI 报错归 paused（可 resume 重试）：下发 canResume 让前端显继续按钮。
        // 不再构造 failureResponse——统一暂停语义下 final Response 恒 success:true。
        // 不下发 done（见下「done + errored 抑制」）：error notification 作为本轮终态信号。
        yield createNotification(
          'error',
          rid,
          { message, canResume: computeCanResume(chatId) },
          { chatId, runId },
        )
        yield createNotification(
          'timeline.patch',
          rid,
          {
            chatId,
            baseRevision: terminationBaseRevision,
            revision: getTimelineRevision(chatId),
            operations: [],
            rootPatches: (['conversation', 'tree', 'audit'] as const).map((view) => ({
              rootChatId: terminationNode.rootChatId,
              view,
              baseRevision: Math.max(0, rootRevision - 1),
              revision: rootRevision,
              operations: [{ type: 'upsert' as const, node: terminationNode }],
            })),
          },
          { chatId, runId },
        )
        const completedAt = Date.now()
        yield createNotification(
          'run.updated',
          rid,
          { runId, status: 'paused', at: completedAt },
          { chatId, runId },
        )
        for (const turnId of turnStarted) {
          if (completedTurns.has(turnId)) continue
          completedTurns.add(turnId)
          yield createNotification(
            'turn.completed',
            rid,
            { turnId, messageId: turnId, completedAt },
            { chatId, runId },
          )
        }
      } else if (chunk.type === 'done') {
        // error 路径抑制 done：error notification 已下发（含 canResume 表达 paused 终态），
        // 无需再发 done（避免 contextUsage 冗余更新；error 已是本轮终态）。
        if (errored) {
          logger.event('chat.run.done.suppressed', { reason: 'errored' }, LogLevel.warn)
          continue
        }
        terminated = true
        // CP7：done 时重算 contextUsage 推送前端，ContextBar 每轮 loop 后实时更新
        const ctxBd = computeContextBreakdown(chatId)
        // P5：loop done 后复检——若本轮又让上下文逼近阈值，下一次 send 出发自动压缩；
        // 推送 auto_compacted 让前端可亮 compact 按钮或做 toast 提示（本轮已结束，不改 prompt）。
        const postReason = maybeAutoCompactAfterDone(chatId)
        if (postReason) {
          const post = computeContextUsage(chatId)
          logger.event('chat.run.autoCompact.next', { chatId, reason: postReason })
          yield createNotification(
            'auto_compacted',
            rid,
            { reason: postReason, usedBefore: post.used, total: post.total },
            { chatId, runId },
          )
        }
        // 子 agent finished 标记由 observer.ts 在 child_done chunk 时设置，不再在 done chunk 时设置
        // 原因：子 agent yield turn 时会 done，但不应设 finished（需等孙 agent 完成后才设）
        // child_yield → 不设 finished（子保持活跃）
        // child_done → 设 finished（子真正完成，变 ghost）
        // 恢复路径（chat.resume 完成的子不在 wait 链上，observer 不 yield child_done）在此前置兜底：
        // done 通知生成前先跑 finalizeSpawnChildIfDone（幂等：非子 chat / 已 finished /
        // 末条非 assistant / 带 sense_calls 均短路），使下方读 metadata 时 finished 已就位。
        // 修复时序竞态——原兜底 finalizeSpawnChildIfDone 在 send.ts 末尾（stream 之后）执行，为时已晚。
        finalizeSpawnChildIfDone(chatId)
        // 读取 DB 中 chat metadata.finished，传递给前端用于 ghost 转换
        const chatRow = getChat(chatId)
        let finished: boolean | undefined
        if (chatRow?.metadata) {
          const meta = safeJsonParse(chatRow.metadata, {}) as { finished?: unknown }
          finished = meta.finished === true ? true : undefined
        }
        logger.event('chat.run.done', { contextUsage: ctxBd.usage, finished })
        // 本轮末条若为 assistant → 携带权威回复，前端实时追加进 stream.history（PetIcons 圆点气泡即时更新）。
        const lastMsg = getLastMessage(chatId)
        const finalMessage =
          lastMsg && lastMsg.role === 'assistant'
            ? {
                msgId: lastMsg.id,
                role: 'assistant' as const,
                content: lastMsg.content ?? '',
                ...(lastMsg.thinking ? { thinking: lastMsg.thinking } : {}),
                createdAt: lastMsg.created_at,
                agentChatId: chatId,
                ...(lastMsg.context_compaction === 1 ? { contextCompaction: true } : {}),
                ...(lastMsg.context_compaction_tokens !== null &&
                lastMsg.context_compaction_tokens !== undefined
                  ? { contextCompactionTokens: lastMsg.context_compaction_tokens }
                  : {}),
              }
            : undefined
        const canResume = computeCanResume(chatId)
        const completedAt = Date.now()
        recordRunFact({ chatId, runId, status: canResume ? 'paused' : 'completed' })
        yield createNotification(
          'done',
          rid,
          {
            contextUsage: ctxBd.usage,
            used: breakdownUsed(ctxBd),
            total: ctxBd.total,
            contextBreakdown: ctxBd,
            ...(finished === true ? { finished: true } : {}),
            ...(finalMessage ? { finalMessage } : {}),
            // 权威 canResume：前端据此区分 paused（显继续）/ ended（无按钮），取代旧 done→canResume=false 硬编码。
            canResume,
            completedAt,
          },
          { chatId, runId },
        )
        yield createNotification(
          'run.updated',
          rid,
          { runId, status: canResume ? 'paused' : 'completed', at: completedAt },
          { chatId, runId },
        )
        for (const turnId of turnStarted) {
          if (completedTurns.has(turnId)) continue
          completedTurns.add(turnId)
          yield createNotification(
            'turn.completed',
            rid,
            { turnId, messageId: turnId, completedAt },
            { chatId, runId },
          )
        }
      } else if (chunk.type === 'message_updated') {
        // kind:"replace" 的 message_updated = 感官去重命中（observeAgentChunks 已落库），
        // 转 "replaced" notification 通知 web 实时更新历史 sense block；content kind 不传 web。
        const u = chunk as MessageUpdatedChunk
        if (u.patch.kind === 'replace') {
          logger.event('message.replaced', { messageId: u.id, by: u.patch.replace.by })
          yield createNotification(
            'replaced',
            rid,
            {
              id: u.id,
              content: u.patch.content,
              originalContent: u.patch.originalContent,
              by: u.patch.replace.by,
            },
            { chatId, runId },
          )
        }
      } else if (chunk.type === 'question_batch_pending') {
        // observer 已先持久化批次；这里只映射一个完整、可重放的批次事件。
        yield createNotification(
          'question_batch_requested',
          rid,
          {
            batchId: chunk.batchId,
            assistantMessageId: chunk.assistantMessageId,
            createdAt: chunk.createdAt,
            questions: chunk.questions,
          },
          { chatId, runId },
        )
      } else if (chunk.type === 'message_created') {
        // observeAgentChunks has already persisted the message and published its
        // timeline patch. Close only this assistant node's live CRT; later turns
        // in the same run retain independent lifecycles.
        const created = chunk as MessageCreatedChunk
        const turnId = created.message.id
        if (
          created.message.role === 'assistant' &&
          turnStarted.has(turnId) &&
          !completedTurns.has(turnId)
        ) {
          completedTurns.add(turnId)
          yield createNotification(
            'turn.completed',
            rid,
            { turnId, messageId: turnId, completedAt: Date.now() },
            { chatId, runId },
          )
        }
      } else if (chunk.type === 'sense_pending') {
        // 内部 effect chunk 应由 observeAgentChunks 消费，不进入传输层。
        // 注：question_batch_pending 已在上面分发为 question_batch_requested 通知，此处不列。
        continue
      }
    }
  } catch (err) {
    // 统一暂停语义终态兜底：generator 抛异常（AgentParkError 断连 park / AgentAbortError 审批取消 /
    // 未预期错误）时，for-await 直接退出、不发终态通知——前端只靠终态通知清 run.status 会永久卡
    // running（CRT「执行中」/ pet「工作中」）。此处补发终态让前端有机会复位。
    terminated = true
    const error = err as Error
    // abort/park 是控制流信号（非故障）→ 不弹 error-bubble；未预期故障补发 error 通知
    //（含权威 canResume，前端据此显继续按钮 + error 提示，与 error chunk 分支语义一致）。
    // isAgentAbortError 覆盖 AgentParkError（park extends abort），两者都抑制 error 通知。
    if (!isAgentAbortError(error)) {
      const raw = error.message
      logger.event('chat.run.error', { message: raw, source: 'generator-throw' }, LogLevel.error)
      // 与 error chunk 分支同款友好文案（前置 tracingId；无 category/source → unknown/system）。
      // 注意：此处绝不 recordTerminationFact / 发 timeline.patch——observer.ts 已在 catch 里对
      // park/未预期记过终止事实并发 patch，重复会双发。
      const message = `[${newTracingId()}] ${friendlyMessage('unknown', 'system')}`
      yield createNotification(
        'error',
        rid,
        { message, canResume: computeCanResume(chatId) },
        { chatId, runId },
      )
    }
    // 无论 abort/park/故障都补发 paused + 未完成 turn 的 turn.completed。
    const completedAt = Date.now()
    yield createNotification(
      'run.updated',
      rid,
      { runId, status: 'paused', at: completedAt },
      { chatId, runId },
    )
    for (const turnId of turnStarted) {
      if (completedTurns.has(turnId)) continue
      completedTurns.add(turnId)
      yield createNotification(
        'turn.completed',
        rid,
        { turnId, messageId: turnId, completedAt },
        { chatId, runId },
      )
    }
    // DB run fact 归 paused：abort 场景 observer 未记（abort 事实在 handleChatAbort 现场记），
    // 此处幂等补齐；unexpected/park 场景 observer 已记 paused，upsert 不降级不覆盖 nodeId。
    recordRunFact({ chatId, runId, status: 'paused' })
    // 继续上抛：send.ts catch 记日志 + finally releaseChatRun/releaseChatConnection 时序保持不变；
    // final Response 恒 success:true（统一暂停语义）。通知先于 rethrow 全部落地，无重复通知。
    throw err
  } finally {
    // 安全网：generator 既没 yield done/error、也没抛异常就结束（如中间件提前 return）→ 归 paused。
    // 真实 loop 中间件恒 yield done/error 或 throw，此处仅防御；无调用方对链条调 gen.return()
    //（observer/checkpoint/connection 显式规避），finally 内 yield 安全。
    if (!terminated) {
      const completedAt = Date.now()
      yield createNotification(
        'run.updated',
        rid,
        { runId, status: 'paused', at: completedAt },
        { chatId, runId },
      )
      for (const turnId of turnStarted) {
        if (completedTurns.has(turnId)) continue
        completedTurns.add(turnId)
        yield createNotification(
          'turn.completed',
          rid,
          { turnId, messageId: turnId, completedAt },
          { chatId, runId },
        )
      }
      recordRunFact({ chatId, runId, status: 'paused' })
    }
  }
}
