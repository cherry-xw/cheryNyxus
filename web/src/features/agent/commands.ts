/** 发送窗口与宠物快捷入口共用的内置/用户技能命令模型。 */
export interface MessageCommand {
  /** 稳定 UI key；用户技能为 `skill:<name>`，内置命令为 `builtin:<name>`。 */
  id: string;
  /** 输入框中显示的 slash 命令。 */
  name: string;
  label: string;
  description: string;
  kind: "skill" | "builtin";
  /** kind=skill 时为 skill 感官所需的实际名称。 */
  skillName?: string;
  /** 激活完整技能指令后预计新增的上下文 token；内置指令不适用。 */
  contextTokens?: number;
}

export interface SkillCommandMeta {
  name: string;
  description: string;
  trigger?: string;
  contextTokens: number;
}

export const COMPACT_COMMAND: MessageCommand = {
  id: "builtin:compact",
  name: "/compact",
  label: "compact",
  description: "整理当前对话的关键事实、决策、进度和待办，供后续继续使用。",
  kind: "builtin",
};

const COMMAND_TOKEN_PATTERN = /\[\[command:(\/[^\]\s]+)\]\]/g;

export interface CommandPromptSegment {
  type: "text" | "command";
  value: string;
}

export function toSkillCommands(skills: SkillCommandMeta[]): MessageCommand[] {
  return skills.map((skill) => ({
    id: `skill:${skill.name}`,
    name: `/${skill.name}`,
    label: skill.name,
    description: skill.description || skill.trigger || "加载并遵守该技能的完整指令。",
    kind: "skill",
    skillName: skill.name,
    contextTokens: skill.contextTokens,
  }));
}

/** 将指令 token 序列化到用户正文；行为语义由系统提示词统一定义。 */
export function serializeCommandToken(command: MessageCommand): string {
  return `[[command:${command.name}]]`;
}

/** 当前用户消息的指令标记 +（如有）完整技能加载指令的近似 token 消耗。 */
export function estimateCommandTokens(command: MessageCommand): number {
  return Math.ceil(serializeCommandToken(command).length / 4) + (command.contextTokens ?? 0);
}

/** 将已存储的用户消息拆为普通正文与可安全渲染的指令 token。 */
export function splitCommandPrompt(content: string): CommandPromptSegment[] {
  const segments: CommandPromptSegment[] = [];
  let cursor = 0;
  for (const match of content.matchAll(COMMAND_TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ type: "text", value: content.slice(cursor, start) });
    segments.push({ type: "command", value: match[1]! });
    cursor = start + match[0].length;
  }
  if (cursor < content.length || segments.length === 0) {
    segments.push({ type: "text", value: content.slice(cursor) });
  }
  return segments;
}

/** 历史快捷入口与发送窗口共用：消息正文已经包含指令 token，无需按发送重复注入提示词。 */
export function composeCommandPrompt(text: string): string {
  return text.trim();
}
