import { randomUUID } from 'crypto'
import type { HandlerContext } from '../message/router.js'
import {
  createNotification,
  Method,
  type Chunk,
  type Notification,
  type ChatInputSubmitRequestData,
  type ChatInputSubmitResponseData,
  type ChatInputWithdrawRequestData,
  type ChatInputWithdrawResponseData,
  type ChatSendToChildRequestData,
  type ChatSendToChildResponseData,
  type ChatStopChildRequestData,
  type ChatStopChildResponseData,
} from '../message/types.js'
import { InternalCommand } from '../message/internalCommand.js'
import { getRootChatId, getTimelineRevision, updateChatMetadata } from '@/db/chat.js'
import { addPendingInput, findPendingInput, cancelQueuedPendingInput } from '@/db/pendingInput.js'
import {
  abandonRequest,
  appendChatEvent,
  claimRequest,
  completeRequest,
  prepareChatEventForDelivery,
} from '@/db/delivery.js'
import { markActiveTreeTargetDelegated } from '@/db/treeControl.js'
import { UserInputQueueFullError } from '@/core/middleware/messageJournal.js'
import { assertRestartAdmission } from '@/service/restartCoordinator.js'
import { logger } from '@/utils/logger/index.js'
import { connectionManager } from '../websocket/connection.js'
import { deliverToSockets } from '../websocket/deliver.js'
import { assertChatExists } from './guards.js'
import { ensureChat } from './runtime.js'
import { getActiveChatRunId, getPendingChatInputs, removeQueuedChatInput } from './runtimeCache.js'
import { handleChatSend, attachmentsToPromptMarkers } from './send.js'
import { recordWorkflowStep, finishActiveWorkflowSteps } from './workflowStepWriter.js'
import { buildTreeInterruptionNotice } from './treeInterruption.js'
import {
  assertRootControlsChild,
  childAgentControlState,
  childDispatchOutcome,
} from './childControl.js'
import { recordDispatchFact } from './executionFacts.js'
import { emitTimelinePatch } from './rootGraphPatch.js'
/**
 * Command-plane input submission. The command is acknowledged immediately;
 * execution is detached from the RPC response and uses the same live output
 * routing as chat.send. IDs are allocated before enqueue so consumed user
 * messages retain the optimistic message identity.
 */
