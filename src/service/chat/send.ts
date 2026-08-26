import type { HandlerContext } from '../message/router.js'
import {
  createChunk,
  createError,
  createNotification,
  createResponse,
  ErrorCode,
  Method,
  type Chunk,
  type Notification,
  type Response as RpcResponse,
  type ChatSendRequestData,
  type ChatSendResponseData,
  type ChatResumeRequestData,
  type ChatResumeResponseData,
  type SenseApprovalRequestData,
  type SenseApprovalResponseData,
  type SenseQuestionAnswerRequestData,
  type SenseQuestionAnswerResponseData,
  type SenseQuestionBatchAnswerRequestData,
  type SenseQuestionBatchAnswerResponseData,
  type ChatAbortRequestData,
  type ChatAbortResponseData,
  type ChildControlTargetResult,
} from '../message/types.js'
import {
  getChat,
  markMessagesRevoked,
  updateChatMetadata,
  collectDescendantsChatIds,
  getTimelineRevision,
  getRootChatId,
  bumpTimelineRevision,
} from '@/db/chat.js'
import { approvalManager } from '../approval/manager.js'
import { findPendingQuestionBatchByQuestionId, hasPendingQuestionBatches } from '@/db/question.js'
import { resolveQuestionBatch } from './wake.js'
import { connectionManager } from '../websocket/connection.js'
import {
  ensureChat,
  clearChatRuntime,
  abortChatRuntime,
  getChatSelection,
  getActiveChatRunId,
  activateChatRun,
  releaseChatRun,
} from './runtime.js'
import { clearWaitedChildrenByParent } from '@/agent/spawnBroker.js'
import { observeAgentChunks } from './observer.js'
import { finalizeSpawnChildIfDone } from './spawnFinalize.js'
import { streamAgentChunks } from './streamMapper.js'
import { injectCommands } from './autoCompact.js'
import { recordAutoCompactTrigger } from './generations.js'
import { computeContextUsage } from '@/utils/token.js'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import { isAgentAbortError } from '@/core/middleware/errors.js'
import { safeJsonParse } from '@/utils/json.js'
import { randomUUID } from 'crypto'
import { recordTerminationFact } from './executionFacts.js'
import { emitTimelinePatch } from './rootGraphPatch.js'
import { appendChatEvent, claimRequest, completeRequest } from '@/db/delivery.js'
import type { ChatRunResumeRequest } from '@chery/protocol'
import { getExecutionActiveRun } from '@/db/executionGraph.js'
import { transport } from '../websocket/transport.js'
import { addTreePauseTarget, createTreePause, refreshTreeControlStatus } from '@/db/treeControl.js'

// P2-1：runtime 缓存/observer/streamMapper 已按职责拆出。
// runtime API（ensureChat/clearChatRuntime/setRuntime/abortChatRuntime）由 ./runtime.js 直接导出，
// 调用方（handler.ts/runtime set.ts）直接 import runtime.js，不再经 send 转发。

// P4：mimeType → 扩展名映射（与服务端 media/index.ts MIME_KIND 对齐，标 marker 供 enrichMediaInputs 解析）。
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
}

/**
 * P4：将结构化 attachments 转为 [[media:<filename>]] 文本标记，附加到 prompt 末尾。
 * enrichMediaInputs 仍以文本标记为解析入口；前端不再发 marker，服务端补 marker 保持向后兼容。
 * 当 mimeType 不在映射中时使用 .bin（MIME_KIND 已先在 saveMediaAsset 校验）。
 */
export function attachmentsToPromptMarkers(
  attachments: ChatSendRequestData['attachments'],
  basePrompt: string,
): string {
  if (!attachments || attachments.length === 0) return basePrompt
  const markers = attachments
    .map((a) => {
      const ext = MIME_EXT[a.mimeType.toLowerCase()] ?? '.bin'
      return `[[media:${a.assetId}${ext}]]`
    })
    .join('\n')
  return basePrompt ? `${basePrompt}\n${markers}` : markers
}

/**
 * 发送聊天消息（流式）
 * runtime 由 chat.create/runtime.set 设置，send 只携带 chatId + prompt。
 */
