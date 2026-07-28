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
  type ChatOpenRequestData,
  type ChatOpenResponseData,
  type ChatCloseRequestData,
  type ChatCloseResponseData,
  type ActiveTurnSnapshot,
  type ChatSyncRequestData,
  type ChatSyncResponseData,
  type ChatTimelineGetRequestData,
  type ChatTimelineGetResponseData,
  type CanonicalMessage,
  type TimelineNode,
  type TimelineActor,
  type RootTimelineSnapshot,
  type TimelinePatchData,
  type ChatSessionSnapshotData,
  type ChatStartSpawnRequestData,
  type ChatStartSpawnResponseData,
  type ChatInputSubmitRequestData,
  type ChatInputSubmitResponseData,
  type Response as RpcResponse,
} from '../message/types.js'
import {
  createChat,
  listAllChats,
  getChat,
  deleteChat,
  getMessages,
  getMessageLinksForRoot,
  upsertMessageLink,
  collectDescendantsChatIds,
  getLastMessage,
  updateChatMetadata,
  parseMessageRow,
  findChatsByParent,
  getChatPreviews,
  getChatWorkspace,
  getChatRuntimeSelection,
  getTimelineRevision,
  addPendingInput,
} from '@/db/chat.js'
import {
  clearChatRuntime,
  ensureChat,
  isChatRunning,
  getActiveChatRunId,
  getPendingChatInputs,
} from './runtime.js'
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
  getRecentChatEvents,
  claimSpawnTask,
  finishSpawnTask,
  getSpawnTaskByChild,
  listOpenSpawnTasks,
  appendChatEvent,
  claimRequest,
  completeRequest,
} from '@/db/delivery.js'
import { resolveRoleAvatar } from '@/utils/roleAvatar.js'
import { handleChatResume, handleChatSend, attachmentsToPromptMarkers } from './send.js'
import { computeCanResume } from './canResume.js'
import { computeCurrentState } from './currentState.js'
import { transport } from '../websocket/transport.js'
import { UserInputQueueFullError } from '@/core/middleware/messageJournal.js'

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
    if (resolved.rule) metadata.rule = resolved.rule
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

function decodeTimelineCursor(cursor: string): { createdAt: number; id: string } | undefined {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as { createdAt?: unknown; id?: unknown }
    if (typeof parsed.createdAt !== 'number' || typeof parsed.id !== 'string') return undefined
    return { createdAt: parsed.createdAt, id: parsed.id }
  } catch {
    return undefined
  }
}