export async function handleChatInputSubmit(
  ctx: HandlerContext,
  data: ChatInputSubmitRequestData,
): Promise<ChatInputSubmitResponseData> {
  if (!data.content.trim()) throw new Error('输入内容不能为空')
  const claimed = claimRequest(data.commandId, Method.CHAT_INPUT_SUBMIT, data)
  if (claimed.state === 'completed') {
    return JSON.parse(claimed.responseJson) as ChatInputSubmitResponseData
  }
  if (claimed.state === 'active') throw new Error('该输入命令正在处理中')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')

  try {
    assertRestartAdmission()
    const chat = assertChatExists(data.chatId)
    if (chat.parent_chat_id && data.controlRootChatId !== getRootChatId(data.chatId)) {
      throw new Error('用户输入只能提交到主 Agent')
    }
    const agent = await ensureChat(data.chatId)
    assertRestartAdmission()
    const running = agent.isRunning()
    const pending = getPendingChatInputs(data.chatId)
    if (pending.length >= 16) throw new UserInputQueueFullError()

    const inputId = randomUUID()
    const messageId = data.messageId
    const runId = getActiveChatRunId(data.chatId) ?? ctx.requestId ?? randomUUID()
    const acceptedAt = Date.now()
    updateChatMetadata(data.chatId, { lastUserActivityAt: acceptedAt })
    // The active input has already left builder.pending when a later command
    // arrives, but it remains sequence 1 in the current run.
    const queueSequence = pending.length + (running ? 2 : 1)
    const prompt = attachmentsToPromptMarkers(data.attachments, data.content)
    const entry = agent.enqueueInput(prompt, {
      inputId,
      messageId,
      clientMessageId: data.clientMessageId,
      commandId: data.commandId,
    })
    if (!entry) throw new Error('输入内容不能为空')

    // A new root instruction resumes only the root. Interrupted children remain
    // paused and are exposed to the main Agent as one durable, auditable notice.
    if (!running && !chat.parent_chat_id) {
      const notice = buildTreeInterruptionNotice(data.chatId, data.commandId)
      if (notice) {
        agent.enqueueInput(notice.content, {
          messageId: notice.messageId,
          role: 'role',
          linkRelation: 'system',
        })
      }
      markActiveTreeTargetDelegated(data.chatId, data.chatId)
    }

    addPendingInput({
      inputId,
      chatId: data.chatId,
      messageId,
      clientMessageId: data.clientMessageId,
      commandId: data.commandId,
      content: prompt,
      queueSequence,
      state: running ? 'queued' : 'started',
      acceptedAt,
    })
    const inputAnchor = { kind: 'message' as const, id: messageId, chatId: data.chatId }
    const submissionOccurrenceId = recordWorkflowStep(data.chatId, {
      kind: 'submission',
      key: inputId,
      scope: 'chat',
      runId,
      status: 'succeeded',
      reason: 'accepted',
      eventKey: 'accepted',
      anchor: inputAnchor,
      at: acceptedAt,
    })
    recordWorkflowStep(data.chatId, {
      kind: 'queue',
      causeOccurrenceId: submissionOccurrenceId,
      key: inputId,
      scope: 'chat',
      runId,
      status: running ? 'waiting' : 'running',
      ...(running ? { waitReason: 'queue' as const, reason: 'queued' as const } : {}),
      eventKey: running ? 'queued' : 'started',
      anchor: inputAnchor,
      at: acceptedAt,
    })

    const response: ChatInputSubmitResponseData = {
      chatId: data.chatId,
      inputId,
      clientMessageId: data.clientMessageId,
      messageId,
      runId,
      state: running ? 'queued' : 'started',
      queueSequence,
      acceptedAt,
    }
    completeRequest(data.commandId, response)

    // Session-plane lifecycle event: consumers can render the optimistic input
    // without coupling it to the command RPC's requestId.
    const inputUpdated = createNotification(
      'input.updated',
      undefined,
      {
        inputId,
        clientMessageId: data.clientMessageId,
        messageId,
        content: data.content,
        state: response.state,
        queueSequence,
        acceptedAt,
      },
      { chatId: data.chatId, runId },
    )
    inputUpdated.seq = appendChatEvent(
      data.chatId,
      inputUpdated as unknown as Record<string, unknown>,
    )
    deliverToSockets(
      connectionManager.getChatOutputs(data.chatId),
      inputUpdated,
      'chat.input.submit.ack_output_failed',
    )

    // Start the normal stream out-of-band. Existing chat.send remains unchanged;
    // this path only feeds the pre-enqueued, ID-bearing input into that runner.
    void (async () => {
      try {
        const generator = handleChatSend(
          { ...ctx, requestId: runId },
          {
            chatId: data.chatId,
            prompt,
            inputAlreadyQueued: true,
            inputMeta: {
              inputId,
              messageId,
              clientMessageId: data.clientMessageId,
              commandId: data.commandId,
            },
          },
          true,
        )
        for await (const item of generator) {
          const event = item as Chunk | Notification
          if (event.chatId) {
            prepareChatEventForDelivery(event.chatId, event as unknown as Record<string, unknown>)
          }
          deliverToSockets(
            connectionManager.getChatOutputs(data.chatId),
            event,
            'chat.input.submit.output_failed',
          )
        }
      } catch (err) {
        logger.event('chat.input.submit.run_failed', {
          chatId: data.chatId,
          message: (err as Error).message,
        })
      }
    })()

    return response
  } catch (cause) {
    // Queue/full/runtime validation failures happen after the journal claim.
    // Release that claim so a user retry with the same idempotency key can be
    // evaluated again instead of being permanently reported as active.
    abandonRequest(data.commandId)
    throw cause
  }
}

/**
 * V2 command-plane input withdrawal. Only queued (running, not-yet-adopted) inputs
 * can be withdrawn (user-confirmed scope). The memory queue entry and durable
 * pending_inputs row transition to cancelled, the workflow queue step is terminalized,
 * and an input.updated {state:'cancelled'} notification removes the optimistic row
 * from session consumers.
 */
