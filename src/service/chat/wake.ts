import {
  addMessage,
  updateChatMetadata,
  getChat,
  listAllChats,
  getMessages,
  parseMessageRow,
} from '@/db/chat.js'
import { safeJsonParse } from '@/utils/json.js'
import { ensureChat, abortChatRuntime, clearChatRuntime } from './runtime.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { createNotification } from '../message/types.js'
import { clearWaitedChild, registerWaitedChild, type WakePolicy } from '@/agent/spawnBroker.js'
import config from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'
import { appendChatEvent } from '@/db/delivery.js'
import {
  completeQuestionBatch,
  type CompletedQuestionBatch,
  type QuestionBatchAnswerInput,
} from '@/db/question.js'

/** 向该 chat 的全部仍在线订阅者广播持久化 notification。 */
function broadcastChatNotification(chatId: string, notification: unknown): boolean {
  const targets = connectionManager.getChatOutputs(chatId)
  for (const ws of targets) {
    ws.send(transport.encode(notification as Parameters<typeof transport.encode>[0]))
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
  opts?: { silent?: boolean },
): Promise<void> {
  const silent = opts?.silent ?? false
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

  // 注入角色回复到主 chat：内存（journal，守单一写者，silent 不置 roleReplyPending）+ DB（addMessage）
  const builder = await ensureChat(parentChatId)
  const parentWasRunning = builder.isRunning()
  const msgId = builder.appendRoleReply(formattedContent, { silent })
  addMessage(msgId, parentChatId, { role: 'role', content: formattedContent })

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
function emitChildAbandoned(
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
  if (completed.alreadyCompleted) return completed

  const builder = await ensureChat(chatId)
  for (const answer of completed.answers) {
    builder.completeSenseResult(answer.questionId, answer.answerText)
  }
  updateChatMetadata(chatId, { resumePending: true })
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
export function handleAsyncWakeTimeout(child: {
  childChatId: string
  parentChatId: string
  type: string
}): void {
  const wakeOnTimeout = config.global.watchdog?.wake_on_timeout ?? false
  const timeoutSec = (config.global.watchdog?.timeout_ms ?? 5 * 60 * 1000) / 1000
  if (wakeOnTimeout) {
    // true：子标记 ghost + 唤主告知任务已结束 + 释放子 runtime。
    const reason = `子任务执行超时（${timeoutSec}s 无输出），任务已结束，无法完成`
    void wakeParent(
      child.parentChatId,
      child.childChatId,
      child.type,
      `[角色 ${child.type}] ${reason}`,
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
 * - abandoned=true（看门狗 wake_on_timeout=true 标记的 ghost）→ 跳过：超时回调已处理
 *   （wakeParent 一次性唤主），避免重启后重复唤主。
 * - finished=true（子完成、崩溃前未唤主）→ wakeParent 从 DB 末条 assistant content 补注入：
 *   immediate 补唤主（silent=false）；deferred/barrier 静默注入（silent=true，主 resumePending 不置，用户手动 resume 消费）。
 * - finished!==true（interrupted，turn 中断）→ registerWaitedChild 重建链+看门狗（带 policy，待前端重连续跑子，完成唤主）。
 *
 * service/index.ts 启动期调用（broadcaster / asyncWake 注入之后）。
 * 内存态 waitedChildren 重启即丢，本函数从持久化 metadata 重建，使唤醒链跨后端重启可恢复。
 */
export async function rebuildWaitedChildren(): Promise<void> {
  const rows = listAllChats()
  for (const row of rows) {
    if (!row.parent_chat_id) continue // 仅子 chat
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

    // abandoned 兜底：ghost 子（超时回调已唤主）重启不重建、不重复唤主
    if (meta.abandoned === true) {
      logger.event('rebuild.skip-abandoned', { childChatId, parentChatId, type })
      continue
    }

    // roleInjected 幂等：live 期 wakeParent 已注入过 role 回复 → 跳过，不重复补注入。
    // 防重启对已唤过的子再落第二行同内容 role DB 行（前端渲染重复两条）。旧记录无此标记默认未注入。
    if (meta.roleInjected === true) {
      logger.event('rebuild.skip-injected', { childChatId, parentChatId, type, policy })
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
