import { getSoulDb, getMonthlyDb } from './index.js'
import { bumpTimelineRevision } from './chat.js'
import type { ChatRow } from './chat.js'
import { defaultMessageLink, upsertMessageLink } from './messageLink.js'
import type { MessageLinkData } from './messageLink.js'
import { safeJsonParse } from '@/utils/json.js'
import type { ThinkingBlock } from '@/core/message/adapter.js'
import type { ToolAuthorization } from '@/core/security/index.js'
import { assertChanged, getChatMonthlyDb } from './chatStorage.js'

export interface MessageRow {
  id: string
  chat_id: string
  role: string
  content: string | null
  thinking: string | null
  /** JSON 序列化的 ThinkingBlock[]（Anthropic 扩展思考完整块） */
  thinking_blocks: string | null
  sense_calls: string | null
  hash: string | null
  replace_state: number | null
  replace_by: string | null
  replace_content: string | null
  original_content: string | null
  revoked: number
  model_excluded: number
  created_at: number
  /** JSON {brain,senseGroup,mcpServers}，仅 user 消息记（发送时配置）；assistant/sense 为 null */
  runtime: string | null
  context_compaction?: number | null
  context_compaction_tokens?: number | null
  /** Immutable context epoch that owned this message. */
  epoch_id?: string | null
}

