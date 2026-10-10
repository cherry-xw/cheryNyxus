import {
  sessionRoleRuntimes,
  ephemeralChatRuntimes,
  getSessionRoleRuntime,
} from './sessionRoleRuntime.js'
import { chatRuntimes, type ChatRuntime } from './runtimeCache.js'
import { prepareTreeRuntimeRefresh } from './treeRuntimeRefresh.js'
import { AgentBuilder, type AgentChatInitOptions } from '@/agent/builder.js'
import { hasWorkflowObserver, reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { effectiveSkillCount, memoryRows } from './workflowEvidence.js'
import { workflowResources, workflowStageId } from './workflowHistory.js'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import { resolveSelectionIssues, type RuntimeIssue } from '@/agent/runtimeResolver.js'
import {
  getChatRuntimeSelection,
  getChatSystemPromptFile,
  getChatWorkspace,
  getChatSkillFilter,
  getChatRule,
  updateChatMetadata,
  getChat,
  getChatType,
  getChatBranchContext,
  getChatMetadata,
} from '@/db/chat.js'
import { getMessages, parseMessageRow } from '@/db/message.js'
import { listPendingInputs, markPendingInputsConsumed } from '@/db/pendingInput.js'
import config from '@/utils/config'
import { ErrorCode } from '@/service/message/types.js'
import type { LLMResponse } from '@/core/message/adapter'
import { extractSummaryBlock } from '@/core/middleware/messageJournal.js'
import { assertRestartAdmission, isRestartDraining } from '@/service/restartCoordinator.js'
import { getChatMentionableRoles } from './roleMentions.js'
import { computeHistoryGenerationInfos } from './generations.js'
import { buildTreeInterruptionNotice } from './treeInterruption.js'
import {
  assertEpochExecutable,
  ensureActiveChatEpoch,
  freezeChatEpochSnapshot,
  getActiveChatEpoch,
  getFrozenChatSnapshot,
  rotateActiveChatEpoch,
  type ChatEpochRecord,
} from '@/db/epoch.js'
import { ensureCurrentConfigRevision, isStartupConfigBoundary } from '@/service/config/revision.js'
import { buildLivePromptSnapshot } from './promptSnapshot.js'
import { assertAgentExecutionAllowed } from '@/service/maintenanceMode.js'
import { getSoulDb } from '@/db/index.js'
import { awaitTreeConfigBoundary, treeBoundaryReason } from '@/service/config/treeBoundary.js'

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
export function configureRuntime(
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
 * 这是预期状态而非 bug。三态（见 docs/backend/service/chat.md「配置演化与 runtime 快照失效」）：
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

export interface SessionRoleRuntimeOptions {
  /** Create a new immutable context epoch only for an actual semantic change. */
  rotateEpoch?: boolean
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
  options: SessionRoleRuntimeOptions = {},
): Promise<SessionRoleRuntimeResult> {
  const current = await ensureChat(chatId)
  if (current.isRunning() || treeBoundaryReason(chatId)) {
    throw new Error('主 Agent 正在运行，必须先到达安全检查点再修改角色编制')
  }
  const previous = sessionRoleRuntimes.get(chatId)
  sessionRoleRuntimes.set(chatId, { primary, roles })
  if (!options.rotateEpoch) return { applied: [], deferredRunning: [] }
  let prepared: ReturnType<typeof prepareTreeRuntimeRefresh>
  let epoch: ChatEpochRecord
  try {
    getSoulDb().transaction(() => {
      prepared = prepareTreeRuntimeRefresh(chatId)
      epoch = rotateActiveChatEpoch({
        chatId,
        transitionReason: 'session-runtime-changed',
        handoffSummary: '会话级运行配置已在节点树安全边界更新；历史对话与子任务保留。',
      })
      for (const snapshot of prepared.snapshots)
        freezeChatEpochSnapshot({
          ...snapshot,
          epochId: epoch.epochId,
          runtime: snapshot.selection as unknown as Record<string, unknown>,
          resources: ensureCurrentConfigRevision().resources,
        })
    })()
  } catch (error) {
    if (previous) sessionRoleRuntimes.set(chatId, previous)
    else sessionRoleRuntimes.delete(chatId)
    throw error
  }
  prepared!.publish(epoch!.epochId)
  return { applied: prepared!.snapshots.map((snapshot) => snapshot.chatId), deferredRunning: [] }
}

/**
 * 从 DB 加载历史消息，交给 builder.init 注入 middleware 内存。
 * 仅 ensureChat 创建时调用一次，send/resume 不再重复加载。
 *
 * 跨纪元全量加载（docs/shared/architecture/context-epochs.md「历史连续性与兼容投影」）：
 * 历史消息是会话的完整事实，不按 epoch_id 过滤；配置变更只更换系统提示词与工具契约，
 * 对话内容一个字不动。过渡期 v1 纪元隔离实现落库的 <epoch_carryover> 消息在加载时过滤
 * （其内容是旧纪元投影摘要，与全量加载的原文冗余；DB 行保留供审计）。
 */
export function loadHistory(chatId: string, epoch: ChatEpochRecord): LLMResponse[] | undefined {
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
  const handoffMessage: LLMResponse | undefined = epoch.handoffSummary
    ? {
        id: `epoch-transition:${epoch.epochId}`,
        role: 'system',
        content:
          `<epoch_transition epoch="${epoch.ordinal}">\n` +
          `${epoch.handoffSummary}\n` +
          '配置快照已切换：仅系统提示词与工具契约更换为当前版本，以上历史对话完整保留并继续有效；' +
          '历史中出现的角色与工具以当时事实为准，不得假定其当前仍存在。\n' +
          '</epoch_transition>',
        createdAt: epoch.createdAt,
        updateAt: epoch.createdAt,
      }
    : undefined
  const prefix = [contextMessage, handoffMessage].filter(
    (message): message is LLMResponse => !!message,
  )
  if (rows.length === 0) return prefix.length > 0 ? prefix : undefined
  const parsedRows = rows
    .map((row) => {
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
        modelExcluded: parsed.modelExcluded,
        contextCompaction: parsed.contextCompaction,
        contextCompactionTokens: parsed.contextCompactionTokens,
        createdAt: row.created_at,
        updateAt: row.created_at,
      }
    })
    // 兼容投影·过渡期过滤：v1 纪元隔离实现落库的 <epoch_carryover> 投影摘要
    // 与跨纪元全量加载的原文冗余，进入 LLM 上下文前剔除（DB 行保留供审计）。
    .filter((message) => !message.content.startsWith('<epoch_carryover'))
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
  if (summaryIdx === -1) return [...prefix, ...parsedRows]
  const latestSummary = parsedRows[summaryIdx]!
  return [
    ...prefix,
    {
      ...latestSummary,
      role: 'system',
      content: `以下是此前对话压缩后的上下文摘要。将其视为后续工作的唯一历史上下文：\n\n${extractSummaryBlock(latestSummary.content)}`,
    },
    ...parsedRows.slice(summaryIdx + 1),
  ]
}

export function chatInitOptions(
  chatId: string,
  messages: LLMResponse[] | undefined,
  frozenSystemPrompt: string,
): AgentChatInitOptions {
  return {
    messages,
    systemPromptFile: getChatSystemPromptFile(chatId),
    workspace: getChatWorkspace(chatId),
    skillFilter: getChatSkillFilter(chatId),
    roleMentions: getChatMentionableRoles(chatId),
    historyGenerations: computeHistoryGenerationInfos(chatId),
    frozenSystemPrompt,
  }
}

/** Do not advance one sibling's epoch outside the tree's configuration boundary. */
function resolveExecutableEpoch(chatId: string): {
  epoch: ChatEpochRecord
  revision: ReturnType<typeof ensureCurrentConfigRevision>
} {
  const revision = ensureCurrentConfigRevision()
  const previousEpoch = getActiveChatEpoch(chatId)
  const revisionId = isStartupConfigBoundary()
    ? revision.revisionId
    : (previousEpoch?.revisionId ?? revision.revisionId)
  if (previousEpoch && previousEpoch.revisionId !== revisionId) {
    const reason = treeBoundaryReason(chatId)
    if (reason) throw new Error(reason)
  }
  // Existing epochs are advanced by the tree transaction, never by a read/send
  // on one member while a sibling still owns the previous contract.
  const transition = ensureActiveChatEpoch({
    chatId,
    revisionId,
    transitionReason: previousEpoch ? 'configuration-changed' : 'created',
    ...(previousEpoch && previousEpoch.revisionId !== revision.revisionId
      ? {
          handoffSummary:
            `系统已从纪元 ${previousEpoch.ordinal} 切换到当前配置修订。` +
            '仅系统提示词与工具契约更换为当前版本，历史对话完整保留并继续参与上下文；' +
            '后续任务使用当前角色编制执行。',
        }
      : {}),
  })
  const epoch = transition.epoch
  assertEpochExecutable(chatId, epoch.epochId)

  return { epoch, revision }
}

function reuseChatRuntime(
  chatId: string,
  epoch: ChatEpochRecord,
  selection: RuntimeSelection | undefined,
): AgentBuilder | undefined {
  let existing = chatRuntimes.get(chatId)
  if (existing?.epochId && existing.epochId !== epoch.epochId) {
    if (existing.builder.isRunning()) {
      throw new Error('配置纪元正在切换，请在节点树安全边界后重试')
    }
    existing.builder.dispose()
    chatRuntimes.delete(chatId)
    ephemeralChatRuntimes.delete(chatId)
    existing = undefined
  }
  if (existing) {
    // A queued input joins the active generator. Reconfiguring here would mutate
    // its global/runtime snapshot halfway through the run.
    if (existing.builder.isRunning()) return existing.builder
    if (selection) {
      configureRuntime(existing, chatId, selection)
    } else {
      // 每轮都重建 runtime：除拾取 registry 变更外，还让角色权限配置在下一次调用立即生效。
      // 重建在 loop 启动前，ctx.runtime 引用替换安全（generator 尚未运行）。
      const sel = existing.selection
      if (sel) configureRuntime(existing, chatId, sel, false)
    }
    return existing.builder
  }

  return undefined
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
  assertAgentExecutionAllowed()
  await awaitTreeConfigBoundary(chatId)
  assertRestartAdmission(isRestartDraining() && !!treeBoundaryReason(chatId, true))
  const { epoch, revision } = resolveExecutableEpoch(chatId)
  const reused = reuseChatRuntime(chatId, epoch, selection)
  if (reused) return reused
  return initializeChatRuntime(chatId, selection, epoch, revision)
}

function initializeChatRuntime(
  chatId: string,
  selection: RuntimeSelection | undefined,
  epoch: ChatEpochRecord,
  revision: ReturnType<typeof ensureCurrentConfigRevision>,
): AgentBuilder {
  const builder = new AgentBuilder().build()

  const runtime: ChatRuntime = { builder, epochId: epoch.epochId }
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
    const selectionForSnapshot = runtime.selection
    if (!selectionForSnapshot) throw new Error(`会话 ${chatId} 缺少运行配置`)
    let frozen = getFrozenChatSnapshot(epoch.epochId, chatId)
    if (!frozen) {
      const live = buildLivePromptSnapshot(chatId, selectionForSnapshot)
      const metadata = getChatMetadata(chatId)
      frozen = freezeChatEpochSnapshot({
        epochId: epoch.epochId,
        chatId,
        ...(typeof metadata.roleId === 'string' ? { roleId: metadata.roleId } : {}),
        ...(getChatType(chatId) ? { roleName: getChatType(chatId) } : {}),
        systemPrompt: live.systemPrompt,
        tools: live.tools,
        runtime: selectionForSnapshot as unknown as Record<string, unknown>,
        resources: { ...revision.resources, workflow: live.resourceSummary },
      })
    }
    const history = loadHistory(chatId, epoch)
    builder.init(chatId, chatInitOptions(chatId, history, frozen.systemPrompt))
    if (hasWorkflowObserver(chatId)) {
      const messages = builder.getMessages()
      reportWorkflow(chatId, {
        activeNodeId: 'context',
        phaseLabel: history?.length ? '上下文已恢复' : '上下文已准备',
        epochId: epoch.epochId,
        contextStageId: workflowStageId(
          chatId,
          messages.findLast((message) => message.role === 'system' && message.contextCompaction)
            ?.id,
        ),
        resources: { ...workflowResources(chatId), ...effectiveSkillCount(memoryRows(messages)) },
      })
    }
    // Restore accepted command-plane inputs that were acknowledged before a
    // process restart. If the user message already reached the durable history,
    // mark it consumed instead of enqueueing a duplicate.
    // Deduplicate against every immutable epoch, not only the active context.
    // A crash may commit the user message immediately before an epoch boundary;
    // replaying it into the new epoch would execute the same command twice.
    const existingMessageIds = new Set(getMessages(chatId).map((message) => message.id))
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
    builder.dispose()
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
  if (runtime.builder.isRunning() || treeBoundaryReason(chatId)) {
    throw new Error('Agent 正在运行，必须先到达安全检查点再修改运行配置')
  }
  if (JSON.stringify(runtime.selection) === JSON.stringify(selection)) return
  rotateActiveChatEpoch({
    chatId,
    transitionReason: 'runtime-changed',
    handoffSummary:
      '用户修改了 Agent 的大脑或工具运行配置。' +
      '仅系统提示词与工具契约更换为当前版本，历史对话完整保留并继续参与上下文；' +
      '旧纪元工具调用仅作为历史事实。',
  })
  runtime.builder.dispose()
  chatRuntimes.delete(chatId)
  ephemeralChatRuntimes.delete(chatId)
  await ensureChat(chatId, selection)
}

/**
 * 将 chatId 从运行时缓存移除（删除 chat 时调用）
 */
export function clearChatRuntime(chatId: string): void {
  chatRuntimes.get(chatId)?.builder.dispose()
  chatRuntimes.delete(chatId)
  sessionRoleRuntimes.delete(chatId)
  ephemeralChatRuntimes.delete(chatId)
}
