/**
 * history_recall sense — 长会话历史回忆（只读）。
 *
 * compact 后 LLM 内存上下文只剩最新摘要（compactToLatestSummary），本感官提供被压缩
 * 历史的回忆能力，代际切分复用 service/chat/generations.ts 的 computeGenerations：
 *   - list_generations → 代际目录（index/时间/trigger/节点数/摘要首 200 字）
 *   - search → 在代际区间内对消息 content 做大小写不敏感子串匹配，
 *     返回命中片段（消息角色 + 前后各 ~150 字符 + 所在代 index）
 * 数据源：root chat + 全部后代 chat 的持久化消息（collectDescendantsChatIds），按 createdAt 排序。
 * 代归属按 createdAt 时间窗判定（orderKey 仅 root 图内有意义，跨 chat 用统一时间坐标）。
 *
 * 硬字符上限：global.history_recall.max_output_chars（默认 4000），超限截断并显式注明。
 * 只读 → 内置 SupervisionLevel.auto（同 read_file / search_codebase 惯例），
 * smart 规则表无需登记（fail-open 未登记 = 放行，内置 auto 根本不进表）。
 *
 * 详见 docs/core/sense.md「内置感官：history_recall」。
 */
import { z } from 'zod'
import { sense, type SenseResult, type SenseSharedData } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import config from '@/utils/config'
import { collectDescendantsChatIds, getMessages, getRootChatId } from '@/db/chat.js'
import { computeGenerations } from '@/service/chat/generations.js'
import type { GenerationEntry } from '@/service/message/types.js'

/** 摘要在目录行的展示截断长度 */
const SUMMARY_PREVIEW_CHARS = 200
/** 命中片段前后上下文字符数 */
const SNIPPET_CONTEXT_CHARS = 150
/** 默认命中条数上限 */
const DEFAULT_LIMIT = 10
/** 输出硬字符上限兜底值（config.global.history_recall.max_output_chars 缺省时） */
const DEFAULT_MAX_OUTPUT_CHARS = 4000

const HistoryRecallSchema = z.object({
  action: z
    .enum(['list_generations', 'search'])
    .describe('操作：list_generations=列代际目录；search=按关键词检索被压缩的历史消息'),
  query: z.string().describe('search 必填：关键词（大小写不敏感子串匹配消息正文）').optional(),
  generation: z
    .number()
    .int()
    .min(1)
    .describe('限定查询的代序号（list_generations 目录中的 index；缺省查全部已定稿代）')
    .optional(),
  role: z.string().describe('限定消息角色（如 user/assistant/role）；缺省不限').optional(),
  limit: z.number().int().min(1).max(50).describe('命中条数上限，默认 10').optional(),
})

interface HistoryMessage {
  role: string
  content: string
  createdAt: number
}

/** 收集 root chat + 全部后代 chat 的持久化消息（跳过空 content / revoked / compact 摘要行），按 createdAt 排序。 */
function collectHistoryMessages(rootChatId: string): HistoryMessage[] {
  const chatIds = [rootChatId, ...collectDescendantsChatIds(rootChatId)]
  const messages: HistoryMessage[] = []
  for (const chatId of chatIds) {
    for (const row of getMessages(chatId)) {
      if (row.revoked === 1) continue
      if (row.context_compaction === 1) continue
      const content = row.content ?? ''
      if (!content.trim()) continue
      messages.push({ role: row.role, content, createdAt: row.created_at })
    }
  }
  return messages.sort((a, b) => a.createdAt - b.createdAt)
}

/** 消息归属的代 index；不在任何已定稿代（当前代）返回 undefined。 */
function generationOf(generations: GenerationEntry[], createdAt: number): number | undefined {
  for (const gen of generations) {
    if (createdAt <= gen.createdAt) return gen.index
  }
  return undefined
}

function formatGenerationLine(gen: GenerationEntry): string {
  const time = new Date(gen.createdAt).toISOString().replace('T', ' ').slice(0, 16)
  const summary = gen.summary.slice(0, SUMMARY_PREVIEW_CHARS)
  return `第${gen.index}代 [${gen.trigger === 'auto' ? '自动' : '手动'}] ${time} · ${gen.nodeCount} 节点 · ${summary}`
}

function listGenerations(generations: GenerationEntry[]): SenseResult {
  const lines = [
    `共 ${generations.length} 个已定稿代际（第 ${generations.length} 代为最近一次压缩定稿，其后为当前代）：`,
    ...generations.map(formatGenerationLine),
    `当前代（第 ${generations.length + 1} 代）仍在继续，未定稿。`,
    '更早细节可用本感官 search 检索：query 必填，可选 generation（限定代）/ role（限定角色）/ limit。',
  ]
  return { content: lines.join('\n') }
}

interface SearchHit {
  generation: number
  role: string
  snippet: string
}