function encodeTimelineCursor(value: { createdAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** Construct the backend-owned canonical timeline projection. */
export function buildCanonicalTimeline(chatId: string): CanonicalMessage[] {
  const rows = getMessages(chatId)
  const chat = getChat(chatId)
  const parentChatId = chat?.parent_chat_id ?? undefined
  const senseResults = new Map<string, { content: string; revoked: boolean }>()
  for (const row of rows) {
    if (row.role === 'sense') {
      senseResults.set(row.id, { content: row.content ?? '', revoked: row.revoked === 1 })
    }
  }
  let lastRuntime: RuntimeSelection | undefined
  // sense 行是工具执行结果，已通过上方 senseResults 并入所属 assistant 的 senseCalls（按 call.id 匹配）；
  // 不作为独立 CanonicalMessage 输出，否则前端 canonicalToChatMessage 会把 sense→assistant，
  // 把工具结果渲染成一条主 agent 气泡。与 buildRootTimeline conversation 视图（L541 if sense -> continue）一致。
  const visibleRows = rows.filter((row) => row.role !== 'sense')
  return visibleRows.map((row) => {
    const parsed = parseMessageRow(row)
    if (parsed.role === 'user' && parsed.runtime) lastRuntime = parsed.runtime
    const runtime =
      parsed.role === 'user'
        ? parsed.runtime
        : parsed.role === 'assistant'
          ? lastRuntime
          : undefined
    const senseCalls = (parsed.senseCall ?? []).map((call) => {
      const result = senseResults.get(call.id)
      return {
        ...call,
        ...(result && result.content ? { result: result.content } : {}),
        status: result?.revoked
          ? ('rejected' as const)
          : result?.content
            ? ('accepted' as const)
            : ('pending' as const),
      }
    })
    const origin = parentChatId ? { parentChatId, childChatId: chatId } : undefined
    return {
      id: row.id,
      chatId,
      role:
        parsed.role === 'subagent'
          ? 'role'
          : parsed.role === 'system'
            ? 'role'
            : (parsed.role as CanonicalMessage['role']),
      content: parsed.content ?? '',
      ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
      createdAt: row.created_at,
      updatedAt: row.created_at,
      status: row.revoked === 1 ? 'revoked' : 'committed',
      ...(runtime ? { runtime } : {}),
      ...(senseCalls.length > 0 ? { senseCalls } : {}),
      ...(origin ? { origin } : {}),
    }
  })
}

/** Build an idempotent revision patch. Callers should invoke this only after
 * the message mutation transaction commits; when a revision gap exists the
 * client can safely replace its snapshot with the returned upserts. */
export function buildTimelinePatch(chatId: string, baseRevision: number): TimelinePatchData {
  const revision = getTimelineRevision(chatId)
  const messages = buildCanonicalTimeline(chatId)
  return {
    chatId,
    baseRevision,
    revision,
    operations:
      revision === baseRevision
        ? []
        : messages.map((message) => ({ type: 'upsert' as const, message })),
  }
}

/**
 * Build the root-owned multi-agent projection. Raw messages remain in their
 * own chat; this function is the only place that assigns actor/direction and
 * hides standalone tool-result rows from the conversation view.
 */
export function buildRootTimeline(
  rootChatId: string,
  view: 'conversation' | 'tree' | 'audit' = 'conversation',
): RootTimelineSnapshot {
  const root = getChat(rootChatId)
  if (!root) throw new Error('这个会话不见了')
  const chatIds = [rootChatId, ...collectDescendantsChatIds(rootChatId)]
  const existingLinkIds = new Set(getMessageLinksForRoot(rootChatId).map((link) => link.messageId))
  // Lazy backfill makes pre-V2 conversations progressively auditable without
  // a destructive one-shot migration. Ambiguous parent role rows are left
  // unlinked so the projector can apply its conservative matcher below.
  for (const chatId of chatIds) {
    const child = chatId !== rootChatId
    for (const row of getMessages(chatId)) {
      if (!child && row.role === 'role') continue
      if (!existingLinkIds.has(row.id)) {
        upsertMessageLink(row.id, chatId, {
          relation: child
            ? row.role === 'user'
              ? 'child_input'
              : 'child_output'
            : row.role === 'user'
              ? 'root_input'
              : row.role === 'sense'
                ? 'tool_result'
                : 'agent_output',
        })
        existingLinkIds.add(row.id)
      }
    }
  }
  const links = new Map(getMessageLinksForRoot(rootChatId).map((link) => [link.messageId, link]))
  const allNodes: TimelineNode[] = []
  const chatMeta = new Map<string, { type?: string; parent?: string }>()
  const childByType = new Map<string, string[]>()
  for (const chatId of chatIds) {
    const chat = getChat(chatId)
    const metadata = chat?.metadata
      ? (safeJsonParse(chat.metadata, {}) as Record<string, unknown>)
      : {}
    chatMeta.set(chatId, {
      type: typeof metadata.type === 'string' ? metadata.type : undefined,
      parent: chat?.parent_chat_id ?? undefined,
    })
    if (chatId !== rootChatId) {
      const type = chatMeta.get(chatId)?.type
      if (type) childByType.set(type, [...(childByType.get(type) ?? []), chatId])
    }
  }
  const actorForAgent = (chatId: string): TimelineActor => ({
    kind: 'agent',
    chatId,
    ...(chatMeta.get(chatId)?.type ? { roleType: chatMeta.get(chatId)!.type } : {}),
  })

  for (const chatId of chatIds) {
    const rows = getMessages(chatId)
    const child = chatId !== rootChatId
    for (const row of rows) {
      let link = links.get(row.id)
      const parsed = parseMessageRow(row)
      // Legacy role rows predate message_links. Recover an unambiguous
      // child-return association from the persisted role type prefix and the
      // child terminal content; ambiguous records remain unknown.
      if (!link && !child && row.role === 'role' && typeof row.content === 'string') {
        const match = /^\[角色\s+([^\]]+)\]\s*(.*)$/s.exec(row.content)
        const candidates = match ? (childByType.get(match[1]!) ?? []) : []
        const matched = candidates.filter((candidate) => {
          const last = getLastMessage(candidate)
          return !!last && (last.content ?? '') === (match?.[2] ?? '')
        })
        if (matched.length === 1) {
          const candidate = matched[0]!
          link = {
            messageId: row.id,
            rootChatId,
            sourceChatId: candidate,
            parentChatId: rootChatId,
            relation: 'child_return',
            relatedMessageId: getLastMessage(candidate)?.id,
            createdAt: row.created_at,
          }
        }
      }
      const relation =
        link?.relation ??
        (child
          ? row.role === 'user'
            ? 'child_input'
            : 'child_output'
          : row.role === 'user'
            ? 'root_input'
            : 'agent_output')
      if (row.role === 'sense') {
        if (view !== 'audit') continue
        allNodes.push({
          id: `tool:${row.id}`,
          rootChatId,
          sourceChatId: chatId,
          sourceMessageId: row.id,
          kind: 'tool-group',
          actor: { kind: 'tool', toolName: 'unknown' },
          direction: 'internal',
          visibility: 'detail',
          content: row.content ?? '',
          createdAt: row.created_at,
          updatedAt: row.created_at,
          status: row.revoked === 1 ? 'revoked' : 'committed',
        })
        continue
      }
      let actor: TimelineActor
      let target: TimelineActor | undefined
      let direction: TimelineNode['direction']
      let kind: TimelineNode['kind'] = 'message'
      if (relation === 'root_input') {
        actor = { kind: 'user', actorId: 'human' }
        target = actorForAgent(rootChatId)
        direction = 'user-to-agent'
      } else if (relation === 'child_input') {
        actor = actorForAgent(chatMeta.get(chatId)?.parent ?? rootChatId)
        target = actorForAgent(chatId)
        direction = 'parent-to-child'
      } else if (relation === 'child_return') {
        actor = actorForAgent(link?.sourceChatId ?? chatId)
        target = actorForAgent(link?.parentChatId ?? rootChatId)
        direction = 'child-to-parent'
        kind = 'return'
      } else if (child) {
        actor = actorForAgent(chatId)
        target = actorForAgent(chatMeta.get(chatId)?.parent ?? rootChatId)
        direction = 'agent-to-user'
      } else {
        actor = actorForAgent(rootChatId)
        direction = 'agent-to-user'
      }
      const senseCalls = (parsed.senseCall ?? []).map((call) => {
        const result = getMessages(chatId).find((candidate) => candidate.id === call.id)
        return {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          ...(result?.content ? { result: result.content } : {}),
          status: result?.revoked
            ? ('rejected' as const)
            : result?.content
              ? ('accepted' as const)
              : ('pending' as const),
        }
      })
      const node: TimelineNode = {
        id: row.id,
        rootChatId,
        sourceChatId: relation === 'child_return' ? (link?.sourceChatId ?? chatId) : chatId,
        sourceMessageId: row.id,
        kind,
        actor,
        ...(target ? { target } : {}),
        direction,
        visibility: 'conversation',
        content: parsed.content ?? '',
        ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
        ...(senseCalls.length > 0 ? { toolCalls: senseCalls } : {}),
        ...(link?.relatedMessageId ? { causationId: link.relatedMessageId } : {}),
        ...(link?.spawnId ? { parentNodeId: link.spawnId } : {}),
        createdAt: row.created_at,
        updatedAt: row.created_at,
        status: row.revoked === 1 ? 'revoked' : 'committed',
      }
      allNodes.push(node)
    }
  }
  allNodes.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  const nodes =
    view === 'conversation'
      ? allNodes.filter((node) => node.visibility === 'conversation')
      : allNodes
  const eventSeq = getChatEvents(rootChatId, Number.MAX_SAFE_INTEGER).latestSeq
  return {
    rootChatId,
    view,
    revision: getTimelineRevision(rootChatId),
    nodes,
    capturedEventSeq: eventSeq,
  }
}

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

  const chat = getChat(data.chatId)
  if (!chat) throw new Error('这个会话不见了')
  const agent = await ensureChat(data.chatId)
  const running = agent.isRunning()
  const pending = getPendingChatInputs(data.chatId)
  if (pending.length >= 16) throw new UserInputQueueFullError()

  const inputId = randomUUID()
  const messageId = randomUUID()
  const runId = getActiveChatRunId(data.chatId) ?? ctx.requestId ?? randomUUID()
  const acceptedAt = Date.now()
  const queueSequence = pending.length + 1
  const prompt = attachmentsToPromptMarkers(data.attachments, data.content)
  const entry = agent.enqueueInput(prompt, {
    inputId,
    messageId,
    clientMessageId: data.clientMessageId,
    commandId: data.commandId,
  })
  if (!entry) throw new Error('输入内容不能为空')

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
      state: response.state,
      queueSequence,
    },
    { chatId: data.chatId, runId },
  )
  inputUpdated.seq = appendChatEvent(
    data.chatId,
    inputUpdated as unknown as Record<string, unknown>,
  )
  for (const ws of connectionManager.getChatOutputs(data.chatId)) {
    if (ws.readyState !== ws.OPEN) continue
    for (const routed of connectionManager.prepareSessionEvent(ws, inputUpdated)) {
      try {
        ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
      } catch (err) {
        logger.event('chat.input.submit.ack_output_failed', { message: (err as Error).message })
      }
    }
  }

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
      )
      for await (const item of generator) {
        const event = item as Chunk | Notification
        if (event.chatId)
          event.seq = appendChatEvent(event.chatId, event as unknown as Record<string, unknown>)
        for (const ws of connectionManager.getChatOutputs(data.chatId)) {
          if (ws.readyState !== ws.OPEN) continue
          for (const routed of connectionManager.prepareSessionEvent(ws, event)) {
            try {
              ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
            } catch (err) {
              logger.event('chat.input.submit.output_failed', { message: (err as Error).message })
            }
          }
        }
      }
    } catch (err) {
      logger.event('chat.input.submit.run_failed', {
        chatId: data.chatId,
        message: (err as Error).message,
      })
    }
  })()

  return response
}

