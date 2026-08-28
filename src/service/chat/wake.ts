import {
  addMessage,
  updateChatMetadata,
  getChat,
  getMessages,
  getLastMessage,
  getMessageLinksForRoot,
  parseMessageRow,
  getRootChatId,
  getTimelineRevision,
} from '@/db/chat.js'
import { safeJsonParse } from '@/utils/json.js'
import { ensureChat, abortChatRuntime, clearChatRuntime, getActiveChatRunId } from './runtime.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { createNotification } from '../message/types.js'
import { clearWaitedChild, registerWaitedChild, type WakePolicy } from '@/agent/spawnBroker.js'
import config from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'
import {
  appendChatEvent,
  getSpawnTaskByChild,
  listSpawnTasksNeedingWakeRecovery,
  timeoutSpawnTask,
} from '@/db/delivery.js'
import {
  completeQuestionBatch,
  type CompletedQuestionBatch,
  type QuestionBatchAnswerInput,
} from '@/db/question.js'
import { emitTimelinePatch } from './rootGraphPatch.js'
import { recordSpawnTerminationFact, recordTerminationFact } from './executionFacts.js'
import { transitionInteraction } from '@/db/interaction.js'
import { broadcastInteractionChanged } from '../interaction/events.js'

/** 向该 chat 的全部仍在线订阅者广播持久化 notification。 */
function broadcastChatNotification(chatId: string, notification: unknown): boolean {
  const targets = connectionManager.getChatOutputs(chatId)
  for (const ws of targets) {
    for (const routed of connectionManager.prepareSessionEvent(ws, notification)) {
      ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
    }
  }
  return targets.length > 0
}

/**
 * 唤醒主 chat（唤醒策略调度器调用，见 docs/agent-pet.md §5.4 唤醒策略调度器）。
 *
 * wakeParent：子完成 / 出错 / 看门狗超时 → 注入角色回复到主 chat（内存 journal + DB 双写）
 * + 推 role_reply notification → 前端 chat.resume 续跑主新一轮。
 *
 * silent（deferred/barrier 暂存）：只注入 role + DB 写 + 释放唤醒链，不唤主
 * （不置 resumePending / 不推 notification / 不 WS）。主停等态下 roleReplyPending 无效；
 * 主被将来某次唤主（immediate / 栅栏全完成 / deferred 兜底）resume 时，loop 消费所有暂存 role。
 *
 * 分层：本模块（service 层）拥 DB（addMessage/updateChatMetadata）+ runtime（ensureChat/abort）+
 * ws 推送（findOwnerWsByChatId）；spawnBroker（agent 层）只持唤醒态数据，经 clearWaitedChild 释放。
 *
 * 幂等：先 clearWaitedChild（防 child_done 与看门狗超时并发重复唤同一子）。
 * 前端离线（无 owner ws）：回复已落 DB，并在主 chat metadata 记 resumePending，重连后前端可恢复主循环。
 */
