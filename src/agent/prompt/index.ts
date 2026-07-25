import { readFileSync, existsSync } from 'fs'
import os from 'os'
import path from 'path'
import dayjs from 'dayjs'
import config from '@/utils/config.js'
import { getSkillMetas, type SkillFilter } from './loadSkill.js'
import { detectVcs, formatVcsBlock } from '@/utils/vcs.js'
import { readMemoryIndexContent, readMemoryIndex } from '@/memory/index.js'

/**
 * 记忆漂移防护指引（注入每个 <memory layer> 段尾，参考 Claude Code 记忆系统）。
 * 三层防护：使用前验证 / 保存约束 / 保存结构。一次性注入，不改注入时机。
 */
const MEMORY_DRIFT_GUIDE = `
记忆是观点而非事实——使用前验证：
- 记忆提及文件路径/函数/flag → 先 read_file / search_codebase 确认当前存在，再据以推荐
- "记忆说 X 存在" ≠ "X 现在存在"；与当前代码冲突时信任当前状态，并用 memory_manage 更新
- 记忆含相对日期 → 应已转绝对日期保存；若已过时用 memory_manage 更新或 remove
- 用户要求"忽略记忆" → 视本段为空，不引用、不对比、不提及记忆内容

保存约束（即使显式请求也拒绝）：
- 不保存可推导信息（代码模式/架构/文件路径/git 历史/调试配方）——这些 read_file / git log 可查
- 不保存 CLAUDE.md 已有内容、当前对话临时任务状态（用 todo/plan 而非 memory）
- 用户要求保存 PR 列表/活动摘要时，只保存"令人意外或非显而易见"的部分

保存结构（feedback/project 类必须）：
- 先规则/事实，再 **Why:** 行（原因），再 **How to apply:** 行（何时/何地适用）`.trim()

/**
 * 全局 system prompt 固定路径：config.global.prompts_dir + "/system.md"（统一目录源）。
 * 模块加载期读取一次并缓存（override 走实时读取，支持每子 agent 不同文件）。
 */
const globalSystemPromptPath = path.join(config.global.prompts_dir, 'system.md')
const systemPrompt = existsSync(globalSystemPromptPath)
  ? readFileSync(globalSystemPromptPath, 'utf-8').trim()
  : ''

interface EnvInfo {
  os: string
  date: string
  time: string
}

/** 提示词分段（计量用）：text 为段文本，count 为条目数（记忆条数 / skill 数）。 */
export interface PromptSegmentText {
  text: string
  count?: number
}

/** 当前主会话可由用户 @ 选择的角色，运行时由 chat 编制快照解析。 */
export interface RoleMentionInfo {
  name: string
  description: string
}

/** skills 段预聚合 token（getSkillMetas 一次性算好，buildSystemPromptSegments 直接累加）。 */
export interface SkillsSegmentTokens {
  nameDescTokens: number
  triggerTokens: number
  contentTokens: number
  promptTokens: number
}

/** buildSystemPromptSegments 返回值：系统提示词各分段（上下文分段计量用，单一数据源）。 */
export interface SystemPromptSegments {
  /** 系统提示词：全局 base + <environment> + <workspace>（**不含** override）。 */
  system: string
  /** 用户系统提示词：per-agent systemPromptFile 补充（合并语义，给出时非空，可与 system 并存）。 */
  userSystem: string
  /** 记忆：<memory global> + <memory workspace>，count = 记忆条数。 */
  memory: PromptSegmentText
  /** 技能：<skills> 元数据，count = skill 数；token 字段由 computeSkillTokens 预计算后累加。 */
  skills: PromptSegmentText & SkillsSegmentTokens
}

interface PromptPieces {
  globalBase: string
  userSystem: string
  envBlock: string // <environment>...</environment>
  workspaceSection: string
  memorySection: string
  memoryCount: number
  skillsInner: string
  skillsCount: number
  /** skill 段预聚合 token（从 getSkillMetas 复用，不在本模块重算）。 */
  skillsTokens: SkillsSegmentTokens
  roleMentionsSection: string
  // 注意：内置命令（/.chery/command/*.md）不再预注入 system prompt；trigger 时由 send 路径临时附注。
  // 详见 docs/agent/command.md。
}

