import type { HandlerContext } from '../message/router.js'
import {
  createChunk,
  createNotification,
  Method,
  type Chunk,
  type Notification,
  type ChatCreateRequestData,
  type ChatCreateResponseData,
  type ChatGetRequestData,
  type ChatGetResponseData,
  type ChatDeleteRequestData,
  type ChatDeleteResponseData,
  type ChatListRequestData,
  type ChatListResponseData,
  type ChatContextUsageRequestData,
  type ChatContextUsageResponseData,
  type ChatAttachRequestData,
  type ChatAttachResponseData,
  type ChatSyncRequestData,
  type ChatSyncResponseData,
  type ChatSessionSnapshotData,
  type ChatStartSpawnRequestData,
  type ChatStartSpawnResponseData,
  type Response as RpcResponse,
} from '../message/types.js'
import {
  createChat,
  listAllChats,
  getChat,
  deleteChat,
  getMessages,
  getLastMessage,
  updateChatMetadata,
  parseMessageRow,
  findChatsByParent,
  getChatPreviews,
  getChatWorkspace,
  getChatRuntimeSelection,
} from '@/db/chat.js'
import { clearChatRuntime, ensureChat, isChatRunning } from './runtime.js'
import { connectionManager } from '../websocket/connection.js'
import { disconnectGrace } from '../websocket/disconnectGrace.js'
import { getQuestionStateSnapshot } from '@/db/question.js'
import { randomUUID } from 'crypto'
import {
  parseRuntimeSelection,
  resolvePresetSelection,
  type RuntimeSelection,
} from '@/agent/runtimeResolver.js'
import { logger } from '@/utils/logger/index.js'
import { breakdownUsed } from '@/utils/token.js'
import config, { DEFAULT_COMMAND_CONFIG, validateWorkspacePath } from '@/utils/config'
import { computeContextBreakdown } from './contextUsage.js'
import { registerPromptSnapshotHandler } from './promptSnapshot.js'
import { safeJsonParse } from '@/utils/json.js'
import {
  getChatEvents,
  claimSpawnTask,
  finishSpawnTask,
  getSpawnTaskByChild,
  listOpenSpawnTasks,
} from '@/db/delivery.js'
import { resolveRoleAvatar } from '@/utils/roleAvatar.js'
import { handleChatResume, handleChatSend } from './send.js'
import { computeCanResume } from './canResume.js'
import { computeCurrentState } from './currentState.js'

/**
 * 创建聊天（chatId 可选由前端指定）
 * 两种编制来源（T6）：
 *   - preset：从预设 leader 角色解析 brain+senseGroups+mcp+systemPrompt（编制快照入 metadata，
 *     运行后锁定）。AgentDialog 选预设路径。
 *   - 显式 brain + senseGroups：原路径（default 兜底 / 子 agent）。
 * 任一来源均原子配置 runtime + 一次性加载历史，返回 chatId。之后 chat.send 无需再带 brain/sense。
 */
export async function handleChatCreate(
  _ctx: HandlerContext,
  data: ChatCreateRequestData,
): Promise<ChatCreateResponseData> {
  const p = data
  const chatId = p.chatId || randomUUID()

  let selection: RuntimeSelection
  const metadata: Record<string, unknown> = {}
  if (p.preset) {
    // 预设路径：解析编制快照 + 记 preset 名 + spawn roster（选中子 agent type 列表）+ prompt 路径
    const resolved = resolvePresetSelection(p.preset)
    selection = resolved.selection
    metadata.preset = p.preset
    metadata.spawnTypes = resolved.spawnTypes
    if (resolved.systemPromptFile) metadata.systemPromptFile = resolved.systemPromptFile
    if (resolved.skillFilter) metadata.skillFilter = resolved.skillFilter
    if (resolved.workspace) metadata.workspace = resolved.workspace
  } else {
    // 显式路径：parseRuntimeSelection 校验 brain + senseGroups 必填
    selection = parseRuntimeSelection(p, 'chat.create')
  }

  createChat(chatId, Object.keys(metadata).length > 0 ? metadata : undefined, p.parentChatId)
  try {
    // 原子配置 runtime，并一次性加载历史到 agent。
    await ensureChat(chatId, selection)
  } catch (err) {
    // ensureChat 失败（configureRuntime 深校验/init 抛错）：清 runtime map 项 + 删 createChat 刚插入的 DB 行，
    // 避免孤儿 chat 行 + 半配置 runtime。createChat 严格 INSERT（重复 chatId 提前抛 SQLITE_CONSTRAINT），
    // 故此 catch 仅在本次新建行后触发，deleteChat 安全（不会销毁既有 chat）。
    clearChatRuntime(chatId)
    deleteChat(chatId)
    throw err
  }
  logger.event('chat.create', {
    chatId,
    preset: p.preset,
    brain: selection.brain,
    senseGroup: selection.senseGroup,
    mcpServers: selection.mcpServers,
  })
  const workspace = getChatWorkspace(chatId)
  const workspaceValid = workspace ? validateWorkspacePath(workspace).valid : undefined
  return {
    chatId,
    brain: selection.brain,
    senseGroup: selection.senseGroup,
    mcpServers: selection.mcpServers,
    ...(workspace ? { workspace, workspaceValid } : {}),
  }
}

