import { AgentBuilder } from '@/agent/builder.js'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import { resolveSelectionIssues, type RuntimeIssue } from '@/agent/runtimeResolver.js'
import {
  getMessages,
  parseMessageRow,
  getChatRuntimeSelection,
  getChatSystemPromptFile,
  getChatWorkspace,
  getChatSkillFilter,
  getChatRule,
  updateChatMetadata,
  getChat,
  getChatType,
  getChatBranchContext,
  findChildChatsWithType,
  listPendingInputs,
  markPendingInputsConsumed,
} from '@/db/chat.js'
import config from '@/utils/config'
import { ErrorCode } from '@/service/message/types.js'
import type { LLMResponse } from '@/core/message/adapter'
import { extractSummaryBlock } from '@/core/middleware/messageJournal.js'
import { notifyRestartActivityChanged } from '@/service/restartCoordinator.js'
import { getChatMentionableRoles } from './roleMentions.js'
import { computeHistoryGenerationInfos } from './generations.js'
import { buildTreeInterruptionNotice } from './treeInterruption.js'

/**
 * Chat 运行时缓存：chatId → builder + runtime 选择（单 chat 绑定，跨轮不重建）
 * （P2-1 从 send.ts 拆出）
 *
 * 每个 chatId 独享一个 AgentBuilder 实例（不再全局单例），与 Middleware 一同随 chat 生命周期存在。
 * runtime selection 由 chat.create/runtime.set 原子注入。
 * 实例不重建，messages 天然保留，无需迁移。
 */
interface ChatRuntime {
  builder: AgentBuilder
  selection?: RuntimeSelection
  /** 当前活跃 chat.send/chat.resume 的协议运行标识。 */
  activeRunId?: string
}

const chatRuntimes = new Map<string, ChatRuntime>()
/** 会话级临时角色编制；进程重启即失效，刻意不写数据库。 */
const sessionRoleRuntimes = new Map<
  string,
  { primary: RuntimeSelection; roles: Record<string, RuntimeSelection> }
>()
/** 子 chat 的临时运行时：用于 role 覆盖，优先于数据库默认值且不落盘。 */
const ephemeralChatRuntimes = new Map<string, RuntimeSelection>()

/**
 * 读 chat 当前 runtime selection（内存 chatRuntimes）。
 * observer 入库 user 消息时记 messages.runtime 用(消息级 runtime 溯源,见 agent-pet.md §5.7)。
 */