export async function* handleChatSend(
  ctx: HandlerContext,
  data: ChatSendRequestData,
): AsyncGenerator<Chunk | Notification, ChatSendResponseData | RpcResponse, unknown> {
  const chatId = data.chatId
  // runId 与启动该运行的 RPC id 同源；脱离 WS 的单元调用使用 UUID 兜底。
  const runId = ctx.requestId ?? randomUUID()

  // 校验 chat 存在
  const chat = getChat(chatId)
  if (!chat) {
    throw new Error('这个会话不见了')
  }

  logger.event('chat.send.start', {
    mode: 'send',
    chatId,
    runtime: getChatSelection(chatId),
    promptLen: data.prompt.length,
    promptPreview: data.prompt.slice(0, 200),
    attachmentCount: data.attachments?.length ?? 0,
  })

  const agent = await ensureChat(chatId)
  const rid = ctx.requestId ?? runId

  // P4：结构化 attachments → [[media:<filename>]] 文本标记追加到 prompt。
  // enrichMediaInputs 仍以文本标记解析；P5 provider 多模态直接读 LLMResponse.attachments 时可省此步。
  const promptWithAttachments = attachmentsToPromptMarkers(data.attachments, data.prompt)

  // 运行中 send：仅入队（迭代触发 send body push userInputs），不绑定连接、不走流。
  // 避免空 generator（isRunning 时 send return 空 gen）立即结束而 finally 误释放当前活跃连接绑定（P0-1）。
  // 新输出跟随当前活跃流发出，客户端无需此流响应。
  if (agent.isRunning()) {
    for await (const _ of agent.run(promptWithAttachments, {
      inputMeta: data.inputMeta,
      inputAlreadyQueued: data.inputAlreadyQueued,
    })) {
      /* 运行中 send 不产出 chunk，迭代仅为触发 send body 入队 */
    }
    logger.event('chat.send.queued', {
      chatId,
      runtime: getChatSelection(chatId),
      promptLen: promptWithAttachments.length,
    })
    return { chatId, runId: getActiveChatRunId(chatId) ?? runId, queued: true }
  }

  // 绑定 chatId 到当前连接，拒绝跨连接并发 send（P0-3）
  try {
    connectionManager.bindChatConnection(chatId, ctx.connectionId)
    logger.event('chat.bind', { chatId, connectionId: ctx.connectionId })
  } catch (e) {
    const msg = (e as Error).message
    logger.event('chat.bind.failed', { chatId, message: msg }, LogLevel.error)
    return createResponse(rid, false, undefined, createError(ErrorCode.CONFLICT, msg))
  }

  activateChatRun(chatId, runId)

  // P5 命令注入 + 自动压缩：send 预检。
  // 1) 扫描 userPrompt 中的 [[command:/<name>]] tokens：skill 类跳过，builtin 类加载对应 .md 正文作为
  //    独立 user message 入队（顺序：extra → 主 prompt，LLM 按 FIFO 消费）。
  // 2) shouldAutoCompact 命中 → 主 prompt 头部注入 [[command:/compact]] token，
  //    compact 正文 unshift 到 extra 顶部（优先级最高）。
  // 3) 流首推 auto_compacted notification（前端 toast）。
  const usageBefore = computeContextUsage(chatId)
  const cmdInjection = injectCommands(chatId, promptWithAttachments)
  if (cmdInjection.triggered) {
    // 自动压缩代际标记（computeGenerations 消费；重启后重算一律 manual，best-effort）
    recordAutoCompactTrigger(chatId)
    logger.event('chat.send.autoCompact', {
      chatId,
      reason: cmdInjection.reason,
      usedBefore: usageBefore.used,
      total: usageBefore.total,
      extraCount: cmdInjection.extraUserMessages.length,
    })
  } else if (cmdInjection.extraUserMessages.length > 0) {
    logger.event('chat.send.commandInjection', {
      chatId,
      extraCount: cmdInjection.extraUserMessages.length,
    })
  }

  // 恢复场景撤回：仅 idle 时触发（运行中 send 只入队，不撤回）。
  // 撤回末尾整个当前周期 AI 响应（assistant think/content/tool + 整个 sense 群），
  // 发 staged.reverse chunk 通知客户端回滚，再 run 用新 prompt 重跑。
  if (!agent.isRunning()) {
    const revokedIds = agent.revokeTrailingCycle()
    if (revokedIds.length > 0) {
      const baseRevision = getTimelineRevision(chatId)
      markMessagesRevoked(chatId, revokedIds)
      emitTimelinePatch(chatId, baseRevision)
      logger.event('chat.send.revoke', { count: revokedIds.length, messageIds: revokedIds })
      yield createChunk(
        'staged',
        rid,
        { type: 'reverse', messageIds: revokedIds },
        { chatId, runId },
      )
    }
  }

  // user message 落库后 observer 回调写入 msgId → Response.data 回前端
  // （前端 sendMessage 即时 push user prompt 到 stream.history 时携带 msgId，下次 reload dedup 用）
  let userMsgId: string | undefined

  try {
    // history 已在 chat.create 时一次性加载到内存。
    // 若当前 chat 正在运行，send 只入队输入；新输出会跟随已有运行流发出。
    // P4：传 promptWithAttachments（含 [[media:]] 标记）供 enrichMediaInputs 解析。
    // P5：injectCommands 改造后的 prompt + extraUserMessages（命令正文）经 AgentSession.send
    //     顺序入队，LLM 看到「先命令正文、再主 prompt」。命令正文不污染 system prompt cache。
    const generator = observeAgentChunks(
      agent.run(cmdInjection.userPrompt, {
        extraUserMessages:
          cmdInjection.extraUserMessages.length > 0 ? cmdInjection.extraUserMessages : undefined,
        inputMeta: {
          ...data.inputMeta,
          ...(cmdInjection.userPrompt !== promptWithAttachments
            ? { persistedContent: promptWithAttachments }
            : {}),
        },
        inputAlreadyQueued: data.inputAlreadyQueued,
      }),
      chatId,
      () => agent.getMessages(),
      (msgId) => {
        userMsgId = msgId
      },
    )

    // autoCompact 命中 → 流首推 auto_compacted notification（前端 toast + context bar 预期下行）。
    // 此 notification 在 streamMapper 任何 chunk 之前发出，前端可靠顺序消费。
    if (cmdInjection.triggered && cmdInjection.reason) {
      yield createNotification(
        'auto_compacted',
        rid,
        {
          reason: cmdInjection.reason,
          usedBefore: usageBefore.used,
          total: usageBefore.total,
        },
        { chatId, runId },
      )
    }

    yield* streamAgentChunks(generator, rid, chatId, runId)
  } catch (err) {
    const error = err as Error
    // 统一暂停语义：abort/park（isAgentAbortError 覆盖 park）静默——暂停控制流，非故障；
    // 其余真实故障记 error 日志，但不再构造 failureResponse（loop 已停，末条保持可恢复态，
    // 前端据 error/done notification 的 canResume 显继续按钮）。final Response 恒 success:true。
    if (isAgentAbortError(error)) {
      logger.event('chat.send.aborted', { reason: 'approval aborted' })
    } else {
      logger.event(
        'chat.send.error',
        { message: error.message, stack: error.stack },
        LogLevel.error,
      )
    }
  } finally {
    releaseChatRun(chatId, runId)
    connectionManager.releaseChatConnection(chatId, ctx.connectionId)
    connectionManager.clearLiveOutput(chatId)
    logger.event('chat.release', { chatId, connectionId: ctx.connectionId })
  }

  // 统一暂停语义：不再构造 failureResponse。AI 报错（retry 耗尽 ErrorChunk）等异常归 paused，
  // streamMapper 已下发 error notification（含 canResume）；final Response 恒 success:true。
  return { chatId, runId, ...(userMsgId ? { userMsgId } : {}) }
}