/**
 * 取当前 .chery/config.yaml 的 global.command 配置投影（compact 阈值）。
 * 所有 chat.* RPC 的 commandConfig 字段均从此取值；前端据此判断 compact 按钮可见性与 warn 提示。
 * compact 无开关；warn/auto 为 Threshold{unit,value}；safety_margin 为内部默认不外露。
 */
function getCommandConfig(): import('../message/types.js').CommandConfigData {
  const cmd = config.global.command ?? {}
  return {
    warn: cmd.warn ?? DEFAULT_COMMAND_CONFIG.warn,
    auto: cmd.auto ?? DEFAULT_COMMAND_CONFIG.auto,
    minContextLimit: cmd.min_context_limit ?? 0,
  }
}

/** 构建 chat.get/chat.sync 共用的前端会话快照，避免启动阶段再发 context/runtime RPC。 */
function buildChatSessionSnapshot(chatId: string): ChatSessionSnapshotData {
  const chat = getChat(chatId)
  if (!chat) throw new Error('这个会话不见了')
  const metadata = chat.metadata ? (safeJsonParse(chat.metadata, {}) as { preset?: string }) : {}
  const contextBreakdown = computeContextBreakdown(chatId)
  const workspace = getChatWorkspace(chatId)
  const workspaceValid = workspace ? validateWorkspacePath(workspace).valid : undefined
  const runtime = getChatRuntimeSelection(chatId)
  return {
    ...(runtime ? { runtime } : {}),
    ...(metadata.preset ? { preset: metadata.preset } : {}),
    canResume: computeCanResume(chatId),
    currentState: computeCurrentState(chatId),
    contextUsage: contextBreakdown.usage,
    contextUsed: breakdownUsed(contextBreakdown),
    contextTotal: contextBreakdown.total,
    contextBreakdown,
    commandConfig: getCommandConfig(),
    ...(workspace ? { workspace, workspaceValid } : {}),
  }
}

/**
 * CP8：includePreview=true 时每项增返 preview（首条 user 消息截断）+ turnCount（user 消息数），
 *   按 messages_month 分组批量查，供会话列表渲染；省略=lean，供初始化重建 pet 树（免 N+1）。
 */
