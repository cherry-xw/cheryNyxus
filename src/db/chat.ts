import { getSoulDb, getMonthlyDb } from './index.js'
import { safeJsonParse } from '@/utils/json.js'

export interface ChatRow {
  id: string
  messages_month: string
  created_at: number
  updated_at: number
  metadata: string | null
  message_count: number
  /**
   * 角色（子 pet）关联主 chat 的 chatId；主 chat 为 NULL。
   * 可选：旧库未补列前查询结果可能缺该字段（CREATE 后 ensureChatColumn 已统一补，运行时恒存在）。
   */
  parent_chat_id?: string | null
}

export interface MessageRow {
  id: string
  chat_id: string
  role: string
  content: string | null
  thinking: string | null
  sense_calls: string | null
  hash: string | null
  replace_state: number | null
  replace_by: string | null
  replace_content: string | null
  original_content: string | null
  revoked: number
  created_at: number
  /** JSON {brain,senseGroup,mcpServers}，仅 user 消息记（发送时配置）；assistant/sense 为 null */
  runtime: string | null
  context_compaction?: number | null
  context_compaction_tokens?: number | null
}

export interface MessageData {
  role: 'user' | 'assistant' | 'system' | 'sense' | 'role' | 'subagent' // role=新（子 pet 回复）；subagent 仅旧历史消息兼容读
  content?: string
  thinking?: string
  senseCall?: Array<{
    id: string
    name: string
    arguments: string
  }>
  hash?: string
  replace?: {
    state: boolean
    by: string
    content: string
  }
  originalContent?: string
  revoked?: boolean
  /** 仅 user 消息传（发送时配置，记入 messages.runtime）；assistant/sense 不传 */
  runtime?: { brain: string; senseGroup: string; mcpServers: string[] }
  contextCompaction?: boolean
  contextCompactionTokens?: number
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
 * 断言写操作命中 ≥1 行，否则抛错（规则12：失败显性化，禁静默 0 行）。
 * better-sqlite3 RunResult.changes 反映受影响行数；UPDATE/DELETE 命中 0 行多为
 * chat/messageId 不匹配等隐性 bug（如 fillApprovalResult 旧实现落错库致 content 永久 NULL）。
 * 用结构类型 { changes: number } 免 import better-sqlite3 类型。
 */
function assertChanged(result: { changes: number }, context: string): void {
  if (result.changes === 0) {
    throw new Error(`[db] ${context}: 0 rows affected (expected ≥1)`)
  }
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

  const stmt = db.prepare(`
    INSERT INTO chats (id, messages_month, created_at, updated_at, metadata, parent_chat_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    chatId,
    messagesMonth,
    now,
    now,
    metadata ? JSON.stringify(metadata) : null,
    parentChatId ?? null,
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
    parent_chat_id: parentChatId ?? null,
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
 * 更新聊天时间戳
 */
export function updateChat(chatId: string): void {
  const db = getSoulDb()
  const result = db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(Date.now(), chatId)
  assertChanged(result, `updateChat(${chatId})`)
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
export function getChatRuntimeSelection(
  chatId: string,
): { brain: string; senseGroup: string; mcpServers: string[] } | undefined {
  const db = getSoulDb()
  const row = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as
    { metadata: string | null } | undefined
  if (!row?.metadata) return undefined
  const parsed = safeJsonParse(row.metadata, {}) as Record<string, unknown>
  const rt = parsed.runtime as
    | { brain?: string; senseGroup?: string; senseGroups?: string[]; mcpServers?: string[] }
    | undefined
  if (!rt?.brain) return undefined
  // 单组化：读 senseGroup（新）；兼容旧行 senseGroups[]（取首项）。无迁移脚本，旧 chat 继续可用。
  const senseGroup =
    rt.senseGroup ?? (Array.isArray(rt.senseGroups) ? rt.senseGroups[0] : undefined)
  if (!senseGroup) return undefined
  // mcpServers 缺省 []：旧 chat metadata 无此字段，视为未启用任何 MCP server（向后兼容）
  const mcpServers = Array.isArray(rt.mcpServers) ? rt.mcpServers : []
  return { brain: rt.brain, senseGroup, mcpServers }
}

/**
 * 读取持久化的 per-agent system prompt 路径（metadata.promptPathOverride）。
 * 来源：spawn_role sense createChat（角色，来自 config.roles[type].systemPrompt）
 *   或 chat.create 预设主 agent（取 leader 角色 systemPrompt，来自 config.roles[leader].systemPrompt）。
 * ensureChat 据此传 builder.init 的 promptPathOverride；缺省（非预设主 agent / 旧 chat）→ undefined → 全局 prompt。
 * 字段名通用化（T6）：原 subagentPromptPath 仅子 agent 用，预设主 agent 亦需此机制，统一为 promptPathOverride。
 */
export function getChatPromptOverride(chatId: string): string | undefined {
  const db = getSoulDb()
  const row = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as
    { metadata: string | null } | undefined
  if (!row?.metadata) return undefined
  const parsed = safeJsonParse(row.metadata, {}) as Record<string, unknown>
  const p = parsed.promptPathOverride
  if (typeof p !== 'string' || p.length === 0) return undefined
  // 历史兼容：旧 chat metadata 曾存 `.chery/prompts/...`（有 s），但实际目录是 `.chery/prompt/`（无 s）。
  // 规范化为当前目录名，避免 existsSync 失败导致 userSystem 段显示 0。
  return p.replace(/\/\.chery\/prompts\//, '/.chery/prompt/')
}

/**
 * 读取持久化的 per-role 技能组/插件组过滤（metadata.skillFilter = {skills?, plugins?}）。
 * 来源：spawn_role sense（config.roles[type].skills/plugins）或 chat.create 预设主 agent（leader 角色）。
 * ensureChat 据此传 builder.init 的 skillFilter → buildFirstSystemPrompt 仅注入选中的 skill。
 * 任一维度缺省（undefined）= 该维度全部通过；二者皆缺省 → 返回 undefined（全部 skill，向后兼容）。
 * 快照于 chat 创建时（"编制运行后不可改"，同 promptPathOverride）。
 */
export function getChatSkillFilter(
  chatId: string,
): { skills?: string[]; plugins?: string[] } | undefined {
  const db = getSoulDb()
  const row = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as
    { metadata: string | null } | undefined
  if (!row?.metadata) return undefined
  const parsed = safeJsonParse(row.metadata, {}) as Record<string, unknown>
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
 * 读取 chat 关联的预设名（metadata.preset）。chat.create 选预设时写入。
 * 仅溯源展示 + spawn 解析角色 roster 用；主 agent 运行编制靠 metadata.runtime 快照（不回读预设）。
 * 缺省（非预设主 agent / 子 agent / 旧 chat）→ undefined。
 */
export function getChatPreset(chatId: string): string | undefined {
  const db = getSoulDb()
  const row = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as
    { metadata: string | null } | undefined
  if (!row?.metadata) return undefined
  const parsed = safeJsonParse(row.metadata, {}) as Record<string, unknown>
  const p = parsed.preset
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

/**
 * 读取 chat 选中的角色 type 列表（metadata.spawnTypes，string[]）。
 * chat.create 选预设时快照写入（编制锁定一致）；spawn_role roster gate 用（preset chat 限制可 spawn 类型）。
 * 缺省（子 chat 无 preset / 旧主 chat 无此字段）→ undefined → spawn gate 走全集（child）或 live preset 回退（旧主 chat）。
 */
export function getChatSpawnTypes(chatId: string): string[] | undefined {
  const db = getSoulDb()
  const row = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as
    { metadata: string | null } | undefined
  if (!row?.metadata) return undefined
  const parsed = safeJsonParse(row.metadata, {}) as Record<string, unknown>
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
  const db = getSoulDb()
  const row = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as
    { metadata: string | null } | undefined
  if (!row?.metadata) return undefined
  const parsed = safeJsonParse(row.metadata, {}) as Record<string, unknown>
  const ws = parsed.workspace
  return typeof ws === 'string' && ws.length > 0 ? ws : undefined
}

/**
 * 删除聊天（手动清理 messages）
 * 跨库无事务：先删 messages 再删 chat，try/finally 保证 chat 行删除，
 * 崩溃风险仅留 chat 行未删的孤儿（指向已空 messages 库），可接受。
 */
export function deleteChat(chatId: string): void {
  const soulDb = getSoulDb()

  // 1. 查询 messages_month
  const chatStmt = soulDb.prepare('SELECT messages_month FROM chats WHERE id = ?')
  const chat = chatStmt.get(chatId) as { messages_month: string } | undefined

  if (!chat) return

  // 2. 先删 messages（跨库），finally 删 chat 行避免中途崩溃留孤儿 chat 指向空库
  try {
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
  } finally {
    const stmt = soulDb.prepare('DELETE FROM chats WHERE id = ?')
    stmt.run(chatId)
  }
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
 * preview 单行规范化（CP8）：折叠空白 + 截断 ≤40 字符。
 * TODO(CP8 "指令"跳过)：当前默认取首条 user 消息（isDirective=false）。
 *   定义指令标记后，改为取首条「非指令」user 消息（需查多条 user 消息）。
 */
function normalizePreview(content: string | null): string {
  if (!content) return ''
  return content.replace(/\s+/g, ' ').trim().slice(0, 40)
}

/**
 * 批量取 chat 的会话列表 preview + turnCount（CP8）。
 * 按 messages_month 分组（消息按月分片，跨月分别查），每 group 一条 SQL：
 *   首条 user 消息 content（相关子查询 MIN created_at）+ user 消息计数。
 * 返回 Map<chatId, {preview, turnCount}>；无 user 消息的 chat 默认 {preview:"",turnCount:0}。
 *
 * 仅 chat.list includePreview=true 调用（会话列表渲染，on-demand）；initFromChats 走 lean 免 N+1。
 */
export function getChatPreviews(
  chats: ChatRow[],
): Map<string, { preview: string; turnCount: number }> {
  const result = new Map<string, { preview: string; turnCount: number }>()
  // 全部 chat 先初始化默认值（无 user 消息的 chat 也有条目）
  for (const c of chats) {
    result.set(c.id, { preview: '', turnCount: 0 })
  }
  if (chats.length === 0) return result

  // 按 messages_month 分组
  const byMonth = new Map<string, string[]>()
  for (const c of chats) {
    if (!c.messages_month) continue
    const arr = byMonth.get(c.messages_month)
    if (arr) arr.push(c.id)
    else byMonth.set(c.messages_month, [c.id])
  }

  for (const [month, chatIds] of byMonth) {
    const monthlyDb = getMonthlyDb(month)
    const placeholders = chatIds.map(() => '?').join(',')
    const rows = monthlyDb
      .prepare(
        `SELECT m.chat_id AS chatId,
          (SELECT m2.content FROM messages m2
            WHERE m2.chat_id = m.chat_id AND m2.role = 'user'
            ORDER BY m2.created_at ASC LIMIT 1) AS firstContent,
          COUNT(*) AS turnCount
         FROM messages m
         WHERE m.role = 'user' AND m.chat_id IN (${placeholders})
         GROUP BY m.chat_id`,
      )
      .all(...chatIds) as {
      chatId: string
      firstContent: string | null
      turnCount: number
    }[]

    for (const r of rows) {
      result.set(r.chatId, {
        preview: normalizePreview(r.firstContent),
        turnCount: r.turnCount,
      })
    }
  }
  return result
}

/**
 * 添加消息（路由到月份文件）
 */
export function addMessage(messageId: string, chatId: string, data: MessageData): MessageRow {
  // 1. 获取 chat 的 messages_month
  const soulDb = getSoulDb()
  const chatStmt = soulDb.prepare('SELECT messages_month FROM chats WHERE id = ?')
  const chat = chatStmt.get(chatId) as { messages_month: string } | undefined

  if (!chat) throw new Error(`Chat ${chatId} not found`)

  // 2. messageId 由调用方传入（checkpoint/loadHistory 生成），直接使用
  const finalMessageId = messageId

  // 3. 路由到月份文件并插入 message
  const monthlyDb = getMonthlyDb(chat.messages_month)
  const now = Date.now()

  const stmt = monthlyDb.prepare(`
    INSERT INTO messages (id, chat_id, role, content, thinking, sense_calls, hash, replace_state, replace_by, replace_content, original_content, revoked, created_at, runtime, context_compaction, context_compaction_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    finalMessageId,
    chatId,
    data.role,
    data.content ?? null,
    data.thinking ?? null,
    data.senseCall ? JSON.stringify(data.senseCall) : null,
    data.hash ?? null,
    data.replace?.state ? 1 : 0,
    data.replace?.by ?? null,
    data.replace?.content ?? null,
    data.originalContent ?? null,
    data.revoked ? 1 : 0,
    now,
    data.runtime ? JSON.stringify(data.runtime) : null,
    data.contextCompaction ? 1 : 0,
    data.contextCompactionTokens ?? null,
  )

  // P1-8：维护冗余 message_count，chatList 无需 N+1 查 messages
  const countResult = soulDb
    .prepare('UPDATE chats SET message_count = message_count + 1 WHERE id = ?')
    .run(chatId)
  assertChanged(countResult, `addMessage count (${chatId})`)

  updateChat(chatId)

  return {
    id: finalMessageId,
    chat_id: chatId,
    role: data.role,
    content: data.content ?? null,
    thinking: data.thinking ?? null,
    sense_calls: data.senseCall ? JSON.stringify(data.senseCall) : null,
    hash: data.hash ?? null,
    replace_state: data.replace?.state ? 1 : 0,
    replace_by: data.replace?.by ?? null,
    replace_content: data.replace?.content ?? null,
    original_content: data.originalContent ?? null,
    revoked: data.revoked ? 1 : 0,
    created_at: now,
    runtime: data.runtime ? JSON.stringify(data.runtime) : null,
    context_compaction: data.contextCompaction ? 1 : 0,
    context_compaction_tokens: data.contextCompactionTokens ?? null,
  }
}

/**
 * 获取消息（路由到月份文件）
 */
export function getMessages(chatId: string): MessageRow[] {
  // 1. 获取 chat 的 messages_month
  const soulDb = getSoulDb()
  const chatStmt = soulDb.prepare('SELECT messages_month FROM chats WHERE id = ?')
  const chat = chatStmt.get(chatId) as { messages_month: string } | undefined

  if (!chat) return []

  // 2. 路由到月份文件
  const monthlyDb = getMonthlyDb(chat.messages_month)

  // 3. 查询 messages
  const stmt = monthlyDb.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC')
  return stmt.all(chatId) as MessageRow[]
}

/**
 * 获取 chat 末条非 revoked 消息（用于 canResume 判定，避免全量加载）
 * 返回 null 表示 chat 不存在或无可见消息
 */
export function getLastMessage(chatId: string): MessageRow | null {
  const soulDb = getSoulDb()
  const chat = soulDb.prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as
    { messages_month: string } | undefined
  if (!chat) return null

  const monthlyDb = getMonthlyDb(chat.messages_month)
  const stmt = monthlyDb.prepare(
    'SELECT * FROM messages WHERE chat_id = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1',
  )
  return (stmt.get(chatId) as MessageRow) ?? null
}

/**
 * 填充审批结果（更新 content / hash 字段）
 * 按 chatId 路由月份库（与 addMessage/getMessages 同源），消除对 messageId 月份前缀的依赖：
 * confirm pending sense 的 messageId = trigger.id（LLM tool_call.id 或 sense-${index}），无月份前缀，
 * 旧实现 substring(0,7) 会落到错误空库、UPDATE 命中 0 行 → content 永远 NULL。
 */
export function fillApprovalResult(
  chatId: string,
  messageId: string,
  fields: { content?: string; hash?: string },
): void {
  const soulDb = getSoulDb()
  const chat = soulDb.prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as
    { messages_month: string } | undefined
  if (!chat) return

  const monthlyDb = getMonthlyDb(chat.messages_month)

  const sets: string[] = []
  const vals: unknown[] = []
  if (fields.content !== undefined) {
    sets.push('content = ?')
    vals.push(fields.content)
  }
  if (fields.hash !== undefined) {
    sets.push('hash = ?')
    vals.push(fields.hash)
  }
  if (sets.length === 0) return

  const result = monthlyDb
    .prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals, messageId)
  assertChanged(result, `fillApprovalResult(${chatId}/${messageId})`)
}

/**
 * 补充 assistant 消息的 sense_calls 字段（流式多 sense_call reconcile）。
 *
 * 流式场景首个 sense_end 时 checkpointState.flushAssistant 写入的 senseCalls 可能不全
 * （OpenAI 流式 delta 分散到达），流结束后由 CheckpointState.reconcileAssistantSenseCalls
 * 比对补充。observer 收到 patch.kind="content" + senseCalls 时调此函数持久化。
 *
 * 按 chatId 路由月份库（与 fillApprovalResult 同源），assembleContent 仅做 JSON.stringify 序列化。
 */
export function updateAssistantSenseCalls(
  chatId: string,
  messageId: string,
  senseCalls: Array<{ id: string; name: string; arguments: string }>,
): void {
  const soulDb = getSoulDb()
  const chat = soulDb.prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as
    { messages_month: string } | undefined
  if (!chat) return

  const monthlyDb = getMonthlyDb(chat.messages_month)
  const result = monthlyDb
    .prepare('UPDATE messages SET sense_calls = ? WHERE id = ?')
    .run(JSON.stringify(senseCalls), messageId)
  assertChanged(result, `updateAssistantSenseCalls(${chatId}/${messageId})`)
}

/**
 * 批量标记消息 revoked（chat.resume 撤回时持久化）
 */
export function markMessagesRevoked(chatId: string, messageIds: string[]): void {
  if (messageIds.length === 0) return
  const soulDb = getSoulDb()
  const chat = soulDb.prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as
    { messages_month: string } | undefined
  if (!chat) return

  const monthlyDb = getMonthlyDb(chat.messages_month)
  const placeholders = messageIds.map(() => '?').join(', ')
  const revoke = monthlyDb.transaction(() => {
    const result = monthlyDb
      .prepare(`UPDATE messages SET revoked = 1 WHERE id IN (${placeholders})`)
      .run(...messageIds)
    assertChanged(result, `markMessagesRevoked(${chatId}) ids=[${messageIds.join(',')}]`)

    // 新 prompt 撤回整个 trailing assistant/sense 周期时，同步关闭其问题批次。
    // 否则被撤回的旧问题会继续阻塞 canResume，并在刷新快照中重新出现。
    const now = Date.now()
    monthlyDb
      .prepare(
        `UPDATE question_items
       SET status = 'cancelled', answer_json = '{"cancelled":true}',
           answer_text = '(问题批次已被新消息取代)', answered_at = ?
       WHERE batch_id IN (
         SELECT batch_id FROM question_batches
         WHERE chat_id = ? AND assistant_message_id IN (${placeholders}) AND status = 'pending'
       ) AND status = 'pending'`,
      )
      .run(now, chatId, ...messageIds)
    monthlyDb
      .prepare(
        `UPDATE question_batches SET status = 'completed', completed_at = ?
       WHERE chat_id = ? AND assistant_message_id IN (${placeholders}) AND status = 'pending'`,
      )
      .run(now, chatId, ...messageIds)
  })
  revoke()
}

/**
 * 标记消息 replaced（感官去重命中时持久化 replace 状态）
 * 与 markMessagesRevoked 同源路由（按 chatId 定位月份库），
 * UPDATE replace_state/replace_by/replace_content/original_content，不动 content 字段（历史内容保持真实，replace 为元数据）。
 */
export function markMessageReplaced(
  chatId: string,
  messageId: string,
  fields: {
    content?: string
    replace: { state: boolean; by: string; content: string }
    originalContent?: string
  },
): void {
  const soulDb = getSoulDb()
  const chat = soulDb.prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as
    { messages_month: string } | undefined
  if (!chat) return

  const monthlyDb = getMonthlyDb(chat.messages_month)
  // content 可选：传入则更新（感官去重改写为短说明，剔除冗长重复内容）；
  // 未传则保留原 content，避免误清空。
  // 调用方（observer）经 AgentMessagePatch kind:"replace" 联合类型约束，replace patch 必携带 content，
  // 故运行时 replace 路径总会传 content（confirm/manual 不再因缺 content 导致 DB 保留旧长内容）。
  const sets = [
    'replace_state = ?',
    'replace_by = ?',
    'replace_content = ?',
    'original_content = ?',
  ]
  const vals: unknown[] = [
    fields.replace.state ? 1 : 0,
    fields.replace.by,
    fields.replace.content,
    fields.originalContent ?? null,
  ]
  if (fields.content !== undefined) {
    sets.push('content = ?')
    vals.push(fields.content)
  }
  const result = monthlyDb
    .prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals, messageId)
  assertChanged(result, `markMessageReplaced(${chatId}/${messageId})`)
}

