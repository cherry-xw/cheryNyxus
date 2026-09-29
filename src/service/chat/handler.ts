import { handleChatArchive, handleArchiveList, handleChatDelete } from './archive.js'
import { assertChatExists } from './guards.js'
import { buildActiveTurns } from './activeTurns.js'
import { buildRootTimeline } from './timeline.js'
import { handleChatTimelineGet } from './timelineGet.js'
import { messagesToStagedEvents } from './stagedHistory.js'
import { pendingInputSnapshot } from './pendingInputs.js'
import { handleChatInputSubmit, handleChatInputWithdraw, handleChatStopChild } from './input.js'
import { registerUsageHandlers } from './usage.js'
export { handleChatDelete } from './archive.js'
import type { HandlerContext } from '../message/router.js'
import {
  createNotification,
  ErrorCode,
  Method,
  type Chunk,
  type Notification,
  type ChatCreateRequestData,
  type ChatCreateResponseData,
  type ChatGetRequestData,
  type ChatGetResponseData,
  type ChatListRequestData,
  type ChatListResponseData,
  type ChatContextUsageRequestData,
  type ChatContextUsageResponseData,
  type ChatOpenRequestData,
  type ChatOpenResponseData,
  type ChatCloseRequestData,
  type ChatCloseResponseData,
  type ChatSyncRequestData,
  type ChatSyncResponseData,
  type ChatSessionSnapshotData,
  type ChatStartSpawnRequestData,
  type ChatStartSpawnResponseData,
  type Response as RpcResponse,
} from '../message/types.js'
import { createChat, listAllChats, listRootChatsForPresets, countRootChatsForPresets, listChatTrees, getChat, deleteChat, collectDescendantsChatIds, updateChatMetadata, getChatWorkspace, getChatPreset, getChatRuntimeSelection, getTimelineRevision } from '@/db/chat.js'
import { getMessages, getLastMessage, getChatPreviews } from '@/db/message.js'
import { listPendingInputs } from '@/db/pendingInput.js'
import { clearChatRuntime, ensureChat } from './runtime.js'
import { isChatRunning, getActiveChatRunId, getChatSelection } from './runtimeCache.js'
import { resolveChatRuntimeSelection } from './sessionRoleRuntime.js'
import { connectionManager } from '../websocket/connection.js'
import { getPendingQuestionAttention, getQuestionStateSnapshot } from '@/db/question.js'
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
  getSpawnTask,
  claimSpawnTask,
  abandonSpawnTask,
  finishSpawnTask,
  getSpawnTaskByChild,
  listOpenSpawnTasks,
  getRootEvents,
} from '@/db/delivery.js'
import { resolveRoleAvatar } from '@/utils/roleAvatar.js'
import { handleChatResume, handleChatSend } from './send.js'
import { computeCanResume } from './canResume.js'
import { computeCurrentState, limitExecutionSteps } from './currentState.js'
import { approvalManager } from '../approval/manager.js'
import { handleChatTimelineGenerationGet } from './generations.js'
import { handleChatTimelineNodeGet } from './nodeDetail.js'
import { handleChatResumeTree } from './treeControl.js'
import { getActiveChatEpoch, getChatEpochStats } from '@/db/epoch.js'
import { abandonChatSubtree } from '@/service/config/roleLifecycle.js'
import { getConversationBranchByChat } from '@/db/conversationBranch.js'

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
          ...(workspace
            ? { workspace, workspaceValid: validateWorkspacePath(workspace).valid }
            : {}),
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
function findBlankPresetRootChat(
  preset: string,
): ReturnType<typeof listRootChatsForPresets>[number] | undefined {
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
  const chat = assertChatExists(chatId)
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
  let total: number | undefined
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
    // 仅 preset scope 分页（标题栏会话下拉）：limit 缺省全量（现有调用不变）；带 limit 时排除
    // 非 original 分支 root（与前端 isPianoRootSession 对齐）并返回 total 供分页判断。
    const pageOptions: { excludeBranches: boolean; limit?: number; offset?: number } | undefined =
      data.scope === 'preset'
        ? {
            excludeBranches: true,
            ...(data.limit !== undefined
              ? {
                  limit: (() => {
                    if (!Number.isInteger(data.limit) || data.limit < 1 || data.limit > 100) {
                      throw new Error('分页参数非法：limit 须为 1-100 的整数')
                    }
                    return data.limit as number
                  })(),
                  ...(data.offset !== undefined
                    ? {
                        offset: (() => {
                          if (!Number.isInteger(data.offset) || (data.offset as number) < 0) {
                            throw new Error('分页参数非法：offset 须为不小于 0 的整数')
                          }
                          return data.offset as number
                        })(),
                      }
                    : {}),
                }
              : {}),
          }
        : undefined
    const matchingRoots = listRootChatsForPresets(associations, pageOptions)
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
      // 仅 preset 分页返回 total（同 WHERE 的 root 匹配总数）；stage/history 不携带。
      if (pageOptions?.limit !== undefined) {
        total = countRootChatsForPresets(associations, pageOptions)
      }
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
    total,
  })
  return { chats, ...(total !== undefined ? { total } : {}) }
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

  assertChatExists(p.chatId)

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
  assertChatExists(data.chatId)
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
    const result = yield* handleChatSend(
      ctx,
      { chatId: task.childChatId, prompt: task.prompt },
      true,
    )
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
 * chat.contextUsage：计算会话上下文用量。
 * selection 优先级：内存活跃 runtime（getChatSelection）→ 持久化 metadata.runtime
 * （resolveChatRuntimeSelection，服务重启后内存 chatRuntimes 丢失时按 DB 恢复，见 runtime.ts）。
 * 两者皆无（全新会话从未运行）时保持原守卫：抛 RUNTIME_SELECTION_REQUIRED，由前端兜底空白。
 */
