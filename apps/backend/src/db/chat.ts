import { assertChanged } from './chatStorage.js'
import { getSoulDb, getMonthlyDb } from './index.js'
import path from 'path'
import { safeJsonParse } from '@/utils/json.js'
import config from '@/utils/config.js'
import type { ThinkingLevel } from '@/core/llm/adapter.js'

export interface ChatRow {
  id: string
  messages_month: string
  created_at: number
  updated_at: number
  metadata: string | null
  message_count: number
  timeline_revision?: number
  /**
   * 角色（子 pet）关联主 chat 的 chatId；主 chat 为 NULL。
   * 可选：旧库未补列前查询结果可能缺该字段（CREATE 后 ensureChatColumn 已统一补，运行时恒存在）。
   */
  parent_chat_id?: string | null
  active_epoch_id?: string | null
  lifecycle?: 'active' | 'retired' | 'abandoned' | 'archived'
}

/**
 * 格式化年份月份（YYYY-MM）
 * 用于 createChat 时确定该 chat 的 messages 分片月份（创建月固定，跨月不迁移）
 */
function formatYearMonth(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 创建聊天（无需 soulId）
 * messages_month 按创建时间固定，之后该 chat 所有消息都写入此月份分片（跨月不迁移）
 * parentChatId 可选：角色（子 pet）写主 chat 的 chatId，主 chat 留空（NULL）。
 */
export function createChat(
  chatId: string,
  metadata?: Record<string, unknown>,
  parentChatId?: string,
): ChatRow {
  const db = getSoulDb()
  const now = Date.now()
  const messagesMonth = formatYearMonth(now)
  const parentEpoch = parentChatId
    ? ((
        db.prepare('SELECT active_epoch_id FROM chats WHERE id = ?').get(parentChatId) as
          { active_epoch_id: string | null } | undefined
      )?.active_epoch_id ?? null)
    : null

  const stmt = db.prepare(`
    INSERT INTO chats
      (id, messages_month, created_at, updated_at, metadata, parent_chat_id, active_epoch_id, lifecycle)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `)

  stmt.run(
    chatId,
    messagesMonth,
    now,
    now,
    metadata ? JSON.stringify(metadata) : null,
    parentChatId ?? null,
    parentEpoch,
  )

  // 确保月份文件存在
  getMonthlyDb(messagesMonth)

  return {
    id: chatId,
    messages_month: messagesMonth,
    created_at: now,
    updated_at: now,
    metadata: metadata ? JSON.stringify(metadata) : null,
    message_count: 0,
    timeline_revision: 0,
    parent_chat_id: parentChatId ?? null,
    active_epoch_id: parentEpoch,
    lifecycle: 'active',
  }
}

/**
 * 获取聊天
 */
export function getChat(chatId: string): ChatRow | undefined {
  const db = getSoulDb()
  const stmt = db.prepare('SELECT * FROM chats WHERE id = ?')
  return stmt.get(chatId) as ChatRow | undefined
}

/**
 * 列出所有聊天（全局，不再按 soulId 过滤）
 */
export function listAllChats(): ChatRow[] {
  const db = getSoulDb()
  const stmt = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC')
  return stmt.all() as ChatRow[]
}

/**
 * Load only roots associated with the requested current presets. Filtering is
 * performed by SQLite so stage startup never materializes the historical root
 * catalog merely to discard unrelated entries in JavaScript.
 *
 * `excludeBranches` 剔除非 original 分支 root（conversation_branches kind != 'original'），
 * 与前端 isPianoRootSession（pianoNotes.ts）语义对齐——preset 分页目录用它，stage 不传保持现状。
 * `limit`/`offset` 仅显式提供时附加（preset 分页下拉用）；缺省返回全量，现有调用不变。
 */
export interface RootChatsForPresetsOptions {
  excludeBranches?: boolean
  limit?: number
  offset?: number
}

function buildRootPresetWhere(
  presets: ReadonlyArray<{ presetId?: string; preset?: string }>,
  options: RootChatsForPresetsOptions,
): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []
  for (const association of presets) {
    if (association.presetId && association.preset) {
      clauses.push(
        `(json_extract(metadata, '$.presetId') = ? OR (` +
          `json_extract(metadata, '$.presetId') IS NULL AND json_extract(metadata, '$.preset') = ?))`,
      )
      params.push(association.presetId, association.preset)
    } else if (association.presetId) {
      clauses.push(`json_extract(metadata, '$.presetId') = ?`)
      params.push(association.presetId)
    } else if (association.preset) {
      clauses.push(`json_extract(metadata, '$.preset') = ?`)
      params.push(association.preset)
    }
  }
  if (clauses.length === 0) return { where: '', params }
  const parts = [`parent_chat_id IS NULL`, `lifecycle != 'archived'`, `(${clauses.join(' OR ')})`]
  if (options.excludeBranches) {
    parts.push(
      `NOT EXISTS (SELECT 1 FROM conversation_branches cb WHERE cb.chat_id = chats.id AND cb.kind != 'original')`,
    )
  }
  return { where: parts.join(' AND '), params }
}

