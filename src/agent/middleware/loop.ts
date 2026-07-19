import type {
  MiddlewareContext,
  LoopHandler,
  ErrorChunk,
  DoneChunk,
  ChildYieldChunk,
  ChildDoneChunk,
} from '@/core/middleware/types'
import type { MiddlewareChunk } from './index'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import { getWaitedParent } from '@/agent/spawnBroker.js'

/**
 * 创建 agent 层循环策略
 * 包装单次 chain 执行，实现 sense 循环 + maxLoop 超限处理
 */
export function createLoopHandler(maxLoop: number = 30): LoopHandler<MiddlewareChunk> {
  return async function* loopHandler(
    ctx: MiddlewareContext,
    runChain: () => AsyncGenerator<MiddlewareChunk, void, unknown>,
  ): AsyncGenerator<MiddlewareChunk, void, unknown> {
    let times = 0
    let stopped = false // 区分 break（正常停止）vs while 条件耗尽（避免误报）
    let failed = false // runChain 内 yield ErrorChunk（retry 重试耗尽等）→ 跳过末尾 done yield

    // yieldTurn 仅属于上一轮 spawn(wait=true) 的停止决定；同一 AgentSession 被 resume 时必须重置，
    // 否则已回传的 role 会在首轮 LLM 调用后再次被旧标记直接截断。
    ctx.soul.yieldTurn = false

    logger.event('loop.start', { max: maxLoop })

    while (times < maxLoop) {
      times++

      logger.event('loop.iter', { n: times })

      // 本轮开始前清空标记；runChain 期间到达的角色结果会重新置位，
      // 从而在本轮 assistant 输出后继续处理，而非被末尾 assistant 掩盖。
      ctx.soul.roleReplyPending = false

      // 检查 runChain 抛出的 ErrorChunk（retry 重试耗尽后 yield），设 failed=true。
      // 抛出 ErrorChunk 后不再继续 loop（重试已耗尽，无新驱动）。
      try {
        for await (const chunk of runChain()) {
          if (chunk.type === 'error') failed = true
          yield chunk
          if (failed) break
        }
      } catch (err) {
        // runChain 直接 throw（非 yield ErrorChunk）：同样标记失败，让错误传播。
        failed = true
        throw err
      }
      if (failed) break

      if (ctx.soul.roleReplyPending) {
        logger.event('loop.decision', { decision: 'continue', reason: 'role-reply-during-run' })
        continue
      }

      // 检查 loop 停止条件（基于 ctx.soul.messages）
      const messages = ctx.soul.messages
      if (!messages || messages.length === 0) {
        if (ctx.soul.userInputs.length > 0) {
          logger.event('loop.decision', {
            decision: 'continue',
            reason: 'residual-userInputs-empty-messages',
          })
          continue
        }
        logger.event('loop.decision', { decision: 'stop', reason: 'no-messages' })
        stopped = true
        break
      }

      // P1-9：跳过已撤回 revoked（revokeTrailingCycle 后末尾可能为 revoked），取最后一条可见消息
      //       判定 loop 分支，避免 revoked 末尾误判（sense→continue / assistant 无 senseCall→stop）。
      const lastVisible = [...messages].reverse().find((m) => !m.revoked)

      // 全部 revoked 或无可判定消息 → 残留输入则继续，否则停止
      if (!lastVisible) {
        if (ctx.soul.userInputs.length > 0) {
          logger.event('loop.decision', {
            decision: 'continue',
            reason: 'residual-userInputs-no-visible',
          })
          continue
        }
        logger.event('loop.decision', { decision: 'stop', reason: 'no-visible-message' })
        stopped = true
        break
      }

      // T9：yieldTurn（spawn_role wait=true 置位）→ 主 loop 立即结束本 turn
      // （子完成后后端注入角色回复唤起新一轮）。break（非 continue）跳 maxLoop 误报、done 正常发。
      if (ctx.soul.yieldTurn) {
        logger.event('loop.decision', { decision: 'stop', reason: 'yield-turn' })
        stopped = true
        break
      }

      // 1. 最后一条是 sense → 刚执行完感官 → 继续 loop（获取 LLM 新响应）
      if (lastVisible.role === 'sense') {
        logger.event('loop.decision', { decision: 'continue', reason: 'last-sense' })
        continue
      }

      // T9：最后一条是角色回复（wait=true 子完成注入，role 或旧历史 subagent）→ 继续 loop（LLM 响应注入的回复）
      if (lastVisible.role === 'role' || lastVisible.role === 'subagent') {
        logger.event('loop.decision', { decision: 'continue', reason: 'last-role' })
        continue
      }

      // 2. 最后一条是 assistant 且有 senseCalls → 感官调用完成 → 继续 loop（执行下一轮感官）
      if (lastVisible.role === 'assistant' && lastVisible.senseCalls?.length) {
        logger.event('loop.decision', {
          decision: 'continue',
          reason: 'assistant-senseCalls',
          senses: lastVisible.senseCalls.map((sc) => sc.name),
        })
        continue
      }

      // 3. 其他情况（assistant 无 senseCall / user / system）→ 检查残留输入后再停止
      if (ctx.soul.userInputs.length > 0) {
        logger.event('loop.decision', { decision: 'continue', reason: 'residual-userInputs' })
        continue
      }
      logger.event('loop.decision', {
        decision: 'stop',
        reason: `last-${lastVisible.role}`,
        lastRole: lastVisible.role,
      })
      stopped = true
      break
    }

    // 仅当 while 条件耗尽（非 break）才报 max loop 超限。
    // 旧实现 `times >= maxLoop` 在第 maxLoop 轮正常 break 时（times===maxLoop）会误报。
    if (!stopped && !failed && times >= maxLoop) {
      logger.event('loop.max', { max: maxLoop }, LogLevel.warn)
      const errorChunk: ErrorChunk = {
        type: 'error',
        errors: [
          {
            attempt: times,
            timestamp: Date.now(),
            message: `已达到最大循环次数限制 (${maxLoop})`,
            userMessage: '我绕进去了，先停下来',
            recoverable: false,
            category: 'validation',
          },
        ],
      }
      yield errorChunk
      failed = true
    }

    logger.event('loop.end', { iterations: times })

    // T9：本 chat 是被 wait 的子（waitedChildren 命中）→ loop 结束时判断是"本轮暂停"还是"真正完成"。
    // - yieldTurn=true（spawn 孙 agent wait=true 触发）→ yield child_yield（不唤醒主，不设 finished）
    // - yieldTurn=false（无 spawn 孙或所有任务完成）→ yield child_done（唤醒主，设 finished）
    // getWaitedParent 守卫：仅被 wait 的子 chat 发，过滤主 agent / wait=false 子（也跑 loop 但无唤醒链）。
    // 注：runChain 内 throw 路径下不执行此处（throw 跳过），子 error 由 observer catch → wakeParent(error)。
    // failed 时不 yield child_yield/child_done：错误路径下由 observer catch 走 wakeParent(error)。
    if (!failed) {
      const waited = getWaitedParent(ctx.soul.chatId)
      if (waited) {
        const result =
          ctx.journal
            .getMessages()
            .filter((m) => m.role === 'assistant')
            .pop()?.content || ''

        // 区分 yield turn 和真正完成
        // 注意：第 24 行在 loop 开始时重置 yieldTurn=false
        // spawn sense 在 runChain 期间设置 yieldTurn=true（spawn.ts:211）
        // 所以这里检查的是 runChain 期间是否设置了 yieldTurn
        if (ctx.soul.yieldTurn) {
          // yield turn：本轮暂停，不唤醒主，不设 finished
          const childYield: ChildYieldChunk = {
            type: 'child_yield',
            childChatId: ctx.soul.chatId,
            content: result,
          }
          yield childYield
          logger.event('loop.child_yield', { childChatId: ctx.soul.chatId })
        } else {
          // 真正完成：唤醒主，设 finished
          const childDone: ChildDoneChunk = {
            type: 'child_done',
            childChatId: ctx.soul.chatId,
            content: result,
          }
          yield childDone
          logger.event('loop.child_done', { childChatId: ctx.soul.chatId })
        }
      }
    }

    // loop 结束后 yield done（表示整个流程完成）。
    // 失败路径（retry yield ErrorChunk / max loop 超限）跳过 done：让 streamMapper 不下发 done notification，
    // send.ts 据 collected failure message 填 failureResponse，最终 Response.success=false。
    if (!failed) {
      const doneChunk: DoneChunk = { type: 'done' }
      yield doneChunk
    } else {
      logger.event('loop.end.failed', { iterations: times }, LogLevel.warn)
    }
  }
}