export async function handleChatInputWithdraw(
  _ctx: HandlerContext,
  data: ChatInputWithdrawRequestData,
): Promise<ChatInputWithdrawResponseData> {
  const claimed = claimRequest(data.commandId, Method.CHAT_INPUT_WITHDRAW, data)
  if (claimed.state === 'completed') {
    return JSON.parse(claimed.responseJson) as ChatInputWithdrawResponseData
  }
  if (claimed.state === 'active') throw new Error('该撤回命令正在处理中')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')

  try {
    assertRestartAdmission()
    assertChatExists(data.chatId)
    const pending = findPendingInput(data.chatId, {
      inputId: data.inputId,
      clientMessageId: data.clientMessageId,
    })
    if (!pending) throw new Error('排队消息不存在或已撤回')
    const clientMessageId = pending.client_message_id ?? data.clientMessageId ?? ''
    // 幂等：已取消直接返回原结果
    if (pending.state === 'cancelled') {
      const response: ChatInputWithdrawResponseData = {
        chatId: data.chatId,
        inputId: pending.input_id,
        clientMessageId,
        messageId: pending.message_id,
        state: 'cancelled',
        withdrawnAt: pending.consumed_at ?? Date.now(),
      }
      completeRequest(data.commandId, response)
      return response
    }
    // 仅 queued 可撤回；started/consumed 拒绝（started 为正在响应的首条指令）
    if (pending.state !== 'queued') {
      throw new Error(`该消息处于 ${pending.state} 状态，无法撤回`)
    }
    // 内存队列：有 runtime 且输入已不在队列 → 已 drain 进当前轮次（已采用），拒绝。
    const outcome = removeQueuedChatInput(data.chatId, {
      inputId: pending.input_id,
      clientMessageId: pending.client_message_id ?? undefined,
    })
    if (outcome === 'already-adopted') {
      throw new Error('该消息已进入模型请求，无法撤回')
    }
    if (!cancelQueuedPendingInput(data.chatId, pending.input_id)) {
      throw new Error('排队消息不存在或已撤回')
    }
    // 终态化 workflow queue 步骤（撤回即排队结束）
    finishActiveWorkflowSteps(data.chatId, {
      kind: 'queue',
      anchor: { kind: 'message', id: pending.message_id },
      status: 'cancelled',
      reason: 'user',
      eventKey: 'cancelled',
    })
    const withdrawnAt = Date.now()
    // 会话平面通知：前端收到 state:'cancelled' 即按 inputId 移除排队消息
    const inputUpdated = createNotification(
      'input.updated',
      undefined,
      {
        inputId: pending.input_id,
        clientMessageId: pending.client_message_id ?? data.clientMessageId,
        messageId: pending.message_id,
        state: 'cancelled',
        reason: 'withdrawn',
      },
      { chatId: data.chatId },
    )
    inputUpdated.seq = appendChatEvent(
      data.chatId,
      inputUpdated as unknown as Record<string, unknown>,
    )
    deliverToSockets(
      connectionManager.getChatOutputs(data.chatId),
      inputUpdated,
      'chat.input.withdraw.output_failed',
    )

    const response: ChatInputWithdrawResponseData = {
      chatId: data.chatId,
      inputId: pending.input_id,
      clientMessageId,
      messageId: pending.message_id,
      state: 'cancelled',
      withdrawnAt,
    }
    completeRequest(data.commandId, response)
    return response
  } catch (cause) {
    abandonRequest(data.commandId)
    throw cause
  }
}

/** Main-agent-only dispatch path used by the send_to_child sense. */
export async function dispatchToChild(
  data: ChatSendToChildRequestData,
): Promise<ChatSendToChildResponseData> {
  if (!data.content.trim()) throw new Error('派发内容不能为空')
  assertRootControlsChild(data.rootChatId, data.childChatId)
  const previousState = childAgentControlState(data.childChatId)
  const dispatchOutcome = childDispatchOutcome(previousState)
  if (dispatchOutcome === 'rejected') {
    return {
      rootChatId: data.rootChatId,
      commandId: data.commandId,
      result: {
        chatId: data.childChatId,
        previousState,
        state: previousState,
        outcome: 'rejected',
        detail: '目标子 Agent 已进入只读终态',
      },
    }
  }

  const claimed = claimRequest(data.commandId, InternalCommand.CHAT_SEND_TO_CHILD, data)
  if (claimed.state === 'completed') {
    return JSON.parse(claimed.responseJson) as ChatSendToChildResponseData
  }
  if (claimed.state === 'active') throw new Error('该派发命令正在处理中')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')

  const parentWs = connectionManager.findWsByChatId(data.rootChatId)
  const parentConnection = parentWs ? connectionManager.get(parentWs) : undefined
  if (!parentConnection) throw new Error('主 Agent 当前没有可用的实时连接')
  const accepted = await handleChatInputSubmit(
    {
      requestId: `dispatch-${data.commandId}`,
      connectionId: parentConnection.id,
      log: logger,
    },
    {
      chatId: data.childChatId,
      commandId: `${data.commandId}:input`,
      clientMessageId: `dispatch:${data.commandId}`,
      messageId: randomUUID(),
      content: data.content,
      controlRootChatId: data.rootChatId,
    },
  )
  markActiveTreeTargetDelegated(data.rootChatId, data.childChatId)
  const dispatchBaseRevision = getTimelineRevision(data.rootChatId)
  recordDispatchFact({
    rootChatId: data.rootChatId,
    parentChatId: data.rootChatId,
    targetChatId: data.childChatId,
    commandId: data.commandId,
    targetNodeId: accepted.messageId,
    content: data.content,
    actor: { kind: 'agent', chatId: data.rootChatId },
    target: { kind: 'agent', chatId: data.childChatId },
    createdAt: accepted.acceptedAt,
  })
  emitTimelinePatch(data.rootChatId, dispatchBaseRevision)
  const response: ChatSendToChildResponseData = {
    rootChatId: data.rootChatId,
    commandId: data.commandId,
    result: {
      chatId: data.childChatId,
      previousState,
      state: 'running',
      outcome: dispatchOutcome,
      runId: accepted.runId,
      messageId: accepted.messageId,
    },
  }
  completeRequest(data.commandId, response)
  return response
}

/** Websocket callers cannot impersonate the main Agent's internal control tools. */
export async function handleChatStopChild(
  _ctx: HandlerContext,
  _data: ChatStopChildRequestData,
): Promise<ChatStopChildResponseData> {
  throw new Error('stop_child 只能由主 Agent 调用')
}
