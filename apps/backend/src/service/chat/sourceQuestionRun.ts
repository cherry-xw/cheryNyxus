import type { UserInputEntry } from '@/core/middleware/types.js'
import type { HandlerContext } from '../message/router.js'
import { ensureChat } from './runtime.js'
import { activateChatRun, getActiveChatRunId, getPendingChatInputs, releaseChatRun } from './runtimeCache.js'
import { listPendingInputs } from '@/db/pendingInput.js'
import { observeAgentChunks } from './observer.js'
import { streamAgentChunks } from './streamMapper.js'
import { prepareChatEventForDelivery } from '@/db/delivery.js'
import { connectionManager } from '../websocket/connection.js'
import { deliverToSockets } from '../websocket/deliver.js'
import { assertBackendContinuation, backendContinuationResumeRequired } from '../backendWork.js'
import { assertRestartAdmission } from '../restartCoordinator.js'
import { sourceTaskError } from '@/db/sourceTasks.js'

/** Reserve before acknowledging; never use trailing-history Resume for a saved answer. */
export async function launchSourceQuestionRun(ctx: HandlerContext, chatId: string, runId: string,
  meta: Omit<Partial<UserInputEntry>, 'content' | 'time'>, claim: () => void): Promise<boolean> {
  assertBackendContinuation(chatId)
  assertRestartAdmission()
  if (backendContinuationResumeRequired(chatId)) sourceTaskError('BACKEND_RESUME_REQUIRED')
  const agent = await ensureChat(chatId)
  assertBackendContinuation(chatId)
  assertRestartAdmission()
  if (agent.isRunning() || getActiveChatRunId(chatId) || getPendingChatInputs(chatId).length || listPendingInputs(chatId).length) return false
  // No await between current-authority validation, durable claim, and reservation.
  connectionManager.bindChatConnection(chatId, ctx.connectionId)
  try { activateChatRun(chatId, runId); claim() }
  catch (error) { releaseChatRun(chatId, runId); connectionManager.releaseChatConnection(chatId, ctx.connectionId); throw error }
  void (async () => {
    try {
      const generator = observeAgentChunks(agent.run('', { resumeMeta: meta }), chatId, () => agent.getMessages())
      for await (const item of streamAgentChunks(generator, runId, chatId, runId)) {
        prepareChatEventForDelivery(chatId, item as unknown as Record<string, unknown>)
        deliverToSockets(connectionManager.getChatOutputs(chatId), item, 'qq.question.output_failed')
      }
    } catch { /* The stream mapper persists the outcome; no model/tool retry. */ }
    finally {
      releaseChatRun(chatId, runId)
      connectionManager.releaseChatConnection(chatId, ctx.connectionId)
      connectionManager.clearLiveOutput(chatId)
    }
  })()
  return true
}
