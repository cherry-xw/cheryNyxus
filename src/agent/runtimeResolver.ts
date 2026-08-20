import type { AdaptersGroup, RuntimeConfig, SenseEntry } from '@/core/middleware/types'
import type { Sense, SenseFunction } from '@/core/sense'
import type { SenseAdapter } from '@/core/sense/adapter'
import { isOrdinaryRole, type BrainConfig } from '@/utils/config'
import type { ZodType } from 'zod'
import config from '@/utils/config'
import { SupervisionLevel } from '@/core/config'
import { getLLMAdapter } from '@/core/llm/adapter'
import { getMessageAdapter } from '@/core/message/adapter'
import { getSenseAdapter } from '@/core/sense/adapter'
import { getSense, loadMergedRuleSet } from '@/core/sense'
import { getConnectedServerSenseNames } from '@/core/mcp'
import { getSense as getBuiltinSense } from '@/core/sense'
import type { SkillFilter } from '@/agent/prompt/loadSkill'
import { buildSpawnRoleSense } from './sense/spawn.js'

export interface RuntimeSelection {
  brain: string
  /** 单一感官组；无 Tool Call 模型时为空字符串。 */
  senseGroup: string
  /** 启用的 MCP server 名（与 senseGroup 同层级）。enabled server 的全部 mcp__<server>__* 直接合并进 schema，绕过 sense_groups。 */
  mcpServers: string[]
}

/** runtime selection 失效清单（仅展示/恢复用；用户主动输入仍走 parseRuntimeSelection 严格抛错）。 */
export interface RuntimeIssue {
  kind: 'brain' | 'senseGroup'
  name: string
}

/**
 * 只读校验 selection 引用的名称是否存在于当前 config（纯函数，不抛错、不触 db）。
 * 快照投影（历史 chat 恢复）用：配置演化导致 brain/感官组失效是常态，返回问题清单供
 * 上层（resolveEffectiveSelection）判定「跟随 / 真·失效」，而非 fail loud。
 * 空数组 = 全部有效。mcpServers 不在此校验（连接态由 resolveSense 运行时判定）。
 */
export function resolveSelectionIssues(selection: RuntimeSelection): RuntimeIssue[] {
  const issues: RuntimeIssue[] = []
  if (!selection.brain || !config.llm.brain[selection.brain]) {
    issues.push({ kind: 'brain', name: selection.brain })
  }
  if (selection.senseGroup && !config.sense_groups?.[selection.senseGroup]) {
    issues.push({ kind: 'senseGroup', name: selection.senseGroup })
  }
  return issues
}

/**
 * 解析并校验 runtime selection（brain + senseGroup + mcpServers）。
 * 供 chat.create / runtime.set 共用，methodName 用于错误消息。
 * mcpServers 缺省 []（旧 chat 向后兼容）；非数组视为非法。
 */
export function parseRuntimeSelection(
  params: { brain?: string; senseGroup?: string; mcpServers?: string[] },
  _methodName: string,
): RuntimeSelection {
  if (!params.brain) throw new Error('必须选择一颗大脑')
  const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : []
  const brain = config.llm.brain[params.brain]
  if (!brain) throw new Error(`大脑 "${params.brain}" 不存在，请在设置里检查`)
  if (brain.capabilities?.toolCall === false) {
    if (params.senseGroup || mcpServers.length)
      throw new Error(`大脑 "${params.brain}" 不支持工具调用，不能配感官组`)
    return { brain: params.brain, senseGroup: '', mcpServers: [] }
  }
  if (!params.senseGroup) throw new Error('这颗大脑需要配一个感官组')
  return { brain: params.brain, senseGroup: params.senseGroup, mcpServers }
}

/**
 * 解析预设主 agent 编制：取 leader 角色的 RoleConfig（config.roles[leader]）作 brain+senseGroup+mcpServers
 * 的 RuntimeSelection 快照，并返回该角色的 systemPrompt 作 systemPromptFile。
 * 复用 parseRuntimeSelection（校验 brain/senseGroup 非空 + mcpServers 数组化）。
 * chat.create 选预设时调用；运行编制快照入 metadata.runtime，运行后不可改。
 */