/** V2 authoritative timeline snapshot. The frontend receives complete messages only. */
export async function handleChatTimelineGet(
  _ctx: HandlerContext,
  data: ChatTimelineGetRequestData,
): Promise<ChatTimelineGetResponseData> {
  const requestedChatId = data.chatId ?? data.rootChatId
  if (!requestedChatId) throw new Error('缺少 chatId/rootChatId')
  if (!getChat(requestedChatId)) throw new Error('这个会话不见了')
  if (data.rootChatId) {
    const rootTimeline = buildRootTimeline(data.rootChatId, data.view ?? 'conversation')
    logger.event('chat.rootTimeline.get', {
      rootChatId: data.rootChatId,
      view: data.view ?? 'conversation',
      revision: rootTimeline.revision,
      count: rootTimeline.nodes.length,
    })
    return {
      chatId: data.rootChatId,
      revision: rootTimeline.revision,
      messages: [],
      rootTimeline,
    }
  }
  const revision = getTimelineRevision(requestedChatId)
  let messages = buildCanonicalTimeline(requestedChatId)
  const cursor = data.before ? decodeTimelineCursor(data.before) : undefined
  if (data.before && !cursor) throw new Error('历史分页游标无效')
  if (cursor) {
    messages = messages.filter(
      (m) =>
        m.createdAt < cursor.createdAt || (m.createdAt === cursor.createdAt && m.id < cursor.id),
    )
  }
  const limit = data.limit ?? 500
  const hasMore = messages.length > limit
  if (hasMore) messages = messages.slice(messages.length - limit)
  const oldest = messages[0]
  logger.event('chat.timeline.get', {
    chatId: requestedChatId,
    revision,
    count: messages.length,
    hasMore,
  })
  return {
    chatId: requestedChatId,
    revision,
    messages,
    ...(hasMore && oldest
      ? { nextCursor: encodeTimelineCursor({ createdAt: oldest.createdAt, id: oldest.id }) }
      : {}),
  }
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

function buildActiveTurns(chatId: string): ActiveTurnSnapshot[] {
  if (!isChatRunning(chatId)) return []
  const activeRunId = getActiveChatRunId(chatId)
  const turns = new Map<string, ActiveTurnSnapshot>()
  for (const event of getRecentChatEvents(chatId, 2000)) {
    const e = event as Record<string, unknown>
    const runId = typeof e.runId === 'string' ? e.runId : undefined
    const data = (e.data ?? {}) as Record<string, unknown>
    if (e.kind === 'chunk' && e.type === 'stream' && typeof data.msgId === 'string') {
      if (activeRunId && runId && runId !== activeRunId) continue
      const id = data.msgId
      const current = turns.get(id) ?? {
        turnId: id,
        messageId: id,
        ...(runId ? { runId } : {}),
        thinking: '',
        content: '',
        thinkingOffset: 0,
        contentOffset: 0,
        nextThinkingOffset: 0,
        nextContentOffset: 0,
        createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
      }
      if (typeof data.thinking === 'string') {
        current.thinking += data.thinking
        current.thinkingOffset = current.thinking.length
        current.nextThinkingOffset = current.thinkingOffset
      }
      if (typeof data.content === 'string') {
        current.content += data.content
        current.contentOffset = current.content.length
        current.nextContentOffset = current.contentOffset
      }
      turns.set(id, current)
    }
    if (e.kind === 'chunk' && e.type === 'staged' && typeof data.msgId === 'string') {
      if (data.type === 'content_end' || data.type === 'sense_end') turns.delete(data.msgId)
    }
    if (e.kind === 'notification' && (e.type === 'done' || e.type === 'error')) {
      const terminalRun = runId
      for (const [id, turn] of turns) {
        if (!terminalRun || !turn.runId || turn.runId === terminalRun) turns.delete(id)
      }
    }
  }
  return [...turns.values()]
}

/** V2 atomic session open: register subscription, capture event boundary, then hydrate state. */
export async function handleChatOpen(
  ctx: HandlerContext,
  data: ChatOpenRequestData,
): Promise<ChatOpenResponseData> {
  if (!getChat(data.chatId)) throw new Error('这个会话不见了')
  const subscriptionId = connectionManager.beginSessionOpen(data.chatId, ctx.connectionId)
  try {
    // Recreate the runtime before taking the session boundary. This restores
    // durable accepted inputs after a process restart and lets the snapshot
    // expose the same queue the runner will consume.
    await ensureChat(data.chatId)
    // getChatEvents is synchronous; registration and boundary capture therefore execute
    // without an await gap, while outgoing events are fenced by ConnectionManager.
    const page = getChatEvents(data.chatId, Number.MAX_SAFE_INTEGER)
    const eventSeq = page.latestSeq
    const timelineRevision = getTimelineRevision(data.chatId)
    connectionManager.setSessionBoundary(subscriptionId, eventSeq)
    const currentState = computeCurrentState(data.chatId)
    const questionSnapshot = getQuestionStateSnapshot(data.chatId)
    const pendingInputs = getPendingChatInputs(data.chatId).map((entry, index) => ({
      inputId: entry.inputId ?? `queued-${data.chatId}-${index}`,
      ...(entry.clientMessageId ? { clientMessageId: entry.clientMessageId } : {}),
      ...(entry.messageId ? { messageId: entry.messageId } : {}),
      content: entry.content,
      createdAt: entry.time,
      state: 'queued' as const,
    }))
    const runId = getActiveChatRunId(data.chatId)
    const roles = listOpenSpawnTasks(data.chatId).map((task) => ({
      taskId: task.taskId,
      chatId: task.childChatId,
      parentChatId: task.parentChatId,
      type: task.type,
      state: task.status,
    }))
    const snapshot: ChatOpenResponseData = {
      chatId: data.chatId,
      subscriptionId,
      eventSeq,
      timelineRevision,
      timelineChanged: data.knownTimelineRevision !== timelineRevision,
      state: {
        ...(runId ? { run: { runId, state: 'running' as const } } : {}),
        pendingInputs,
        activeTurns: buildActiveTurns(data.chatId),
        ...(currentState.pendingApproval ? { pendingApproval: currentState.pendingApproval } : {}),
        questionBatches: questionSnapshot.pendingQuestionBatches,
        runningTools: currentState.runningTools,
        roles,
      },
    }
    connectionManager.finishSessionOpen(subscriptionId)
    logger.event('chat.open', { chatId: data.chatId, subscriptionId, eventSeq })
    if (!runId && pendingInputs.length > 0) {
      const prompt = pendingInputs[0]!.content
      const resumedRunId = randomUUID()
      void (async () => {
        try {
          const generator = handleChatSend(
            { ...ctx, requestId: resumedRunId },
            { chatId: data.chatId, prompt, inputAlreadyQueued: true },
          )
          for await (const item of generator) {
            const event = item as Chunk | Notification
            if (event.chatId) {
              event.seq = appendChatEvent(event.chatId, event as unknown as Record<string, unknown>)
            }
            for (const ws of connectionManager.getChatOutputs(data.chatId)) {
              if (ws.readyState !== ws.OPEN) continue
              for (const routed of connectionManager.prepareSessionEvent(ws, event)) {
                try {
                  ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
                } catch (error) {
                  logger.event('chat.open.resume_output_failed', {
                    message: (error as Error).message,
                  })
                }
              }
            }
          }
        } catch (error) {
          logger.event('chat.open.resume_failed', {
            chatId: data.chatId,
            message: (error as Error).message,
          })
        }
      })()
    }
    return snapshot
  } catch (error) {
    connectionManager.closeSession(subscriptionId)
    throw error
  }
}

export async function handleChatClose(
  ctx: HandlerContext,
  data: ChatCloseRequestData,
): Promise<ChatCloseResponseData> {
  const sub = connectionManager.getSessionSubscription(data.subscriptionId)
  if (!sub || sub.connectionId !== ctx.connectionId) {
    return { subscriptionId: data.subscriptionId, closed: false }
  }
  const closed = connectionManager.closeSession(data.subscriptionId)
  logger.event('chat.close', { chatId: closed?.chatId, subscriptionId: data.subscriptionId })
  return {
    subscriptionId: data.subscriptionId,
    ...(closed ? { chatId: closed.chatId } : {}),
    closed: true,
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
  router.register(Method.CHAT_TIMELINE_GET, handleChatTimelineGet)
  router.register(Method.CHAT_INPUT_SUBMIT, handleChatInputSubmit)
  router.register(Method.CHAT_SYNC, handleChatSync)
  router.register(Method.CHAT_OPEN, handleChatOpen)
  router.register(Method.CHAT_CLOSE, handleChatClose)
  router.register(Method.CHAT_START_SPAWN, handleChatStartSpawn)
  router.register(Method.CHAT_DELETE, handleChatDelete)
  router.register(Method.CHAT_CONTEXT_USAGE, handleChatContextUsage)
  registerPromptSnapshotHandler(router)
  router.register(Method.CHAT_ATTACH, handleChatAttach)
}