export async function wakeParent(
  parentChatId: string,
  childChatId: string,
  type: string,
  content: string,
  opts?: { silent?: boolean; causationNodeId?: string },
): Promise<void> {
  const silent = opts?.silent ?? false
  const initialSpawnTask = getSpawnTaskByChild(childChatId)
  // parent_chat_id remains immutable dispatch ownership; delivery_chat_id is
  // the mutable mainline target selected by continuation/activation.
  parentChatId = initialSpawnTask?.deliveryChatId ?? parentChatId
  // 来源说明：注入主 chat 的 role 消息统一带 [角色 type] 前缀（主 LLM 据此识别子来源）。
  // idempotent：caller 已格式化（看门狗超时、rebuild 空结果、旧记录带 [type]/[角色 type]）则不重复拼。
  const prefix = `[角色 ${type}]`
  const formattedContent =
    content.startsWith(prefix) || content.startsWith(`[${type}]`) ? content : `${prefix} ${content}`

  // 主 chat 已删除（用户删会话）→ 无处唤醒，仅清理（子结果丢弃）
  if (!getChat(parentChatId)) {
    clearWaitedChild(childChatId)
    logger.event('wake.parent-gone', { parentChatId, childChatId })
    return
  }

  let spawnTask = getSpawnTaskByChild(childChatId)
  const spawnTaskId = spawnTask?.taskId
  const existingReturn = spawnTaskId
    ? getMessageLinksForRoot(getRootChatId(parentChatId)).find(
        (link) => link.relation === 'child_return' && link.spawnId === spawnTaskId,
      )
    : undefined
  if (existingReturn) {
    updateChatMetadata(childChatId, { roleInjected: true })
    if (!silent) updateChatMetadata(parentChatId, { resumePending: true })
    clearWaitedChild(childChatId)
    logger.event('wake.duplicate-suppressed', {
      parentChatId,
      childChatId,
      messageId: existingReturn.messageId,
    })
    return
  }

  // 注入角色回复到主 chat：内存（journal，守单一写者，silent 不置 roleReplyPending）+ DB（addMessage）
  const builder = await ensureChat(parentChatId)
  // ensureChat may yield while a mainline switch commits. Re-read the
  // generation fence before the synchronous journal + DB append.
  const latestSpawnTask = getSpawnTaskByChild(childChatId)
  if (
    latestSpawnTask &&
    (latestSpawnTask.deliveryGeneration !== (spawnTask?.deliveryGeneration ?? -1) ||
      latestSpawnTask.deliveryChatId !== parentChatId)
  ) {
    return wakeParent(latestSpawnTask.deliveryChatId, childChatId, type, content, opts)
  }
  spawnTask = latestSpawnTask ?? spawnTask
  const parentWasRunning = builder.isRunning()
  const msgId = builder.appendRoleReply(formattedContent, { silent })
  const childLastMessage = getLastMessage(childChatId)
  const baseRevision = getTimelineRevision(parentChatId)
  addMessage(msgId, parentChatId, {
    role: 'role',
    content: formattedContent,
    link: {
      relation: 'child_return',
      sourceChatId: childChatId,
      parentChatId,
      spawnId: spawnTask?.taskId,
      relatedMessageId: childLastMessage?.id,
      causationNodeId: opts?.causationNodeId ?? childLastMessage?.id,
    },
  })
  emitTimelinePatch(parentChatId, baseRevision)

  // 持久幂等标记：子 chat metadata.roleInjected=true。重启后 rebuildWaitedChildren 据此跳过，
  // 避免对已 live 唤过的子再调 wakeParent 落第二行同内容 role DB 行（前端渲染重复两条）。
  updateChatMetadata(childChatId, { roleInjected: true })

  // 子结果持久化完成后再释放唤醒链，避免落库失败时丢失重试机会。
  clearWaitedChild(childChatId)

  if (silent) {
    // deferred/barrier 暂存：role 已注入 + DB 已写，不唤主。主被将来唤主 resume 时消费所有暂存 role。
    logger.event('wake.silent', { parentChatId, childChatId, type, contentLen: content.length })
    return
  }

  // immediate（或策略满足唤主）：父不在运行时置 resumePending（前端 resume 续跑）；
  // 父正在运行时 loop 会检测并消费新 role，无需额外 resume。
  if (!parentWasRunning) updateChatMetadata(parentChatId, { resumePending: true })

  // 读子 chat metadata.spawnSenseCallId（= 触发 spawn 的 sense call id）。
  let spawnSenseCallId: string | undefined
  const childMetaRow = getChat(childChatId)
  if (childMetaRow?.metadata) {
    try {
      const parsed = JSON.parse(childMetaRow.metadata) as { spawnSenseCallId?: unknown }
      if (typeof parsed.spawnSenseCallId === 'string' && parsed.spawnSenseCallId.length > 0) {
        spawnSenseCallId = parsed.spawnSenseCallId
      }
    } catch {
      // 元数据非合法 JSON → 旧记录兼容，忽略关联锚点即可。
    }
  }
  const notif = createNotification(
    'role_reply',
    undefined,
    {
      parentChatId,
      childChatId,
      type,
      content: formattedContent,
      msgId,
      spawnSenseCallId,
    },
    { chatId: parentChatId },
  )
  notif.seq = appendChatEvent(parentChatId, notif as unknown as Record<string, unknown>)

  if (!broadcastChatNotification(parentChatId, notif)) {
    // 前端离线：resumePending 已持久化，重连后 rebuildSpawnWaits 会恢复主循环。
    logger.event('wake.offline', { parentChatId, childChatId, type })
  }
  logger.event('wake.parent', { parentChatId, childChatId, type, contentLen: content.length })
}

