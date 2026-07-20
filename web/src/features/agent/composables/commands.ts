/** 发送窗口与宠物快捷入口共用的内置/用户技能命令模型。 */
export interface MessageCommand {
  /** 稳定 UI key；用户技能为 `skill:<name>`，内置命令为 `builtin:<name>`。 */
  id: string
  /** 输入框中显示的 slash 命令（搜索 key 也用此）。 */
  name: string
  /** 弹窗与 token 内显示的纯技能名（不含 plugin 前缀）。 */
  label: string
  description: string
  kind: 'skill' | 'builtin'
  /** kind=skill 时为 skill 感官所需的实际名称（与 `label` 同义；公开别名用于语义清晰）。 */
  skillName?: string
  /** 激活完整技能指令后预计新增的上下文 token；内置指令不适用。 */
  contextTokens?: number
  /** 来源插件名（独立 skill 时缺省）；显示成 `<plugin>:<skillName>` 用于与独立技能区分。 */
  plugin?: string
}

export interface SkillCommandMeta {
  name: string
  description: string
  trigger?: string
  contextTokens: number
  /** 来源插件名（独立技能时缺省）；see SkillInfo.plugin。 */
  plugin?: string
}

export const COMPACT_COMMAND: MessageCommand = {
  id: 'builtin:compact',
  name: '/compact',
  label: 'compact',
  description: '整理当前对话的关键事实、决策、进度和待办，供后续继续使用。',
  kind: 'builtin',
}

const COMMAND_TOKEN_PATTERN = /\[\[command:(\/[^\]\s]+)\]\]/g

export interface CommandPromptSegment {
  type: 'text' | 'command'
  value: string
}

export function toSkillCommands(skills: SkillCommandMeta[]): MessageCommand[] {
  return skills.map((skill) => ({
    id: `skill:${skill.name}`,
    name: `/${skill.name}`,
    label: skill.name,
    description: skill.description || skill.trigger || '加载并遵守该技能的完整指令。',
    kind: 'skill',
    skillName: skill.name,
    contextTokens: skill.contextTokens,
    // 透传来源插件：独立 skill 时缺省；有插件时弹窗显示 `<plugin>:<skillName>`。
    plugin: skill.plugin,
  }))
}

/** 弹窗与日志显示用的合成名（plugin 前缀拼接；独立技能时退回 label）。 */
export function getCommandDisplayName(command: MessageCommand): string {
  return command.plugin ? `${command.plugin}:${command.label}` : command.label
}

/** 将指令 token 序列化到用户正文；行为语义由系统提示词统一定义。 */
export function serializeCommandToken(command: MessageCommand): string {
  return `[[command:${command.name}]]`
}

/** 当前用户消息的指令标记 +（如有）完整技能加载指令的近似 token 消耗。 */
export function estimateCommandTokens(command: MessageCommand): number {
  return Math.ceil(serializeCommandToken(command).length / 4) + (command.contextTokens ?? 0)
}

/** 将已存储的用户消息拆为普通正文与可安全渲染的指令 token。 */
export function splitCommandPrompt(content: string): CommandPromptSegment[] {
  const segments: CommandPromptSegment[] = []
  let cursor = 0
  for (const match of content.matchAll(COMMAND_TOKEN_PATTERN)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ type: 'text', value: content.slice(cursor, start) })
    segments.push({ type: 'command', value: match[1]! })
    cursor = start + match[0].length
  }
  if (cursor < content.length || segments.length === 0) {
    segments.push({ type: 'text', value: content.slice(cursor) })
  }
  return segments
}

/**
 * 历史快捷入口与发送窗口共用：消息正文已经包含指令 token，无需按发送重复注入提示词。
 *
 * **token 形态语义**（由后端 `injectCommands` 处理，详见 docs/agent/command.md）：
 * - `[[command:/<skillName>]]`：AI 通过 system prompt `<skills>` 段自行加载；
 * - `[[command:/<builtinName>]]`：后端从 `.chery/command/<builtinName>.md` 加载正文作为**独立
 *   user message** 追加到主 prompt 之前；不在此处做任何后处理。
 */
export function composeCommandPrompt(text: string): string {
  return text.trim()
}

// ========== compact 阈值配置：文本 ↔ Threshold ==========

/** 阈值（与后端 utils/config.ts Threshold / agentApi ThresholdDto 对齐）。 */
export interface Threshold {
  unit: 'tokens' | 'percent'
  value: number
}

/**
 * 解析阈值文本 → Threshold。**强制后缀**（数字 + `%` 或 `k`）：
 * - `50%`   → { percent, 0.5 }
 * - `64k`/`64K` → { tokens, 64000 }
 * 裸数字（如 `64000`）或无后缀 → null（调用方据此标红/禁保存）。
 */
export function parseThreshold(text: string): Threshold | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  if (t.endsWith('%')) {
    const num = Number.parseFloat(t.slice(0, -1))
    if (!Number.isFinite(num)) return null
    return { unit: 'percent', value: num / 100 }
  }
  if (t.endsWith('k')) {
    const num = Number.parseFloat(t.slice(0, -1))
    if (!Number.isFinite(num)) return null
    return { unit: 'tokens', value: num * 1000 }
  }
  return null
}

/** 阈值 → 展示文本：percent → `60%`；tokens → `64k`（强制带后缀，回填即合法）。 */
export function formatThreshold(t: Threshold): string {
  if (t.unit === 'percent') {
    const pct = t.value * 100
    return `${Number.isInteger(pct) ? pct : Math.round(pct)}%`
  }
  return `${t.value / 1000}k`
}

/**
 * 解析纯 token 数（min_context_limit 用）：**强制 `k` 后缀**（如 `32k`）。
 * 裸数字（如 `32000`）或无后缀 → null；≤ 0 → null。
 */
export function parseTokenCount(text: string): number | null {
  const t = text.trim().toLowerCase()
  if (!t || !t.endsWith('k')) return null
  const num = Number.parseFloat(t.slice(0, -1))
  const value = num * 1000
  if (!Number.isFinite(value) || value <= 0) return null
  return value
}

/** token 数 → 展示文本（按 K 计，如 `32k`；强制带后缀，回填即合法）。 */
export function formatTokenCount(n: number): string {
  return `${n / 1000}k`
}