/**
 * chat.resume — 续接（无 prompt，恢复执行 / 继续 loop）
 * 前置：chat.get 返回 canResume:true（末尾为未完成周期：pending sense 或 done sense 无后续 assistant）。
 * Case1（末尾有 pending sense）→ 置 resumePending 标志，首轮 senseMiddleware skip chat 层，
 *   从历史 pending 重建 SenseTriggerChunk 执行（按监管等级；工具不在 senseTable 写「无此工具」）；
 * Case2（末尾全 done）→ run("") 正常 loop，LLM 基于 done sense 结果回复。
 * 整体同默认 send 流一致，仅首轮跳过 chat。前置：须 chat.create / runtime.set 注入完整 runtime。
 *
 * TODO(统一暂停语义-级联resume)：主 resume 时应级联 resume 所有因级联 abort 而暂停的后代
 *   （用户需求"主启动级联子"）。未实现——低频触发（主 spawn wait=true 后处于等待 idle 无 resume 按钮；
 *   主被 abort 时通常无 wait=true 子在等），且实现需 spawn 状态机加固（区分"暂停的子"vs"等孙的子"，
 *   避免重复 spawn 孙）。当代价路径：①子完成后 role_reply 自动唤主；②用户手动点子 pet 继续（Phase 3 放开 isMaster 守卫）。
 */