export async function handleChatList(
  _ctx: HandlerContext,
  data: ChatListRequestData,
): Promise<ChatListResponseData> {
  const rows = listAllChats()
  const previews = data.includePreview ? getChatPreviews(rows) : undefined

  const chats = rows.map((chat) => {
    const meta = chat.metadata
      ? (safeJsonParse(chat.metadata, {}) as {
          finished?: boolean
          wake?: 'immediate' | 'deferred' | 'barrier'
          resumePending?: boolean
          preset?: string
          type?: string
        })
      : {}
    // 兼容旧数据：历史终态异常可能已经完成 spawn task 并回传父会话，
    // 但尚未写入 metadata.finished。任务终态同样是子 agent 已结束的权威事实。
    const spawnTask = chat.parent_chat_id ? getSpawnTaskByChild(chat.id) : undefined
    const finished = meta.finished === true || spawnTask?.status === 'finished'
    const running = isChatRunning(chat.id)
    // 唤醒策略（子 metadata.wake）供前端重连恢复等待状态；刷新阶段不自动续跑。
    const wake =
      meta.wake === 'immediate' || meta.wake === 'deferred' || meta.wake === 'barrier'
        ? meta.wake
        : undefined
    const resumePending = meta.resumePending === true
    // canResume：idle chat 末条为未完成周期 → 前端重建时显示显式“继续”入口。
    // 仅非 finished 非 running 时计算（finished 不可恢复，running 不需恢复）
    const canResume = !finished && !running ? computeCanResume(chat.id) : false
    const workspace = getChatWorkspace(chat.id)
    const workspaceValid = workspace ? validateWorkspacePath(workspace).valid : undefined
    const base = {
      chatId: chat.id,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      messageCount: chat.message_count,
      parentChatId: chat.parent_chat_id ?? null,
      finished,
      running,
      wake,
      resumePending,
      canResume,
      preset: typeof meta.preset === 'string' ? meta.preset : undefined,
      agentType: typeof meta.type === 'string' ? meta.type : undefined,
      avatar:
        typeof meta.type === 'string'
          ? resolveRoleAvatar(meta.type, config.roles?.[meta.type]?.avatar)
          : undefined,
      ...(workspace ? { workspace, workspaceValid } : {}),
    }
    if (!data.includePreview || !previews) return base
    const p = previews.get(chat.id)
    const bd = computeContextBreakdown(chat.id)
    return {
      ...base,
      preview: p?.preview ?? '',
      turnCount: p?.turnCount ?? 0,
      contextUsage: bd.usage,
      contextUsed: breakdownUsed(bd),
      contextTotal: bd.total,
      contextBreakdown: bd,
    }
  })

  logger.event('chat.list', { count: chats.length, includePreview: !!data.includePreview })
  return { chats }
}

/**
 * 把 chat 持久消息转成 staged chunk 序列（消息→staged），供 chat.get 历史回放与 chat.sync 超窗回填复用。
 * runtime 溯源：user 带自身 runtime（并推进 lastUserRuntime），assistant 带前一条 user runtime（关联，见 agent-pet.md §5.7）。
 * 合成 chunk 的 requestId 为空串（非 RPC 产物），seq 缺省（超窗回填的旧历史无真实 seq，前端按 msgId/id 处理）。
 */
export function messagesToStagedEvents(chatId: string): Chunk[] {
  const messages = getMessages(chatId)
  let lastUserRuntime: RuntimeSelection | undefined
  const chunks: Chunk[] = []
  for (const msg of messages) {
    const parsedMsg = parseMessageRow(msg)
    if (parsedMsg.thinking) {
      chunks.push(
        createChunk(
          'staged',
          '',
          {
            type: 'thinking_end',
            role: parsedMsg.role,
            thinking: parsedMsg.thinking,
            createdAt: msg.created_at,
            msgId: msg.id,
            agentChatId: chatId,
          },
          { chatId },
        ),
      )
    }
    if (parsedMsg.content) {
      let msgRuntime: RuntimeSelection | undefined
      if (parsedMsg.role === 'user') {
        msgRuntime = parsedMsg.runtime
        lastUserRuntime = msgRuntime
      } else if (parsedMsg.role === 'assistant') {
        msgRuntime = lastUserRuntime
      }
      chunks.push(
        createChunk(
          'staged',
          '',
          {
            type: 'content_end',
            role: parsedMsg.role,
            content: parsedMsg.content,
            createdAt: msg.created_at,
            msgId: msg.id,
            agentChatId: chatId,
            ...(msgRuntime ? { runtime: msgRuntime } : {}),
            ...(parsedMsg.role === 'sense' ? { id: msg.id } : {}),
            ...(parsedMsg.replace?.state
              ? { replace: parsedMsg.replace, originalContent: parsedMsg.originalContent }
              : {}),
            ...(parsedMsg.contextCompaction ? { contextCompaction: true } : {}),
            ...(parsedMsg.contextCompactionTokens !== undefined
              ? { contextCompactionTokens: parsedMsg.contextCompactionTokens }
              : {}),
          },
          { chatId },
        ),
      )
    }
    if (parsedMsg.role !== 'sense' && parsedMsg.senseCall && parsedMsg.senseCall.length > 0) {
      for (const sc of parsedMsg.senseCall) {
        chunks.push(
          createChunk(
            'staged',
            '',
            {
              type: 'sense_end',
              role: parsedMsg.role,
              senseName: sc.name,
              arguments: sc.arguments,
              id: sc.id,
              agentChatId: chatId,
            },
            { chatId },
          ),
        )
      }
    }
  }
  return chunks
}

