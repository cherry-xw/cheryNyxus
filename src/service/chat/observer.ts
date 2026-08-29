import {
  addMessage,
  fillApprovalResult,
  markMessageReplaced,
  updateAssistantSenseCalls,
  updateChatMetadata,
  getTimelineRevision,
} from '@/db/chat.js'
import { getActiveChatRunId, getChatRuntimeProvenance } from './runtime.js'
import { approvalManager } from '../approval/manager.js'
import { getSense } from '@/core/sense/senseRegistry.js'

import { onChildDone } from './wakeScheduler.js'
import type { LLMResponse } from '@/core/message/adapter'
import type { MiddlewareChunk } from '@/core/middleware/types'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import config from '@/utils/config.js'
import { getWaitedParent, feedWatchdog } from '@/agent/spawnBroker.js'
import { isAgentAbortError, isAgentParkError } from '@/core/middleware/errors.js'
import { ClassifiedError } from '@/utils/error.js'
import { createQuestionBatch } from '@/db/question.js'
import { upsertPendingInteraction } from '@/db/interaction.js'
import { broadcastInteractionChanged } from '../interaction/events.js'
import { emitTimelinePatch } from './rootGraphPatch.js'
import { recordTerminationFact } from './executionFacts.js'

function unexpectedTerminationContent(error: unknown): string {
  if (error instanceof ClassifiedError) {
    const guidance =
      error.category === 'validation' && error.source === 'brain'
        ? '请在设置中修正模型地址、模型或密钥配置后，再继续运行。'
        : '可以尝试继续运行；若持续出现，请检查服务设置或查看日志。'
    return `本轮运行未完成。\n\n${error.userMessage}\n\n下一步：${guidance}`
  }
  return '本轮运行意外中断。\n\n下一步：可以尝试继续运行；若持续出现，请检查服务设置或查看日志。'
}

/**
 * 统一消费 agent 内部 effect chunk（P2-1 从 send.ts 拆出）。
 * middleware 只产出事实流，service observer 在这里集中处理 DB/approval 副作用。
 *
 * onUserMessageCreated（可选）：user message 落库后回调（携带 msgId）。
 * send.ts 据此在 Response.data 回 userMsgId，前端 sendMessage 即时 push user prompt
 * 到 stream.history 时附带 msgId，下一次 chat.get reload 时按 msgId dedup。
 */
