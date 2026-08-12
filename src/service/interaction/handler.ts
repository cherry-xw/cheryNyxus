import { randomUUID } from 'crypto'
import type { RpcRouter } from '../message/router.js'
import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type InteractionApprovalDecideRequestData,
  type InteractionApprovalDecideResponseData,
  type InteractionListRequestData,
  type InteractionListResponseData,
  type InteractionQuestionAnswerRequestData,
  type InteractionQuestionAnswerResponseData,
} from '../message/types.js'
import {
  claimInteraction,
  getInteraction,
  listInteractions,
  reconcileInteractionInbox,
  transitionInteraction,
  type InteractionRecord,
} from '@/db/interaction.js'
import { abandonRequest, claimRequest, completeRequest } from '@/db/delivery.js'
import { approvalManager } from '../approval/manager.js'
import { launchDetachedResume } from '../chat/send.js'
import { resolveQuestionBatch } from '../chat/wake.js'
import { broadcastInteractionChanged } from './events.js'

function assertRevision(record: InteractionRecord, expectedRevision: number): void {
  if (record.revision !== expectedRevision) {
    throw new Error('待处理交互已发生变化，请刷新后重试')
  }
}

async function waitForApproval(interactionId: string, timeoutMs = 8000): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (approvalManager.has(interactionId)) return true
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return false
}

async function handleList(
  _ctx: HandlerContext,
  data: InteractionListRequestData,
): Promise<InteractionListResponseData> {
  reconcileInteractionInbox()
  return { interactions: listInteractions(data) }
}

async function handleApprovalDecide(
  ctx: HandlerContext,
  data: InteractionApprovalDecideRequestData,
): Promise<InteractionApprovalDecideResponseData> {
  const command = claimRequest(data.commandId, Method.INTERACTION_APPROVAL_DECIDE, data)
  if (command.state === 'completed') return JSON.parse(command.responseJson) as InteractionApprovalDecideResponseData
  if (command.state === 'mismatch') throw new Error('commandId 已用于另一条命令')
  if (command.state === 'active') throw new Error('该操作正在处理中')
  try {
    let record = getInteraction(data.interactionId)
    if (!record || record.kind !== 'approval') throw new Error('审批待办不存在')
    assertRevision(record, data.expectedRevision)
    if (record.deadlineAt !== undefined && record.deadlineAt <= Date.now()) {
      const expired = transitionInteraction(record.interactionId, ['pending', 'blocked'], 'expired', {
        action: 'reject',
        reason: '审批超时，工具未执行',
      })
      broadcastInteractionChanged(expired)
      // Rebuild the suspended core promise so ApprovalManager.register can replay
      // the already-durable rejection and let the Agent continue.
      await launchDetachedResume(ctx, record.chatId, randomUUID()).catch(() => undefined)
      const response = { interaction: expired ?? getInteraction(record.interactionId)! }
      completeRequest(data.commandId, response)
      return response
    }
    if (!['pending', 'blocked'].includes(record.status)) throw new Error('审批已经处理')
    record = claimInteraction(record.interactionId, data.expectedRevision)
    if (!record) throw new Error('待处理交互已发生变化，请刷新后重试')
    broadcastInteractionChanged(record)

    if (!approvalManager.has(record.interactionId)) {
      await launchDetachedResume(ctx, record.chatId, randomUUID())
      if (!(await waitForApproval(record.interactionId))) {
        record = transitionInteraction(record.interactionId, ['resolving'], 'blocked', {
          reason: '无法恢复原工具审批，请检查当前角色与工具配置',
        }) ?? record
        broadcastInteractionChanged(record)
        const response = { interaction: record }
        completeRequest(data.commandId, response)
        return response
      }
    }
    const ok = approvalManager.confirm(record.interactionId, data.action, data.reason)
    if (!ok) throw new Error('审批恢复期间状态发生变化，请重试')
    const response = { interaction: getInteraction(record.interactionId)! }
    broadcastInteractionChanged(response.interaction)
    completeRequest(data.commandId, response)
    return response
  } catch (cause) {
    const current = getInteraction(data.interactionId)
    if (current?.status === 'resolving') {
      broadcastInteractionChanged(transitionInteraction(data.interactionId, ['resolving'], 'blocked', {
        reason: cause instanceof Error ? cause.message : '审批恢复失败',
      }))
    }
    abandonRequest(data.commandId)
    throw cause
  }
}

async function handleQuestionAnswer(
  ctx: HandlerContext,
  data: InteractionQuestionAnswerRequestData,
): Promise<InteractionQuestionAnswerResponseData> {
  const command = claimRequest(data.commandId, Method.INTERACTION_QUESTION_ANSWER, data)
  if (command.state === 'completed') return JSON.parse(command.responseJson) as InteractionQuestionAnswerResponseData
  if (command.state === 'mismatch') throw new Error('commandId 已用于另一条命令')
  if (command.state === 'active') throw new Error('该操作正在处理中')
  try {
    let record = getInteraction(data.interactionId)
    if (!record || record.kind !== 'question_batch') throw new Error('问题待办不存在')
    assertRevision(record, data.expectedRevision)
    if (record.status !== 'pending') throw new Error('问题已经处理')
    record = claimInteraction(record.interactionId, data.expectedRevision)
    if (!record) throw new Error('待处理交互已发生变化，请刷新后重试')
    broadcastInteractionChanged(record)
    await resolveQuestionBatch(record.chatId, record.interactionId, data.answers)
    // The durable answer is already committed. Replaying resume is safe and also
    // closes the crash window between the answer transaction and Agent startup.
    await launchDetachedResume(ctx, record.chatId, randomUUID()).catch(() => undefined)
    const response = { interaction: getInteraction(record.interactionId)! }
    broadcastInteractionChanged(response.interaction)
    completeRequest(data.commandId, response)
    return response
  } catch (cause) {
    const current = getInteraction(data.interactionId)
    if (current?.status === 'resolving') {
      broadcastInteractionChanged(transitionInteraction(data.interactionId, ['resolving'], 'pending'))
    }
    abandonRequest(data.commandId)
    throw cause
  }
}

export function registerInteractionHandlers(router: RpcRouter): void {
  router.register(Method.INTERACTION_LIST, handleList)
  router.register(Method.INTERACTION_APPROVAL_DECIDE, handleApprovalDecide)
  router.register(Method.INTERACTION_QUESTION_ANSWER, handleQuestionAnswer)
}