export function resolvePresetSelection(presetName: string): {
  presetId: string
  selection: RuntimeSelection
  systemPromptFile?: string
  /** 该预设选中的角色 type 列表（chat.create 快照入 metadata.spawnTypes，spawn roster gate 用） */
  spawnTypes: string[]
  /** 该预设的项目工作目录（chat.create 快照入 metadata.workspace，buildFirstSystemPrompt 注入提示词） */
  workspace?: string
  /** leader 角色的技能组/插件组过滤（chat.create 快照入 metadata.skillFilter，<skills> 块按角色裁剪） */
  skillFilter?: SkillFilter
  /** smart 监管规则覆盖文件名（chat.create 快照入 metadata.rule，resolve 期与 base.yaml 深合并） */
  rule?: string
} {
  const preset = config.presets?.[presetName]
  if (!preset?.leader) {
    throw new Error(
      `预设 "${presetName}" 不存在或没指定组长角色（可用：${Object.keys(config.presets ?? {}).join(', ') || '（未配置任何预设）'}）`,
    )
  }
  // 主 pet 编制取 leader 角色的 RoleConfig（config.roles 单一源）。
  const leader = config.roles?.[preset.leader]
  if (!isOrdinaryRole(leader)) {
    throw new Error(
      `预设 "${presetName}" 的组长角色 "${preset.leader}" 不存在（可用：${Object.keys(config.roles ?? {}).join(', ') || '（未配置任何角色）'}）`,
    )
  }
  const selection = parseRuntimeSelection(
    { brain: leader.brain, senseGroup: leader.senseGroup, mcpServers: leader.mcpServers ?? [] },
    `presets.${presetName}.leader(${preset.leader})`,
  )
  // per-role 技能组/插件组：任一维度显式设置（含 []）→ 构造 filter；二者皆 undefined → undefined（全部 skill）
  const skillFilter: SkillFilter | undefined =
    leader.skills !== undefined || leader.plugins !== undefined
      ? { skills: leader.skills, plugins: leader.plugins }
      : undefined
  return {
    presetId: preset.id!,
    selection,
    systemPromptFile: leader.systemPrompt,
    spawnTypes: (preset.roles ?? []).filter((name) => isOrdinaryRole(config.roles?.[name])),
    workspace: preset.workspace,
    skillFilter,
    rule: preset.rule,
  }
}

export function resolveDetailSelection(presetName: string): {
  selection: RuntimeSelection
  systemPromptFile?: string
  description?: string
  skillFilter?: SkillFilter
} {
  const preset = config.presets?.[presetName]
  if (!preset?.detailRole) throw new Error(`预设 "${presetName}" 未配置解释角色`)
  if (!(preset.roles ?? []).includes(preset.detailRole)) {
    throw new Error(`预设 "${presetName}" 的解释角色必须是预设成员`)
  }
  const detail = config.roles?.[preset.detailRole]
  if (!isOrdinaryRole(detail))
    throw new Error(`预设 "${presetName}" 的解释角色 "${preset.detailRole}" 必须是普通角色`)
  const selection = parseRuntimeSelection(
    { brain: detail.brain, senseGroup: detail.senseGroup, mcpServers: detail.mcpServers ?? [] },
    'detail role',
  )
  const skillFilter =
    detail.skills !== undefined || detail.plugins !== undefined
      ? { skills: detail.skills, plugins: detail.plugins }
      : undefined
  return {
    selection,
    systemPromptFile: detail.systemPrompt,
    description: detail.description,
    skillFilter,
  }
}

export class RuntimeResolver {
  /**
   * 原子解析完整 runtime。
   * brain、adapters、builtSenses、senseTable 必须来自同一次 selection。
   *
   * @param opts.injectMemoryManage 主 agent 硬编码注入 memory_manage sense（默认 true）；
   *   子 agent 传 false 排除。
   * @param opts.ruleName smart 监管规则覆盖文件名（metadata.rule；resolve 期与 base.yaml 深合并
   *   冻结入 sensitivityRules）。缺省 → 仅用基准。所有 configureRuntime 触点须透传，避免切 brain 退化。
   */
  resolve(
    selection: RuntimeSelection,
    opts?: { injectMemoryManage?: boolean; ruleName?: string; chatId?: string },
  ): RuntimeConfig {
    this.validateSelection(selection)

    const { brain, adapters } = this.resolveBrain(selection.brain)
    const { builtSenses, senseTable } = this.resolveSense(
      adapters.senseAdapter,
      selection.senseGroup,
      selection.mcpServers,
      brain.capabilities?.generate,
      opts?.injectMemoryManage ?? true,
      opts?.chatId,
    )

    return {
      brain,
      adapters,
      builtSenses,
      senseTable,
      sensitivityRules: loadMergedRuleSet(opts?.ruleName),
    }
  }

  private validateSelection(selection: RuntimeSelection): void {
    if (!selection.brain || selection.brain.trim().length === 0) {
      throw new Error('必须选择一颗大脑')
    }
    // Public runtime/create inputs stay strict in parseRuntimeSelection. Internal
    // detail branches deliberately pass an empty group to create a no-tools role.
    if (!config.llm.brain[selection.brain]) {
      throw new Error(`大脑 "${selection.brain}" 不存在，请在设置里检查`)
    }
  }

  /**
   * resolve brain 名称 -> brain 配置 + provider adapters。
   */
  private resolveBrain(name: string): { brain: BrainConfig; adapters: AdaptersGroup } {
    const brain = config.llm.brain[name]
    if (!brain) {
      throw new Error(`大脑 "${name}" 不存在，请在设置里检查`)
    }

    const provider = brain.provider
    const llmAdapter = getLLMAdapter(provider)
    const messageAdapter = getMessageAdapter(provider)
    const senseAdapter = getSenseAdapter(provider)

    if (!llmAdapter || !messageAdapter || !senseAdapter) {
      throw new Error(`不支持 "${provider}" 这类大脑`)
    }

    return {
      brain,
      adapters: { llmAdapter, messageAdapter, senseAdapter },
    }
  }