export async function handleChatContextUsage(
  _ctx: HandlerContext,
  data: ChatContextUsageRequestData,
): Promise<ChatContextUsageResponseData> {
  const selection = getChatSelection(data.chatId) ?? resolveChatRuntimeSelection(data.chatId)
  if (!selection) {
    const error = new Error('该会话尚未建立运行配置，请先发送或继续') as Error & {
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

/** V2 atomic session open: register subscription, capture event boundary, then hydrate state. */
export async function handleChatOpen(
  ctx: HandlerContext,
  data: ChatOpenRequestData,
): Promise<ChatOpenResponseData> {
  const requestedChatId = data.scope === 'root' ? data.rootChatId : data.chatId
  if (!requestedChatId) throw new Error('缺少 chatId/rootChatId/taskId')
  assertChatExists(requestedChatId)
  if (data.scope === 'root') {
    const subscriptionId = connectionManager.beginRootSessionOpen(data.rootChatId, ctx.connectionId)
    try {
      const chatIds = [data.rootChatId, ...collectDescendantsChatIds(data.rootChatId)]
      const page = getRootEvents(data.rootChatId, Number.MAX_SAFE_INTEGER)
      const eventSeq = page.latestSeq
      connectionManager.setSessionBoundary(subscriptionId, eventSeq)
      const pendingInputs = chatIds.flatMap((chatId) =>
        listPendingInputs(chatId).map((entry) => pendingInputSnapshot(entry, chatId)),
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
    const pendingInputs = listPendingInputs(chatId).map((entry) => pendingInputSnapshot(entry))
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
 * 注册 Chat 管理 handlers
 */
export function registerChatManageHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.CHAT_CREATE, handleChatCreate)
  router.register(Method.CHAT_LIST, handleChatList)
  router.register(Method.CHAT_TIMELINE_GET, handleChatTimelineGet)
  router.register(Method.CHAT_TIMELINE_GENERATION_GET, handleChatTimelineGenerationGet)
  router.register(Method.CHAT_TIMELINE_NODE_GET, handleChatTimelineNodeGet) // lite P0：单节点按需详情
  router.register(Method.CHAT_INPUT_SUBMIT, handleChatInputSubmit)
  router.register(Method.CHAT_INPUT_WITHDRAW, handleChatInputWithdraw)
  router.register(Method.CHAT_RESUME_TREE, handleChatResumeTree)
  router.register(Method.CHAT_OPEN, handleChatOpen)
  router.register(Method.CHAT_CLOSE, handleChatClose)
  router.register(Method.CHAT_STOP_CHILD, handleChatStopChild)
  router.register(Method.CHAT_DELETE, handleChatDelete)
  router.register(Method.CHAT_ARCHIVE, handleChatArchive)
  router.register(Method.CHAT_ARCHIVE_LIST, handleArchiveList)
  router.register(Method.CHAT_CONTEXT_USAGE, handleChatContextUsage)
  registerPromptSnapshotHandler(router)
  registerUsageHandlers(router)
}