/**
 * 获取聊天详情（载入历史对话）
 * runtime selection 持久化在 chats.metadata.runtime，服务重启后 ensureChat 自动恢复，
 * 前端无需重新 runtime.set（除非持久化的 brain/group 已从 config.yaml 删除，恢复时报错）。
 */
export async function* handleChatGet(
  ctx: HandlerContext,
  data: ChatGetRequestData,
): AsyncGenerator<Chunk | Notification, ChatGetResponseData, unknown> {
  const p = data
  const requestId = ctx.requestId ?? p.chatId

  const chat = getChat(p.chatId)
  if (!chat) {
    throw new Error('这个会话不见了')
  }

  const messages = getMessages(p.chatId)

  // 逐条返回历史消息（消息→staged 转换抽取为 messagesToStagedEvents，供 chat.sync 超窗回填复用）
  for (const chunk of messagesToStagedEvents(p.chatId)) {
    yield chunk
  }

  // 发送 loaded notification
  yield createNotification('loaded', requestId, null, { chatId: p.chatId })

  const snapshot = buildChatSessionSnapshot(p.chatId)
  const questionSnapshot = getQuestionStateSnapshot(p.chatId)
  logger.event('chat.get', {
    chatId: p.chatId,
    messageCount: messages.length,
    canResume: snapshot.canResume,
    contextUsage: snapshot.contextUsage,
    pendingQuestionBatches: questionSnapshot.pendingQuestionBatches.length,
    snapshotSeq: questionSnapshot.snapshotSeq,
  })
  return {
    chatId: p.chatId,
    ...snapshot,
    ...questionSnapshot,
  }
}

/**
 * Replays the recoverable event stream for a chat. When retention has evicted
 * the requested cursor, callers receive reset=true and reload chat.get.
 * Open role tasks are emitted in that fallback so their start intent survives
 * even when the original role_created event has expired.
 */
export async function* handleChatSync(
  _ctx: HandlerContext,
  data: ChatSyncRequestData,
): AsyncGenerator<Chunk | Notification, ChatSyncResponseData, unknown> {
  if (!getChat(data.chatId)) throw new Error('这个会话不见了')
  const page = getChatEvents(data.chatId, data.afterSeq)
  let backfilled = false
  if (page.reset) {
    // 超窗淘汰：role_created 补发（spawn task 是持久载体）+ 消息合成回填旧历史 + 留存近期事件，
    // 拼成连续事件流（reset 转 false），前端单数组累积，无需回落 chat.get 双路合并（G3 改造A）。
    for (const task of listOpenSpawnTasks(data.chatId)) {
      const childMetaRow = getChat(task.childChatId)
      const childWakeRaw = childMetaRow?.metadata
        ? (safeJsonParse(childMetaRow.metadata, {}) as { wake?: string }).wake
        : undefined
      const wake: 'immediate' | 'deferred' | 'barrier' =
        childWakeRaw === 'deferred' || childWakeRaw === 'barrier' ? childWakeRaw : 'immediate'
      yield createNotification(
        'role_created',
        undefined,
        {
          taskId: task.taskId,
          chatId: task.childChatId,
          parentChatId: task.parentChatId,
          type: task.type,
          avatar: resolveRoleAvatar(task.type, config.roles?.[task.type]?.avatar),
          prompt: task.prompt,
          brain: task.brain,
          senseGroup: task.senseGroup,
          wake,
        },
        { chatId: data.chatId },
      )
    }
    // 留存近期事件（minSeq..latest）：afterSeq = minSeq-1 不触发 reset，返回全部留存事件
    const minSeq = page.minSeq ?? 1
    const retained = getChatEvents(data.chatId, minSeq - 1).events
    // 合成全部消息为 staged，按 msgId/id 去掉已被留存事件覆盖的近期消息，剩余 = 超窗淘汰的旧历史
    const seenKeys = new Set<string>()
    for (const ev of retained) {
      const e = ev as Record<string, unknown>
      if (e.kind === 'chunk' && e.type === 'staged') {
        const d = (e.data ?? {}) as unknown as Record<string, unknown>
        if (typeof d.msgId === 'string') seenKeys.add('m:' + d.msgId)
        if (typeof d.id === 'string') seenKeys.add('s:' + d.id)
      }
    }
    const backfill = messagesToStagedEvents(data.chatId).filter((ev) => {
      const d = (ev.data ?? {}) as unknown as Record<string, unknown>
      if (typeof d.msgId === 'string' && seenKeys.has('m:' + d.msgId)) return false
      if (typeof d.id === 'string' && seenKeys.has('s:' + d.id)) return false
      return true
    })
    for (const ev of backfill) yield ev
    for (const ev of retained) yield ev as unknown as Chunk | Notification
    backfilled = true
  } else {
    for (const event of page.events) {
      yield event as unknown as Chunk | Notification
    }
  }
  const questionSnapshot = getQuestionStateSnapshot(data.chatId)
  const snapshot = buildChatSessionSnapshot(data.chatId)
  return {
    chatId: data.chatId,
    latestSeq: page.latestSeq,
    ...(page.minSeq !== undefined ? { minSeq: page.minSeq } : {}),
    reset: false,
    ...(backfilled ? { backfilled: true } : {}),
    ...snapshot,
    ...questionSnapshot,
  }
}