/**
 * 推 child_abandoned notification（看门狗超时掐断子 agent）。
 * 与 role_reply 并列：role_reply 负责主唤醒 + 历史注入，child_abandoned 仅负责前端子 pet 即时转 ghost。
 * 两者并列发送互不阻塞——role_reply 丢投递时 child_abandoned 仍保证前端 ghost 视觉落地。
 * WS 投递用 findOwnerWsByChatId（主 turn 已结束也能反查 owner）；前端离线则由 chat.list 的 finished=true 重建兜底。
 */
export function emitChildAbandoned(
  parentChatId: string,
  childChatId: string,
  type: string,
  reason: string,
): void {
  const notif = createNotification(
    'child_abandoned',
    undefined,
    { parentChatId, childChatId, type, reason },
    { chatId: parentChatId },
  )
  notif.seq = appendChatEvent(parentChatId, notif as unknown as Record<string, unknown>)
  if (!broadcastChatNotification(parentChatId, notif)) {
    logger.event('wake.abandoned-offline', { parentChatId, childChatId, type })
  }
  logger.event('wake.child-abandoned', { parentChatId, childChatId, type })
}

/**
 * 原子完成一个持久化问题批次，并同步当前进程中的 agent journal。
 * DB 事务先写入全部 sense 答案和批次终态；随后设置 resumePending，并持久化完成事件。
 */
