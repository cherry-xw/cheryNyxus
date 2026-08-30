import type { HandlerContext } from '../message/router.js'
import {
  createChunk,
  createNotification,
  ErrorCode,
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
  type ExecutionEdgeFact,
  type GraphToolCall,
  type ActiveRunFact,
  type RootTimelineSnapshot,
  type ChatSessionSnapshotData,
  type ChatStartSpawnRequestData,
  type ChatStartSpawnResponseData,
  type ChatInputSubmitRequestData,
  type ChatInputSubmitResponseData,
  type ChatStopChildRequestData,
  type ChatStopChildResponseData,
  type ChatSendToChildRequestData,
  type ChatSendToChildResponseData,
  type Response as RpcResponse,
} from '../message/types.js'
import { InternalCommand } from '../message/internalCommand.js'
import {
  createChat,
  listAllChats,
  listRootChatsForPresets,
  listChatTrees,
  getChat,
  deleteChat,
  getMessages,
  getMessageLinksForRoot,
  getChildReturnMessageIds,
  upsertMessageLink,
  collectDescendantsChatIds,
  getLastMessage,
  updateChatMetadata,
  parseMessageRow,
  findChatsByParent,
  getChatPreviews,
  getChatWorkspace,
  getChatPreset,
  getChatRuntimeSelection,
  getTimelineRevision,
  bumpTimelineRevision,
  getRootChatId,
  addPendingInput,
  listPendingInputs,
} from '@/db/chat.js'
import {
  getExecutionActiveRun,
  listExecutionEdges,
  listExecutionNodes,
  listLatestExecutionRuns,
  removeExecutionEdge,
  upsertExecutionEdge,
  upsertExecutionNode,
  upsertToolCallOwner,
} from '@/db/executionGraph.js'
import {
  clearChatRuntime,
  ensureChat,
  isChatRunning,
  getActiveChatRunId,
  getPendingChatInputs,
  getChatSelection,
} from './runtime.js'
import { connectionManager } from '../websocket/connection.js'
import { disconnectGrace } from '../websocket/disconnectGrace.js'
import { getPendingQuestionAttention, getQuestionStateSnapshot } from '@/db/question.js'
import { listBranchFamilyChatIds } from '@/db/conversationBranch.js'
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
import { CHERY_NYXUS_NAME } from '@/utils/lockedRole.js'
import {
  getChatEvents,
  getRecentChatEvents,
  getSpawnTask,
  claimSpawnTask,
  abandonSpawnTask,
  finishSpawnTask,
  getSpawnTaskByChild,
  setSpawnTaskOwnership,
  listOpenSpawnTasks,
  appendChatEvent,
  prepareChatEventForDelivery,
  getRootEvents,
  abandonRequest,
  claimRequest,
  completeRequest,
} from '@/db/delivery.js'
import { resolveRoleAvatar } from '@/utils/roleAvatar.js'
import { handleChatResume, handleChatSend, attachmentsToPromptMarkers } from './send.js'
import { getLiveTurns } from './liveTurns.js'
import { computeCanResume } from './canResume.js'
import { computeCurrentState, limitExecutionSteps } from './currentState.js'
import { transport } from '../websocket/transport.js'
import { approvalManager } from '../approval/manager.js'
import { UserInputQueueFullError } from '@/core/middleware/messageJournal.js'
import {
  assertRootControlsChild,
  childAgentControlState,
  childDispatchOutcome,
} from './childControl.js'
import { recordDispatchFact } from './executionFacts.js'
import { emitTimelinePatch } from './rootGraphPatch.js'
import {
  computeGenerations,
  generationWindowFloor,
  handleChatTimelineGenerationGet,
} from './generations.js'
import { handleChatTimelineNodeGet } from './nodeDetail.js'
import { handleChatResumeTree, toTreeControlState } from './treeControl.js'
import { getActiveChatEpoch, getChatEpochStats } from '@/db/epoch.js'
import { clearWaitedChild, clearWaitedChildrenByParent } from '@/agent/spawnBroker.js'
import { abandonChatSubtree } from '@/service/config/roleLifecycle.js'
import {
  getConversationBranchByChat,
  getConversationTask,
  listConversationBranches,
} from '@/db/conversationBranch.js'
import { markActiveTreeTargetDelegated } from '@/db/treeControl.js'
import { buildTreeInterruptionNotice } from './treeInterruption.js'

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
  const isFixedNyxus = p.preset === CHERY_NYXUS_NAME
  // cheryNyxus 仍是固定主角色（不可作子实例），但不再全局唯一：允许多个 root 会话，
  // 以规避单会话 LLM 上下文上限（compact 遗忘）。每次 chat.create 都新建一条，用随机 chatId。
  if (isFixedNyxus && p.parentChatId) {
    throw new Error('cheryNyxus 是固定主角色，不能创建为子实例')
  }
  const chatId = p.chatId || randomUUID()

  let selection: RuntimeSelection
  const metadata: Record<string, unknown> = {}
  if (p.preset) {
    // 预设路径：解析编制快照 + 记 preset 名 + spawn roster（选中子 agent type 列表）+ prompt 路径
    const resolved = resolvePresetSelection(p.preset)
    selection = resolved.selection
    // 空白复用（默认启用，skipBlankReuse 显式关闭）：预设路径 + 主 chat + 未显式指定 chatId 时，
    // 命中同预设 turnCount===0（无任何 user 消息）的最近 root 会话即直接返回其 chatId——
    // 不新建 DB 行、不 ensureChat，前端「新建会话」入口据此天然去重。
    // runtime 字段回显该会话持久化的 metadata.runtime（缺失时回退本次解析值）。
    if (!p.skipBlankReuse && !p.parentChatId && !p.chatId) {
      const reusedChat = findBlankPresetRootChat(p.preset)
      if (reusedChat) {
        const reusedMeta = reusedChat.metadata
          ? (safeJsonParse(reusedChat.metadata, {}) as {
              presetId?: string
              runtime?: { brain?: string; senseGroup?: string; mcpServers?: string[] }
            })
          : {}
        const workspace = getChatWorkspace(reusedChat.id)
        logger.event('chat.create', { chatId: reusedChat.id, preset: p.preset, reused: true })
        return {
          chatId: reusedChat.id,
          ...(typeof reusedMeta.presetId === 'string'
            ? { presetId: reusedMeta.presetId }
            : { presetId: resolved.presetId }),
          brain: reusedMeta.runtime?.brain ?? selection.brain,
          senseGroup: reusedMeta.runtime?.senseGroup ?? selection.senseGroup,
          mcpServers: reusedMeta.runtime?.mcpServers ?? [...selection.mcpServers],
          reused: true,
          ...(workspace ? { workspace, workspaceValid: validateWorkspacePath(workspace).valid } : {}),
        }
      }
    }
    metadata.preset = p.preset
    metadata.presetId = resolved.presetId
    // leader 角色稳定身份快照（getChatType ID 优先反查当前名，角色改名不影响历史主 chat 身份）。
    // 注意：不写 metadata.type —— type 是子 chat（spawn_role 创建）的判定标记。
    metadata.roleId = resolved.leaderId
    metadata.lastUserActivityAt = Date.now()
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
    ...(typeof metadata.presetId === 'string' ? { presetId: metadata.presetId } : {}),
    brain: selection.brain,
    senseGroup: selection.senseGroup,
    mcpServers: selection.mcpServers,
    ...(workspace ? { workspace, workspaceValid } : {}),
  }
}