  /**
   * resolve senseGroup + mcpServers -> builtSenses（给 LLM）+ senseTable（监管等级 + 执行器）。
   *
   * 监管优先级：后缀覆盖（:level）> 感官内置 > global。（单组化后不再有跨组覆盖合并）
   *
   * MCP 挂载：mcpServers 绕过 sense_groups，enabled server 的全部 mcp__<server>__* sense
   * 直接合并进 resolved Map（去重冲突 MCP 覆盖）；监管用 sense 自带 server 级 supervision
   * （无 :level 覆盖）。未连 server 由 getConnectedServerSenseNames 抛 NOT_FOUND（fail loud）。
   */
  private resolveSense(
    senseAdapter: SenseAdapter<unknown>,
    senseGroup: string,
    mcpServers: string[],
    generateCapabilities?: { image?: boolean; video?: boolean; audio?: boolean },
    injectMemoryManage = true,
    chatId?: string,
  ): { builtSenses: SenseFunction[]; senseTable: Map<string, SenseEntry> } {
    const resolved = new Map<string, Sense<ZodType>>()

    if (!senseGroup) return { builtSenses: [], senseTable: new Map() }
    const group = config.sense_groups?.[senseGroup]
    if (!group) {
      throw new Error(`感官组 "${senseGroup}" 不存在，请在设置里检查`)
    }

    for (const entry of group) {
      const { senseName, supervisionLevel } = this.parseSenseGroupEntry(entry)
      const mediaKind = senseName.match(/^generate_(image|video|audio)$/)?.[1] as
        'image' | 'video' | 'audio' | undefined
      if (mediaKind && !generateCapabilities?.[mediaKind]) continue
      let original = getSense(senseName)
      if (!original) {
        throw new Error(`感官 "${senseName}" 不存在，请在设置里检查`)
      }

      // spawn_role：「可见即可选」——按当前 chat roster 裁剪工具定义（preset 编制 + self-spawn 排除）。
      // 工具 type 枚举只暴露本 chat 可派发角色，LLM 不再选到别处角色（原有执行期 roster gate 保留为纵深防御）。
      if (senseName === 'spawn_role' && chatId) {
        original = buildSpawnRoleSense(chatId)
      }

      const name = original.definition.function.name
      // shallow copy 隔离：supervisionLevel 写入不得污染全局 senseRegistry（多 chat 共享）
      const s: Sense<ZodType> = { ...original }
      s.supervisionLevel = supervisionLevel ?? s.supervisionLevel ?? config.global.supervision
      resolved.set(name, s)
    }

    // MCP server 的全部 sense 合并进 schema（绕过 sense_groups，监管用 server 级默认）
    for (const serverName of mcpServers) {
      for (const senseName of getConnectedServerSenseNames(serverName)) {
        const original = getSense(senseName)
        if (!original) continue // registry 中已不存在（理论上不应发生，连接时注册）
        const s: Sense<ZodType> = { ...original }
        s.supervisionLevel = original.supervisionLevel ?? config.global.supervision
        resolved.set(original.definition.function.name, s)
      }
    }

    // 主 agent 硬编码注入记忆与子 Agent 控制能力（子 agent 排除）。
    if (injectMemoryManage) {
      for (const senseName of ['memory_manage', 'stop_child', 'send_to_child']) {
        const mainSense = getBuiltinSense(senseName)
        if (!mainSense) continue
        const s: Sense<ZodType> = { ...mainSense }
        s.supervisionLevel = s.supervisionLevel ?? config.global.supervision
        resolved.set(senseName, s)
      }
    }

    const senses = [...resolved.values()]
    return {
      builtSenses: senseAdapter.buildSenses(senses),
      senseTable: this.buildSenseTable(senses),
    }
  }

  private parseSenseGroupEntry(entry: string): {
    senseName: string
    supervisionLevel?: SupervisionLevel
  } {
    const [rawName, rawLevel] = entry.split(':')
    const senseName = rawName?.trim()
    if (!senseName) {
      throw new Error(`感官组配置 "${entry}" 无效`)
    }
    if (!rawLevel) {
      return { senseName }
    }

    const levelName = rawLevel.trim()
    const supervisionByName: Record<string, SupervisionLevel> = {
      auto: SupervisionLevel.auto,
      smart: SupervisionLevel.smart,
      manual: SupervisionLevel.manual,
    }
    const supervisionLevel = supervisionByName[levelName]
    if (supervisionLevel === undefined) {
      throw new Error(
        `感官 "${senseName}" 的监管等级 "${rawLevel}" 无效（合法：auto/smart/manual）`,
      )
    }

    return { senseName, supervisionLevel }
  }

  private buildSenseTable(senses: Sense<ZodType>[]): Map<string, SenseEntry> {
    const senseTable = new Map<string, SenseEntry>()
    for (const s of senses) {
      const name = s.definition.function.name
      senseTable.set(name, {
        supervisionLevel: s.supervisionLevel ?? config.global.supervision,
        execute: (args, sharedData, ctx) =>
          s.executor.execute(args as Parameters<typeof s.executor.execute>[0], sharedData, ctx),
      })
    }
    return senseTable
  }
}