export async function* observeAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  chatId: string,
  getMessages: () => LLMResponse[],
  onUserMessageCreated?: (msgId: string) => void,
): AsyncGenerator<MiddlewareChunk, void, unknown> {
  // 历史消息（loadHistory 注入）视为已落库，避免 abort flush 时重复 INSERT 触发 UNIQUE 冲突。
  const syncedIds = new Set<string>(getMessages().map((m) => m.id))
  try {
    for await (const chunk of generator) {
      // feed-dog：每条 chunk 到达 = 子 agent generator 仍活着 = 未卡死，重置看门狗计时。
      // 主 chat（非注册唤醒子）feedWatchdog 内部自动忽略（waitedChildren 无此 chatId）。
      feedWatchdog(chatId)
      if (chunk.type === 'message_created') {
        if (chunk.message.ephemeral) {
          // 命令正文等模型专用上下文不属于用户历史，也不应产生 timeline fact。
          syncedIds.add(chunk.message.id)
          continue
        }
        if (!syncedIds.has(chunk.message.id)) {
          const baseRevision = getTimelineRevision(chatId)
          addMessage(chunk.message.id, chatId, {
            role: chunk.message.role,
            content: chunk.message.content,
            thinking: chunk.message.thinking,
            thinkingBlocks: chunk.message.thinkingBlocks,
            senseCall: chunk.message.senseCalls,
            hash: chunk.message.hash,
            contextCompaction: chunk.message.contextCompaction,
            contextCompactionTokens: chunk.message.contextCompactionTokens,
            // 仅 user 消息记 runtime（发送时配置 + brain model/provider 溯源快照）；assistant/sense 不记 NULL
            runtime: chunk.message.role === 'user' ? getChatRuntimeProvenance(chatId) : undefined,
            ...(chunk.message.linkRelation
              ? { link: { relation: chunk.message.linkRelation } }
              : {}),
          })
          syncedIds.add(chunk.message.id)
          emitTimelinePatch(chatId, baseRevision)
          // user 消息落库后回调（send.ts 据此回 userMsgId 给前端做实时 push + msgId dedup）
          if (chunk.message.role === 'user' && onUserMessageCreated) {
            onUserMessageCreated(chunk.message.id)
          }
          logger.event('message.created', {
            messageId: chunk.message.id,
            role: chunk.message.role,
            contentLen: chunk.message.content?.length ?? 0,
            thinkingLen: chunk.message.thinking?.length ?? 0,
            senseCalls: chunk.message.senseCalls?.length,
            hash: chunk.message.hash,
          })
        }
        // Keep the effect internal, but let the transport mapper observe the
        // committed assistant boundary. The timeline patch has already been
        // emitted above, so it is safe for the mapper to close this node's CRT.
        yield chunk
        continue
      }

      if (chunk.type === 'message_updated') {
        const baseRevision = getTimelineRevision(chatId)
        if (chunk.patch.kind === 'replace') {
          // 感官去重命中：content 改说明文字 + replace 状态 + originalContent 落库
          markMessageReplaced(chatId, chunk.id, {
            content: chunk.patch.content,
            replace: chunk.patch.replace,
            originalContent: chunk.patch.originalContent,
          })
          syncedIds.add(chunk.id)
          emitTimelinePatch(chatId, baseRevision)
          logger.event('message.replaced.db', { messageId: chunk.id, by: chunk.patch.replace.by })
          // yield 出去让 streamAgentChunks 转 "replaced" notification，
          // 通知 web 实时更新对应历史 sense block（而非等下次 chat.get 回放）。
          yield chunk
          continue
        }

        // recovery update patch = { content, hash }，整体写入
        // （旧实现仅判 content 丢 hash → smart pending sense hash 永远 NULL → 重启去重失效）
        fillApprovalResult(chatId, chunk.id, {
          content: chunk.patch.content,
          hash: chunk.patch.hash,
        })
        syncedIds.add(chunk.id)
        emitTimelinePatch(chatId, baseRevision)
        logger.event('message.updated', {
          messageId: chunk.id,
          contentLen: chunk.patch.content?.length ?? 0,
          hash: chunk.patch.hash,
        })

        // 流式多 sense_call reconcile：patch 仅含 senseCalls 时调 updateAssistantSenseCalls（独立 UPDATE）
        if (chunk.patch.senseCalls) {
          const senseBaseRevision = getTimelineRevision(chatId)
          updateAssistantSenseCalls(chatId, chunk.id, chunk.patch.senseCalls)
          emitTimelinePatch(chatId, senseBaseRevision)
          logger.event('message.updated.sense_calls', {
            messageId: chunk.id,
            senseCalls: chunk.patch.senseCalls.length,
          })
        }
        continue
      }

      if (chunk.type === 'sense_pending') {
        // P1-11：approvalPromise 由 core approvalRegistry 管理，service 仅按 approvalId 注册标记，
        //   confirm/abort 时 ApprovalManager 调 resolveApproval/rejectApproval 触发 core await。
        // payload（chatId/senseName/waitTime/createdAt）供 chat.list 派生 pendingApproval「琴键」闪烁态；
        //   waitTime/createdAt 与 streamMapper interrupt 通知同源（global.approval_timeout / Date.now()）。
        approvalManager.register(chunk.approvalId, {
          chatId,
          senseName: chunk.senseName,
          // 工具能力解释（config_manage 等）：待确认面板小字展示。来源 sense 定义，缺失时 undefined。
          senseDescription: getSense(chunk.senseName)?.definition?.function?.description,
          waitTime: config.global.approval_timeout ?? 0,
          createdAt: Date.now(),
          arguments: chunk.arguments,
          supervisionLevel: chunk.supervisionLevel,
          security: chunk.security,
        })
        logger.event('approval.pending', {
          approvalId: chunk.approvalId,
          senseName: chunk.senseName,
          supervisionLevel: chunk.supervisionLevel,
        })
        continue
      }

      if (chunk.type === 'question_batch_pending') {
        // placeholder sense 已由前序 message_created effect 全部落库；先持久化批次，再允许协议事件出站。
        // 这样任何收到事件的客户端都能立即安全调用原子 batchAnswer。
        const batch = createQuestionBatch(chatId, chunk.assistantMessageId, chunk.questions)
        if (!batch) continue
        const interaction = upsertPendingInteraction({
          interactionId: batch.batchId,
          kind: 'question_batch',
          chatId,
          anchorNodeId: batch.assistantMessageId,
          payload: {
            assistantMessageId: batch.assistantMessageId,
            questions: batch.questions,
          },
        })
        broadcastInteractionChanged(interaction)
        logger.event('question.batch.pending', {
          batchId: chunk.batchId,
          assistantMessageId: chunk.assistantMessageId,
          questionCount: chunk.questions.length,
        })
        yield chunk
        continue
      }

      // child_yield chunk（wait=true 子 agent yield turn 本轮暂停）→ 仅记录日志，不唤醒主，不设 finished
      // 子 agent 保持活跃状态，等待孙 agent 完成后 resume 继续运行
      if (chunk.type === 'child_yield') {
        logger.event('child.yield', {
          childChatId: chunk.childChatId,
          contentLen: chunk.content.length,
        })
        continue
      }

      // child_done chunk（子 loop 真正完成）→ 标 finished + wakeScheduler 按策略唤主/暂存
      if (chunk.type === 'child_done') {
        const waited = getWaitedParent(chunk.childChatId)
        if (waited) {
          // child_done 已是子 agent 的权威终态。先持久化 finished，再交调度器：
          // 避免聚合唤主时 role_reply 已送达但刷新读不到 finished 的窗口；
          // 调度器 allChildrenFinished 判定也依赖此标记。
          updateChatMetadata(chunk.childChatId, { finished: true })

          // wakeScheduler 按 wake_policy 决定 silent 暂存（deferred/barrier）/ resume 唤主（immediate/策略满足）
          await onChildDone(chunk.childChatId, chunk.content)

          logger.event('child.done.schedule', {
            childChatId: chunk.childChatId,
            parentChatId: waited.parentChatId,
            contentLen: chunk.content.length,
          })
        }
        continue
      }

      yield chunk
    }
  } catch (err) {
    // 控制流信号（用户 chat.abort / WS 断连 park）归 paused；未预期异常记录 error
    // termination 并归 failed。两者都不唤主、不写 finished；canResume 由末条消息独立派生。
    // 用户可在 canResume=true 时显式续跑，父若仍等待则由看门狗中性唤主或用户干预。
    // child_done 正常完成路径不触发此处（throw 跳过 loop 末尾 child_done yield）。
    const activeRunId = getActiveChatRunId(chatId)
    if (isAgentParkError(err)) {
      if (activeRunId) {
        const baseRevision = getTimelineRevision(chatId)
        recordTerminationFact({
          chatId,
          runId: activeRunId,
          actor: 'system',
          code: 'system_stop',
          detail: 'disconnect grace park',
        })
        emitTimelinePatch(chatId, baseRevision)
      }
      logger.event('agent.paused', { chatId, kind: 'park' })
    } else if (isAgentAbortError(err)) {
      logger.event('agent.paused', { chatId, kind: 'abort' })
    } else {
      if (activeRunId) {
        const baseRevision = getTimelineRevision(chatId)
        recordTerminationFact({
          chatId,
          runId: activeRunId,
          actor: 'system',
          code: 'error',
          content: unexpectedTerminationContent(err),
          detail: (err as Error).message,
        })
        emitTimelinePatch(chatId, baseRevision)
      }
      logger.event(
        'agent.failed',
        {
          chatId,
          kind: 'unexpected',
          message: (err as Error).message,
          stack: (err as Error).stack,
        },
        LogLevel.error,
      )
    }
    throw err
  } finally {
    // abort 兜底：ws.close → connectionManager.close → approvalManager.abort 解除 senseMiddleware
    // await（不调 gen.return，避免与 catch yield 死锁）。sense_call 流的 assistant 已在 sense_end
    // 时落库（for-await 内 effect）；纯 content 流的 assistant 在 checkpoint finally yield effect
    // 被 observer 消费落库。此处兜底 flush 极端情况未 sync 的消息，保证 DB 一致。
    for (const m of getMessages()) {
      // 仅落库 user/assistant/sense（system 仅内存 loadHistory 期不入库；function 本项目不产生）
      if (m.revoked) continue
      if (m.ephemeral) continue
      if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'sense') continue
      if (syncedIds.has(m.id)) continue
      const baseRevision = getTimelineRevision(chatId)
      addMessage(m.id, chatId, {
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        thinkingBlocks: m.thinkingBlocks,
        senseCall: m.senseCalls,
        hash: m.hash,
        contextCompaction: m.contextCompaction,
        contextCompactionTokens: m.contextCompactionTokens,
        // 仅 user 消息记 runtime（发送时配置 + brain model/provider 溯源快照）
        runtime: m.role === 'user' ? getChatRuntimeProvenance(chatId) : undefined,
      })
      syncedIds.add(m.id)
      emitTimelinePatch(chatId, baseRevision)
    }
  }
}