/**
 * 空白复用：查同预设 root 会话中无任何 user 消息（turnCount===0）者，取最近更新的一条。
 * 复用 listRootChatsForPresets（updated_at DESC）+ getChatPreviews（user 消息计数），
 * turnCount 口径与 chat.list includePreview 完全一致；presetId/preset 双字段关联与
 * handleChatList 的 stage 归属判定同源（覆盖预设改名与旧 name-only 数据）。
 */
function findBlankPresetRootChat(preset: string): ReturnType<typeof listRootChatsForPresets>[number] | undefined {
  const presetId = config.presets?.[preset]?.id
  const association = presetId ? { presetId, preset } : { preset }
  const roots = listRootChatsForPresets([association])
  const previews = getChatPreviews(roots)
  return roots.find((chat) => previews.get(chat.id)?.turnCount === 0)
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

/** 构建 chat.get/chat.sync 共用的只读会话快照；历史 runtime 仅回显，不做解析或校验。 */
function buildChatSessionSnapshot(chatId: string): ChatSessionSnapshotData {
  const chat = getChat(chatId)
  if (!chat) throw new Error('这个会话不见了')
  const metadata = chat.metadata ? (safeJsonParse(chat.metadata, {}) as { preset?: string }) : {}
  const workspace = getChatWorkspace(chatId)
  const workspaceValid = workspace ? validateWorkspacePath(workspace).valid : undefined
  const runtime = getChatRuntimeSelection(chatId)
  // preset 显示名 ID 优先反查（getChatPreset：presetId -> 当前名，旧数据回退 metadata.preset），
  // 预设改名后历史会话快照显示新名而非 stale 旧名。
  const presetName = getChatPreset(chatId) ?? metadata.preset
  return {
    ...(runtime ? { runtime } : {}),
    ...(presetName ? { preset: presetName } : {}),
    canResume: computeCanResume(chatId),
    currentState: computeCurrentState(chatId),
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
  const rootMeta = (chat: ReturnType<typeof listRootChatsForPresets>[number]) =>
    chat.metadata
      ? (safeJsonParse(chat.metadata, {}) as { preset?: string; presetId?: string })
      : {}
  let rows: ReturnType<typeof listAllChats>
  if (data.scope === 'history') {
    rows = listAllChats()
  } else {
    const associations =
      data.scope === 'preset'
        ? [{ presetId: data.presetId, preset: data.preset }]
        : Object.entries(config.presets ?? {}).map(([preset, value]) => ({
            presetId: value.id,
            preset,
          }))
    const matchingRoots = listRootChatsForPresets(associations)
    if (data.scope === 'stage') {
      const latestByPreset = new Map<string, (typeof matchingRoots)[number]>()
      for (const chat of matchingRoots) {
        const meta = rootMeta(chat)
        const association = meta.presetId
          ? associations.find((candidate) => candidate.presetId === meta.presetId)
          : associations.find((candidate) => candidate.preset === meta.preset)
        if (!association) continue
        // A legacy name-only root and a newer stable-id root can belong to the
        // same current preset. Normalize both before choosing the newest root.
        const key = association.presetId
          ? `id:${association.presetId}`
          : `name:${association.preset}`
        if (!latestByPreset.has(key)) latestByPreset.set(key, chat)
      }
      rows = listChatTrees([...latestByPreset.values()].map((chat) => chat.id))
    } else {
      rows = listChatTrees(matchingRoots.map((chat) => chat.id))
    }
  }
  const previews = data.includePreview ? getChatPreviews(rows) : undefined

  // preset 显示名 ID 优先反查（一次性映射免 N+1）：presetId -> 当前名；旧数据/预设已删回退 metadata.preset 旧名。
  const presetNameById = new Map(
    Object.entries(config.presets ?? {}).map(([name, preset]) => [preset.id, name] as const),
  )

  const chats = rows.map((chat) => {
    const epochStats = getChatEpochStats(chat.id)
    const conversationBranch = getConversationBranchByChat(chat.id)
    const meta = chat.metadata
      ? (safeJsonParse(chat.metadata, {}) as {
          finished?: boolean
          wake?: 'immediate' | 'deferred' | 'barrier'
          resumePending?: boolean
          preset?: string
          presetId?: string
          lastUserActivityAt?: number
          type?: string
        })
      : {}
    // 兼容旧数据：历史终态异常可能已经完成 spawn task 并回传父会话，
    // 但尚未写入 metadata.finished。任务终态同样是子 agent 已结束的权威事实。
    const spawnTask = chat.parent_chat_id ? getSpawnTaskByChild(chat.id) : undefined
    const finished =
      meta.finished === true ||
      spawnTask?.status === 'finished' ||
      spawnTask?.status === 'timed_out'
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
    const pendingQuestions = getPendingQuestionAttention(chat.id)
    const lifecycle = chat.lifecycle ?? 'active'
    const base = {
      chatId: chat.id,
      createdAt: chat.created_at,
      updatedAt: chat.updated_at,
      messageCount: chat.message_count,
      parentChatId: chat.parent_chat_id ?? null,
      ...(lifecycle === 'active' ? epochStats : { epochCount: epochStats.epochCount }),
      lifecycle,
      ...(conversationBranch
        ? {
            taskId: conversationBranch.taskId,
            branchId: conversationBranch.branchId,
            branchKind: conversationBranch.kind,
          }
        : {}),
      finished,
      running,
      wake,
      resumePending,
      canResume,
      // pendingApproval：approvalManager 内存索引派生（轻量，免 hydration），供会话列表「琴键」闪烁。
      // 与 currentState.pendingApproval（computeCurrentState 扫事件，单 chat 已 hydration）同为 approval 生命周期。
      pendingApproval: approvalManager.getForChat(chat.id) ?? null,
      // 目录只携带计数与裁剪后的问题标题；完整选项在打开对应根会话后按需取得。
      pendingQuestionCount: pendingQuestions.length,
      pendingQuestions,
      preset:
        (typeof meta.presetId === 'string' ? presetNameById.get(meta.presetId) : undefined) ??
        (typeof meta.preset === 'string' ? meta.preset : undefined),
      presetId:
        typeof meta.presetId === 'string'
          ? meta.presetId
          : typeof meta.preset === 'string'
            ? config.presets?.[meta.preset]?.id
            : undefined,
      lastUserActivityAt:
        typeof meta.lastUserActivityAt === 'number' ? meta.lastUserActivityAt : undefined,
      agentType: typeof meta.type === 'string' ? meta.type : undefined,
      avatar:
        typeof meta.type === 'string'
          ? resolveRoleAvatar(meta.type, config.roles?.[meta.type]?.avatar)
          : undefined,
      ...(workspace ? { workspace, workspaceValid } : {}),
    }
    if (!data.includePreview || !previews) return base
    const p = previews.get(chat.id)
    return {
      ...base,
      preview: p?.preview ?? '',
      turnCount: p?.turnCount ?? 0,
    }
  })

  logger.event('chat.list', {
    count: chats.length,
    scope: data.scope,
    includePreview: !!data.includePreview,
  })
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
  // child_return 链接的消息（wakeParent 注入的子返回/超时）-> 标 childReturn，
  // 前端 canonicalToChatMessage 据此设 mergedView=child-to-master 从主轴过滤（与 live 一致）。
  const childReturnIds = getChildReturnMessageIds(chatId)
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
      ...(childReturnIds.has(row.id) ? { childReturn: true } : {}),
    }
  })
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
  const chatMeta = new Map<string, { type?: string; parent?: string; spawnCallId?: string }>()
  const childByType = new Map<string, string[]>()
  const childBySpawnCall = new Map<string, string[]>()
  const messagesByChat = new Map(chatIds.map((chatId) => [chatId, getMessages(chatId)]))
  const runtimeByMessageId = new Map<string, RuntimeSelection>()
  for (const chatId of chatIds) {
    const chat = getChat(chatId)
    const metadata = chat?.metadata
      ? (safeJsonParse(chat.metadata, {}) as Record<string, unknown>)
      : {}
    chatMeta.set(chatId, {
      type: typeof metadata.type === 'string' ? metadata.type : undefined,
      parent: chat?.parent_chat_id ?? undefined,
      spawnCallId:
        typeof metadata.spawnSenseCallId === 'string' ? metadata.spawnSenseCallId : undefined,
    })
    if (chatId !== rootChatId) {
      const type = chatMeta.get(chatId)?.type
      if (type) childByType.set(type, [...(childByType.get(type) ?? []), chatId])
      const spawnCallId = chatMeta.get(chatId)?.spawnCallId
      if (spawnCallId) {
        childBySpawnCall.set(spawnCallId, [...(childBySpawnCall.get(spawnCallId) ?? []), chatId])
      }
    }
    let lastUserRuntime: RuntimeSelection | undefined
    for (const row of messagesByChat.get(chatId) ?? []) {
      const parsed = parseMessageRow(row)
      if (parsed.role === 'user' && parsed.runtime) lastUserRuntime = parsed.runtime
      const runtime =
        parsed.role === 'user'
          ? parsed.runtime
          : parsed.role === 'assistant'
            ? lastUserRuntime
            : undefined
      if (runtime) runtimeByMessageId.set(row.id, runtime)
    }
  }
  const actorForAgent = (chatId: string): TimelineActor => ({
    kind: 'agent',
    chatId,
    ...(chatMeta.get(chatId)?.type ? { roleType: chatMeta.get(chatId)!.type } : {}),
  })

  type Candidate = {
    node: Omit<TimelineNode, 'orderKey'>
    branchChatId: string
    rank: number
    relation: string
  }
  const candidates: Candidate[] = []
  for (const chatId of chatIds) {
    const rows = messagesByChat.get(chatId) ?? []
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
      const runtime =
        runtimeByMessageId.get(row.id) ??
        (link?.relation === 'child_return' && link.relatedMessageId
          ? runtimeByMessageId.get(link.relatedMessageId)
          : undefined)
      const relation =
        link?.relation ??
        (child
          ? row.role === 'user'
            ? 'child_input'
            : 'child_output'
          : row.role === 'user'
            ? 'root_input'
            : 'agent_output')
      if (row.role === 'sense') continue
      let actor: TimelineActor
      let target: TimelineActor | undefined
      let direction: TimelineNode['direction']
      let kind: TimelineNode['kind'] = 'message'
      if (relation === 'root_input') {
        actor = { kind: 'user', actorId: 'human' }
        target = actorForAgent(rootChatId)
        direction = 'user-to-agent'
      } else if (relation === 'system') {
        actor = { kind: 'system' }
        target = actorForAgent(rootChatId)
        direction = 'internal'
        kind = 'system'
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
      const senseCalls: GraphToolCall[] = (parsed.senseCall ?? [])
        .map((call, fallbackIndex) => {
          const result = rows.find((candidate) => candidate.id === call.id)
          const childMatches = childBySpawnCall.get(call.id) ?? []
          return {
            callId: call.id,
            index: call.index ?? fallbackIndex,
            name: call.name ?? '',
            arguments: call.arguments,
            ...(result ? { result: result.content ?? '' } : {}),
            ...(childMatches.length === 1 ? { childChatId: childMatches[0] } : {}),
            status:
              result?.revoked || result?.content?.startsWith('被拒绝:')
                ? ('rejected' as const)
                : result?.content?.startsWith('感官执行失败：')
                  ? ('error' as const)
                  : result
                    ? ('completed' as const)
                    : ('pending' as const),
          }
        })
        .sort((a, b) => a.index - b.index || a.callId.localeCompare(b.callId))
      const node: Omit<TimelineNode, 'orderKey'> = {
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
        ...(runtime ? { runtime } : {}),
        ...(senseCalls.length > 0 ? { toolCalls: senseCalls } : {}),
        ...(link?.causationNodeId ? { causationId: link.causationNodeId } : {}),
        createdAt: row.created_at,
        updatedAt: row.created_at,
        status: row.revoked === 1 ? 'revoked' : 'committed',
      }
      candidates.push({ node, branchChatId: chatId, rank: 0, relation })
      if (senseCalls.length > 0) {
        candidates.push({
          node: {
            id: `batch:${row.id}`,
            rootChatId,
            sourceChatId: chatId,
            sourceMessageId: row.id,
            kind: 'tool-batch',
            actor,
            ...(target ? { target } : {}),
            direction: 'internal',
            visibility: 'detail',
            content: '',
            toolCalls: senseCalls,
            batchId: `batch:${row.id}`,
            createdAt: row.created_at,
            updatedAt: row.created_at,
            status: row.revoked === 1 ? 'revoked' : 'committed',
          },
          branchChatId: chatId,
          rank: 1,
          relation: 'tool_batch',
        })
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.node.createdAt - b.node.createdAt ||
      a.node.sourceMessageId!.localeCompare(b.node.sourceMessageId!) ||
      a.rank - b.rank,
  )
  const persistedById = new Map<string, TimelineNode>()
  // 回填改图检测：懒回填（spawn 边/return-continuation 等）不经消息写路径，不会自然推进
  // timeline_revision。图变更必须 bump（见返回前），否则客户端同 revision 丢弃增量 patch，
  // knownRevision 短路会冻结残缺快照（不变量：图变更 ⇒ revision 前进）。
  const nodeIdsBefore = new Set(listExecutionNodes(rootChatId).map((node) => node.id))
  let graphMutated = false
  for (const candidate of candidates) {
    const persisted = upsertExecutionNode(candidate.node) as unknown as TimelineNode
    if (!nodeIdsBefore.has(persisted.id)) graphMutated = true
    persistedById.set(persisted.id, persisted)
    if (persisted.kind === 'tool-batch') {
      for (const call of persisted.toolCalls ?? []) {
        upsertToolCallOwner({
          callId: call.callId,
          rootChatId,
          owningNodeId: persisted.id,
          batchId: persisted.batchId,
          index: call.index,
          resolution: 'owned',
        })
      }
    }
  }

  // Mark unresolved legacy IDs explicitly. A task id and a call id are not the
  // same identity space, so no edge is fabricated when ownership is unknown.
  for (const link of links.values()) {
    const legacyCallId = link.spawnCallId ?? link.spawnId
    if (!legacyCallId || persistedById.has(legacyCallId)) continue
    const owned = candidates.some((candidate) =>
      candidate.node.toolCalls?.some((call) => call.callId === legacyCallId),
    )
    if (!owned) {
      upsertToolCallOwner({
        callId: legacyCallId,
        rootChatId,
        resolution: 'unknown',
        detail: 'legacy spawn id has no unique owning tool batch',
      })
    }
  }

  const branchCandidates = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const list = branchCandidates.get(candidate.branchChatId) ?? []
    list.push(candidate)
    branchCandidates.set(candidate.branchChatId, list)
  }
  const storedNodesBeforeEdges = listExecutionNodes(rootChatId) as unknown as Array<
    TimelineNode & { targetChatId?: string; callId?: string }
  >
  const storedNodeById = new Map(storedNodesBeforeEdges.map((node) => [node.id, node]))
  const existingEdgesBefore = listExecutionEdges(rootChatId) as unknown as ExecutionEdgeFact[]
  const edgeInputs: Array<Omit<ExecutionEdgeFact, 'orderKey'>> = []
  const addEdge = (
    kind: ExecutionEdgeFact['kind'],
    fromNodeId: string,
    toNodeId: string,
    sourceChatId: string,
    targetChatId: string,
    callId?: string,
  ): void => {
    if (fromNodeId === toNodeId) return
    edgeInputs.push({
      id: `edge:${kind}:${fromNodeId}:${toNodeId}`,
      rootChatId,
      fromNodeId,
      toNodeId,
      kind,
      sourceChatId,
      targetChatId,
      ...(callId ? { callId } : {}),
    })
  }

  for (const [branchChatId, branch] of branchCandidates) {
    branch.sort(
      (a, b) => persistedById.get(a.node.id)!.orderKey - persistedById.get(b.node.id)!.orderKey,
    )
    // Return nodes describe cross-branch delivery. They are not turns on the
    // parent's ordinary sequence, otherwise sibling returns become chained and
    // a spawn batch can "continue" into a child return instead of its parent.
    const sequenceBranch = branch.filter(
      (candidate) => persistedById.get(candidate.node.id)!.kind !== 'return',
    )
    for (let index = 1; index < sequenceBranch.length; index += 1) {
      const previous = persistedById.get(sequenceBranch[index - 1]!.node.id)!
      const current = persistedById.get(sequenceBranch[index]!.node.id)!
      const spawnBatch =
        previous.kind === 'tool-batch' &&
        previous.toolCalls?.some((call) => typeof call.childChatId === 'string')
      addEdge(
        spawnBatch ? 'continue' : 'sequence',
        previous.id,
        current.id,
        branchChatId,
        branchChatId,
      )
    }
  }

  for (const candidate of candidates) {
    const node = persistedById.get(candidate.node.id)!
    if (node.kind === 'tool-batch') {
      for (const call of node.toolCalls ?? []) {
        if (!call.childChatId) continue
        if (
          existingEdgesBefore.some(
            (edge) =>
              edge.kind === 'spawn' && edge.fromNodeId === node.id && edge.callId === call.callId,
          )
        )
          continue
        const spawnTarget = storedNodesBeforeEdges.find(
          (stored) =>
            stored.id.startsWith('spawn-target:') &&
            stored.targetChatId === call.childChatId &&
            stored.callId === call.callId,
        )
        const firstChild = (branchCandidates.get(call.childChatId) ?? []).find(
          (childCandidate) => persistedById.get(childCandidate.node.id)!.kind !== 'return',
        )
        const targetNodeId = spawnTarget?.id ?? firstChild?.node.id
        if (targetNodeId) {
          addEdge(
            'spawn',
            node.id,
            targetNodeId,
            candidate.branchChatId,
            call.childChatId,
            call.callId,
          )
          const task = getSpawnTaskByChild(call.childChatId)
          if (task) setSpawnTaskOwnership(task.taskId, call.callId, node.id)
        }
      }
    }
    if (node.kind === 'return') {
      const link = node.sourceMessageId ? links.get(node.sourceMessageId) : undefined
      const childBranch = branchCandidates.get(node.sourceChatId) ?? []
      const explicit = link?.causationNodeId
        ? storedNodeById.get(link.causationNodeId)
        : link?.relatedMessageId
          ? persistedById.get(link.relatedMessageId)
          : undefined
      const childTerminal =
        explicit ??
        childBranch
          .map((item) => persistedById.get(item.node.id)!)
          .filter(
            (item) =>
              item.orderKey < node.orderKey && item.kind !== 'tool-batch' && item.kind !== 'return',
          )
          .at(-1)
      if (childTerminal) {
        addEdge('return', childTerminal.id, node.id, node.sourceChatId, candidate.branchChatId)
      }
      const parentBranch = branchCandidates.get(candidate.branchChatId) ?? []
      const continuation = parentBranch
        .map((item) => persistedById.get(item.node.id)!)
        .find((item) => item.orderKey > node.orderKey && item.kind !== 'return')
      if (continuation) {
        addEdge(
          'return-continuation',
          node.id,
          continuation.id,
          node.sourceChatId,
          candidate.branchChatId,
        )
      }
    }
  }
  for (const spawnTarget of storedNodesBeforeEdges) {
    if (!spawnTarget.id.startsWith('spawn-target:') || !spawnTarget.targetChatId) continue
    const firstChild = (branchCandidates.get(spawnTarget.targetChatId) ?? []).find(
      (candidate) => persistedById.get(candidate.node.id)!.kind !== 'return',
    )
    if (firstChild) {
      addEdge(
        'sequence',
        spawnTarget.id,
        firstChild.node.id,
        spawnTarget.sourceChatId,
        spawnTarget.targetChatId,
      )
    }
  }
  const desiredGeneratedEdgeIds = new Set(edgeInputs.map((edge) => edge.id))
  const regeneratedKinds = new Set<ExecutionEdgeFact['kind']>([
    'sequence',
    'continue',
    'return',
    'return-continuation',
  ])
  for (const edge of existingEdgesBefore) {
    const generatedId = `edge:${edge.kind}:${edge.fromNodeId}:${edge.toNodeId}`
    if (
      regeneratedKinds.has(edge.kind) &&
      edge.id === generatedId &&
      !desiredGeneratedEdgeIds.has(edge.id)
    ) {
      if (removeExecutionEdge(edge.id)) graphMutated = true
    }
  }
  const edgeIdsBefore = new Set(existingEdgesBefore.map((edge) => edge.id))
  for (const edge of edgeInputs) {
    const persistedEdge = upsertExecutionEdge(edge)
    if (!edgeIdsBefore.has(persistedEdge.id)) graphMutated = true
  }

  const allNodes = listExecutionNodes(rootChatId) as unknown as TimelineNode[]
  const allEdges = listExecutionEdges(rootChatId) as unknown as ExecutionEdgeFact[]
  // 代际窗口：默认完整展示两代（当前代 + 上一代），更早代由前端按 generations 索引
  // 经 chat.timeline.generation.get 按需拉取。窗口过滤只影响返回的 snapshot，
  // 持久层（execution_nodes/execution_edges）与上方全量重建/回填逻辑不受影响。
  const generations = computeGenerations(rootChatId)
  const windowFloor = generationWindowFloor(generations)
  const nodes = windowFloor > 0 ? allNodes.filter((node) => node.orderKey > windowFloor) : allNodes
  const knownNodeIds = new Set(nodes.map((node) => node.id))
  const edges = allEdges.filter(
    (edge) => knownNodeIds.has(edge.fromNodeId) && knownNodeIds.has(edge.toNodeId),
  )
  const pendingInputs = chatIds.flatMap((chatId) =>
    listPendingInputs(chatId).map((entry) => ({
      chatId,
      inputId: entry.input_id,
      ...(entry.client_message_id ? { clientMessageId: entry.client_message_id } : {}),
      messageId: entry.message_id,
      content: entry.content,
      createdAt: entry.accepted_at,
      state: entry.state,
      queueSequence: entry.queue_sequence,
      acceptedAt: entry.accepted_at,
    })),
  )
  const durableRuns = new Map(
    listLatestExecutionRuns(rootChatId)
      .filter((run) => chatIds.includes(run.chatId))
      .map((run) => [run.chatId, run]),
  )
  const liveRuns: ActiveRunFact[] = chatIds.flatMap((chatId) => {
    const runId = getActiveChatRunId(chatId)
    if (!runId) return []
    const turn = buildActiveTurns(chatId).find((candidate) => candidate.runId === runId)
    const nodeId = turn && persistedById.has(turn.messageId) ? turn.messageId : undefined
    const batchId = nodeId && persistedById.has(`batch:${nodeId}`) ? `batch:${nodeId}` : undefined
    return [
      {
        rootChatId,
        chatId,
        runId,
        status: 'running' as const,
        ...(turn ? { turnId: turn.turnId } : {}),
        ...(nodeId ? { nodeId } : {}),
        ...(batchId ? { batchId } : {}),
      },
    ]
  })
  for (const run of liveRuns) durableRuns.set(run.chatId, run)
  const activeRuns: ActiveRunFact[] = [...durableRuns.values()]
  const eventSeq = getRootEvents(rootChatId, Number.MAX_SAFE_INTEGER).latestSeq
  const controlState = toTreeControlState(rootChatId)
  // 本次 rebuild 实际改图（插入节点/边或删除边）：bump 必须先于下方 revision 读取，
  // 使 snapshot/patch 携带新 revision，客户端丢增量后可经全量拉取自愈。
  if (graphMutated) bumpTimelineRevision(rootChatId)
  return {
    rootChatId,
    view,
    revision: getTimelineRevision(rootChatId),
    nodes,
    edges,
    activeRuns,
    pendingInputs,
    generations,
    ...(controlState ? { controlState } : {}),
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

  try {
    const chat = getChat(data.chatId)
    if (!chat) throw new Error('这个会话不见了')
    if (chat.parent_chat_id && data.controlRootChatId !== getRootChatId(data.chatId)) {
      throw new Error('用户输入只能提交到主 Agent')
    }
    const agent = await ensureChat(data.chatId)
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
          if (event.chatId) {
            prepareChatEventForDelivery(
              event.chatId,
              event as unknown as Record<string, unknown>,
            )
          }
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
  } catch (cause) {
    // Queue/full/runtime validation failures happen after the journal claim.
    // Release that claim so a user retry with the same idempotency key can be
    // evaluated again instead of being permanently reported as active.
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

export async function handleChatSendToChild(
  _ctx: HandlerContext,
  _data: ChatSendToChildRequestData,
): Promise<ChatSendToChildResponseData> {
  throw new Error('send_to_child 只能由主 Agent 调用')
}

/** V2 authoritative timeline snapshot. The frontend receives complete messages only. */
export async function handleChatTimelineGet(
  _ctx: HandlerContext,
  data: ChatTimelineGetRequestData,
): Promise<ChatTimelineGetResponseData> {
  if (data.taskId) {
    const task = getConversationTask(data.taskId)
    if (!task) throw new Error('任务不存在')
    const branches = listConversationBranches(data.taskId)
    const snapshots = branches.map((branch) => ({
      branch,
      timeline: buildRootTimeline(branch.chatId, data.view ?? 'tree'),
    }))
    const nodes: TimelineNode[] = []
    const edges: ExecutionEdgeFact[] = []
    const activeRuns: ActiveRunFact[] = []
    const pendingInputs: RootTimelineSnapshot['pendingInputs'] = []
    let orderOffset = 0
    for (const { branch, timeline } of snapshots) {
      const maxOrder = Math.max(
        0,
        ...timeline.nodes.map((node) => node.orderKey),
        ...timeline.edges.map((edge) => edge.orderKey),
      )
      for (const node of timeline.nodes) {
        nodes.push({
          ...node,
          rootChatId: task.originalChatId,
          orderKey: node.orderKey + orderOffset,
          taskId: data.taskId,
          branchId: branch.branchId,
          branchKind: branch.kind,
        })
      }
      for (const edge of timeline.edges) {
        edges.push({
          ...edge,
          rootChatId: task.originalChatId,
          orderKey: edge.orderKey + orderOffset,
          taskId: data.taskId,
          branchId: branch.branchId,
        })
      }
      activeRuns.push(
        ...timeline.activeRuns.map((run) => ({ ...run, rootChatId: task.originalChatId })),
      )
      pendingInputs.push(...timeline.pendingInputs)
      orderOffset += maxOrder + 1
    }
    for (const { branch, timeline } of snapshots) {
      if (!branch.sourceBranchId || !branch.anchorNodeId) continue
      const first = timeline.nodes
        .filter((node) => node.status === 'committed')
        .sort((a, b) => a.orderKey - b.orderKey)[0]
      const anchor = nodes.find(
        (node) => node.id === branch.anchorNodeId && node.branchId === branch.sourceBranchId,
      )
      if (!first || !anchor) continue
      anchor.forkAnchor = true
      const projectedFirst = nodes.find(
        (node) => node.id === first.id && node.branchId === branch.branchId,
      )
      if (projectedFirst) projectedFirst.forkAnchor = true
      edges.push({
        id: `edge:fork:${branch.branchId}`,
        rootChatId: task.originalChatId,
        fromNodeId: anchor.id,
        toNodeId: first.id,
        kind: branch.kind === 'detail' ? 'fork-detail' : 'fork-continuation',
        orderKey: orderOffset++,
        sourceChatId: anchor.sourceChatId,
        targetChatId: branch.chatId,
        taskId: data.taskId,
        branchId: branch.branchId,
      })
    }
    const rootTimeline: RootTimelineSnapshot = {
      rootChatId: task.originalChatId,
      taskId: data.taskId,
      activeBranchId: task.activeBranchId,
      branches: snapshots.map(({ branch, timeline }) => {
        const firstUserMessage = timeline.nodes
          .filter((node) => node.status === 'committed' && node.actor.kind === 'user')
          .sort((a, b) => a.orderKey - b.orderKey)[0]
          ?.content.trim()
        const snapshotMetadata = branch.runtimeSnapshot.metadata
        const storedTitle =
          snapshotMetadata && typeof snapshotMetadata === 'object'
            ? (snapshotMetadata as Record<string, unknown>).branchTitle
            : undefined
        const title =
          typeof storedTitle === 'string' && storedTitle.trim()
            ? storedTitle.trim()
            : firstUserMessage
        return {
          branchId: branch.branchId,
          taskId: branch.taskId,
          chatId: branch.chatId,
          kind: branch.kind,
          ...(branch.sourceBranchId ? { sourceBranchId: branch.sourceBranchId } : {}),
          ...(branch.anchorRootChatId ? { anchorRootChatId: branch.anchorRootChatId } : {}),
          ...(branch.anchorNodeId ? { anchorNodeId: branch.anchorNodeId } : {}),
          ...(title ? { title } : {}),
          createdAt: branch.createdAt,
        }
      }),
      view: data.view ?? 'tree',
      revision: Math.max(0, ...snapshots.map((item) => item.timeline.revision)),
      nodes,
      edges,
      activeRuns,
      pendingInputs,
      generations: [],
      capturedEventSeq: Math.max(0, ...snapshots.map((item) => item.timeline.capturedEventSeq)),
    }
    return {
      chatId: task.originalChatId,
      revision: rootTimeline.revision,
      messages: [],
      rootTimeline,
    }
  }
  const requestedChatId = data.chatId ?? data.rootChatId
  if (!requestedChatId) throw new Error('缺少 chatId/rootChatId/taskId')
  if (!getChat(requestedChatId)) throw new Error('这个会话不见了')
  if (data.rootChatId) {
    // knownRevision 短路：客户端已持有该 revision 的窗口快照，不重传图
    const revision = getTimelineRevision(data.rootChatId)
    if (data.knownRevision !== undefined && data.knownRevision >= revision) {
      return { chatId: data.rootChatId, revision, unchanged: true }
    }
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
  // lite P1-② 的 number 游标（orderKey）不进本 legacy 消息路径（由 lite 投影层消费）；仅字符串复合游标在此解码。
  const cursor = typeof data.before === 'string' ? decodeTimelineCursor(data.before) : undefined
  if (typeof data.before === 'string' && !cursor) throw new Error('历史分页游标无效')
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
 * 历史 runtime selection 仅随快照回显；读取历史不会初始化 Agent 或校验旧配置。
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
  const pendingTask = getSpawnTask(data.taskId)
  if (!pendingTask) throw new Error('找不到这个 spawn 任务')
  if (
    pendingTask.status === 'finished' ||
    pendingTask.status === 'timed_out' ||
    pendingTask.status === 'abandoned'
  ) {
    return {
      chatId: pendingTask.childChatId,
      runId: ctx.requestId ?? data.taskId,
      alreadyFinished: true,
    }
  }
  const child = getChat(pendingTask.childChatId)
  const activeEpochId = child ? getActiveChatEpoch(child.id)?.epochId : undefined
  const staleEpoch = !pendingTask.epochId || pendingTask.epochId !== activeEpochId
  if (child?.lifecycle !== 'active' || staleEpoch) {
    abandonSpawnTask(pendingTask.taskId)
    if (child) {
      abandonChatSubtree(
        child.id,
        staleEpoch ? 'spawn 任务属于历史纪元，不能在当前纪元恢复' : 'spawn 子树已不可执行',
      )
    }
    return {
      chatId: pendingTask.childChatId,
      runId: ctx.requestId ?? data.taskId,
      alreadyFinished: true,
    }
  }
  const claimed = claimSpawnTask(data.taskId)
  const task = claimed.task
  if (!task) throw new Error('找不到这个 spawn 任务')
  if (task.status === 'finished' || task.status === 'timed_out' || task.status === 'abandoned') {
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
 * 分支链路：主 chat 属 conversation_branches.task_id 家族时，同 task 下的所有分支根
 *   （continuation/detail，parent 为 NULL）连同各自后代一并级联删除，杜绝孤儿分支根。
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
  const deletedChatIds: string[] = []
  const deletionOrder: Array<{ id: string }> = []
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
    // 分支链路级联：同 task（conversation_branches.task_id）下的其他分支根一并删除 + 各自后代。
    // 否则分支根（parent 为 NULL 的 continuation/detail）脱离会话列表却残留内容，重开工作台被
    // 自动选中造成「列表为空但内容仍在」。从未分支的普通根 listBranchFamilyChatIds 返 []，无副作用。
    for (const familyChatId of listBranchFamilyChatIds(p.chatId)) {
      if (seen.has(familyChatId)) continue
      seen.add(familyChatId)
      visit(familyChatId)
      descendants.push({ id: familyChatId })
    }
    cascaded = descendants.length
    deletionOrder.push(...descendants)
  }
  deletionOrder.push({ id: p.chatId })

  const running = deletionOrder.filter((candidate) => isChatRunning(candidate.id))
  if (running.length > 0) {
    const error = new Error(
      `会话仍在运行，不能直接删除：${running.map((candidate) => candidate.id).join(', ')}。请先停止运行。`,
    ) as Error & { code: string }
    error.code = ErrorCode.CONFLICT
    throw error
  }

  for (const target of deletionOrder) {
    clearWaitedChild(target.id)
    clearWaitedChildrenByParent(target.id)
    clearChatRuntime(target.id)
    deleteChat(target.id)
    deletedChatIds.push(target.id)
  }

  logger.event('chat.delete', { chatId: p.chatId, cascaded, deletedChatIds })
  return { chatId: p.chatId, deletedChatIds }
}

/**
 * chat.contextUsage：仅对已建立当前执行 runtime 的活跃会话计算上下文用量。
 * 历史浏览不得调用此接口，避免为展示历史而解析运行配置。
 */
export async function handleChatContextUsage(
  _ctx: HandlerContext,
  data: ChatContextUsageRequestData,
): Promise<ChatContextUsageResponseData> {
  const selection = getChatSelection(data.chatId)
  if (!selection) {
    const error = new Error('该历史任务尚未建立当前运行配置，请先发送或继续') as Error & {
      code: string
    }
    error.code = ErrorCode.RUNTIME_SELECTION_REQUIRED
    throw error
  }
  const bd = computeContextBreakdown(data.chatId, selection)
  return {
    chatId: data.chatId,
    contextUsage: bd.usage,
    contextUsed: breakdownUsed(bd),
    contextTotal: bd.total,
    contextBreakdown: bd,
    commandConfig: getCommandConfig(),
  }
}

export function buildActiveTurns(chatId: string): ActiveTurnSnapshot[] {
  const activeRunId = getActiveChatRunId(chatId)
  if (!isChatRunning(chatId) && !activeRunId) return []
  const turns = new Map<string, ActiveTurnSnapshot>()
  const v2MessageIds = new Set<string>()
  if (activeRunId) {
    const durableRun = getExecutionActiveRun(chatId, activeRunId)
    if (durableRun?.turnId && durableRun.nodeId) {
      turns.set(durableRun.turnId, {
        turnId: durableRun.turnId,
        runId: durableRun.runId,
        messageId: durableRun.nodeId,
        thinking: '',
        content: '',
        thinkingOffset: 0,
        contentOffset: 0,
        nextThinkingOffset: 0,
        nextContentOffset: 0,
        createdAt: Date.now(),
      })
    }
  }
  for (const event of getRecentChatEvents(chatId, 2000)) {
    const e = event as Record<string, unknown>
    const runId = typeof e.runId === 'string' ? e.runId : undefined
    const data = (e.data ?? {}) as Record<string, unknown>
    if (
      e.kind === 'notification' &&
      e.type === 'turn.started' &&
      typeof data.turnId === 'string' &&
      typeof data.messageId === 'string'
    ) {
      const turnRunId = typeof data.runId === 'string' ? data.runId : runId
      if (activeRunId && turnRunId && turnRunId !== activeRunId) continue
      v2MessageIds.add(data.messageId)
      turns.set(data.turnId, {
        turnId: data.turnId,
        ...(turnRunId ? { runId: turnRunId } : {}),
        messageId: data.messageId,
        thinking: '',
        content: '',
        thinkingOffset: 0,
        contentOffset: 0,
        nextThinkingOffset: 0,
        nextContentOffset: 0,
        createdAt: typeof data.createdAt === 'number' ? data.createdAt : Date.now(),
      })
      continue
    }
    if (
      e.kind === 'notification' &&
      e.type === 'turn.delta' &&
      typeof data.turnId === 'string' &&
      typeof data.delta === 'string' &&
      typeof data.offset === 'number'
    ) {
      const turn = turns.get(data.turnId)
      if (!turn) continue
      if (data.channel === 'thinking' && data.offset === turn.thinking.length) {
        turn.thinking += data.delta
        turn.thinkingOffset = turn.thinking.length
        turn.nextThinkingOffset = turn.thinkingOffset
      } else if (data.channel === 'content' && data.offset === turn.content.length) {
        turn.content += data.delta
        turn.contentOffset = turn.content.length
        turn.nextContentOffset = turn.contentOffset
      }
      continue
    }
    if (
      e.kind === 'notification' &&
      (e.type === 'turn.completed' || e.type === 'turn.cancelled') &&
      typeof data.turnId === 'string'
    ) {
      const completed = turns.get(data.turnId)
      turns.delete(data.turnId)
      if (completed) v2MessageIds.delete(completed.messageId)
      continue
    }
    if (e.kind === 'chunk' && e.type === 'stream' && typeof data.msgId === 'string') {
      if (activeRunId && runId && runId !== activeRunId) continue
      const id = data.msgId
      // V2 turn events are authoritative. Legacy chunks only reconstruct chats
      // created before the turn lifecycle protocol was available.
      if (v2MessageIds.has(id)) continue
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
    if (
      e.kind === 'notification' &&
      (e.type === 'done' || e.type === 'error' || e.type === 'run.outcome')
    ) {
      const terminalRun = runId
      for (const [id, turn] of turns) {
        if (!terminalRun || !turn.runId || turn.runId === terminalRun) turns.delete(id)
      }
    }
  }
  // 新运行不再持久化逐 token delta；当前进程内的累计文本覆盖兼容事件重建结果。
  // 旧数据库中仍保留的 delta 继续由上面的扫描读取，不需要迁移。
  for (const live of getLiveTurns(chatId)) turns.set(live.turnId, live)
  return [...turns.values()]
}

/** V2 atomic session open: register subscription, capture event boundary, then hydrate state. */
export async function handleChatOpen(
  ctx: HandlerContext,
  data: ChatOpenRequestData,
): Promise<ChatOpenResponseData> {
  const requestedChatId = data.scope === 'root' ? data.rootChatId : data.chatId
  if (!requestedChatId || !getChat(requestedChatId)) throw new Error('这个会话不见了')
  if (data.scope === 'root') {
    const subscriptionId = connectionManager.beginRootSessionOpen(data.rootChatId, ctx.connectionId)
    try {
      const chatIds = [data.rootChatId, ...collectDescendantsChatIds(data.rootChatId)]
      const page = getRootEvents(data.rootChatId, Number.MAX_SAFE_INTEGER)
      const eventSeq = page.latestSeq
      connectionManager.setSessionBoundary(subscriptionId, eventSeq)
      const pendingInputs = chatIds.flatMap((chatId) =>
        listPendingInputs(chatId).map((entry) => ({
          chatId,
          inputId: entry.input_id,
          ...(entry.client_message_id ? { clientMessageId: entry.client_message_id } : {}),
          messageId: entry.message_id,
          content: entry.content,
          createdAt: entry.accepted_at,
          state: entry.state,
          queueSequence: entry.queue_sequence,
          acceptedAt: entry.accepted_at,
        })),
      )
      const activeTurns = chatIds.flatMap((chatId) =>
        buildActiveTurns(chatId).map((turn) => ({ ...turn, chatId })),
      )
      const currentStates = new Map(
        chatIds.map(
          (chatId) =>
            [
              chatId,
              computeCurrentState(chatId, { executionStepLimit: data.executionStepLimit }),
            ] as const,
        ),
      )
      const runs = chatIds.flatMap((chatId) => {
        const runId = getActiveChatRunId(chatId)
        if (!runId) return []
        const runTiming = currentStates.get(chatId)?.runTiming
        return [
          {
            chatId,
            runId,
            state: 'running' as const,
            ...(runTiming?.runId === runId ? { startedAt: runTiming.startedAt } : {}),
          },
        ]
      })
      const executionSteps = limitExecutionSteps(
        chatIds.flatMap((chatId) => currentStates.get(chatId)?.executionSteps ?? []),
        data.executionStepLimit,
      )
      // knownTimelineRevision 短路：客户端已持有该 revision 的窗口快照，
      // 省略 rootTimeline（订阅栅栏与 state 照常返回）
      const revision = getTimelineRevision(data.rootChatId)
      if (data.knownTimelineRevision !== undefined && data.knownTimelineRevision >= revision) {
        connectionManager.finishSessionOpen(subscriptionId)
        logger.event('chat.open.root', {
          rootChatId: data.rootChatId,
          subscriptionId,
          eventSeq,
          revision,
          unchanged: true,
        })
        return {
          chatId: data.rootChatId,
          subscriptionId,
          eventSeq,
          timelineRevision: revision,
          timelineChanged: false,
          timelineUnchanged: true,
          state: {
            chatIds,
            pendingInputs,
            activeTurns,
            runs,
            questionBatches: [],
            runningTools: [],
            executionSteps,
            roles: [],
          },
        }
      }
      const rootTimeline = buildRootTimeline(data.rootChatId, data.view)
      rootTimeline.capturedEventSeq = eventSeq
      connectionManager.finishSessionOpen(subscriptionId)
      logger.event('chat.open.root', {
        rootChatId: data.rootChatId,
        subscriptionId,
        eventSeq,
        revision: rootTimeline.revision,
      })
      return {
        chatId: data.rootChatId,
        subscriptionId,
        eventSeq,
        timelineRevision: rootTimeline.revision,
        timelineChanged: data.knownTimelineRevision !== rootTimeline.revision,
        rootTimeline,
        state: {
          chatIds,
          pendingInputs,
          activeTurns,
          runs,
          questionBatches: [],
          runningTools: [],
          executionSteps,
          roles: [],
        },
      }
    } catch (error) {
      connectionManager.closeSession(subscriptionId)
      throw error
    }
  }
  const chatId = data.chatId
  const subscriptionId = connectionManager.beginSessionOpen(chatId, ctx.connectionId)
  try {
    // getChatEvents is synchronous; registration and boundary capture therefore execute
    // without an await gap, while outgoing events are fenced by ConnectionManager.
    const page = getChatEvents(chatId, Number.MAX_SAFE_INTEGER)
    const eventSeq = page.latestSeq
    const timelineRevision = getTimelineRevision(chatId)
    connectionManager.setSessionBoundary(subscriptionId, eventSeq)
    const currentState = computeCurrentState(chatId, {
      executionStepLimit: data.executionStepLimit,
    })
    const questionSnapshot = getQuestionStateSnapshot(chatId)
    const pendingInputs = listPendingInputs(chatId).map((entry) => ({
      inputId: entry.input_id,
      ...(entry.client_message_id ? { clientMessageId: entry.client_message_id } : {}),
      messageId: entry.message_id,
      content: entry.content,
      createdAt: entry.accepted_at,
      state: entry.state,
      queueSequence: entry.queue_sequence,
      acceptedAt: entry.accepted_at,
    }))
    const runId = getActiveChatRunId(chatId)
    const runTiming = currentState.runTiming
    const roles = listOpenSpawnTasks(chatId).map((task) => ({
      taskId: task.taskId,
      chatId: task.childChatId,
      parentChatId: task.parentChatId,
      type: task.type,
      state: task.status,
    }))
    const snapshot: ChatOpenResponseData = {
      chatId,
      subscriptionId,
      eventSeq,
      timelineRevision,
      timelineChanged: data.knownTimelineRevision !== timelineRevision,
      state: {
        ...(runId
          ? {
              run: {
                runId,
                state: 'running' as const,
                ...(runTiming?.runId === runId ? { startedAt: runTiming.startedAt } : {}),
              },
            }
          : {}),
        pendingInputs,
        activeTurns: buildActiveTurns(chatId),
        ...(currentState.pendingApproval ? { pendingApproval: currentState.pendingApproval } : {}),
        questionBatches: questionSnapshot.pendingQuestionBatches,
        runningTools: currentState.runningTools,
        executionSteps: currentState.executionSteps,
        roles,
      },
    }
    connectionManager.finishSessionOpen(subscriptionId)
    logger.event('chat.open', { chatId, subscriptionId, eventSeq })
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
 * attach 同时返回 activeTurns 完整快照，当前未完成文本无需由 chat.sync 的历史 delta 拼装。
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
    return { chatId, running: false, activeTurns: [], ...questionSnapshot }
  }

  // attach 同时是订阅登记：idle 主 chat 也要接收随后由子完成触发的
  // role_reply / child_abandoned；运行中 chat 则额外接收后续 stream。
  connectionManager.subscribeChat(chatId, ctx.connectionId)

  // 未在运行时仍保留订阅，用于后续子完成等异步 notification。
  if (!isChatRunning(chatId)) {
    return { chatId, running: false, activeTurns: [], ...questionSnapshot }
  }

  // 加入后续实时输出订阅 + 取消该 run 的断连 park（子 run 未跟踪则 no-op）。
  connectionManager.setLiveOutput(chatId, ws)
  disconnectGrace.rebindByChatId(chatId, ctx.connectionId, ws)
  const activeRunId = getActiveChatRunId(chatId)

  logger.event('chat.attach', { chatId, connectionId: ctx.connectionId })
  return {
    chatId,
    running: true,
    attached: true,
    ...(activeRunId ? { runId: activeRunId } : {}),
    activeTurns: buildActiveTurns(chatId),
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
  router.register(Method.CHAT_TIMELINE_GET, handleChatTimelineGet)
  router.register(Method.CHAT_TIMELINE_GENERATION_GET, handleChatTimelineGenerationGet)
  router.register(Method.CHAT_TIMELINE_NODE_GET, handleChatTimelineNodeGet) // lite P0：单节点按需详情
  router.register(Method.CHAT_INPUT_SUBMIT, handleChatInputSubmit)
  router.register(Method.CHAT_RESUME_TREE, handleChatResumeTree)
  router.register(Method.CHAT_OPEN, handleChatOpen)
  router.register(Method.CHAT_CLOSE, handleChatClose)
  router.register(Method.CHAT_STOP_CHILD, handleChatStopChild)
  router.register(Method.CHAT_DELETE, handleChatDelete)
  router.register(Method.CHAT_CONTEXT_USAGE, handleChatContextUsage)
  registerPromptSnapshotHandler(router)
}
