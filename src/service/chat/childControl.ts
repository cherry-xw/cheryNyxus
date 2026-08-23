import { clearWaitedChild, clearWaitedChildrenByParent } from '@/agent/spawnBroker.js'
import {
  collectDescendantsChatIds,
  getChat,
  getRootChatId,
  getTimelineRevision,
  updateChatMetadata,
} from '@/db/chat.js'
import { claimRequest, completeRequest, getSpawnTaskByChild } from '@/db/delivery.js'
import { getExecutionActiveRun, listExecutionNodes } from '@/db/executionGraph.js'
import {
  Method,
  type ChildAgentControlState,
  type ChildControlTargetResult,
  type ChatStopChildRequestData,
  type ChatStopChildResponseData,
  type TimelineNode,
} from '../message/types.js'
import { connectionManager } from '../websocket/connection.js'
import { computeCanResume } from './canResume.js'
import { recordTerminationFact } from './executionFacts.js'
import { emitTimelinePatch } from './rootGraphPatch.js'
import { abortChatRuntime, clearChatRuntime, getActiveChatRunId, isChatRunning } from './runtime.js'
import { abortPendingApprovals } from './send.js'

function metadataOf(chatId: string): Record<string, unknown> {
  const raw = getChat(chatId)?.metadata
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function childAgentControlState(chatId: string): ChildAgentControlState {
  const chat = getChat(chatId)
  if (!chat) return 'failed'
  const metadata = metadataOf(chatId)
  if (metadata.redirected === true) return 'redirected'
  if (metadata.abandoned === true) return 'failed'
  if (metadata.finished === true || getSpawnTaskByChild(chatId)?.status === 'finished') {
    return 'finished'
  }
  if (getSpawnTaskByChild(chatId)?.status === 'timed_out') return 'failed'
  if (isChatRunning(chatId)) return 'running'
  const nodes = listExecutionNodes(getRootChatId(chatId)) as unknown as TimelineNode[]
  const lastTermination = nodes
    .filter((node) => node.sourceChatId === chatId && node.termination)
    .at(-1)?.termination
  if (lastTermination?.code === 'agent_redirect') return 'redirected'
  if (lastTermination?.code === 'error' || lastTermination?.code === 'watchdog') return 'failed'
  return computeCanResume(chatId) ? 'paused' : 'paused'
}

export function childDispatchOutcome(
  state: ChildAgentControlState,
): 'queued' | 'resumed' | 'rejected' {
  if (state === 'running') return 'queued'
  if (state === 'paused') return 'resumed'
  return 'rejected'
}

export function assertRootControlsChild(rootChatId: string, childChatId: string): void {
  const root = getChat(rootChatId)
  const child = getChat(childChatId)
  if (!root || !child) throw new Error('目标会话不存在')
  if (root.parent_chat_id || getRootChatId(rootChatId) !== rootChatId) {
    throw new Error('只有主 Agent 可以控制子 Agent')
  }
  if (childChatId === rootChatId || getRootChatId(childChatId) !== rootChatId) {
    throw new Error('目标子 Agent 不属于当前主会话')
  }
}

function redirectOne(
  rootChatId: string,
  chatId: string,
  commandId: string,
): ChildControlTargetResult {
  const previousState = childAgentControlState(chatId)
  if (
    previousState === 'finished' ||
    previousState === 'failed' ||
    previousState === 'redirected'
  ) {
    return { chatId, previousState, state: previousState, outcome: 'unchanged' }
  }
  const runId = getActiveChatRunId(chatId) ?? `redirect:${commandId}:${chatId}`
  const durableRun = getExecutionActiveRun(chatId, runId)
  if (durableRun && ['paused', 'completed', 'failed'].includes(durableRun.status)) {
    const state =
      durableRun.status === 'completed'
        ? 'finished'
        : durableRun.status === 'failed'
          ? 'failed'
          : 'paused'
    return { chatId, previousState, state, outcome: 'unchanged', runId }
  }
  try {
    const baseRevision = getTimelineRevision(chatId)
    recordTerminationFact({
      chatId,
      runId,
      actor: 'agent',
      code: 'agent_redirect',
      detail: `redirected by root ${rootChatId}`,
    })
    updateChatMetadata(chatId, { redirected: true })
    emitTimelinePatch(chatId, baseRevision)
    clearWaitedChild(chatId)
    clearWaitedChildrenByParent(chatId)
    abortPendingApprovals(chatId)
    abortChatRuntime(chatId)
    connectionManager.forceReleaseChatConnection(chatId)
    clearChatRuntime(chatId)
    return {
      chatId,
      previousState,
      state: 'redirected',
      outcome: 'stopped',
      ...(previousState === 'running' ? { runId } : {}),
    }
  } catch (error) {
    return {
      chatId,
      previousState,
      state: childAgentControlState(chatId),
      outcome: 'failed',
      detail: error instanceof Error ? error.message : '停止失败',
    }
  }
}

/** Stop one child or its subtree. Descendants are stopped deepest-first. */
export function stopChildAgents(data: ChatStopChildRequestData): ChatStopChildResponseData {
  assertRootControlsChild(data.rootChatId, data.childChatId)
  const claimed = claimRequest(data.commandId, Method.CHAT_STOP_CHILD, data)
  if (claimed.state === 'completed') {
    return JSON.parse(claimed.responseJson) as ChatStopChildResponseData
  }
  if (claimed.state === 'active') throw new Error('该停止命令正在处理中')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')
  const targets = data.recursive
    ? [...collectDescendantsChatIds(data.childChatId).reverse(), data.childChatId]
    : [data.childChatId]
  const response: ChatStopChildResponseData = {
    rootChatId: data.rootChatId,
    commandId: data.commandId,
    results: targets.map((chatId) => redirectOne(data.rootChatId, chatId, data.commandId)),
  }
  completeRequest(data.commandId, response)
  return response
}
