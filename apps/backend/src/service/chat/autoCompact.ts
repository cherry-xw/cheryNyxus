/**
 * 命令注入 + 自动压缩判定。
 *
 * 设计要点：
 * - 默认情况下 .chery/command/<name>.md 不注入 system prompt（避免永远占用 token）；
 * - `[[command:/<name>]]` 在用户正文中出现时，分两类处理：
 *     - **skill 类**（name ∈ 已注册 skill 名）→ AI 通过 system prompt `<skills>` 段自动加载，无需额外操作；
 *     - **builtin 类**（name 对应 `.chery/command/<name>.md` 文件）→ 加载正文作为**独立 user message**
 *       追加在该轮主 user prompt 之前入队，LLM 看到「先正文指令、再用户实际消息」按序消费。
 * - 自动 compact 触发条件任一满足：
 *     1. thresholdReached(auto, used, total)（auto 阈值支持 tokens/percent）
 *     2. used + safety_margin > total（小 context 溢出防御）
 * - 仅当 brain.contextLimit >= config.global.command.min_context_limit 时启用整个 compact 功能。
 *   低于阈值的 brain 上无 compact 价值（如 mock_test 8K）——前端不显按钮、不自动触发。
 * - 触发动作：在 userPrompt 头部注入 `[[command:/compact]]` token，并把 compact.md 正文 unshift 到
 *   extraUserMessages 顶部（compact 优先级最高）。
 * - 失败闭降：触发但 <name>.md 缺失 → console.warn + 不入队该正文，LLM 失去详细指令但行为不退化
 *   （system prompt 通用 instruction 兜底）。
 *
 * 详见 docs/backend/agent/command.md。
 */
import { getSystemCommand } from '@/agent/prompt/loadCommand.js'
import { reportWorkflow } from '@/core/middleware/workflowObservation.js'
import { getSkillMetas } from '@/agent/prompt/loadSkill.js'

/** 触发原因：usage 达强制门 / 估算会溢出。 */
export type AutoCompactReason = 'usage' | 'overflow'

/** token 形态：与 apps/web/features/agent/commands.ts 中的 COMMAND_TOKEN_PATTERN 保持一致 */
const COMMAND_TOKEN_PATTERN = /\[\[command:(\/[^\]\s]+)\]\]/g

/** 注入结果：
 * - userPrompt：可能改了头部（自动注入 `[[command:/compact]]` token 保留在原 prompt）。
 * - extraUserMessages：追加在主 userPrompt 之前的独立 user messages（命令正文）；
 *   LLM 看到顺序：extra[0] → extra[1] → ... → 主 userPrompt。
 * - triggered / reason：仅自动 compact 触发时为 true。 */
export interface CommandInjection {
  userPrompt: string
  extraUserMessages: string[]
  triggered: boolean
  reason?: AutoCompactReason
}

/**
 * 提取 userPrompt 中所有 builtin command 的 name 列表（去重，保留首次出现顺序）。
 * skill 类（name ∈ 已注册 skill 名）跳过——AI 通过 `<skills>` 段自行加载，无需再注入正文。
 */
function extractBuiltinCommandNames(userPrompt: string): string[] {
  const skillNames = new Set(getSkillMetas().map((s) => s.name))
  const seen = new Set<string>()
  const result: string[] = []
  for (const m of userPrompt.matchAll(COMMAND_TOKEN_PATTERN)) {
    // match[1] = "/<name>"，去掉前导 "/"
    const raw = m[1] ?? ''
    const name = raw.startsWith('/') ? raw.slice(1) : raw
    if (!name || seen.has(name) || skillNames.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

/**
 * 加载 builtin command 的正文（用于独立 user message 注入）。
 * 文件缺失返回 undefined（调用方 warn + 跳过，不阻断其他指令）。
 */
function loadCommandBody(name: string): string | undefined {
  const cmd = getSystemCommand(name)
  return cmd?.content || undefined
}

/**
 * 格式化「独立 user message」正文：提示 LLM 这是某 token 对应的完整指令，仅本轮生效。
 */
function formatCommandBody(name: string, content: string): string {
  return (
    `以下是 \`[[command:/${name}]]\` 的完整指令正文（仅本轮生效，系统按需注入）。\n\n` +
    `${content}\n\n` +
    `---\n` +
    `请按上述指令执行；如该指令同时要求后续动作，按指令优先级处理。`
  )
}

/**
 * 主入口：send 预检阶段调用。
 *
 * 行为：
 * 1. 扫描 userPrompt 中的 `[[command:/<name>]]` tokens，跳过 skill 类；
 *    对每个 builtin command 加载 `.chery/command/<name>.md` 正文，加入 extraUserMessages（按出现顺序）。
 * 2. 若 shouldAutoCompact 命中 → 在 userPrompt 头部注入 `[[command:/compact]]` token，
 *    并把 compact.md 正文 unshift 到 extraUserMessages 顶部（compact 优先级最高）。
 * 3. 未触发时 userPrompt / extraUserMessages 原样返回。
 *
 * @returns `{ userPrompt, extraUserMessages, triggered, reason }`
 */
export function injectCommands(chatId: string, userPrompt: string): CommandInjection {
  const extraUserMessages: string[] = []

  // 1. 提取 userPrompt 中的 builtin commands → 加载正文 → 入队
  const builtinNames = extractBuiltinCommandNames(userPrompt)
  for (const name of builtinNames) {
    if (name === 'compact') continue // Dedicated maintenance, never a model user instruction.
    const body = loadCommandBody(name)
    if (!body) {
      reportWorkflow(chatId, {
        activeNodeId: 'command',
        phaseLabel: `${name} 正文加载失败`.slice(0, 200),
      })
      console.warn(
        `[injectCommands] .chery/command/${name}.md 缺失或为空，token 触发但无指令正文（chat=${chatId}）`,
      )
      continue
    }
    extraUserMessages.push(formatCommandBody(name, body))
    reportWorkflow(chatId, {
      activeNodeId: 'command',
      phaseLabel: `${name} 正文已加载`.slice(0, 200),
    })
  }

  return { userPrompt, extraUserMessages, triggered: false }
}