/**
 * Atomically starts the prompt attached to a persisted role task. Replayed
 * role_created events can call this endpoint repeatedly: only the winning
 * pending→started transition sends the initial user prompt.
 */
export async function* handleChatStartSpawn(
  ctx: HandlerContext,
  data: ChatStartSpawnRequestData,
): AsyncGenerator<Chunk | Notification, ChatStartSpawnResponseData | RpcResponse, unknown> {
  const claimed = claimSpawnTask(data.taskId)
  const task = claimed.task
  if (!task) throw new Error('找不到这个 spawn 任务')
  if (task.status === 'finished') {
    updateChatMetadata(task.childChatId, { finished: true })
    return { chatId: task.childChatId, runId: ctx.requestId ?? data.taskId, alreadyFinished: true }
  }

  if (claimed.firstStart) {
    const result = yield* handleChatSend(ctx, { chatId: task.childChatId, prompt: task.prompt })
    // A yielded child can end this RPC without producing its own assistant
    // message (for example, while waiting on a descendant). Keep the task
    // `started` in that case so a reconnect can resume the persisted prompt;
    // only an actual child terminal message makes the launch irrecoverable.
    if (!('success' in result) || result.success !== false) {
      const last = getLastMessage(task.childChatId)
      if (last?.role === 'assistant') {
        finishSpawnTask(task.taskId)
        updateChatMetadata(task.childChatId, { finished: true })
        return { ...result, finished: true }
      }
    }
    return result
  }

  // A previous launcher may still be streaming. handleChatResume returns
  // alreadyRunning in that case, otherwise it continues an interrupted child
  // from its persisted user message without inserting that message again.
  const last = getLastMessage(task.childChatId)
  if (last?.role === 'assistant') {
    finishSpawnTask(task.taskId)
    updateChatMetadata(task.childChatId, { finished: true })
    return { chatId: task.childChatId, runId: ctx.requestId ?? data.taskId, alreadyFinished: true }
  }
  const result = yield* handleChatResume(ctx, { chatId: task.childChatId })
  if (!('success' in result) || result.success !== false) {
    const finalLast = getLastMessage(task.childChatId)
    if (finalLast?.role === 'assistant') {
      finishSpawnTask(task.taskId)
      updateChatMetadata(task.childChatId, { finished: true })
      return { ...result, finished: true }
    }
  }
  return result
}

/**
 * 删除聊天
 * CP8：目标为主 chat（无 parent_chat_id）时级联删其全部后代 chat + 各自消息 + 清内存 runtime，
 *   避免多级 spawn 留下孤儿 chat。子 chat 自身删除不级联。
 */
