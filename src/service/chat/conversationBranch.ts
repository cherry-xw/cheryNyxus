import { createHash, randomUUID } from 'node:crypto'
import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type BranchSideEffect,
  type ChatAbortTaskRequestData,
  type ChatAbortTaskResponseData,
  type ChatBranchCreateRequestData,
  type ChatBranchCreateResponseData,
  type ChatBranchActivateRequestData,
  type ChatBranchActivateResponseData,
  type ChatBranchPreviewRequestData,
  type ChatBranchPreviewResponseData,
  type TimelineNode,
  type ExecutionEdgeFact,
} from '../message/types.js'
import {
  deleteConversationBranch,
  activateConversationBranch,
  ensureConversationTask,
  getConversationBranch,
  getConversationBranchByChat,
  getConversationTask,
  insertConversationBranch,
  listConversationBranches,
} from '@/db/conversationBranch.js'
import {
  createChat,
  deleteChat,
  getChat,
  getChatMetadata,
  getChatRuntimeSelection,
  getRootChatId,
  addMessage,
  getLastMessage,
} from '@/db/chat.js'
import {
  abandonRequest,
  claimRequest,
  completeRequest,
  listSpawnTasksByParents,
  rerouteSpawnTasks,
  type SpawnTask,
} from '@/db/delivery.js'
import { clearChatRuntime, ensureChat } from './runtime.js'
import { buildRootTimeline, handleChatInputSubmit } from './handler.js'
import { isNodeInPackedGeneration } from './generations.js'
import { handleChatAbort } from './send.js'
import { resolveDetailSelection, type RuntimeSelection } from '@/agent/runtimeResolver.js'
import { collectDescendantsChatIds } from '@/db/chat.js'
import { computeCanResume } from './canResume.js'
import { launchDetachedResume } from './send.js'

const DETAIL_PROMPT =
  '你正在一个独立的细节解释分支中。只帮助用户理解给定历史中的概念、表述和因果关系；不要主动执行项目任务、修改文件或把回答回传到原任务。'

function runtimeSnapshot(rootChatId: string): Record<string, unknown> {
  const metadata = getChatMetadata(rootChatId)
  return {
    metadata,
    runtime: getChatRuntimeSelection(rootChatId),
  }
}

function sourceIdentity(rootChatId: string) {
  const existing = getConversationBranchByChat(rootChatId)
  if (existing) return existing
  return ensureConversationTask(rootChatId, runtimeSnapshot(rootChatId)).branch
}

function eligibleAnchor(node: TimelineNode | undefined): node is TimelineNode {
  if (!node || node.status !== 'committed' || !node.content && !node.toolCalls?.length) return false
  if (node.kind === 'system') return false
  return !(node.toolCalls ?? []).some((call) => call.status === 'pending' || call.status === 'accepted')
}

function ancestors(nodes: TimelineNode[], edges: ExecutionEdgeFact[], anchorNodeId: string): TimelineNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, string[]>()
  for (const edge of edges) incoming.set(edge.toNodeId, [...(incoming.get(edge.toNodeId) ?? []), edge.fromNodeId])
  const seen = new Set<string>()
  const stack = [anchorNodeId]
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const parent of incoming.get(id) ?? []) stack.push(parent)
  }
  return [...seen]
    .map((id) => byId.get(id))
    .filter((node): node is TimelineNode => !!node && node.status === 'committed')
    .sort((a, b) => a.orderKey - b.orderKey)
}

function snapshotText(path: TimelineNode[], anchor: TimelineNode, detail: boolean): string {
  const lines = path.map((node) => {
    const actor = node.actor.kind === 'user'
      ? '用户'
      : node.actor.kind === 'agent'
        ? `角色 ${node.actor.roleType ?? node.actor.chatId}`
        : node.actor.kind === 'tool'
          ? `工具 ${node.actor.toolName}`
          : '系统'
    const content = node.content.trim()
    const tools = (node.toolCalls ?? []).map((call) =>
      `[工具 ${call.name}] 参数: ${call.arguments}${call.result ? `\n结果: ${call.result}` : ''}`,
    )
    return [`[${actor}] ${content}`, ...tools].filter(Boolean).join('\n')
  })
  return [
    detail ? DETAIL_PROMPT : '以下是从原任务根到所选节点的不可变因果历史。请从该状态继续完成用户的新指令，不要假设历史节点之后的其他分支内容。',
    `来源节点: ${anchor.id}`,
    ...lines,
  ].join('\n\n')
}