/**
 * 组装系统提示词各组成片段（buildFirstSystemPrompt 与分段计量共用，单一数据源）。
 * 合并语义：给出则作补充拼接到全局 base 之后（**非**替换）；文件缺失 warn + 留空（仅全局 base）。
 * @param systemPromptFile per-agent system prompt 文件绝对路径（可选；缺省 → 仅全局 base）
 * @param skillFilter per-role 技能组/插件组过滤（undefined = 全部 skill，向后兼容）；仅作用于 <skills> 块注入。
 */
function buildPromptPieces(
  systemPromptFile?: string,
  workspace?: string,
  skillFilter?: SkillFilter,
  roleMentions: RoleMentionInfo[] = [],
): PromptPieces {
  // systemPromptFile 路径实时读（每子 agent 可不同文件）；缺失容错仅用全局 base（配置期 validateRawConfig 已校验存在）
  let userSystem = ''
  if (systemPromptFile) {
    if (existsSync(systemPromptFile)) {
      userSystem = readFileSync(systemPromptFile, 'utf-8').trim()
    } else {
      console.warn(`[prompt] systemPrompt 文件不存在，仅用全局 base: ${systemPromptFile}`)
    }
  }

  const envInfo: EnvInfo = {
    os: `${os.type()} ${os.release()}`,
    date: dayjs().format('YYYY-MM-DD'),
    time: dayjs().toISOString(),
  }
  const envBlock = `<environment>
操作系统: ${envInfo.os}
当前日期: ${envInfo.date}
当前时间: ${envInfo.time}
</environment>`

  // workspace（预设级项目工作目录）：仅提示词层声明本会话专属该项目，不改变 sense 实际行为
  let workspaceSection = ''
  if (workspace) {
    const vcsBlock = formatVcsBlock(detectVcs(workspace))
    const vcsLine = vcsBlock ? `\n${vcsBlock}` : ''
    workspaceSection = `\n\n<workspace>\n当前工作区: ${workspace}\n本会话用于开发该项目，文件操作与命令以此目录为基准。${vcsLine}\n</workspace>`
  }

  // 项目记忆：双层注入（仅在初始化时一次性注入；不动态更新）
  //   <memory layer="global">    所有 chat 共享（用户角色/偏好/准则）
  //   <memory layer="workspace"> 当前 chat（项目行为规范）
  //   段尾追加漂移防护指引（使用前验证 / 保存约束 / 保存结构）
  const globalContent = readMemoryIndexContent(undefined, 'global')
  const wsContent = workspace ? readMemoryIndexContent(workspace, 'workspace') : ''
  const memoryParts: string[] = []
  if (globalContent) {
    memoryParts.push(
      `<memory layer="global">\n以下是全局活跃记忆（所有 chat 共享，最多 ${config.memory?.global?.max_count ?? 30} 条），通过 memory_manage 工具的 scope="global" 管理。\n${globalContent}\n${MEMORY_DRIFT_GUIDE}\n</memory>`,
    )
  }
  if (wsContent) {
    memoryParts.push(
      `<memory layer="workspace">\n以下是当前 workspace 活跃记忆（最多 ${config.memory?.workspace?.max_count ?? 15} 条），通过 memory_manage 工具的 scope="workspace" 管理。\n${wsContent}\n${MEMORY_DRIFT_GUIDE}\n</memory>`,
    )
  }
  const memorySection = memoryParts.length ? `\n\n${memoryParts.join('\n\n')}` : ''
  const memoryCount =
    readMemoryIndex(undefined, 'global').length +
    (workspace ? readMemoryIndex(workspace, 'workspace').length : 0)

  // P1-5：trigger 作为软提示注入 skill 描述，供 LLM 判断何时自动触发该 skill
  // per-role 过滤：skillFilter 限定独立 skill（skills 白名单）/ 插件 skill（plugins 白名单）；undefined = 全部
  const skillMetas = getSkillMetas(skillFilter)
  const skillsInner = skillMetas
    .map((s) => {
      const trigger = s.trigger ? `\n触发条件: ${s.trigger}` : ''
      return `<skill name="${s.name}">\n${s.description}${trigger}\n</skill>`
    })
    .join('\n')
  // 累加 skill 段预计算 token（loadSkill 集中算好，不在本模块重算）
  const skillsTokens = skillMetas.reduce<SkillsSegmentTokens>(
    (acc, s) => ({
      nameDescTokens: acc.nameDescTokens + s.nameDescTokens,
      triggerTokens: acc.triggerTokens + s.triggerTokens,
      contentTokens: acc.contentTokens + s.contentTokens,
      promptTokens: acc.promptTokens + s.promptTokens,
    }),
    { nameDescTokens: 0, triggerTokens: 0, contentTokens: 0, promptTokens: 0 },
  )
  const roleMentionsSection =
    roleMentions.length >= 2
      ? `\n\n<role-mentions>\n当前会话可由用户明确选择的协作角色：\n${roleMentions
          .map((role) => `- @${role.name}: ${role.description}`)
          .join(
            '\n',
          )}\n\n用户消息中的 [[role:@名称]] 是选择器插入的结构化角色标记，不是普通文本。它表示用户希望你将该角色纳入本次协作候选编制。你作为 coordinator 必须结合任务依赖，自主决定是否派发、并行或串行顺序、是否补充其他角色以及 wake 策略；实际派发只能通过 spawn_role，且必须遵守其可用角色限制。不要把标记原样当作用户任务内容回复。\n</role-mentions>`
      : ''
  // 内置命令（/.chery/command/*.md）不在默认 system prompt 注入；trigger 时由 autoCompact / manual
  // 路径临时附注到 user prompt 末尾。详见 docs/agent/command.md。

  return {
    globalBase: systemPrompt,
    userSystem,
    envBlock,
    workspaceSection,
    memorySection,
    memoryCount,
    skillsInner,
    skillsCount: skillMetas.length,
    skillsTokens,
    roleMentionsSection,
  }
}