export async function* handleChatResume(
  ctx: HandlerContext,
  data: ChatResumeRequestData,
): AsyncGenerator<Chunk | Notification, ChatResumeResponseData | RpcResponse, unknown> {
  const chatId = data.chatId
  const runId = ctx.requestId ?? randomUUID()
  const rid = ctx.requestId ?? runId

  const chat = getChat(chatId)
  if (!chat) {
    throw new Error('这个会话不见了')
  }

  // abandoned 守卫：watchdog wake_on_timeout=true 标记的子为 ghost，用户无法操作。
  // 前端 canResume=false 应已隐藏按钮；此处防御性兜底（前端状态错位时仍拒绝）。
  const isAbandoned = chat.metadata
    ? safeJsonParse<{ abandoned?: boolean }>(chat.metadata, {}).abandoned === true
    : false
  if (isAbandoned) {
    throw new Error('子会话已废弃，无法继续')
  }

  // pending 提问批守卫：提问占位期间禁止 resume，答案必须走 chat.answerQuestionBatch
  // （批完成 → 置 resumePending → 返回 shouldResume，前端批完成后才调 resume）。
  // 防御前端竞态/绕过带着未答问题跑 Case2 死循环；见 docs/interaction.md 工作台树级暂停与续接。
  if (hasPendingQuestionBatches(chatId)) {
    throw new Error('该会话有待回答的问题，请先完成提问')
  }

  logger.event('chat.send.start', { mode: 'resume' })

  const resumeWasPending = chat.metadata
    ? safeJsonParse<{ resumePending?: boolean }>(chat.metadata, {}).resumePending === true
    : false

  const agent = await ensureChat(chatId)

  // 运行中 resume：无意义（无 prompt 入队，活跃流已在跑），直接返回避免重复启动流误释放绑定（P0-1）
  if (agent.isRunning()) {
    return { chatId, runId: getActiveChatRunId(chatId) ?? runId, alreadyRunning: true }
  }

  // 绑定 chatId 到当前连接，拒绝跨连接并发 resume（P0-3）
  try {
    connectionManager.bindChatConnection(chatId, ctx.connectionId)
    logger.event('chat.bind', { chatId, connectionId: ctx.connectionId })
  } catch (e) {
    const msg = (e as Error).message
    logger.event('chat.bind.failed', { chatId, message: msg }, LogLevel.error)
    return createResponse(rid, false, undefined, createError(ErrorCode.CONFLICT, msg))
  }

  activateChatRun(chatId, runId)

  try {
    // 仅消费本次已持久化的待恢复标记；运行期间新到的角色结果会由 wakeParent 再次置 true。
    if (resumeWasPending) updateChatMetadata(chatId, { resumePending: false })
    // resume 内部据末尾状态决定 Case1/Case2（见 builder.resume）
    const generator = observeAgentChunks(agent.resume(), chatId, () => agent.getMessages())
    yield* streamAgentChunks(generator, rid, chatId, runId)
  } catch (err) {
    const error = err as Error
    // 统一暂停语义：abort/park 静默；真实故障记日志，不构造 failureResponse（同 handleChatSend）。
    if (isAgentAbortError(error)) {
      logger.event('chat.send.aborted', { reason: 'approval aborted' })
    } else {
      logger.event(
        'chat.send.error',
        { message: error.message, stack: error.stack },
        LogLevel.error,
      )
    }
  } finally {
    releaseChatRun(chatId, runId)
    connectionManager.releaseChatConnection(chatId, ctx.connectionId)
    connectionManager.clearLiveOutput(chatId)
    logger.event('chat.release', { chatId, connectionId: ctx.connectionId })
  }

  // resumePending 恢复策略：统一暂停语义下无 failureResponse，判据简化为「末条非 assistant」
  // （LLM 空响应 / loop 异常结束 / AI 报错 retry 回滚 → 末条保持 user 或 assistant+senseCalls）。
  // 重连后 rebuildSpawnWaits 据此识别 idle+canResume 主 chat 再次 resume。
  if (resumeWasPending) {
    const msgs = agent.getMessages()
    const lastVisible = [...msgs].reverse().find((m) => !m.revoked)
    const producedAssistant = !!lastVisible && lastVisible.role === 'assistant'
    if (!producedAssistant) {
      updateChatMetadata(chatId, { resumePending: true })
      logger.event('resume.restore-no-assistant', {
        chatId,
        lastRole: lastVisible?.role ?? 'none',
      })
    }
  }

  // 防御性 finalize：子 chat（parent_chat_id 非空）经独立 resume 跑完时兜底标 finished
  // （主路径 wait=true/false 子 loop 结束均经 child_done 设 finished，见 docs/agent-pet.md §5.4；
  //   此处兜底 child_done 未走边界，与 handleChatStartSpawn 对齐，幂等，不唤主）。
  if (chat.parent_chat_id) finalizeSpawnChildIfDone(chatId)

  return { chatId, runId }
}