function sideEffects(snapshot: ReturnType<typeof buildRootTimeline>, anchor: TimelineNode): BranchSideEffect[] {
  const effects = snapshot.nodes
    .filter((node) => node.orderKey > anchor.orderKey)
    .flatMap((node) => (node.toolCalls ?? [])
      .filter((call) => call.status === 'completed')
      .map((call) => ({
        nodeId: node.id,
        callId: call.callId,
        toolName: call.name,
        arguments: call.arguments,
        ...(call.result ? { result: call.result } : {}),
      })))
  const byCall = new Map<string, BranchSideEffect>()
  for (const effect of effects) {
    const previous = byCall.get(effect.callId)
    if (!previous || effect.nodeId.startsWith('batch:')) byCall.set(effect.callId, effect)
  }
  return [...byCall.values()].sort(
    (a, b) => a.nodeId.localeCompare(b.nodeId) || a.callId.localeCompare(b.callId),
  )
}

function digest(effects: BranchSideEffect[]): string {
  return createHash('sha256').update(JSON.stringify(effects)).digest('hex')
}

function inheritedTasks(
  snapshot: ReturnType<typeof buildRootTimeline>,
  anchor: TimelineNode,
): SpawnTask[] {
  const causalChats = new Set<string>([snapshot.rootChatId])
  const selected: SpawnTask[] = []
  const all = listSpawnTasksByParents([snapshot.rootChatId, ...collectDescendantsChatIds(snapshot.rootChatId)])
  const nodeOrder = new Map(snapshot.nodes.map((node) => [node.id, node.orderKey]))
  let changed = true
  while (changed) {
    changed = false
    for (const task of all) {
      if (selected.some((item) => item.taskId === task.taskId)) continue
      if (!causalChats.has(task.parentChatId)) continue
      const dispatchOrder = task.owningBatchId ? nodeOrder.get(task.owningBatchId) : undefined
      if (dispatchOrder === undefined || dispatchOrder > anchor.orderKey) continue
      selected.push(task)
      causalChats.add(task.childChatId)
      changed = true
    }
  }
  return selected.sort((a, b) => {
    const ao = a.owningBatchId ? (nodeOrder.get(a.owningBatchId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
    const bo = b.owningBatchId ? (nodeOrder.get(b.owningBatchId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
    return ao - bo || a.taskId.localeCompare(b.taskId)
  })
}

function inheritedTaskView(task: SpawnTask) {
  const last = getLastMessage(task.childChatId)
  return {
    taskId: task.taskId,
    childChatId: task.childChatId,
    parentChatId: task.parentChatId,
    type: task.type,
    status: task.status,
    ...(task.status === 'finished' && last?.content ? { content: last.content } : {}),
  }
}

function mergeContent(tasks: SpawnTask[]): string | undefined {
  const completed = tasks.filter((task) => task.status === 'finished')
  if (!completed.length) return undefined
  const sections = completed.map((task) => {
    const content = getLastMessage(task.childChatId)?.content ?? ''
    const checksum = createHash('sha256').update(content).digest('hex')
    return `[子任务 ${task.type} · ${task.taskId} · sha256:${checksum}]\n${content}`
  })
  return ['以下是所选节点前已派发子任务的原始最终返回，按派发顺序合并：', ...sections].join('\n\n')
}

export async function handleChatBranchPreview(
  _ctx: HandlerContext,
  data: ChatBranchPreviewRequestData,
): Promise<ChatBranchPreviewResponseData> {
  const rootChatId = getRootChatId(data.rootChatId)
  if (rootChatId !== data.rootChatId) throw new Error('只能从分支根时间线创建新分支')
  const source = sourceIdentity(rootChatId)
  const snapshot = buildRootTimeline(rootChatId, 'tree')
  const anchor = snapshot.nodes.find((node) => node.id === data.anchorNodeId)
  // 分支不可跨代：anchor 属已打包代（不在代际窗口内且 orderKey <= 最后一代边界）时拒绝。
  // 无 compact（generations 为空）不限制。
  if (!anchor && isNodeInPackedGeneration(rootChatId, data.anchorNodeId)) {
    return {
      taskId: source.taskId,
      sourceBranchId: source.branchId,
      eligible: false,
      reason: '只能在当前对话段内创建分支，已打包的历史不支持分支',
      sideEffects: [],
      effectDigest: digest([]),
      inheritedCompletedTasks: [],
      inheritedPausedTasks: [],
    }
  }
  const eligible = eligibleAnchor(anchor)
  const effects = eligible ? sideEffects(snapshot, anchor) : []
  const inherited = eligible ? inheritedTasks(snapshot, anchor) : []
  return {
    taskId: source.taskId,
    sourceBranchId: source.branchId,
    eligible,
    ...(!eligible ? { reason: '该节点没有稳定的可分支内容' } : {}),
    sideEffects: effects,
    effectDigest: digest(effects),
    inheritedCompletedTasks: inherited.filter((task) => task.status === 'finished').map(inheritedTaskView),
    inheritedPausedTasks: inherited.filter((task) => task.status === 'pending' || task.status === 'started').map(inheritedTaskView),
  }
}

function taskIsIdle(taskId: string): boolean {
  return listConversationBranches(taskId).every((branch) =>
    buildRootTimeline(branch.chatId, 'tree').activeRuns.every(
      (run) => !['running', 'waiting'].includes(run.status),
    ),
  )
}

export async function handleChatBranchCreate(
  ctx: HandlerContext,
  data: ChatBranchCreateRequestData,
): Promise<ChatBranchCreateResponseData> {
  const claimed = claimRequest(data.commandId, Method.CHAT_BRANCH_CREATE, data)
  if (claimed.state === 'completed') return JSON.parse(claimed.responseJson) as ChatBranchCreateResponseData
  if (claimed.state === 'active') throw new Error('该分支创建命令正在处理中')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')
  let chatId: string | undefined
  let branchId: string | undefined
  let previousActiveBranchId: string | undefined
  let inheritedForRollback: SpawnTask[] = []
  try {
    const preview = await handleChatBranchPreview(ctx, data)
    if (!preview.eligible) throw new Error(preview.reason)
    if (data.branchType === 'continuation') {
      if (!taskIsIdle(preview.taskId)) throw new Error('任务仍在运行，请先暂停任务后再从历史节点继续')
      if (data.effectDigest !== preview.effectDigest) throw new Error('节点后的工具副作用已变化，请重新确认')
    }
    const source = getConversationBranchByChat(data.rootChatId) ?? sourceIdentity(data.rootChatId)
    previousActiveBranchId = getConversationTask(preview.taskId)?.activeBranchId
    const sourceChat = getChat(data.rootChatId)
    if (!sourceChat) throw new Error('来源会话不存在')
    const timeline = buildRootTimeline(data.rootChatId, 'tree')
    const anchor = timeline.nodes.find((node) => node.id === data.anchorNodeId)!
    const path = ancestors(timeline.nodes, timeline.edges, anchor.id)
    const sourceMeta = getChatMetadata(data.rootChatId)
    const fallback = getChatRuntimeSelection(data.rootChatId)
    if (!fallback) throw new Error('来源会话缺少运行时快照')
    let selection: RuntimeSelection = fallback
    let systemPromptFile = typeof sourceMeta.systemPromptFile === 'string' ? sourceMeta.systemPromptFile : undefined
    let skillFilter = sourceMeta.skillFilter
    if (data.branchType === 'detail') {
      const preset = typeof sourceMeta.preset === 'string' ? sourceMeta.preset : undefined
      if (!preset) throw new Error('来源会话未绑定预设，不能创建解释分支')
      const resolved = resolveDetailSelection(preset)
      selection = resolved.selection
      systemPromptFile = resolved.systemPromptFile
      skillFilter = resolved.skillFilter
    }
    chatId = randomUUID()
    branchId = randomUUID()
    const inheritedContext = typeof sourceMeta.branchContext === 'string' ? sourceMeta.branchContext : ''
    const localContext = snapshotText(path, anchor, data.branchType === 'detail')
    const context = inheritedContext ? `${inheritedContext}\n\n--- 后续分叉 ---\n\n${localContext}` : localContext
    const metadata = {
      ...sourceMeta,
      runtime: selection,
      branchContext: context,
      branchKind: data.branchType,
      branchTitle: data.prompt.trim(),
      ...(systemPromptFile ? { systemPromptFile } : { systemPromptFile: undefined }),
      ...(skillFilter ? { skillFilter } : { skillFilter: undefined }),
      lastUserActivityAt: Date.now(),
    }
    createChat(chatId, metadata)
    const inherited = data.branchType === 'continuation' ? inheritedTasks(timeline, anchor) : []
    inheritedForRollback = inherited
    insertConversationBranch({
      branchId,
      taskId: preview.taskId,
      chatId,
      kind: data.branchType,
      sourceBranchId: source.branchId,
      anchorRootChatId: data.rootChatId,
      anchorNodeId: anchor.id,
      contextSnapshot: path,
      runtimeSnapshot: {
        metadata,
        runtime: selection,
        ...(data.branchType === 'continuation'
          ? { inheritedTaskIds: inherited.map((task) => task.taskId) }
          : {}),
      },
    }, {
      activate: data.branchType === 'continuation',
      deliveryTaskIds: inherited.map((task) => task.taskId),
    })
    if (data.branchType === 'continuation') {
      const merged = mergeContent(inherited)
      if (merged) addMessage(`branch-merge:${branchId}`, chatId, { role: 'system', content: merged })
    }
    await ensureChat(chatId, selection)
    const input = await handleChatInputSubmit(ctx, {
      chatId,
      commandId: `${data.commandId}:input`,
      clientMessageId: data.clientMessageId,
      messageId: data.messageId,
      content: data.prompt,
    })
    const response: ChatBranchCreateResponseData = {
      branchId,
      taskId: preview.taskId,
      chatId,
      kind: data.branchType,
      sourceBranchId: source.branchId,
      anchorRootChatId: data.rootChatId,
      anchorNodeId: anchor.id,
      createdAt: Date.now(),
      input,
    }
    completeRequest(data.commandId, response)
    if (data.branchType === 'continuation') {
      for (const task of inherited.filter((item) => item.status === 'pending' || item.status === 'started')) {
        if (!computeCanResume(task.childChatId)) continue
        void launchDetachedResume(ctx, task.childChatId, `branch-resume:${branchId}:${task.taskId}`).catch(() => {})
      }
    }
    return response
  } catch (error) {
    if (previousActiveBranchId && branchId && getConversationTask(getConversationBranchByChat(chatId ?? '')?.taskId ?? '')?.activeBranchId === branchId) {
      const restored = activateConversationBranch(previousActiveBranchId)
      rerouteSpawnTasks(
        inheritedForRollback.map((task) => task.taskId),
        restored.branch.chatId,
        restored.branch.branchId,
        restored.task.deliveryGeneration,
      )
    }
    if (chatId) clearChatRuntime(chatId)
    if (branchId) deleteConversationBranch(branchId)
    if (chatId) deleteChat(chatId)
    abandonRequest(`${data.commandId}:input`)
    abandonRequest(data.commandId)
    throw error
  }
}

export async function handleChatBranchActivate(
  _ctx: HandlerContext,
  data: ChatBranchActivateRequestData,
): Promise<ChatBranchActivateResponseData> {
  const claimed = claimRequest(data.commandId, Method.CHAT_BRANCH_ACTIVATE, data)
  if (claimed.state === 'completed') return JSON.parse(claimed.responseJson) as ChatBranchActivateResponseData
  if (claimed.state === 'active') throw new Error('主流程切换命令正在处理中')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')
  try {
    const branch = getConversationBranch(data.branchId)
    if (!branch) throw new Error('分支不存在')
    const snapshotNodes = Array.isArray(branch.contextSnapshot)
      ? branch.contextSnapshot as TimelineNode[]
      : []
    const causalParents = new Set([
      branch.chatId,
      ...collectDescendantsChatIds(branch.chatId),
      ...snapshotNodes.map((node) => node.sourceChatId),
    ])
    const inheritedTaskIds: Set<string> | undefined = Array.isArray(branch.runtimeSnapshot.inheritedTaskIds)
      ? new Set((branch.runtimeSnapshot.inheritedTaskIds as unknown[]).filter((id): id is string => typeof id === 'string'))
      : undefined
    const openTaskIds = inheritedTaskIds
      ? [...inheritedTaskIds]
      : listSpawnTasksByParents([...causalParents])
          .filter((task) => task.status === 'pending' || task.status === 'started')
          .map((task) => task.taskId)
    const activated = activateConversationBranch(data.branchId, openTaskIds)
    const response = {
      taskId: activated.task.taskId,
      activeBranchId: activated.branch.branchId,
      activeChatId: activated.branch.chatId,
      deliveryGeneration: activated.task.deliveryGeneration,
    }
    completeRequest(data.commandId, response)
    return response
  } catch (error) {
    abandonRequest(data.commandId)
    throw error
  }
}

export async function handleChatAbortTask(
  ctx: HandlerContext,
  data: ChatAbortTaskRequestData,
): Promise<ChatAbortTaskResponseData> {
  const claimed = claimRequest(data.commandId, Method.CHAT_ABORT_TASK, data)
  if (claimed.state === 'completed') return JSON.parse(claimed.responseJson) as ChatAbortTaskResponseData
  if (claimed.state === 'active') throw new Error('该任务暂停命令正在处理中')
  if (claimed.state === 'mismatch') throw new Error('commandId 已用于另一条命令')
  try {
    if (!getConversationTask(data.taskId)) throw new Error('任务不存在')
    const abortedBranches: string[] = []
    for (const branch of listConversationBranches(data.taskId)) {
      await handleChatAbort(ctx, { chatId: branch.chatId, commandId: `${data.commandId}:${branch.branchId}` })
      abortedBranches.push(branch.branchId)
    }
    const response = { taskId: data.taskId, abortedBranches }
    completeRequest(data.commandId, response)
    return response
  } catch (error) {
    abandonRequest(data.commandId)
    throw error
  }
}

export function registerConversationBranchHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.CHAT_BRANCH_PREVIEW, handleChatBranchPreview)
  router.register(Method.CHAT_BRANCH_CREATE, handleChatBranchCreate)
  router.register(Method.CHAT_BRANCH_ACTIVATE, handleChatBranchActivate)
  router.register(Method.CHAT_ABORT_TASK, handleChatAbortTask)
}
