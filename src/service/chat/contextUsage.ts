/**
 * 上下文用量 6 段分解（computeContextBreakdown）。
 *
 * recompute-at-compute：compute 时刻从 chat metadata（promptPathOverride/workspace）+
 * runtime selection 重建各段文本与 senseTable 后逐段 estimateTokens（字符数/4）。
 * 不持久化 breakdown——系统消息不入库，memory 按设计仅 init 一次性注入，recompute 偏差可忽略。
 *
 * 段：系统提示词 / 用户系统提示词 / 记忆 / 技能 / 工具定义 / 用户对话（含 sense 调用结果）。
 * 详见 docs/agent/prompt.md「上下文分段计量」。
 *
 * 放 service 层（非 utils/token）：需依赖 agent/prompt + agent/runtimeResolver，避免 utils→agent 反向依赖。
 */
import { RuntimeResolver } from '@/agent/runtimeResolver.js'
import { buildSystemPromptSegments } from '@/agent/prompt/index.js'
import {
  getChat,
  getChatRuntimeSelection,
  getChatPromptOverride,
  getChatWorkspace,
  getChatSkillFilter,
} from '@/db/chat.js'
import {
  estimateTokens,
  sumChatConversationTokens,
  type Segment,
  type ContextBreakdown,
} from '@/utils/token.js'
import config from '@/utils/config'

/** contextLimit 兜底值（token）：brain 未配 contextLimit 时使用（与 utils/token 一致）。 */
const DEFAULT_CONTEXT_LIMIT_TOKENS = 8192

/** 单段快捷构造：count 缺省则仅 tokens。 */
function seg(tokens: number, count?: number): Segment {
  return count === undefined ? { tokens } : { tokens, count }
}

/** 全 0 兜底 breakdown（异常降级，规则 12 fail loud：warn 已在调用处输出）。 */
function zeroBreakdown(): ContextBreakdown {
  const z = seg(0)
  return {
    system: z,
    userSystem: z,
    memory: z,
    skills: z,
    tools: z,
    conversation: z,
    total: DEFAULT_CONTEXT_LIMIT_TOKENS,
    usage: 0,
  }
}

/**
 * 计算 chat 上下文用量的 6 段分解（比例 usage + total + 各段 tokens/count）。
 *
 * - 段 1-4（系统/用户系统/记忆/技能）：buildSystemPromptSegments(promptPathOverride, workspace) 重建后逐段估算。
 * - 段 5（工具定义）：RuntimeResolver.resolve(selection) 重建 senseTable，Σ estimateTokens(JSON.stringify(sense))；
 *   injectMemoryManage 据是否子 agent（parent_chat_id）决定，与 init 期一致。
 * - 段 6（用户对话）：DB 行 role∈user/assistant/role/subagent/sense（含感官调用结果）。
 *
 * limit 来源：chat runtime 的 brain → config.llm.brain[brain].contextLimit；缺失 → DEFAULT 兜底。
 * 异常（chat 不存在 / DB 读失败）→ 兜底 zeroBreakdown + console.warn（不阻塞调用方）。
 */
export function computeContextBreakdown(chatId: string): ContextBreakdown {
  try {
    const promptPathOverride = getChatPromptOverride(chatId)
    const workspace = getChatWorkspace(chatId)
    const skillFilter = getChatSkillFilter(chatId)

    // 段 1-4：提示词分段（系统消息不入库，需重建）
    const promptSegs = buildSystemPromptSegments(promptPathOverride, workspace, skillFilter)
    const system = seg(estimateTokens(promptSegs.system))
    const userSystem = seg(estimateTokens(promptSegs.userSystem))
    const memory = seg(estimateTokens(promptSegs.memory.text), promptSegs.memory.count)
    // skills 段 token = estimateTokens(整段 <skills>...</skills> 文本)：含 XML 标签 + 每 skill 的 name+desc+trigger。
    // 旧实现用 triggerTokens 仅算触发条件（无 trigger 的 skill 显示 0，严重低估），改为直接估算 text。
    const skills = seg(estimateTokens(promptSegs.skills.text), promptSegs.skills.count)

    // 段 5：工具定义（重建 runtime senseTable；主 agent 注入 memory_manage，子 agent 不注入——同 init）
    let tools = seg(0, 0)
    const selection = getChatRuntimeSelection(chatId)
    if (selection) {
      try {
        const isSubagent = !!getChat(chatId)?.parent_chat_id
        const runtime = new RuntimeResolver().resolve(selection, {
          injectMemoryManage: !isSubagent,
        })
        let toolTokens = 0
        for (const fn of runtime.builtSenses) {
          toolTokens += estimateTokens(JSON.stringify(fn))
        }
        tools = seg(toolTokens, runtime.senseTable.size)
      } catch (err) {
        console.warn(
          `[contextBreakdown] resolve runtime 失败，工具定义段 0:`,
          (err as Error).message,
        )
      }
    }

    // 段 6：用户对话（含 sense 调用结果）
    const conv = sumChatConversationTokens(chatId)
    const conversation = seg(conv.tokens, conv.count)

    // total / usage
    const used =
      system.tokens +
      userSystem.tokens +
      memory.tokens +
      skills.tokens +
      tools.tokens +
      conversation.tokens
    const brainName = selection?.brain
    const limitTokens =
      (brainName && config.llm.brain[brainName]?.contextLimit) || DEFAULT_CONTEXT_LIMIT_TOKENS
    const total = limitTokens > 0 ? limitTokens : 0
    const usage = total > 0 ? Math.min(1, used / total) : 0

    return { system, userSystem, memory, skills, tools, conversation, total, usage }
  } catch (err) {
    console.warn(`[contextBreakdown](${chatId}) failed, fallback 0:`, (err as Error).message)
    return zeroBreakdown()
  }
}