function searchGenerations(
  generations: GenerationEntry[],
  messages: HistoryMessage[],
  input: { query: string; generation?: number; role?: string; limit: number },
): SenseResult {
  const lastBoundary = generations[generations.length - 1]!

  // 检索窗口：指定 generation → 该代时间窗 (上一代边界, 本代边界]；缺省 → 全部已定稿代 [0, 最近边界]
  let fromTime = 0
  let toTime = lastBoundary.createdAt
  if (input.generation !== undefined) {
    const genIndex = input.generation
    const gen = generations.find((entry) => entry.index === genIndex)
    if (!gen) {
      return {
        content: `代际 ${genIndex} 不存在（有效范围：第 1 ~ ${generations.length} 代），请先用 list_generations 查看目录。`,
      }
    }
    const prev = generations.find((entry) => entry.index === genIndex - 1)
    fromTime = prev ? prev.createdAt : 0
    toTime = gen.createdAt
  }

  const needle = input.query.toLowerCase()
  const hits: SearchHit[] = []
  let scanned = 0
  for (const message of messages) {
    if (message.createdAt <= fromTime || message.createdAt > toTime) continue
    if (input.role && message.role !== input.role) continue
    scanned += 1
    const idx = message.content.toLowerCase().indexOf(needle)
    if (idx === -1) continue
    const start = Math.max(0, idx - SNIPPET_CONTEXT_CHARS)
    const end = Math.min(message.content.length, idx + needle.length + SNIPPET_CONTEXT_CHARS)
    const prefix = start > 0 ? '…' : ''
    const suffix = end < message.content.length ? '…' : ''
    hits.push({
      generation: generationOf(generations, message.createdAt) ?? generations.length,
      role: message.role,
      snippet: `${prefix}${message.content.slice(start, end)}${suffix}`,
    })
    if (hits.length >= input.limit) break
  }

  if (hits.length === 0) {
    const scope = input.generation !== undefined ? `第 ${input.generation} 代` : '全部已定稿代'
    return {
      content: `在${scope}的 ${scanned} 条历史消息中未找到包含 "${input.query}" 的内容。可尝试更换关键词、放宽 role 限制或去掉 generation 限定。`,
    }
  }

  const lines = [
    `命中 ${hits.length} 条（范围：${input.generation !== undefined ? `第 ${input.generation} 代` : `全部已定稿代（第 1 ~ ${generations.length} 代）`}，query="${input.query}"${input.role ? `，role=${input.role}` : ''}）：`,
    ...hits.map((hit, i) => `${i + 1}. [第${hit.generation}代] ${hit.role}: ${hit.snippet}`),
  ]
  return { content: lines.join('\n') }
}

/** 硬字符上限截断：超限截到上限内并显式注明（确定性代码，非 LLM 判断）。 */
function applyOutputCap(text: string): SenseResult {
  const maxChars = config.global.history_recall?.max_output_chars ?? DEFAULT_MAX_OUTPUT_CHARS
  if (text.length <= maxChars) return { content: text }
  const notice = `\n\n[已截断：结果超出上限 ${maxChars} 字符，请缩小 query 范围或指定 generation 分代查询]`
  return { content: text.slice(0, Math.max(0, maxChars - notice.length)) + notice }
}

export default sense(
  'history_recall',
  '回忆被压缩的长会话历史（只读）。此前对话经过 compact 压缩后仅保留摘要，本工具可检索完整历史。' +
    'action="list_generations" 列出代际目录（每代摘要索引）；' +
    'action="search" 按关键词在已定稿代际的历史消息中做大小写不敏感子串检索，' +
    '返回命中片段（角色 + 前后约150字符上下文 + 所在代），可选 generation 限定代、role 限定角色、limit 限条数（默认10）。' +
    '当用户询问较早之前聊过的内容、而你当前上下文中只有摘要时，使用本工具。',
  HistoryRecallSchema,
  async (
    input,
    _senseSharedData: SenseSharedData,
    ctx?: { chatId: string },
  ): Promise<SenseResult> => {
    if (!ctx?.chatId) {
      return { content: '错误：缺少会话上下文（chatId），无法定位历史会话' }
    }
    const rootChatId = getRootChatId(ctx.chatId)
    const generations = computeGenerations(rootChatId)
    if (generations.length === 0) {
      return {
        content:
          '当前会话还没有已定稿的压缩代际（无 compact 历史），完整对话本就在上下文中，无需回忆检索。',
      }
    }

    if (input.action === 'list_generations') {
      return applyOutputCap(listGenerations(generations).content)
    }

    const query = input.query?.trim()
    if (!query) {
      return {
        content:
          '错误：search 需要 query 参数（非空关键词）。示例：{"action":"search","query":"部署方案"}',
      }
    }
    const messages = collectHistoryMessages(rootChatId)
    return applyOutputCap(
      searchGenerations(generations, messages, {
        query,
        generation: input.generation,
        role: input.role,
        limit: input.limit ?? DEFAULT_LIMIT,
      }).content,
    )
  },
  SupervisionLevel.auto,
)