export function listRootChatsForPresets(
  presets: ReadonlyArray<{ presetId?: string; preset?: string }>,
  options: RootChatsForPresetsOptions = {},
): ChatRow[] {
  const { where, params } = buildRootPresetWhere(presets, options)
  if (!where) return []
  let sql = `SELECT * FROM chats WHERE ${where} ORDER BY updated_at DESC, created_at DESC`
  if (options.limit !== undefined) {
    sql += ` LIMIT ?`
    params.push(String(options.limit))
    if (options.offset !== undefined) {
      sql += ` OFFSET ?`
      params.push(String(options.offset))
    }
  }
  return getSoulDb()
    .prepare(sql)
    .all(...params) as ChatRow[]
}

/** 同 WHERE（含分支排除）的匹配总数，供 chat.list preset 分页 total。 */
export function countRootChatsForPresets(
  presets: ReadonlyArray<{ presetId?: string; preset?: string }>,
  options: RootChatsForPresetsOptions = {},
): number {
  const { where, params } = buildRootPresetWhere(presets, options)
  if (!where) return 0
  const row = getSoulDb()
    .prepare(`SELECT COUNT(*) AS total FROM chats WHERE ${where}`)
    .get(...params) as { total: number }
  return row.total
}

/** Return the selected roots and all descendants using one recursive catalog query. */
export function listChatTrees(rootChatIds: readonly string[]): ChatRow[] {
  if (rootChatIds.length === 0) return []
  const placeholders = rootChatIds.map(() => '?').join(', ')
  return getSoulDb()
    .prepare(
      `WITH RECURSIVE tree AS (
         SELECT * FROM chats WHERE id IN (${placeholders})
         UNION ALL
         SELECT child.* FROM chats child JOIN tree parent ON child.parent_chat_id = parent.id
       )
       SELECT * FROM tree ORDER BY created_at ASC`,
    )
    .all(...rootChatIds) as ChatRow[]
}

/** Return the current authoritative timeline revision for a chat. */
export function getTimelineRevision(chatId: string): number {
  const row = getSoulDb()
    .prepare('SELECT timeline_revision FROM chats WHERE id = ?')
    .get(chatId) as { timeline_revision?: number } | undefined
  return row?.timeline_revision ?? 0
}

/** Advance timeline revision after a committed message mutation. */
export function bumpTimelineRevision(chatId: string): number {
  const db = getSoulDb()
  const root = getRootChat(chatId)
  const now = Date.now()
  const result = db
    .prepare(
      'UPDATE chats SET timeline_revision = COALESCE(timeline_revision, 0) + 1, updated_at = ? WHERE id = ?',
    )
    .run(now, chatId)
  assertChanged(result, `bumpTimelineRevision(${chatId})`)
  if (root.id !== chatId) {
    const rootResult = db
      .prepare(
        'UPDATE chats SET timeline_revision = COALESCE(timeline_revision, 0) + 1, updated_at = ? WHERE id = ?',
      )
      .run(now, root.id)
    assertChanged(rootResult, `bumpTimelineRevision(root=${root.id})`)
  }
  // Existing per-chat timeline callers continue to receive the source chat
  // revision; root projections read the root chat's independently advanced
  // revision.
  return getTimelineRevision(chatId)
}