/**
 * 解析消息行
 */
export function parseMessageRow(row: MessageRow): MessageData {
  return {
    role: row.role as MessageData['role'],
    content: row.content ?? undefined,
    thinking: row.thinking ?? undefined,
    senseCall: row.sense_calls ? safeJsonParse(row.sense_calls, undefined) : undefined,
    hash: row.hash ?? undefined,
    replace: row.replace_state
      ? { state: true, by: row.replace_by ?? '', content: row.replace_content ?? '' }
      : undefined,
    originalContent: row.original_content ?? undefined,
    revoked: row.revoked === 1,
    runtime: row.runtime
      ? safeJsonParse<
          | {
              brain: string
              senseGroup: string
              mcpServers: string[]
            }
          | undefined
        >(row.runtime, undefined)
      : undefined,
    contextCompaction: row.context_compaction === 1,
    contextCompactionTokens: row.context_compaction_tokens ?? undefined,
  }
}

/**
 * 对账 message_count：遍历 soul.db chats，按各自 messages_month 路由 COUNT 修正冗余计数列。
 *
 * 单 chat 消息只在一个分片（messages_month 创建时钉死，跨月不迁移），故 O(chats)、
 * 每 chat 1 次 COUNT、无 fan-out。修 addMessage 跨库写（monthly INSERT + soul count UPDATE）
 * 崩溃导致的漂移。启动期 + CLI 调用。
 *
 * @returns { checked, fixed } — checked 总 chat 数，fixed 修正的漂移数
 */
export function reconcileMessageCounts(): { checked: number; fixed: number } {
  const soulDb = getSoulDb()
  const chats = soulDb.prepare('SELECT id, messages_month, message_count FROM chats').all() as {
    id: string
    messages_month: string
    message_count: number
  }[]
  let fixed = 0
  for (const c of chats) {
    const monthlyDb = getMonthlyDb(c.messages_month)
    const row = monthlyDb
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?')
      .get(c.id) as { n: number }
    if (row.n !== c.message_count) {
      soulDb.prepare('UPDATE chats SET message_count = ? WHERE id = ?').run(row.n, c.id)
      fixed++
    }
  }
  return { checked: chats.length, fixed }
}