/**
 * 构建系统提示词各分段（上下文分段计量用）。
 * system 段含全局 base + <environment> + <workspace>（**不含** override），
 * userSystem 段为 override 补充；二者 token 之和 = 实际 <system-reminder> 内 body（合并）。
 */
export function buildSystemPromptSegments(
  systemPromptFile?: string,
  workspace?: string,
  skillFilter?: SkillFilter,
  roleMentions?: RoleMentionInfo[],
): SystemPromptSegments {
  const p = buildPromptPieces(systemPromptFile, workspace, skillFilter, roleMentions)
  return {
    system: `<system-reminder>\n${p.globalBase}${p.roleMentionsSection}\n</system-reminder>\n\n${p.envBlock}${p.workspaceSection}`,
    userSystem: p.userSystem,
    memory: { text: p.memorySection, count: p.memoryCount },
    skills: {
      text: `<skills>\n${p.skillsInner}\n</skills>`,
      count: p.skillsCount,
      ...p.skillsTokens,
    },
  }
}

/**
 * 构建首条 system prompt（全局 base + per-agent systemPromptFile **合并**）。
 * @param systemPromptFile 可选，每 chat agent 专属 system prompt 文件绝对路径
 *   （主 agent 来自 preset.leader.systemPrompt，子 agent 来自 config.roles[type].systemPrompt）；
 *   给出则作**补充**合并到全局 base 之后（合并非替换，支持每 agent 不同 prompt 文件）；
 *   文件缺失 warn + 仅用全局 base（配置期 validateRawConfig 已 existsSync 校验）。缺省 → 仅全局 base。
 * @param workspace 可选，预设级项目工作目录（注入 <workspace> 段）。
 * @param skillFilter 可选，per-role 技能组/插件组过滤（仅 <skills> 块；undefined = 全部）。
 */
export default function buildFirstSystemPrompt(
  systemPromptFile?: string,
  workspace?: string,
  skillFilter?: SkillFilter,
  roleMentions?: RoleMentionInfo[],
): string {
  const p = buildPromptPieces(systemPromptFile, workspace, skillFilter, roleMentions)
  // 合并：全局 base 在前为基础，override 在后为补充
  const base = `${p.globalBase}${p.roleMentionsSection}`
  const body = p.userSystem ? `${base}\n\n${p.userSystem}` : base
  return `<system-reminder>
${body}
</system-reminder>

${p.envBlock}${p.workspaceSection}${p.memorySection}

<skills>
${p.skillsInner}
</skills>`
}
