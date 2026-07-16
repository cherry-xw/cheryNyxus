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
}

export interface SkillCommandMeta {
  name: string;
  description: string;
  trigger?: string;
}

export const COMPACT_COMMAND: MessageCommand = {
  id: "builtin:compact",
  name: "/compact",
  label: "压缩上下文",
  description: "整理当前对话的关键事实、决策、进度和待办，供后续继续使用。",
  kind: "builtin",
};

export function toSkillCommands(skills: SkillCommandMeta[]): MessageCommand[] {
  return skills.map((skill) => ({
    id: `skill:${skill.name}`,
    name: `/${skill.name}`,
    label: skill.name,
    description: skill.description || skill.trigger || "加载并遵守该技能的完整指令。",
    kind: "skill",
    skillName: skill.name,
  }));
}

/**
 * 将可见的指令标签编排为用户消息中的明确 AI 指令。
 * 不使用富文本/contenteditable：最终消息仍是普通文本，确保历史和传输层兼容。
 */
export function composeCommandPrompt(text: string, commands: MessageCommand[]): string {
  const directives = commands.map((command) => {
    if (command.kind === "skill" && command.skillName) {
      return `<command name="${command.name}">\n用户明确要求加载技能“${command.skillName}”。请立刻调用 skill 工具，参数为 {"name":"${command.skillName}"}；在技能加载完成前不要处理其他任务，并严格遵守其完整指令。\n</command>`;
    }
    return `<command name="/compact">\n用户明确要求压缩当前上下文。请整理本会话的目标、关键事实、已作决策、当前进度与待办，输出可供后续轮次直接使用的简明摘要。\n</command>`;
  });
  const userText = text.trim();
  return [...directives, userText].filter(Boolean).join("\n\n");
}