/** Launch a resume outside the command RPC while preserving normal event routing. */
export async function launchDetachedResume(
  ctx: HandlerContext,
  chatId: string,
  runId: string,
): Promise<void> {
  const generator = handleChatResume({ ...ctx, requestId: runId }, { chatId })
  const route = (item: Chunk | Notification): void => {
    if (item.chatId) {
      item.seq = appendChatEvent(item.chatId, item as unknown as Record<string, unknown>)
    }
    for (const ws of connectionManager.getChatOutputs(chatId)) {
      if (ws.readyState !== ws.OPEN) continue
      for (const routed of connectionManager.prepareSessionEvent(ws, item)) {
        try {
          ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
        } catch (error) {
          logger.event('chat.resumeTree.output_failed', {
            chatId,
            message: (error as Error).message,
          })
        }
      }
    }
  }
  const first = await generator.next()
  if (first.done) {
    const response = first.value as ChatResumeResponseData | RpcResponse
    if ('success' in response && response.success === false) {
      throw new Error(response.error?.message ?? '恢复执行失败')
    }
    return
  }
  route(first.value)
  void (async () => {
    try {
      for await (const item of generator) route(item)
    } catch (error) {
      logger.event('chat.resumeTree.run_failed', {
        chatId,
        message: (error as Error).message,
      })
    }
  })()
}

/** Canonical command-plane resume: durable idempotent ack, output stays on subscriptions. */
export async function handleChatRunResume(
  ctx: HandlerContext,
  data: ChatRunResumeRequest,
): Promise<{ chatId: string; commandId: string; runId: string; status: 'started' | 'already-running' }> {
  const claimed = claimRequest(data.commandId, Method.CHAT_RUN_RESUME, data)
  if (claimed.state === 'completed') {
    return JSON.parse(claimed.responseJson) as {
      chatId: string
      commandId: string
      runId: string
      status: 'started' | 'already-running'
    }
  }
  if (claimed.state === 'active') throw new Error('该继续命令正在处理')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')

  if (!getChat(data.chatId)) throw new Error('这个会话不见了')
  const activeRunId = getActiveChatRunId(data.chatId)
  const runId = activeRunId ?? randomUUID()
  const response = {
    chatId: data.chatId,
    commandId: data.commandId,
    runId,
    status: activeRunId ? ('already-running' as const) : ('started' as const),
  }
  if (!activeRunId) await launchDetachedResume(ctx, data.chatId, runId)
  completeRequest(data.commandId, response)
  return response
}

/**
 * 审批 Sense
 */
export async function handleSenseApproval(
  _ctx: HandlerContext,
  data: SenseApprovalRequestData,
): Promise<SenseApprovalResponseData> {
  // 转调 ApprovalManager.confirm → core approvalRegistry.resolve（P1-11 解耦后）
  // 旧气泡直连入口只处理当前进程仍存活的 approval；全局待办入口可跨断线/重启
  // 恢复同一个稳定 approvalId 后再提交决定。
  const ok = approvalManager.confirm(data.approvalId, data.action, data.reason)
  if (!ok) {
    throw new Error('审批已失效（可能因连接中断或超时被清除），请重新触发该工具的审批')
  }
  logger.event('sense.approval', {
    approvalId: data.approvalId,
    action: data.action,
    reason: data.reason,
  })

  return {
    approvalId: data.approvalId,
    action: data.action,
  }
}

