import { AgentBuilder } from '@/agent/builder.js'
import config from '@/utils/config.js'
import type { RuntimeSelection, RuntimeProvenance } from '@/agent/runtimeResolver.js'
import {
  assertRestartAdmission,
  isRestartDraining,
  notifyRestartActivityChanged,
} from '@/service/restartCoordinator.js'
import { notifyTreeConfigBoundary, treeBoundaryReason } from '@/service/config/treeBoundary.js'

/**
 * Chat 运行时缓存：chatId → builder + runtime 选择（单 chat 绑定，跨轮不重建）
 * （P2-1 从 send.ts 拆出）
 *
 * 每个 chatId 独享一个 AgentBuilder 实例（不再全局单例），与 Middleware 一同随 chat 生命周期存在。
 * runtime selection 由 chat.create/runtime.set 原子注入。
 * 实例不重建，messages 天然保留，无需迁移。
 */
export interface ChatRuntime {
  builder: AgentBuilder
  selection?: RuntimeSelection
  /** Frozen context epoch loaded into this builder. */
  epochId?: string
  /** 当前活跃 chat.send/chat.resume 的协议运行标识。 */
  activeRunId?: string
}

export const chatRuntimes = new Map<string, ChatRuntime>()
/**
 * 读 chat 当前 runtime selection（内存 chatRuntimes）。
 * observer 入库 user 消息时记 messages.runtime 用(消息级 runtime 溯源,见 agent-pet.md §5.7)。
 */
export function getChatSelection(chatId: string): RuntimeSelection | undefined {
  return chatRuntimes.get(chatId)?.selection
}

/**
 * 消息级 runtime 溯源：selection + 当前 brain 的 model/provider 快照。
 * observer 入库 user 消息时记 messages.runtime（brain 配置后续修改不影响历史消息展示）。
 */
export function getChatRuntimeProvenance(chatId: string): RuntimeProvenance | undefined {
  const selection = chatRuntimes.get(chatId)?.selection
  if (!selection) return undefined
  const brain = config.llm.brain[selection.brain]
  return {
    ...selection,
    ...(brain?.model ? { brainModel: brain.model } : {}),
    ...(brain?.provider ? { brainProvider: brain.provider } : {}),
  }
}

/** Read-only queued user input snapshot for chat.open session hydration. */
export function getPendingChatInputs(chatId: string): Array<{
  content: string
  time: number
  inputId?: string
  messageId?: string
  clientMessageId?: string
  commandId?: string
}> {
  const runtime = chatRuntimes.get(chatId)
  return runtime?.builder.getPendingInputs().map((entry) => ({ ...entry })) ?? []
}

/**
 * 撤回排队输入的内存队列部分（chat.input.withdraw 用）。
 * - 'removed'：已从内存队列移除，可继续落 DB cancelled；
 * - 'absent'：无 runtime（重启后尚未初始化），输入为 DB-only、从未被采用，可取消；
 * - 'already-adopted'：有 runtime 但输入已不在队列（已被 drain 进当前轮次），拒绝撤回。
 */
export function removeQueuedChatInput(
  chatId: string,
  matcher: { inputId?: string; clientMessageId?: string },
): 'removed' | 'absent' | 'already-adopted' {
  const runtime = chatRuntimes.get(chatId)
  if (!runtime) return 'absent'
  return runtime.builder.removeInput(matcher) ? 'removed' : 'already-adopted'
}

/**
 * 查 chat 当前是否正在运行(有活跃 generator)。
 * chat.list 暴露 running 字段用(前端据此判断子 agent 是否还活着、主 chat 是否卡死)。
 */
export function isChatRunning(chatId: string): boolean {
  return chatRuntimes.get(chatId)?.builder.isRunning() ?? false
}

/** 守护进程待重启时，用于判定所有 chat 是否已安全空闲。 */
export function hasRunningChats(): boolean {
  return [...chatRuntimes.values()].some(
    (runtime) => runtime.activeRunId || runtime.builder.isRunning(),
  )
}

/** Non-sensitive runtime summary for the local manager status file. */
export function getAgentRuntimeStats(): {
  initializedChats: number
  runningChats: number
  activeRuns: number
} {
  let runningChats = 0
  let activeRuns = 0
  for (const runtime of chatRuntimes.values()) {
    if (runtime.builder.isRunning()) runningChats += 1
    if (runtime.activeRunId) activeRuns += 1
  }
  return { initializedChats: chatRuntimes.size, runningChats, activeRuns }
}

/** 获取当前活跃运行，用于 queued send 回包与带条件的 chat.abort。 */
export function getActiveChatRunId(chatId: string): string | undefined {
  return chatRuntimes.get(chatId)?.activeRunId
}

/** Observation must never initialize a runtime. */
export function peekChatMessages(chatId: string) {
  return chatRuntimes.get(chatId)?.builder.getMessages()
}

/** 在启动 send/resume 前登记运行；同一 chat 同时至多一个活跃运行。 */
export function activateChatRun(chatId: string, runId: string): void {
  assertRestartAdmission(isRestartDraining() && !!treeBoundaryReason(chatId, true))
  const runtime = chatRuntimes.get(chatId)
  if (!runtime) {
    throw new Error(`Chat runtime not initialized: ${chatId}`)
  }
  runtime.activeRunId = runId
}

/** 仅清除自己启动的运行，防止旧 generator 的 finally 清掉新运行。 */
export function releaseChatRun(chatId: string, runId: string): void {
  const runtime = chatRuntimes.get(chatId)
  if (runtime?.activeRunId === runId) {
    runtime.activeRunId = undefined
  }
  notifyRestartActivityChanged()
  notifyTreeConfigBoundary()
}

/**
 * 中止 chat 运行中 generator（chat.abort 场景）。
 * 转发 builder.abort → compose.abort 注入错误退出 generator。
 */
export function abortChatRuntime(chatId: string): void {
  chatRuntimes.get(chatId)?.builder.abort()
}

/** Fail-closed maintenance transition: stop all active generators immediately. */
export function abortAllChatRuntimes(): void {
  for (const runtime of chatRuntimes.values()) runtime.builder.abort()
}

/**
 * 标记 chat 当前 run 在“下一轮 loop 决策前”抛 AgentParkError（安全边界暂停）。
 * 由断连宽限调度器在 `disconnect_grace_ms` 到期时调用。
 * 当前 runChain 不会被立刻打断；只对处于 active 运行期的 chat 起作用。
 */
export function requestParkAfterTurn(chatId: string, runId: string): void {
  const runtime = chatRuntimes.get(chatId)
  if (!runtime) return
  if (runtime.activeRunId !== runId) {
    // 不同 runId（重连后已用新 requestId 启动的流）→ 旧的 request 已结束，不应再标记。
    return
  }
  runtime.builder.requestParkAfterTurn()
}