export async function resolveQuestionBatch(
  chatId: string,
  batchId: string,
  answers: QuestionBatchAnswerInput[],
): Promise<CompletedQuestionBatch> {
  if (!getChat(chatId)) throw new Error('这个会话不见了')

  const completed = completeQuestionBatch(chatId, batchId, answers)
  const interaction = transitionInteraction(
    batchId,
    ['pending', 'resolving', 'blocked'],
    'completed',
    {
      answers: completed.answers,
    },
  )
  broadcastInteractionChanged(interaction)

  updateChatMetadata(chatId, { resumePending: true })
  try {
    const builder = await ensureChat(chatId)
    for (const answer of completed.answers) {
      builder.completeSenseResult(answer.questionId, answer.answerText)
    }
  } catch (cause) {
    // DB answers + resumePending are already durable. A cold resume will rebuild
    // the journal from those rows, so an in-memory hydration failure is recoverable.
    logger.event('question.batch.runtime_sync_failed', {
      chatId,
      batchId,
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }
  if (completed.alreadyCompleted) return completed
  const notif = createNotification('question_batch_completed', undefined, { batchId }, { chatId })
  notif.seq = appendChatEvent(chatId, notif as unknown as Record<string, unknown>)
  if (!broadcastChatNotification(chatId, notif)) {
    logger.event('question.batch.completed-offline', { chatId, batchId })
  }
  logger.event('question.batch.completed', {
    chatId,
    batchId,
    questionCount: completed.answers.length,
  })
  return completed
}

/**
 * 看门狗超时回调（service 启动期 setAsyncWakeHandler 注入）。
 * feed-dog 机制：子 timeout_ms（config.global.watchdog.timeout_ms，默认 5min）内无 chunk 喂狗 → 判定卡死。
 * 按 config.global.watchdog.wake_on_timeout 决定行为：
 *
 * - true（子废弃为 ghost）：
 *   - updateChatMetadata(abandoned=true, finished=true) 标记 ghost
 *   - wakeParent 唤主告知「任务已结束，无法完成」（resumePending + notification 推送）
 *     wakeParent 内部 clearWaitedChild（释放唤醒链 + 看门狗）
 *   - abortChatRuntime + clearChatRuntime 释放挂死 generator 与内存
 *   - 父决策后续补救（spawn 新子 / 改 prompt / 告知用户）
 *   - 用户无法再对子 Agent 做任何操作（chat.send/resume 拒绝，computeCanResume=false）
 *
 * - false（主无限等待，默认）：
 *   - 不唤主：不调 wakeParent、不设 resumePending、不推 notification
 *   - 保留唤醒链（不清 waitedChildren）— 用户可手动 resume 子（chat.send/chat.resume，
 *     ensureChat 重建 builder），子最终完成仍走 child_done → wakeParent 正常唤主
 *   - abortChatRuntime + clearChatRuntime 释放子 generator + runtime
 *   - 主不被错误情况唤醒
 */
export async function handleAsyncWakeTimeout(child: {
  childChatId: string
  parentChatId: string
  type: string
}): Promise<void> {
  const wakeOnTimeout = config.global.watchdog?.wake_on_timeout ?? false
  const timeoutSec = (config.global.watchdog?.timeout_ms ?? 5 * 60 * 1000) / 1000
  if (wakeOnTimeout) {
    const timeout = timeoutSpawnTask(child.childChatId)
    if (!timeout.task) {
      logger.event('watchdog.timeout.missing-task', child, 3)
      abortChatRuntime(child.childChatId)
      clearChatRuntime(child.childChatId)
      return
    }
    if (!timeout.firstTimeout) return
    const activeRunId = getActiveChatRunId(child.childChatId)
    const baseRevision = getTimelineRevision(child.childChatId)
    const termination = recordSpawnTerminationFact({
      rootChatId: getRootChatId(child.parentChatId),
      parentChatId: child.parentChatId,
      childChatId: child.childChatId,
      taskId: timeout.task.taskId,
      ...(activeRunId ? { runId: activeRunId } : {}),
      code: 'watchdog',
      detail: `${timeoutSec}s without output`,
    })
    emitTimelinePatch(child.childChatId, baseRevision)
    // true：子标记 ghost + 唤主告知任务已结束 + 释放子 runtime。
    const reason = `子任务执行超时（${timeoutSec}s 无输出），任务已结束，无法完成`
    await wakeParent(
      child.parentChatId,
      child.childChatId,
      child.type,
      `[角色 ${child.type}] ${reason}`,
      { causationNodeId: termination.id },
    )
    // 显式 child_abandoned notification：前端据 childChatId 即时转 ghost，不等 role_reply
    // 的 WS 投递兜底（role_reply 走 findOwnerWsByChatId，连接轮换/非 owner 会丢）。
    // 与 role_reply 并列：child_abandoned 只负责 ghost 视觉，不注入历史/不唤主。
    emitChildAbandoned(child.parentChatId, child.childChatId, child.type, reason)
    updateChatMetadata(child.childChatId, { abandoned: true, finished: true })
    abortChatRuntime(child.childChatId)
    clearChatRuntime(child.childChatId)
    return
  }
  const activeRunId = getActiveChatRunId(child.childChatId)
  if (activeRunId) {
    const baseRevision = getTimelineRevision(child.childChatId)
    recordTerminationFact({
      chatId: child.childChatId,
      runId: activeRunId,
      actor: 'system',
      code: 'watchdog',
      detail: `${timeoutSec}s without output`,
    })
    emitTimelinePatch(child.childChatId, baseRevision)
    // false 分支仍推 run.updated{paused} 终态：前端据终态清 run.status，
    // 避免子 pet / CRT「工作中」在看门狗超时后永久残留（与 emitChildAbandoned 同广播模式）。
    const notif = createNotification(
      'run.updated',
      undefined,
      { runId: activeRunId, status: 'paused', at: Date.now() },
      { chatId: child.childChatId },
    )
    notif.seq = appendChatEvent(child.childChatId, notif as unknown as Record<string, unknown>)
    if (!broadcastChatNotification(child.childChatId, notif)) {
      logger.event('watchdog.paused-offline', {
        chatId: child.childChatId,
        runId: activeRunId,
      })
    }
  }
  // false：主无限等待；唤醒链保留（不清 waitedChildren）；释放子 runtime。
  // 子若恢复 chunk → feedWatchdog 续命；子若最终完成 → child_done → wakeParent 正常唤主。
  logger.event('watchdog.timeout.silent', {
    parentChatId: child.parentChatId,
    childChatId: child.childChatId,
    type: child.type,
    timeoutSec,
  })
  abortChatRuntime(child.childChatId)
  clearChatRuntime(child.childChatId)
}

/**
 * 后端启动重建唤醒链（T9.10 重启容错，见 docs/agent-pet.md §5.8）。
 * 扫所有子 chat（parent_chat_id 非空）按 wake 策略分流：
 * - spawn task timed_out 且尚未 roleInjected → 以稳定 termination 因果补写超时回传。
 * - abandoned=true（已处理的 ghost）→ 跳过，避免重启后重复唤主。
 * - finished=true（子完成、崩溃前未唤主）→ wakeParent 从 DB 末条 assistant content 补注入：
 *   immediate 补唤主（silent=false）；deferred/barrier 静默注入（silent=true，主 resumePending 不置，用户手动 resume 消费）。
 * - finished!==true（interrupted，turn 中断）→ registerWaitedChild 重建链+看门狗（带 policy，待前端重连续跑子，完成唤主）。
 *
 * service/index.ts 启动期调用（broadcaster / asyncWake 注入之后）。
 * 内存态 waitedChildren 重启即丢，本函数从持久化 metadata 重建，使唤醒链跨后端重启可恢复。
 */
export async function rebuildWaitedChildren(): Promise<void> {
  const tasks = listSpawnTasksNeedingWakeRecovery()
  for (const spawnTask of tasks) {
    const row = getChat(spawnTask.childChatId)
    if (!row?.parent_chat_id) continue
    const meta = row.metadata
      ? (safeJsonParse(row.metadata, {}) as {
          wake?: WakePolicy
          finished?: boolean
          abandoned?: boolean
          roleInjected?: boolean
          type?: string
        })
      : {}

    const childChatId = row.id
    const parentChatId = row.parent_chat_id
    const type = meta.type ?? 'unknown'
    const policy: WakePolicy = meta.wake ?? 'immediate' // 旧记录无 wake 默认 immediate

    // roleInjected 幂等：live 期 wakeParent 已注入过 role 回复 → 跳过，不重复补注入。
    // 防重启对已唤过的子再落第二行同内容 role DB 行（前端渲染重复两条）。旧记录无此标记默认未注入。
    if (meta.roleInjected === true) {
      logger.event('rebuild.skip-injected', { childChatId, parentChatId, type, policy })
      continue
    }

    if (spawnTask?.status === 'timed_out') {
      const timeoutSec = (config.global.watchdog?.timeout_ms ?? 5 * 60 * 1000) / 1000
      const termination = recordSpawnTerminationFact({
        rootChatId: getRootChatId(parentChatId),
        parentChatId,
        childChatId,
        taskId: spawnTask.taskId,
        code: 'watchdog',
        detail: `${timeoutSec}s without output`,
      })
      await wakeParent(
        parentChatId,
        childChatId,
        type,
        `[角色 ${type}] 子任务执行超时（${timeoutSec}s 无输出），任务已结束，无法完成`,
        { causationNodeId: termination.id },
      )
      updateChatMetadata(childChatId, { abandoned: true, finished: true })
      logger.event('rebuild.wake-timeout', { childChatId, parentChatId, type })
      continue
    }

    // abandoned 兜底：已成功注入回传的 ghost 子不会走到这里；异常残留也不重建为可运行任务。
    if (meta.abandoned === true) {
      logger.event('rebuild.skip-abandoned', { childChatId, parentChatId, type })
      continue
    }

    if (meta.finished === true) {
      // 子已完成、崩溃前未唤主 → 从 DB 末条 assistant content 补注入
      const msgs = getMessages(childChatId)
      let content = ''
      for (let i = msgs.length - 1; i >= 0; i--) {
        const parsed = parseMessageRow(msgs[i]!)
        if (parsed.role === 'assistant') {
          content = parsed.content ?? ''
          break
        }
      }
      await wakeParent(parentChatId, childChatId, type, content || `[角色 ${type}]（无结果内容）`, {
        silent: policy !== 'immediate',
      })
      logger.event('rebuild.wake-finished', { childChatId, parentChatId, type, policy })
    } else {
      // interrupted → 重建唤醒链 + 看门狗（前端重连 chat.resume 续跑子，完成唤主）
      registerWaitedChild(childChatId, parentChatId, type, policy)
      logger.event('rebuild.wait-interrupted', { childChatId, parentChatId, type, policy })
    }
  }
}