/**
 * 更新 chat metadata（JSON merge）。
 * patch 浅合并到现有 metadata，避免覆盖其他 key（未来扩展用途不冲突）。
 */
export function updateChatMetadata(chatId: string, patch: Record<string, unknown>): void {
  const db = getSoulDb()
  const row = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as
    { metadata: string | null } | undefined
  if (!row) return
  const current = row.metadata ? (safeJsonParse(row.metadata, {}) as Record<string, unknown>) : {}
  const next = { ...current, ...patch }
  const result = db
    .prepare('UPDATE chats SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(next), Date.now(), chatId)
  assertChanged(result, `updateChatMetadata(${chatId})`)
}

/**
 * 读取持久化的 runtime selection（metadata.runtime）。
 * 服务重启后内存 chatRuntimes 丢失，ensureChat 据此自动恢复 runtime。
 * brain/group 为 config.yaml 名称引用，恢复时实时 resolve（配置变更后自动用新配置）。
 */
export function getChatRuntimeSelection(chatId: string):
  | {
      brain: string
      senseGroup: string
      mcpServers: string[]
      thinking?: ThinkingLevel
    }
  | undefined {
  const parsed = getChatMetadata(chatId)
  const rt = parsed.runtime as
    | {
        brain?: string
        senseGroup?: string
        senseGroups?: string[]
        mcpServers?: string[]
        thinking?: ThinkingLevel
      }
    | undefined
  if (!rt?.brain) return undefined
  // 单组化：读 senseGroup（新）；兼容旧行 senseGroups[]（取首项）。无迁移脚本，旧 chat 继续可用。
  const senseGroup =
    rt.senseGroup ?? (Array.isArray(rt.senseGroups) ? rt.senseGroups[0] : undefined)
  if (!senseGroup) return undefined
  // mcpServers 缺省 []：旧 chat metadata 无此字段，视为未启用任何 MCP server（向后兼容）
  const mcpServers = Array.isArray(rt.mcpServers) ? rt.mcpServers : []
  // thinking 缺省不写字段：无临时覆盖时运行沿用大脑配置默认档位。
  return {
    brain: rt.brain,
    senseGroup,
    mcpServers,
    ...(rt.thinking !== undefined ? { thinking: rt.thinking } : {}),
  }
}

export function getChatMetadata(chatId: string): Record<string, unknown> {
  const row = getSoulDb().prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as
    { metadata: string | null } | undefined
  return row?.metadata ? (safeJsonParse(row.metadata, {}) as Record<string, unknown>) : {}
}

export function getChatBranchContext(chatId: string): string | undefined {
  const value = getChatMetadata(chatId).branchContext
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 读取持久化的 per-agent system prompt 路径（metadata.systemPromptFile）。
 * 来源：spawn_role sense createChat（角色，来自 config.roles[type].systemPrompt）
 *   或 chat.create 预设主 agent（取 leader 角色 systemPrompt，来自 config.roles[leader].systemPrompt）。
 * ensureChat 据此传 builder.init 的 systemPromptFile；缺省（非预设主 agent / 旧 chat）→ undefined → 全局 prompt。
 * 字段名演进：subagentPromptPath（T6 之前，仅子 agent）→ promptPathOverride（T6 通用化）→ systemPromptFile（语义修正：合并补充而非替换）。
 */
export function getChatSystemPromptFile(chatId: string): string | undefined {
  const parsed = getChatMetadata(chatId)
  const p = parsed.systemPromptFile
  if (typeof p !== 'string' || p.length === 0) return undefined
  // 历史兼容：旧 chat metadata 曾存 `.chery/prompts/...`（有 s），但实际目录是 `.chery/prompt/`（无 s）。
  // 规范化为当前目录名，避免 existsSync 失败导致 userSystem 段显示 0。
  const normalized = p.replace(/\/\.chery\/prompts\//, '/.chery/prompt/')
  // 兜底：历史配置热更新曾把配置原始相对路径（如 prompt/cheryNyxus/cheryNyxus.md）写入
  // metadata.systemPromptFile，运行时 existsSync 相对进程 cwd 解析不到 → 「systemPrompt 文件不存在」
  // 告警随每次 prompt 构建反复出现。按「相对 CHERY_DIR/.chery」解析为绝对路径
  // （与 config normalizeRuntimeConfig / validateRawConfig 同一基准；lazy 读取，兼容测试切目录）。
  return path.isAbsolute(normalized)
    ? normalized
    : path.join(process.env.CHERY_DIR || process.cwd(), '.chery', normalized)
}

/**
 * 读取持久化的 per-role 技能组/插件组过滤（metadata.skillFilter = {skills?, plugins?}）。
 * 来源：spawn_role sense（config.roles[type].skills/plugins）或 chat.create 预设主 agent（leader 角色）。
 * ensureChat 据此传 builder.init 的 skillFilter → buildFirstSystemPrompt 仅注入选中的 skill。
 * 任一维度缺省（undefined）= 该维度全部通过；二者皆缺省 → 返回 undefined（全部 skill，向后兼容）。
 * 快照于 chat 创建时（"编制运行后不可改"，同 systemPromptFile）。
 */
export function getChatSkillFilter(
  chatId: string,
): { skills?: string[]; plugins?: string[] } | undefined {
  const parsed = getChatMetadata(chatId)
  const f = parsed.skillFilter
  if (!f || typeof f !== 'object') return undefined
  const obj = f as Record<string, unknown>
  const asStrArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined
  const skills = asStrArr(obj.skills)
  const plugins = asStrArr(obj.plugins)
  if (skills === undefined && plugins === undefined) return undefined
  const filter: { skills?: string[]; plugins?: string[] } = {}
  if (skills !== undefined) filter.skills = skills
  if (plugins !== undefined) filter.plugins = plugins
  return filter
}

/**
 * 读取 chat 关联的预设名（ID 优先：metadata.presetId -> 当前 config 预设名；旧数据回退 metadata.preset 名）。
 * 仅溯源展示 + spawn 解析角色 roster 用；主 agent 运行编制靠 metadata.runtime 快照（不回读预设）。
 * 预设改名后此处返回新名（显示不 stale、roster 回退分支指向新键）。
 * 缺省（非预设主 agent / 子 agent / 旧 chat）→ undefined。
 */
export function getChatPreset(chatId: string): string | undefined {
  const parsed = getChatMetadata(chatId)
  // ID 优先：presetId -> 当前 config 预设名（改名后显示/关联均指向新名）；旧数据回退 metadata.preset 名
  const presetId = parsed.presetId
  if (typeof presetId === 'string' && presetId.length > 0) {
    const current = Object.entries(config.presets ?? {}).find(
      ([, preset]) => preset.id === presetId,
    )
    if (current?.[0]) return current[0]
  }
  const p = parsed.preset
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

/**
 * 读取 chat 自身的角色 type（self-spawn 禁止用：角色不能派发任务给自己）。
 * ID 优先（rename-safe）：metadata.roleId -> 当前 config.roles 内该 id 角色的当前名；找不到（角色已删/旧数据）回退名字链。
 * - 主 chat：无 type 字段 -> 回退 preset.leader（config.presets[preset].leader，主 chat 自身角色）。创建时快照 metadata.roleId 后优先走 ID。
 * 缺省（无 preset 的非子 chat / 未知）→ undefined → 不做 self 排除。
 */
export function getChatType(chatId: string): string | undefined {
  const parsed = getChatMetadata(chatId)
  // ID 优先（rename-safe）：roleId -> 按 id 在当前 config.roles 找角色，返回当前名。
  // 主 chat 创建时快照 leader 的 roleId（不回读 live preset.leader，改 leader 不影响历史主 chat 身份）；
  // 子 chat 由 spawn_role 写入 roleId + type（config.save 改名迁移保持同步）。
  const roleId = parsed.roleId
  if (typeof roleId === 'string' && roleId.length > 0) {
    const current = Object.entries(config.roles ?? {}).find(([, role]) => role.id === roleId)
    if (current?.[0]) return current[0]
  }
  const t = parsed.type
  if (typeof t === 'string' && t.length > 0) return t
  const presetName = parsed.preset
  const presetId = parsed.presetId
  if (typeof presetId === 'string' && presetId.length > 0) {
    const preset = Object.values(config.presets ?? {}).find(
      (candidate) => candidate.id === presetId,
    )
    if (preset?.leader) return preset.leader
  }
  if (typeof presetName === 'string' && presetName.length > 0) {
    const leader = config.presets?.[presetName]?.leader
    if (typeof leader === 'string' && leader.length > 0) return leader
  }
  return undefined
}

/**
 * 读取 chat 选中的角色 type 列表（metadata.spawnTypes，string[]）。
 * chat.create 选预设时快照写入（编制锁定一致）；spawn_role roster gate 用（preset chat 限制可 spawn 类型）。
 * 缺省（子 chat 无 preset / 旧主 chat 无此字段）→ undefined → spawn gate 走全集（child）或 live preset 回退（旧主 chat）。
 */
export function getChatSpawnTypes(chatId: string): string[] | undefined {
  const parsed = getChatMetadata(chatId)
  const arr = parsed.spawnTypes
  return Array.isArray(arr) ? (arr as string[]) : undefined
}

/**
 * 读取 chat 关联的项目工作目录（metadata.workspace）。
 * 来源：chat.create 选预设时快照写入（config.presets[preset].workspace）/ spawn_role 子 chat 继承主 chat。
 * 仅 buildFirstSystemPrompt 注入 system prompt 的 <workspace> 段用（不约束 sense 实际行为）。
 * 缺省（非预设主 agent / 预设未配 workspace / 旧 chat）→ undefined → 不注入该段。
 */
export function getChatWorkspace(chatId: string): string | undefined {
  const parsed = getChatMetadata(chatId)
  const ws = parsed.workspace
  return typeof ws === 'string' && ws.length > 0 ? ws : undefined
}

/**
 * 读取 chat 关联的 smart 监管规则覆盖文件名（metadata.rule）。
 * 来源：chat.create 选预设时快照写入（config.presets[preset].rule）/ spawn_role 子 chat 继承主 chat。
 * resolve 期与 .chery/rule/base.yaml 深合并成 sensitivityRules（供 isSafeSenseCall）。
 * 缺省（非预设主 agent / 预设未配 rule / 旧 chat）→ undefined → 仅用基准 base.yaml。
 */
export function getChatRule(chatId: string): string | undefined {
  const parsed = getChatMetadata(chatId)
  const r = parsed.rule
  return typeof r === 'string' && r.length > 0 ? r : undefined
}

function clearMonthlyChatData(chatId: string, chat: ChatRow): void {
  const monthlyDb = getMonthlyDb(chat.messages_month)
  const clear = monthlyDb.transaction(() => {
    monthlyDb
      .prepare(
        'DELETE FROM question_items WHERE batch_id IN (SELECT batch_id FROM question_batches WHERE chat_id = ?)',
      )
      .run(chatId)
    monthlyDb.prepare('DELETE FROM question_batches WHERE chat_id = ?').run(chatId)
    monthlyDb.prepare('DELETE FROM question_projection_meta WHERE chat_id = ?').run(chatId)
    monthlyDb.prepare('DELETE FROM chat_events WHERE chat_id = ?').run(chatId)
    monthlyDb.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId)
  })
  clear()
}

type ChatDeleteTarget = {
  chatId: string
  executionRootId: string
  workflowRootId: string
}

/** All soul.db dependent rows for one chat, inside the caller's transaction. */
function clearSoulChatData(
  soulDb: ReturnType<typeof getSoulDb>,
  { chatId, executionRootId, workflowRootId }: ChatDeleteTarget,
  mutatedWorkflowRoots: Set<string>,
): void {
  soulDb
    .prepare('DELETE FROM interactions WHERE chat_id = ? OR root_chat_id = ?')
    .run(chatId, chatId)
  soulDb
    .prepare(
      'DELETE FROM tree_control_targets WHERE chat_id = ? OR pause_id IN (SELECT pause_id FROM tree_control_operations WHERE root_chat_id = ?)',
    )
    .run(chatId, chatId)
  soulDb.prepare('DELETE FROM tree_control_operations WHERE root_chat_id = ?').run(chatId)
  soulDb
    .prepare(
      'DELETE FROM spawn_tasks WHERE child_chat_id = ? OR parent_chat_id = ? OR delivery_chat_id = ?',
    )
    .run(chatId, chatId, chatId)
  soulDb
    .prepare(
      'DELETE FROM execution_edges WHERE root_chat_id = ? AND (? = ? OR from_node_id IN (SELECT node_id FROM execution_nodes WHERE source_chat_id = ?) OR to_node_id IN (SELECT node_id FROM execution_nodes WHERE source_chat_id = ?))',
    )
    .run(executionRootId, chatId, executionRootId, chatId, chatId)
  soulDb
    .prepare('DELETE FROM execution_nodes WHERE root_chat_id = ? AND (? = ? OR source_chat_id = ?)')
    .run(executionRootId, chatId, executionRootId, chatId)
  soulDb.prepare('DELETE FROM execution_active_runs WHERE chat_id = ?').run(chatId)
  if (chatId === workflowRootId) {
    soulDb.prepare('DELETE FROM task_result_views WHERE task_key = ?').run(workflowRootId)
    soulDb.prepare('DELETE FROM workflow_step_events WHERE root_chat_id = ?').run(workflowRootId)
    soulDb.prepare('DELETE FROM workflow_occurrences WHERE root_chat_id = ?').run(workflowRootId)
    soulDb.prepare('DELETE FROM workflow_journal_gaps WHERE root_chat_id = ?').run(workflowRootId)
    soulDb.prepare('DELETE FROM workflow_journal_roots WHERE root_chat_id = ?').run(workflowRootId)
  } else {
    soulDb
      .prepare('DELETE FROM workflow_step_events WHERE root_chat_id = ? AND source_chat_id = ?')
      .run(workflowRootId, chatId)
    soulDb
      .prepare('DELETE FROM workflow_occurrences WHERE root_chat_id = ? AND source_chat_id = ?')
      .run(workflowRootId, chatId)
    soulDb
      .prepare('DELETE FROM workflow_journal_gaps WHERE root_chat_id = ? AND source_chat_id = ?')
      .run(workflowRootId, chatId)
    mutatedWorkflowRoots.add(workflowRootId)
  }
  if (chatId === executionRootId) {
    soulDb.prepare('DELETE FROM tool_call_owners WHERE root_chat_id = ?').run(executionRootId)
    soulDb
      .prepare('DELETE FROM execution_graph_counters WHERE root_chat_id = ?')
      .run(executionRootId)
  }
  soulDb
    .prepare(
      'DELETE FROM message_links WHERE source_chat_id = ? OR root_chat_id = ? OR parent_chat_id = ?',
    )
    .run(chatId, chatId, chatId)
  soulDb.prepare('DELETE FROM pending_inputs WHERE chat_id = ?').run(chatId)
  soulDb.prepare('DELETE FROM chat_epoch_snapshots WHERE chat_id = ?').run(chatId)
  if (chatId === executionRootId) {
    soulDb.prepare('DELETE FROM root_events WHERE root_chat_id = ?').run(chatId)
    soulDb.prepare('DELETE FROM chat_epochs WHERE root_chat_id = ?').run(chatId)
  }
  const branch = soulDb
    .prepare('SELECT task_id FROM conversation_branches WHERE chat_id = ?')
    .get(chatId) as { task_id: string } | undefined
  soulDb.prepare('DELETE FROM conversation_branches WHERE chat_id = ?').run(chatId)
  if (branch) {
    const remaining = soulDb
      .prepare('SELECT COUNT(*) AS count FROM conversation_branches WHERE task_id = ?')
      .get(branch.task_id) as { count: number }
    if (remaining.count === 0) {
      soulDb.prepare('DELETE FROM conversation_tasks WHERE task_id = ?').run(branch.task_id)
    }
  }
  const stmt = soulDb.prepare('DELETE FROM chats WHERE id = ?')
  stmt.run(chatId)
}

/** Bump surviving workflow roots once, within the same soul.db transaction. */
function updateWorkflowAfterChatDeletion(
  soulDb: ReturnType<typeof getSoulDb>,
  mutatedWorkflowRoots: Set<string>,
): void {
  for (const rootChatId of mutatedWorkflowRoots) {
    const root = soulDb
      .prepare('SELECT revision FROM workflow_journal_roots WHERE root_chat_id = ?')
      .get(rootChatId) as { revision: number } | undefined
    if (!root) continue
    soulDb
      .prepare(
        `UPDATE workflow_journal_roots SET revision = revision + 1, updated_at = ?
         WHERE root_chat_id = ?`,
      )
      .run(Date.now(), rootChatId)
  }
}

/** Clear monthly data first; failure retains ownership records for retry. */
export function deleteChats(chatIds: readonly string[]): void {
  const soulDb = getSoulDb()
  const mutatedWorkflowRoots = new Set<string>()
  const targets = chatIds.flatMap((chatId) => {
    const chat = getChat(chatId)
    if (!chat) return []
    const executionRootId = getRootChat(chatId).id
    const task = soulDb
      .prepare(
        `SELECT t.original_chat_id FROM conversation_branches b
         JOIN conversation_tasks t ON t.task_id = b.task_id WHERE b.chat_id = ?`,
      )
      .get(executionRootId) as { original_chat_id: string } | undefined
    return [
      {
        chatId,
        chat,
        executionRootId,
        workflowRootId: task?.original_chat_id ?? executionRootId,
      },
    ]
  })
  for (const { chatId, chat } of targets) clearMonthlyChatData(chatId, chat)
  soulDb.transaction(() => {
    for (const target of targets) clearSoulChatData(soulDb, target, mutatedWorkflowRoots)
    updateWorkflowAfterChatDeletion(soulDb, mutatedWorkflowRoots)
  })()
}

/** Internal rollback primitive; public deletion requires an archived family. */
export function deleteChat(chatId: string): void {
  deleteChats([chatId])
}

/**
 * 查主 chat 的所有子 chat（CP8：chat.delete 级联用）。
 * 按 parent_chat_id 索引查 soul.db（子 chat 与主 chat 同库，messages 各自按月分片）。
 */
export function findChatsByParent(parentChatId: string): ChatRow[] {
  const soulDb = getSoulDb()
  const stmt = soulDb.prepare('SELECT * FROM chats WHERE parent_chat_id = ?')
  return stmt.all(parentChatId) as ChatRow[]
}

/**
 * 递归收集 chat 的所有后代 chatId（子→孙→…，BFS，含 visited 防环）。
 * 统一暂停语义：主 chat abort/resume 级联所有后代用。不含 parentChatId 本身，仅返回后代。
 */
export function collectDescendantsChatIds(parentChatId: string): string[] {
  const result: string[] = []
  const visited = new Set<string>([parentChatId])
  const queue: string[] = [parentChatId]
  while (queue.length > 0) {
    const pid = queue.shift()!
    for (const child of findChatsByParent(pid)) {
      if (!visited.has(child.id)) {
        visited.add(child.id)
        result.push(child.id)
        queue.push(child.id)
      }
    }
  }
  return result
}

/** Get the root chat; keep missing-parent and cycle behavior for existing families. */
export function getRootChat(chatId: string): ChatRow {
  let current = getChat(chatId)
  if (!current) throw new Error(`Chat ${chatId} not found`)
  const seen = new Set<string>()
  while (current.parent_chat_id && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = getChat(current.parent_chat_id)
    if (!parent) break
    current = parent
  }
  return current
}

/** Root chat identity for root-scoped event journals and subscriptions. */
export function getRootChatId(chatId: string): string {
  return getRootChat(chatId).id
}
