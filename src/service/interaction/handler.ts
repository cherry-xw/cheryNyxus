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
  transitionInteraction,
  type InteractionRecord,
} from '@/db/interaction.js'
import { abandonRequest, claimRequest, completeRequest } from '@/db/delivery.js'
import { approvalManager } from '../approval/manager.js'
import { launchDetachedResume } from '../chat/send.js'
import { resolveQuestionBatch } from '../chat/wake.js'
import { broadcastInteractionChanged } from './events.js'
import { truncateByBytes, utf8ByteLength } from '@/utils/boundedContent.js'
import { ErrorCode, type InteractionData } from '../message/types.js'

/** D13：抛显式携带 ErrorCode 的错误（router toRpcError 按码透传；message 保持中文用户面，F11）。 */
function throwError(code: string, message: string): never {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  throw err
}

function assertRevision(record: InteractionRecord, expectedRevision: number): void {
  if (record.revision !== expectedRevision) {
    throwError(ErrorCode.INTERACTION_STALE, '待处理交互已发生变化，请刷新后重试')
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

/**
 * approval payload 的 arguments 字段级截断预算（T4-D3：保留键名与短字段全文，
 * 仅超长单字段截断；write_file 类 {path 短, content 长} 决策结构保持完整）。
 * docs/mcu-lite-api.md §3.7-2 / §3.5 R7。
 */
const PAYLOAD_FIELD_BUDGET_BYTES = 2048

/** lite（P0，R7）：对 approval payload 的超长字符串字段做字节截断，返回截断引用。 */
function boundApprovalPayload(
  payload: Record<string, unknown>,
): {
  payload: Record<string, unknown>
  truncations: Array<{ field: string; contentLength: number; contentHash: string }>
} {
  const truncations: Array<{ field: string; contentLength: number; contentHash: string }> = []
  const bounded: Record<string, unknown> = { ...payload }
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== 'string') continue
    const bytes = utf8ByteLength(value)
    if (bytes <= PAYLOAD_FIELD_BUDGET_BYTES) continue
    const cut = truncateByBytes(value, PAYLOAD_FIELD_BUDGET_BYTES)
    bounded[key] = cut.text
    truncations.push({ field: key, contentLength: bytes, contentHash: cut.contentHash })
  }
  return { payload: bounded, truncations }
}

async function handleList(
  _ctx: HandlerContext,
  data: InteractionListRequestData,
): Promise<InteractionListResponseData> {
  const records = listInteractions(data)
  // lite 分页（R8）：maxItems+1 探测；超限截断并置 hasMore（无 OFFSET 游标，客户端重拉全量窗口）。
  const hasMore = data.maxItems !== undefined && records.length > data.maxItems
  const window = hasMore ? records.slice(0, data.maxItems) : records
  const allTruncations: Array<{
    interactionId: string
    field: string
    contentLength: number
    contentHash: string
  }> = []
  const interactions = window.map((record) => {
    const item = record as unknown as InteractionData
    if (record.kind !== 'approval') return item
    const { payload, truncations } = boundApprovalPayload(record.payload)
    for (const t of truncations) {
      allTruncations.push({ interactionId: record.interactionId, ...t })
    }
    return { ...item, payload }
  })
  return {
    interactions,
    // lite（P0，B-3）：设备无 NTP 时校准本地钟（mcu-lite-api.md §3.5/§3.9）
    serverNow: Date.now(),
    ...(hasMore ? { hasMore: true } : {}),
    ...(allTruncations.length > 0 ? { truncations: allTruncations } : {}),
  }
}

async function handleApprovalDecide(
  ctx: HandlerContext,
  data: InteractionApprovalDecideRequestData,
): Promise<InteractionApprovalDecideResponseData> {
  const command = claimRequest(data.commandId, Method.INTERACTION_APPROVAL_DECIDE, data)
  if (command.state === 'completed')
    return JSON.parse(command.responseJson) as InteractionApprovalDecideResponseData
  if (command.state === 'mismatch')
    throwError(ErrorCode.COMMAND_CONFLICT, 'commandId 已用于另一条命令')
  if (command.state === 'active') throwError(ErrorCode.COMMAND_CONFLICT, '该操作正在处理中')
  try {
    let record = getInteraction(data.interactionId)
    if (!record || record.kind !== 'approval') throw new Error('审批待办不存在')
    assertRevision(record, data.expectedRevision)
    if (record.deadlineAt !== undefined && record.deadlineAt <= Date.now()) {
      const expired = transitionInteraction(
        record.interactionId,
        ['pending', 'blocked'],
        'expired',
        {
          action: 'reject',
          reason: '审批超时，工具未执行',
        },
      )
      broadcastInteractionChanged(expired)
      // Rebuild the suspended core promise so ApprovalManager.register can replay
      // the already-durable rejection and let the Agent continue.
      await launchDetachedResume(ctx, record.chatId, randomUUID()).catch(() => undefined)
      const response = { interaction: expired ?? getInteraction(record.interactionId)! }
      completeRequest(data.commandId, response)
      return response
    }
    if (!['pending', 'blocked'].includes(record.status))
      throwError(ErrorCode.INTERACTION_ALREADY_RESOLVED, '审批已经处理')
    record = claimInteraction(record.interactionId, data.expectedRevision)
    if (!record) throwError(ErrorCode.INTERACTION_STALE, '待处理交互已发生变化，请刷新后重试')
    broadcastInteractionChanged(record)

    if (!approvalManager.has(record.interactionId)) {
      await launchDetachedResume(ctx, record.chatId, randomUUID())
      if (!(await waitForApproval(record.interactionId))) {
        record =
          transitionInteraction(record.interactionId, ['resolving'], 'blocked', {
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
      broadcastInteractionChanged(
        transitionInteraction(data.interactionId, ['resolving'], 'blocked', {
          reason: cause instanceof Error ? cause.message : '审批恢复失败',
        }),
      )
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
  if (command.state === 'completed')
    return JSON.parse(command.responseJson) as InteractionQuestionAnswerResponseData
  if (command.state === 'mismatch')
    throwError(ErrorCode.COMMAND_CONFLICT, 'commandId 已用于另一条命令')
  if (command.state === 'active') throwError(ErrorCode.COMMAND_CONFLICT, '该操作正在处理中')
  try {
    let record = getInteraction(data.interactionId)
    if (!record || record.kind !== 'question_batch') throw new Error('问题待办不存在')
    assertRevision(record, data.expectedRevision)
    if (record.status !== 'pending')
      throwError(ErrorCode.INTERACTION_ALREADY_RESOLVED, '问题已经处理')
    record = claimInteraction(record.interactionId, data.expectedRevision)
    if (!record) throwError(ErrorCode.INTERACTION_STALE, '待处理交互已发生变化，请刷新后重试')
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
      broadcastInteractionChanged(
        transitionInteraction(data.interactionId, ['resolving'], 'pending'),
      )
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
