/**
 * Token 估算 + chat 上下文用量计算。
 *
 * 简化估算：字符数 / 4（英文近似 4 char/token；中文偏保守但够用）。
 * 后续接 tokenizer（如 js-tiktoken）时替换 estimateTokens 实现即可，调用点不变。
 *
 * 用量 = chat 所有非 revoked 消息 content+thinking 累加 token / brain.contextLimit，
 * clamp [0,1]。contextLimit 单位为 token（与 config.llm.brain[name].contextLimit 一致）。
 * 估算失败不阻塞（规则 12 fail loud：兜底 0 + console.warn，避免 chat.send/get 因
 * token 计算挂掉）。
 */
import { getMessages, type MessageRow } from '@/db/chat.js'
import { getChatRuntimeSelection } from '@/db/chat.js'
import config from '@/utils/config'

/** 上限未知时 total=0；不再用通用 8192 伪造模型上下文百分比。 */
const UNKNOWN_CONTEXT_LIMIT_TOKENS = 0

/**
 * 估算文本 token 数（简化：字符数 / 4，向上取整）。
 * 空字符串/undefined → 0。
 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/**
 * 累加单条消息 token（content + thinking）。
 * revoked 消息已从 LLM 上下文中剔除（revokeTrailingCycle 撤回），不计。
 */
function sumRowTokens(row: MessageRow): number {
  if (row.revoked === 1) return 0
  return estimateTokens(row.content) + estimateTokens(row.thinking)
}

/**
 * 累加 chat 所有消息 token（读 DB）。
 */
export function sumChatTokens(chatId: string): number {
  const messages = getMessages(chatId)
  let total = 0
  for (const m of messages) {
    total += sumRowTokens(m)
  }
  return total
}

/** 用户对话段计入的 role（sense 调用结果按设计计入用户对话，见 docs/agent/prompt.md 分段表）。 */
const CONVERSATION_ROLES = new Set(['user', 'assistant', 'role', 'subagent', 'sense'])

/**
 * 累加 chat「用户对话」段 token（content+thinking）：role ∈ user/assistant/role/subagent/sense 的非 revoked 行。
 * system 行不计（observer 不持久化 system 消息，理论不存在）。
 * 返 { tokens(content+thinking 合计), count(消息条数), thinking(thinking 拆分，已含在 tokens 内，前端展示用) }。
 */
export function sumChatConversationTokens(chatId: string): {
  tokens: number
  count: number
  /** thinking 部分累计（已含在 tokens 合计内，前端拆分展示用）。 */
  thinking: number
} {
  const messages = getMessages(chatId)
  const latestCompaction = messages.reduce(
    (last, message, index) => (message.context_compaction === 1 ? index : last),
    -1,
  )
  const visibleMessages = latestCompaction >= 0 ? messages.slice(latestCompaction) : messages
  let tokens = 0
  let count = 0
  let thinking = 0
  for (const m of visibleMessages) {
    if (m.revoked === 1) continue
    if (!CONVERSATION_ROLES.has(m.role)) continue
    const thinkingTokens = estimateTokens(m.thinking)
    tokens += estimateTokens(m.content) + thinkingTokens
    thinking += thinkingTokens
    count += 1
  }
  return { tokens, count, thinking }
}

/**
 * chat 上下文用量详情（computeContextUsage 返回值）。
 * - usage：比例（0-1），clamp
 * - used：已用 token 数（估算值，字符数/4）
 * - total：上限 token 数（brain.contextLimit，单位 token）
 */
export interface ContextUsageDetail {
  usage: number
  used: number
  total: number
}

/**
 * 上下文用量分段（计量用）。
 * - tokens：该段 token 估算（字符数/4）
 * - count：条目数（记忆条数 / skill 数 / tool 数 / 消息条数；系统/用户系统提示词段无）
 */
export interface Segment {
  tokens: number
  count?: number
  /** 用户对话段中 thinking 部分的 token 估算（拆分展示用，已含在 tokens 合计内；仅 conversation 段填）。 */
  thinking?: number
}

/**
 * 上下文用量 6 段分解（computeContextBreakdown 返回值）。
 * 段：系统提示词 / 用户系统提示词 / 记忆 / 技能 / 工具定义 / 用户对话（含 sense 调用结果）。
 * used = 各段 tokens 之和；usage = clamp(used / total, 0, 1)；total = brain.contextLimit。
 */
export interface ContextBreakdown {
  system: Segment
  userSystem: Segment
  memory: Segment
  skills: Segment
  tools: Segment
  conversation: Segment
  total: number
  usage: number
}

/** 各段 tokens 之和（= 已用 token 总数，与 breakdown.usage * breakdown.total 一致）。 */
export function breakdownUsed(bd: ContextBreakdown): number {
  return (
    bd.system.tokens +
    bd.userSystem.tokens +
    bd.memory.tokens +
    bd.skills.tokens +
    bd.tools.tokens +
    bd.conversation.tokens
  )
}

/**
 * 计算 chat 上下文用量详情（比例 + 已用 token + 总预算 token）。
 *
 * limit 来源：chat 持久化 runtime 的 brain 对应 config.llm.brain[brain].contextLimit（单位 token）；
 * brain 未配或缺失 → DEFAULT_CONTEXT_LIMIT_TOKENS 兜底。
 * 异常（chat 不存在/DB 读失败）→ 兜底 {usage:0, used:0, total:DEFAULT} + console.warn（不阻塞调用方）。
 */
export function computeContextUsage(chatId: string): ContextUsageDetail {
  try {
    const used = sumChatTokens(chatId)
    const selection = getChatRuntimeSelection(chatId)
    const brainName = selection?.brain
    const brain = brainName ? config.llm.brain[brainName] : undefined
    const limitTokens = brain?.contextLimit ?? 0
    if (limitTokens <= 0) return { usage: 0, used, total: 0 }
    return {
      usage: Math.min(1, used / limitTokens),
      used,
      total: limitTokens,
    }
  } catch (err) {
    console.warn(
      `[token] computeContextUsage(${chatId}) failed, fallback 0:`,
      (err as Error).message,
    )
    return { usage: 0, used: 0, total: UNKNOWN_CONTEXT_LIMIT_TOKENS }
  }
}