export interface MessageData {
  role: 'user' | 'assistant' | 'system' | 'sense' | 'role' | 'subagent' // role=新（子 pet 回复）；subagent 仅旧历史消息兼容读
  content?: string
  thinking?: string
  /** Anthropic 扩展：thinking 完整块（含 signature）；JSON 列反序列化 */
  thinkingBlocks?: ThinkingBlock[]
  senseCall?: Array<{
    index?: number
    id: string
    name: string
    arguments: string
    /** 该工具调用的安全授权判定（authorizeToolCall 输出原样 JSON round-trip；缺省 = 旧数据无判定） */
    security?: ToolAuthorization
  }>
  hash?: string
  replace?: {
    state: boolean
    by: string
    content: string
  }
  originalContent?: string
  revoked?: boolean
  modelExcluded?: boolean
  /** 仅 user 消息传（发送时配置，记入 messages.runtime）；assistant/sense 不传。brainModel/brainProvider 为溯源快照（展示用）。 */
  runtime?: {
    brain: string
    senseGroup: string
    mcpServers: string[]
    brainModel?: string
    brainProvider?: string
  }
  contextCompaction?: boolean
  contextCompactionTokens?: number
  /** Cross-chat provenance used by the root timeline projector. */
  link?: MessageLinkData
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

export function addMessage(messageId: string, chatId: string, data: MessageData): MessageRow {
  // 1. 获取 chat 的 messages_month
  const soulDb = getSoulDb()
  const chatStmt = soulDb.prepare('SELECT messages_month, active_epoch_id FROM chats WHERE id = ?')
  const chat = chatStmt.get(chatId) as
    { messages_month: string; active_epoch_id: string | null } | undefined

  if (!chat) throw new Error(`Chat ${chatId} not found`)

  // 2. messageId 由调用方传入（checkpoint/loadHistory 生成），直接使用
  const finalMessageId = messageId

  // 3. 路由到月份文件并插入 message
  const monthlyDb = getMonthlyDb(chat.messages_month)
  const now = Date.now()

  const stmt = monthlyDb.prepare(`
    INSERT INTO messages (id, chat_id, role, content, thinking, thinking_blocks, sense_calls, hash, replace_state, replace_by, replace_content, original_content, revoked, model_excluded, created_at, runtime, context_compaction, context_compaction_tokens, epoch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  stmt.run(
    finalMessageId,
    chatId,
    data.role,
    data.content ?? null,
    data.thinking ?? null,
    data.thinkingBlocks ? JSON.stringify(data.thinkingBlocks) : null,
    data.senseCall ? JSON.stringify(data.senseCall) : null,
    data.hash ?? null,
    data.replace?.state ? 1 : 0,
    data.replace?.by ?? null,
    data.replace?.content ?? null,
    data.originalContent ?? null,
    data.revoked ? 1 : 0,
    data.modelExcluded ? 1 : 0,
    now,
    data.runtime ? JSON.stringify(data.runtime) : null,
    data.contextCompaction ? 1 : 0,
    data.contextCompactionTokens ?? null,
    chat.active_epoch_id,
  )

  // P1-8：维护冗余 message_count，chatList 无需 N+1 查 messages
  const countResult = soulDb
    .prepare('UPDATE chats SET message_count = message_count + 1 WHERE id = ?')
    .run(chatId)
  assertChanged(countResult, `addMessage count (${chatId})`)
  bumpTimelineRevision(chatId)
  upsertMessageLink(messageId, chatId, data.link ?? defaultMessageLink(chatId, data.role))

  return {
    id: finalMessageId,
    chat_id: chatId,
    role: data.role,
    content: data.content ?? null,
    thinking: data.thinking ?? null,
    thinking_blocks: data.thinkingBlocks ? JSON.stringify(data.thinkingBlocks) : null,
    sense_calls: data.senseCall ? JSON.stringify(data.senseCall) : null,
    hash: data.hash ?? null,
    replace_state: data.replace?.state ? 1 : 0,
    replace_by: data.replace?.by ?? null,
    replace_content: data.replace?.content ?? null,
    original_content: data.originalContent ?? null,
    revoked: data.revoked ? 1 : 0,
    model_excluded: data.modelExcluded ? 1 : 0,
    created_at: now,
    runtime: data.runtime ? JSON.stringify(data.runtime) : null,
    context_compaction: data.contextCompaction ? 1 : 0,
    context_compaction_tokens: data.contextCompactionTokens ?? null,
    epoch_id: chat.active_epoch_id,
  }
}

/**
 * 获取消息（路由到月份文件）
 */
export function getMessages(chatId: string, epochId?: string): MessageRow[] {
  const monthlyDb = getChatMonthlyDb(chatId)
  if (!monthlyDb) return []
  if (epochId) {
    return monthlyDb
      .prepare(
        'SELECT * FROM messages WHERE chat_id = ? AND epoch_id = ? ORDER BY created_at ASC, rowid ASC',
      )
      .all(chatId, epochId) as MessageRow[]
  }
  return monthlyDb
    .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(chatId) as MessageRow[]
}

/**
 * 获取 chat 末条非 revoked 消息（用于 canResume 判定，避免全量加载）
 * 返回 null 表示 chat 不存在或无可见消息
 */
export function getLastMessage(chatId: string): MessageRow | null {
  const monthlyDb = getChatMonthlyDb(chatId)
  if (!monthlyDb) return null
  const stmt = monthlyDb.prepare(
    'SELECT * FROM messages WHERE chat_id = ? AND revoked = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1',
  )
  return (stmt.get(chatId) as MessageRow) ?? null
}

/**
 * 填充审批结果（更新 content / hash 字段）
 * 按 chatId 路由月份库（与 addMessage/getMessages 同源），消除对 messageId 月份前缀的依赖：
 * smart pending sense 的 messageId = trigger.id（LLM tool_call.id 或 sense-${index}），无月份前缀，
 * 旧实现 substring(0,7) 会落到错误空库、UPDATE 命中 0 行 → content 永远 NULL。
 */
export function fillApprovalResult(
  chatId: string,
  messageId: string,
  fields: { content?: string; hash?: string },
): void {
  const monthlyDb = getChatMonthlyDb(chatId)
  if (!monthlyDb) return

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
  bumpTimelineRevision(chatId)
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
  const monthlyDb = getChatMonthlyDb(chatId)
  if (!monthlyDb) return
  const result = monthlyDb
    .prepare('UPDATE messages SET sense_calls = ? WHERE id = ?')
    .run(JSON.stringify(senseCalls), messageId)
  assertChanged(result, `updateAssistantSenseCalls(${chatId}/${messageId})`)
  bumpTimelineRevision(chatId)
}

/**
 * 批量标记消息 revoked（chat.resume 撤回时持久化）
 */
export function markMessagesRevoked(chatId: string, messageIds: string[]): void {
  if (messageIds.length === 0) return
  const monthlyDb = getChatMonthlyDb(chatId)
  if (!monthlyDb) return
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
  bumpTimelineRevision(chatId)
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
  const monthlyDb = getChatMonthlyDb(chatId)
  if (!monthlyDb) return
  // content 可选：传入则更新（感官去重改写为短说明，剔除冗长重复内容）；
  // 未传则保留原 content，避免误清空。
  // 调用方（observer）经 AgentMessagePatch kind:"replace" 联合类型约束，replace patch 必携带 content，
  // 故运行时 replace 路径总会传 content（smart/manual 不再因缺 content 导致 DB 保留旧长内容）。
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
  bumpTimelineRevision(chatId)
}

/**
 * 解析消息行
 */
export function parseMessageRow(row: MessageRow): MessageData {
  return {
    role: row.role as MessageData['role'],
    content: row.content ?? undefined,
    thinking: row.thinking ?? undefined,
    thinkingBlocks: row.thinking_blocks
      ? safeJsonParse<ThinkingBlock[] | undefined>(row.thinking_blocks, undefined)
      : undefined,
    senseCall: row.sense_calls ? safeJsonParse(row.sense_calls, undefined) : undefined,
    hash: row.hash ?? undefined,
    replace: row.replace_state
      ? { state: true, by: row.replace_by ?? '', content: row.replace_content ?? '' }
      : undefined,
    originalContent: row.original_content ?? undefined,
    revoked: row.revoked === 1,
    modelExcluded: row.model_excluded === 1,
    runtime: row.runtime
      ? safeJsonParse<
          | {
              brain: string
              senseGroup: string
              mcpServers: string[]
              brainModel?: string
              brainProvider?: string
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