export async function handleChatDelete(
  _ctx: HandlerContext,
  data: ChatDeleteRequestData,
): Promise<ChatDeleteResponseData> {
  const p = data

  const chat = getChat(p.chatId)
  if (!chat) {
    throw new Error('这个会话不见了')
  }

  // 主 chat 级联全部后代：后序删除保证孙级先于父级，容忍异常 parent 环。
  const isMaster = !chat.parent_chat_id
  let cascaded = 0
  if (isMaster) {
    const descendants: Array<{ id: string }> = []
    const seen = new Set<string>([p.chatId])
    const visit = (parentChatId: string): void => {
      for (const child of findChatsByParent(parentChatId)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        visit(child.id)
        descendants.push(child)
      }
    }
    visit(p.chatId)
    cascaded = descendants.length
    for (const child of descendants) {
      clearChatRuntime(child.id)
      deleteChat(child.id)
    }
  }

  // 清理运行时缓存 + 删除目标 chat
  clearChatRuntime(p.chatId)
  deleteChat(p.chatId)

  logger.event('chat.delete', { chatId: p.chatId, cascaded })
  return { chatId: p.chatId }
}

/**
 * chat.contextUsage：轻量取上下文用量详情（不流式回历史）。
 * 前端 initFromChats 后为每个可见 pet 拉一次，驱动 ContextBar 初始渲染。
 */
export async function handleChatContextUsage(
  _ctx: HandlerContext,
  data: ChatContextUsageRequestData,
): Promise<ChatContextUsageResponseData> {
  const bd = computeContextBreakdown(data.chatId)
  return {
    chatId: data.chatId,
    contextUsage: bd.usage,
    contextUsed: breakdownUsed(bd),
    contextTotal: bd.total,
    contextBreakdown: bd,
    commandConfig: getCommandConfig(),
  }
}

/**
 * chat.attach：F5 后重连运行中 run，把后续实时输出重定向到本连接。
 * 非流式；attach 立即返回，后续 chunk/notification 由原 run 的（已重定向）流式循环持续投递。
 * 前端时序：先 chat.attach（开启重定向）→ 再 chat.sync（回放补齐当前实时态，见 web streamRouter resume 模式）。
 */
export async function handleChatAttach(
  ctx: HandlerContext,
  data: ChatAttachRequestData,
): Promise<ChatAttachResponseData> {
  const { chatId } = data
  if (!getChat(chatId)) throw new Error('这个会话不见了')

  // cursor 锚点：chat_events.MAX(seq) 同 pendingQuestionBatches 一事务快照。
  // 前端 attachRunningChats 用此 resetChatSeq，把 chatSeq 推到此刻；紧接 chat.sync 仅补回 >snapshotSeq 的事件。
  const questionSnapshot = getQuestionStateSnapshot(chatId)

  const ws = connectionManager.getWsByConnectionId(ctx.connectionId)
  if (!ws) {
    // 连接已不可达（竞态）：无法重定向，按未运行回落。
    logger.event('chat.attach.no-ws', { chatId, connectionId: ctx.connectionId })
    return { chatId, running: false, ...questionSnapshot }
  }

  // attach 同时是订阅登记：idle 主 chat 也要接收随后由子完成触发的
  // role_reply / child_abandoned；运行中 chat 则额外接收后续 stream。
  connectionManager.subscribeChat(chatId, ctx.connectionId)

  // 未在运行时仍保留订阅，用于后续子完成等异步 notification。
  if (!isChatRunning(chatId)) {
    return { chatId, running: false, ...questionSnapshot }
  }

  // 加入后续实时输出订阅 + 取消该 run 的断连 park（子 run 未跟踪则 no-op）。
  connectionManager.setLiveOutput(chatId, ws)
  disconnectGrace.rebindByChatId(chatId, ctx.connectionId, ws)

  logger.event('chat.attach', { chatId, connectionId: ctx.connectionId })
  return {
    chatId,
    running: true,
    attached: true,
    currentState: computeCurrentState(chatId),
    ...questionSnapshot,
  }
}

/**
 * 注册 Chat 管理 handlers
 */
export function registerChatManageHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.CHAT_CREATE, handleChatCreate)
  router.register(Method.CHAT_LIST, handleChatList)
  router.register(Method.CHAT_GET, handleChatGet) // 流式返回历史
  router.register(Method.CHAT_SYNC, handleChatSync)
  router.register(Method.CHAT_START_SPAWN, handleChatStartSpawn)
  router.register(Method.CHAT_DELETE, handleChatDelete)
  router.register(Method.CHAT_CONTEXT_USAGE, handleChatContextUsage)
  registerPromptSnapshotHandler(router)
  router.register(Method.CHAT_ATTACH, handleChatAttach)
}