/** 旧版单题接口：仅兼容单题批次；多题必须使用原子 batchAnswer。 */
export async function handleSenseQuestionAnswer(
  _ctx: HandlerContext,
  data: SenseQuestionAnswerRequestData,
): Promise<SenseQuestionAnswerResponseData> {
  const cancelled = data.cancelled === true
  const pending = findPendingQuestionBatchByQuestionId(data.questionId)
  logger.event('sense.question.answer', {
    questionId: data.questionId,
    chatId: pending?.chatId,
    selectedLabels: data.selectedLabels,
    hasFreeText: data.freeText !== undefined,
    cancelled,
    legacy: true,
  })
  if (!pending) {
    logger.event('sense.question.answer.unknown', { questionId: data.questionId })
    return { questionId: data.questionId, cancelled }
  }
  if (pending.pendingCount !== 1) {
    throw new Error(
      `Question "${data.questionId}" belongs to a multi-question batch; use sense.question.batchAnswer`,
    )
  }
  await resolveQuestionBatch(pending.chatId, pending.batchId, [
    {
      questionId: data.questionId,
      selectedLabels: data.selectedLabels,
      ...(data.optionNotes ? { optionNotes: data.optionNotes } : {}),
      ...(data.freeText !== undefined ? { freeText: data.freeText } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    },
  ])

  return { questionId: data.questionId, cancelled }
}

/** 原子回答整批 ask_user_question；成功响应由调用方负责启动 chat.resume。 */
export async function handleSenseQuestionBatchAnswer(
  _ctx: HandlerContext,
  data: SenseQuestionBatchAnswerRequestData,
): Promise<SenseQuestionBatchAnswerResponseData> {
  logger.event('sense.question.batchAnswer', {
    chatId: data.chatId,
    batchId: data.batchId,
    questionCount: data.answers.length,
    cancelledCount: data.answers.filter((answer) => answer.cancelled === true).length,
  })
  const completed = await resolveQuestionBatch(data.chatId, data.batchId, data.answers)
  return {
    chatId: data.chatId,
    batchId: data.batchId,
    completed: true,
    shouldResume: !completed.alreadyCompleted,
  }
}

/**
 * 中止 chat（切换 chat：清内存 + 退出挂起 generator，不动 DB）。
 * 先 abortChatRuntime（compose.abort .throw 注入错误到挂起的 await → senseMiddleware catch →
 * throw 传播退出整个链，不继续 next），再 clearChatRuntime 释放该 chat 的 Middleware/messages 内存。
 * 顺序关键：clearChatRuntime 删 Map，须先取 builder 引用调 abort；throw 异步传播期间实例仍存活
 * （generator 链持有），不依赖 Map。相关数据已落 DB，此处不做任何保存；
 * pending sense content 保持 NULL，下次 chat.get canResume=true 重新审核。
 */
/**
 * reject 该 chat 的挂起审批（若存在）：approvalManager.abort → rejectApproval(AgentAbortError)，
 * 使 senseMiddleware 的 `await Promise.all(approvals)` 抛错退出 generator。
 * 单独的 compose.abort()→gen.throw 注入到「await 外部 pending promise」挂起点在此 yield* 链不可靠，
 * 故 abort-during-approval 必须走 promise reject 路径（与 park/用户超时一致）。
 * 审批归属是 chat 域事实，不能依赖 WebSocket/disconnectGrace 的 request 跟踪：
 * chat.input.submit 在 RPC ACK 后脱钩运行，此时传输层跟踪已经结束。
 */
export function abortPendingApprovals(chatId: string): void {
  approvalManager.abortForChat(chatId)
}

export async function handleChatAbort(
  ctx: HandlerContext,
  data: ChatAbortRequestData,
): Promise<ChatAbortResponseData | RpcResponse> {
  let activeRunId = getActiveChatRunId(data.chatId)
  if (
    activeRunId &&
    ['paused', 'completed', 'failed'].includes(
      getExecutionActiveRun(data.chatId, activeRunId)?.status ?? 'running',
    )
  ) {
    activeRunId = undefined
  }
  if (data.runId && activeRunId && data.runId !== activeRunId) {
    return createResponse(
      ctx.requestId ?? '',
      false,
      undefined,
      createError(ErrorCode.CONFLICT, '操作的目标已改变'),
    )
  }
  if (data.commandId) {
    const claimed = claimRequest(data.commandId, Method.CHAT_ABORT, data)
    if (claimed.state === 'completed') {
      return JSON.parse(claimed.responseJson) as ChatAbortResponseData
    }
    if (claimed.state === 'active') throw new Error('该暂停命令正在处理中')
    if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')
  }

  const treePauseId =
    data.commandId && getRootChatId(data.chatId) === data.chatId ? data.commandId : undefined
  if (treePauseId) createTreePause(treePauseId, data.chatId)

  // 统一暂停语义：主 abort 时递归暂停所有后代（主停→子停→孙停）。
  // 主可能 idle（spawn wait=true 等子回复，无 activeRunId）但后代在跑——仍需级联停后代。
  const descendants = collectDescendantsChatIds(data.chatId)
  const results: ChildControlTargetResult[] = []
  for (const childId of [...descendants].reverse()) {
    clearWaitedChildrenByParent(childId)
    let childRunId = getActiveChatRunId(childId)
    if (
      childRunId &&
      ['paused', 'completed', 'failed'].includes(
        getExecutionActiveRun(childId, childRunId)?.status ?? 'running',
      )
    ) {
      childRunId = undefined
    }
    if (childRunId) {
      const baseRevision = getTimelineRevision(childId)
      recordTerminationFact({
        chatId: childId,
        runId: childRunId,
        actor: 'user',
        code: 'user_abort',
        ...(treePauseId ? { controlOperationId: treePauseId } : {}),
      })
      if (treePauseId) addTreePauseTarget(treePauseId, childId, childRunId)
      emitTimelinePatch(childId, baseRevision)
      // 先 reject 挂起审批（可靠中断 approval.wait），再 gen.throw（中断流式 yield 挂起）。
      abortPendingApprovals(childId)
      abortChatRuntime(childId)
      results.push({
        chatId: childId,
        previousState: 'running',
        state: 'paused',
        outcome: 'stopped',
        runId: childRunId,
      })
    } else {
      results.push({
        chatId: childId,
        previousState: 'paused',
        state: 'paused',
        outcome: 'unchanged',
      })
    }
    // 强制解绑连接（不校验 owner）：跨连接重连后旧 owner 须无条件清除避免 busy 死锁（P0-2）
    connectionManager.forceReleaseChatConnection(childId)
    clearChatRuntime(childId)
  }

  // 主 chat 自身
  if (activeRunId) {
    const baseRevision = getTimelineRevision(data.chatId)
    recordTerminationFact({
      chatId: data.chatId,
      runId: activeRunId,
      actor: 'user',
      code: 'user_abort',
      ...(treePauseId ? { controlOperationId: treePauseId } : {}),
    })
    if (treePauseId) addTreePauseTarget(treePauseId, data.chatId, activeRunId)
    emitTimelinePatch(data.chatId, baseRevision)
    abortPendingApprovals(data.chatId)
    abortChatRuntime(data.chatId)
    results.push({
      chatId: data.chatId,
      previousState: 'running',
      state: 'paused',
      outcome: 'stopped',
      runId: activeRunId,
    })
  } else {
    results.push({
      chatId: data.chatId,
      previousState: 'paused',
      state: 'paused',
      outcome: 'unchanged',
    })
  }
  // 清主→子唤醒链，防子完成反唤醒已停的主
  clearWaitedChildrenByParent(data.chatId)
  connectionManager.forceReleaseChatConnection(data.chatId)
  clearChatRuntime(data.chatId)

  logger.event('chat.abort', {
    chatId: data.chatId,
    runId: activeRunId,
    cascaded: descendants.length,
  })
  const response: ChatAbortResponseData = {
    chatId: data.chatId,
    ...(treePauseId ? { pauseId: treePauseId, status: refreshTreeControlStatus(treePauseId) } : {}),
    ...(activeRunId ? { runId: activeRunId } : {}),
    aborted: !!activeRunId,
    cascaded: descendants.length,
    results,
  }
  if (treePauseId) {
    const controlBaseRevision = getTimelineRevision(data.chatId)
    bumpTimelineRevision(data.chatId)
    emitTimelinePatch(data.chatId, controlBaseRevision)
  }
  if (data.commandId) completeRequest(data.commandId, response)
  return response
}

/**
 * 注册 Chat handlers
 */
export function registerChatHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.CHAT_RUN_RESUME, handleChatRunResume)
  router.register(Method.CHAT_ABORT, handleChatAbort)
}