export function getChatSelection(chatId: string): RuntimeSelection | undefined {
  return chatRuntimes.get(chatId)?.selection
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
 * 查 chat 当前是否正在运行(有活跃 generator)。
 * chat.list 暴露 running 字段用(前端据此判断子 agent 是否还活着、主 chat 是否卡死)。
 */
export function isChatRunning(chatId: string): boolean {
  return chatRuntimes.get(chatId)?.builder.isRunning() ?? false
}

/** 守护进程待重启时，用于判定所有 chat 是否已安全空闲。 */
export function hasRunningChats(): boolean {
  return [...chatRuntimes.values()].some((runtime) => runtime.builder.isRunning())
}

/** 获取当前活跃运行，用于 queued send 回包与带条件的 chat.abort。 */
export function getActiveChatRunId(chatId: string): string | undefined {
  return chatRuntimes.get(chatId)?.activeRunId
}

/** 在启动 send/resume 前登记运行；同一 chat 同时至多一个活跃运行。 */
export function activateChatRun(chatId: string, runId: string): void {
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
}

/**
 * 取 chat 对应的完整运行时。
 * ensureChat 后必定存在，缺失则视为内部错误。
 */
async function ensureRuntime(chatId: string): Promise<ChatRuntime> {
  await ensureChat(chatId)
  const runtime = chatRuntimes.get(chatId)
  if (!runtime) {
    throw new Error(`Chat runtime not initialized: ${chatId}`)
  }
  return runtime
}

/**
 * 原子解析并注入完整 runtime。
 * 主 agent（parent_chat_id 为空）硬编码注入 memory_manage；子 agent 排除。
 * @param persist 是否写回 metadata.runtime（默认 true）。只读跟随恢复（resolveEffectiveSelection status=followed）
 *   传 false：配置演化后按当前角色重解析的结果不落盘，历史快照保持纯净，每次恢复幂等重算。
 */
function configureRuntime(
  runtime: ChatRuntime,
  chatId: string,
  selection: RuntimeSelection,
  persist = true,
): void {
  runtime.selection = selection
  const isMainAgent = !getChat(chatId)?.parent_chat_id
  runtime.builder.configureRuntime(selection, isMainAgent, getChatRule(chatId), chatId)
  // 持久化 selection 到 metadata.runtime，服务重启后 ensureChat 自动恢复
  if (persist) {
    updateChatMetadata(chatId, { runtime: selection })
  }
}

/**
 * 解析 chat 的有效 runtime selection（快照投影，只读，不写回）。
 *
 * 配置演化（brain/感官组/预设/角色增删改）是常态，持久化快照（metadata.runtime）引用的名称可能已失效——
 * 这是预期状态而非 bug。三态（见 docs/service/chat.md「配置演化与 runtime 快照失效」）：
 * 历史 metadata.runtime 仅供展示，不参与此处解析。显式会话选择优先；否则主会话按当前
 * presetId/旧 preset 名关联 leader，子会话按当前 metadata.type 关联角色。关联缺失时返回
 * invalid，由执行入口要求用户显式选择当前运行配置。
 */
export function resolveEffectiveSelection(
  chatId: string,
):
  | { status: 'ok' | 'followed' | 'invalid'; selection: RuntimeSelection; issues: RuntimeIssue[] }
  | undefined {
  const type = getChatType(chatId)
  const selectedForSession =
    ephemeralChatRuntimes.get(chatId) ??
    sessionRoleRuntimes.get(chatId)?.primary ??
    (type ? getSessionRoleRuntime(chatId, type) : undefined)
  if (selectedForSession) {
    const issues = resolveSelectionIssues(selectedForSession)
    return issues.length
      ? { status: 'invalid', selection: selectedForSession, issues }
      : { status: 'followed', selection: selectedForSession, issues: [] }
  }

  // Historical metadata.runtime is display-only. New execution follows the
  // current preset/type association and therefore never validates an obsolete
  // brain or sense group stored in the database.
  const role = type ? config.roles?.[type] : undefined
  if (role?.brain) {
    const followed: RuntimeSelection = {
      brain: role.brain,
      senseGroup: role.senseGroup ?? '',
      mcpServers: role.mcpServers ?? [],
    }
    const issues = resolveSelectionIssues(followed)
    return issues.length
      ? { status: 'invalid', selection: followed, issues }
      : { status: 'followed', selection: followed, issues: [] }
  }

  const historical = getChatRuntimeSelection(chatId)
  return historical
    ? {
        status: 'invalid',
        selection: historical,
        issues: [{ kind: 'brain', name: 'current preset/type association' }],
      }
    : undefined
}

/**
 * session.runtime.set 回灌结果：
 * - applied：已立即切换并持久化到子 chat `metadata.runtime` 的子 chatId（含 running 子，下一轮 loop 自动取新 brain）。
 * - deferredRunning：applied 的子集中那些本次正在运行的子 chatId——流未打断，需前端可选提示「下一轮生效」。
 */
export interface SessionRoleRuntimeResult {
  applied: string[]
  deferredRunning: string[]
}

/**
 * 设置主会话的临时角色编制，并立即切换主角色运行时；同时回灌已存在的同 type 子 chat。
 *
 * 分层语义（修主发送界面改子角色 brain 不作用于已派发子的缺口）：
 * - **主角色**：运行时切换（`configureRuntime(primary,true)`）+ 内存 `sessionRoleRuntimes` 缓存为后续 spawn 模板；
 *   不写主 chat 的 `metadata.runtime`（保持「会话级临时」语义，重启即失效）。
 * - **子角色**：内存 `sessionRoleRuntimes` 继续为未来 spawn 模板；
 *   **同时遍历父会话下所有存活子 chat，按 type 匹配新 roles**：无论 idle / 未加载 / **running**，
 *   均立即 `configureRuntime`（替换 ctx.runtime 引用，不打断当前 stream——流是已发出 chunk 与 ctx.runtime 解耦）
 *   + 写子 chat 自己的 `metadata.runtime` 持久化；running 子同时计入 `deferredRunning`（前端可选提示
 *   「下一轮生效」），不静默但也不阻断流。
 *
 * 返回 { applied, deferredRunning } 供前端展示反馈（fail-loud，规则12）。
 */
export async function setSessionRoleRuntimes(
  chatId: string,
  primary: RuntimeSelection,
  roles: Record<string, RuntimeSelection>,
): Promise<SessionRoleRuntimeResult> {
  const previous = sessionRoleRuntimes.get(chatId)
  sessionRoleRuntimes.set(chatId, { primary, roles })
  let runtime: ChatRuntime
  try {
    await ensureChat(chatId)
    runtime = chatRuntimes.get(chatId)!
  } catch (error) {
    if (previous) sessionRoleRuntimes.set(chatId, previous)
    else sessionRoleRuntimes.delete(chatId)
    throw error
  }
  runtime.selection = primary
  runtime.builder.configureRuntime(primary, true, getChatRule(chatId), chatId)

  // 回灌已存在的同 type 子 chat（修主发送界面改子角色 brain 不作用于已派发子的缺口）。
  const applied: string[] = []
  const deferredRunning: string[] = []
  const children = findChildChatsWithType(chatId)
  for (const { childChatId, type } of children) {
    const sel = roles[type]
    if (!sel) continue
    const childRt = chatRuntimes.get(childChatId)
    if (childRt?.builder.isRunning()) {
      // running 子：仍立即 configureRuntime 替换 ctx.runtime 引用（不打断当前 stream——流是已发出
      // chunk，与 ctx.runtime 解耦），同时持久化 metadata.runtime。下一轮 LLM 请求自然取新 brain。
      // 仅在日志层标记 deferredRunning（前端可选提示「下一轮生效」）；不静默。
      childRt.selection = sel
      childRt.builder.configureRuntime(sel, false, getChatRule(childChatId), childChatId)
      updateChatMetadata(childChatId, { runtime: sel })
      applied.push(childChatId)
      deferredRunning.push(childChatId)
      continue
    }
    // idle / 未加载：直接 configureRuntime + 持久化到子 chat 自己的 metadata.runtime。
    // 下次 ensureChat 从 metadata 恢复（重启/切回皆生效）。
    if (childRt) {
      childRt.selection = sel
      childRt.builder.configureRuntime(sel, false, getChatRule(childChatId), childChatId)
    }
    updateChatMetadata(childChatId, { runtime: sel })
    applied.push(childChatId)
  }
  return { applied, deferredRunning }
}

/** 返回祖先主会话的某角色临时编制，供 spawn_role 使用。 */
export function getSessionRoleRuntime(chatId: string, role: string): RuntimeSelection | undefined {
  let current = chatId
  // parent 链理论上无环；上限防脏数据无限循环。
  for (let depth = 0; depth < 32; depth += 1) {
    const session = sessionRoleRuntimes.get(current)
    if (session) return session.roles[role]
    const row = getChat(current)
    if (!row?.parent_chat_id) return undefined
    current = row.parent_chat_id
  }
  return undefined
}

/** 注册刚派发子角色的临时编制；在该 child 首次 ensureChat 时消费。（子 agent，排除 memory_manage） */
export function setEphemeralChatRuntime(chatId: string, selection: RuntimeSelection): void {
  ephemeralChatRuntimes.set(chatId, selection)
  const runtime = chatRuntimes.get(chatId)
  // 已初始化但尚未运行的复用子角色也切到临时编制；运行中的请求保持其启动时配置。
  if (runtime && !runtime.builder.isRunning()) {
    runtime.selection = selection
    runtime.builder.configureRuntime(selection, false, getChatRule(chatId), chatId)
  }
}

/**
 * 从 DB 加载历史消息，交给 builder.init 注入 middleware 内存。
 * 仅 ensureChat 创建时调用一次，send/resume 不再重复加载。
 */
function loadHistory(chatId: string): LLMResponse[] | undefined {
  const rows = getMessages(chatId)
  const branchContext = getChatBranchContext(chatId)
  const contextMessage: LLMResponse | undefined = branchContext
    ? {
        id: `branch-context:${chatId}`,
        role: 'system',
        content: branchContext,
        createdAt: 0,
        updateAt: 0,
      }
    : undefined
  if (rows.length === 0) return contextMessage ? [contextMessage] : undefined
  const parsedRows = rows.map((row) => {
    const parsed = parseMessageRow(row)
    return {
      id: row.id,
      role: parsed.role,
      content: parsed.content ?? '',
      thinking: parsed.thinking,
      senseCalls: parsed.senseCall,
      hash: parsed.hash,
      replace: parsed.replace,
      originalContent: parsed.originalContent,
      revoked: parsed.revoked,
      contextCompaction: parsed.contextCompaction,
      contextCompactionTokens: parsed.contextCompactionTokens,
      createdAt: row.created_at,
      updateAt: row.created_at,
    }
  })
  // 取最后一条 compact 摘要作为重建起点；其后的全部后续对话一并加载。
  // 与 compactToLatestSummary 内存裁剪语义对齐——冷重建不得丢失压缩点之后已持久化的消息
  // （否则重启/切 chat 回来，summary 之后的几轮对话"DB 在、模型看不见"）。
  let summaryIdx = -1
  for (let i = parsedRows.length - 1; i >= 0; i--) {
    if (parsedRows[i]!.contextCompaction) {
      summaryIdx = i
      break
    }
  }
  if (summaryIdx === -1) return contextMessage ? [contextMessage, ...parsedRows] : parsedRows
  const latestSummary = parsedRows[summaryIdx]!
  return [
    ...(contextMessage ? [contextMessage] : []),
    {
      ...latestSummary,
      role: 'system',
      content: `以下是此前对话压缩后的上下文摘要。将其视为后续工作的唯一历史上下文：\n\n${extractSummaryBlock(latestSummary.content)}`,
    },
    ...parsedRows.slice(summaryIdx + 1),
  ]
}

/**
 * 获取或创建 chat 对应的 AgentBuilder 实例（单 chat 绑定，跨轮不重建）。
 *
 * 创建时完成：原子配置 runtime（如传入）→ 加载历史。
 * 幂等：已存在直接返回，不重新配置。send/resume 不带 brain/senseGroups，
 * 依赖 create 时已配置的 runtime；服务端重启内存丢失后须重新 create。
 *
 * @param selection 可选，chat.create/runtime.set 携带时参与原子 runtime 配置
 */
export async function ensureChat(
  chatId: string,
  selection?: RuntimeSelection,
): Promise<AgentBuilder> {
  const existing = chatRuntimes.get(chatId)
  if (existing) {
    if (selection) {
      configureRuntime(existing, chatId, selection)
    } else {
      // P1-6：registry 变更（mcp.reload/重编译）后，存量 chat 的 senseTable 快照过期。
      // send/resume 入口（无 selection）用持久化 selection 重建 senseTable，拾取新增/移除感官。
      // 重建在 loop 启动前，ctx.runtime 引用替换安全（generator 尚未运行）。
      const sel = existing.selection
      if (sel && existing.builder.isSenseTableStale()) {
        configureRuntime(existing, chatId, sel)
      }
    }
    return existing.builder
  }

  // 每个 chat 独享一个 AgentBuilder 实例（不再全局单例）
  const builder = new AgentBuilder().build()

  const runtime: ChatRuntime = { builder }
  chatRuntimes.set(chatId, runtime)
  try {
    // 原子配置 runtime selection：
    //   1. 显式传入（chat.create/runtime.set）→ 严格路径（输入校验已过），持久化
    //   2. 否则按当前 preset/type 关联或会话级临时编制恢复；历史 metadata.runtime 不参与执行。
    //      followed→只读注入（不写回历史）；invalid→要求用户显式选择当前运行配置。
    if (selection) {
      configureRuntime(runtime, chatId, selection)
    } else {
      const effective = resolveEffectiveSelection(chatId)
      if (effective) {
        if (effective.status === 'invalid') {
          const err = new Error(
            '该历史任务无法关联到当前 preset/type，请先选择当前运行配置',
          ) as Error & { code: string }
          err.code = ErrorCode.RUNTIME_SELECTION_REQUIRED
          throw err
        }
        configureRuntime(runtime, chatId, effective.selection, effective.status === 'ok')
      } else {
        const err = new Error('该历史任务没有当前运行配置，请先选择') as Error & {
          code: string
        }
        err.code = ErrorCode.RUNTIME_SELECTION_REQUIRED
        throw err
      }
    }

    // 一次性加载历史到内存 + 注入 system prompt（chat metadata.systemPromptFile 合并补充；
    // 来源：spawn 写子 agent / chat.create 写预设主 agent；缺省 → undefined → 全局）
    // skillFilter：per-role 技能组/插件组过滤（metadata.skillFilter），仅 <skills> 块按角色裁剪。
    // historyGenerations：LLM 历史回忆 L0 代际索引（存在已定稿 compact 代际时注入 <history_generations> 段）。
    const history = loadHistory(chatId)
    builder.init(
      chatId,
      history,
      getChatSystemPromptFile(chatId),
      getChatWorkspace(chatId),
      getChatSkillFilter(chatId),
      getChatMentionableRoles(chatId),
      computeHistoryGenerationInfos(chatId),
    )
    // Restore accepted command-plane inputs that were acknowledged before a
    // process restart. If the user message already reached the durable history,
    // mark it consumed instead of enqueueing a duplicate.
    const existingMessageIds = new Set((history ?? []).map((message) => message.id))
    const durablePending = listPendingInputs(chatId)
    const consumedIds: string[] = []
    for (const pending of durablePending) {
      if (existingMessageIds.has(pending.message_id)) {
        consumedIds.push(pending.input_id)
      } else {
        builder.enqueueInput(pending.content, {
          inputId: pending.input_id,
          messageId: pending.message_id,
          clientMessageId: pending.client_message_id ?? undefined,
          commandId: pending.command_id,
        })
      }
      // Only the input that started the detached root runner owns this notice;
      // later queued inputs must not each produce a duplicate interruption.
      const notice =
        pending.state === 'started'
          ? buildTreeInterruptionNotice(chatId, pending.command_id)
          : undefined
      if (notice && !existingMessageIds.has(notice.messageId)) {
        builder.enqueueInput(notice.content, {
          messageId: notice.messageId,
          role: 'role',
          linkRelation: 'system',
        })
      }
    }
    markPendingInputsConsumed(chatId, consumedIds)
  } catch (err) {
    // 半初始化清理：configureRuntime 深校验或 init 抛错时，移除刚 set 的 map 项，
    // 避免留半配置 runtime（无 brain/sense）被后续 send 误用。DB 行由调用方清理。
    chatRuntimes.delete(chatId)
    throw err
  }

  return builder
}

/**
 * 原子设置 runtime selection。
 * 由 runtime.set handler 调用。
 */
export async function setRuntime(chatId: string, selection: RuntimeSelection): Promise<void> {
  const runtime = await ensureRuntime(chatId)
  configureRuntime(runtime, chatId, selection)
}

/**
 * 将 chatId 从运行时缓存移除（删除 chat 时调用）
 */
export function clearChatRuntime(chatId: string): void {
  chatRuntimes.delete(chatId)
  sessionRoleRuntimes.delete(chatId)
  ephemeralChatRuntimes.delete(chatId)
}

/**
 * 解析 chat 当前生效的 runtime selection（含 ephemeral 子角色覆盖），解析顺序与 ensureRuntime 对齐：
 * ephemeral 临时编制（子 agent role 覆盖）优先于数据库默认值。
 * 供 autoCompact 等热路径使用——使 compact 可用性按当次发送的实际 brain 判定。
 */
export function resolveChatRuntimeSelection(chatId: string): RuntimeSelection | undefined {
  return ephemeralChatRuntimes.get(chatId) ?? getChatRuntimeSelection(chatId)
}

/**
 * 中止 chat 运行中 generator（chat.abort 场景）。
 * 转发 builder.abort → compose.abort 注入错误退出 generator。
 */
export function abortChatRuntime(chatId: string): void {
  chatRuntimes.get(chatId)?.builder.abort()
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
