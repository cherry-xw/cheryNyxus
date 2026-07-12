/**
 * Settings 面板共享常量。各 tab 组件按需 import。
 */
export type TabKey = "brains" | "senses" | "roles" | "presets" | "mcp" | "global";

export const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: "presets", icon: "📦", label: "预设" },
  { key: "brains", icon: "🧠", label: "AI 大脑" },
  { key: "senses", icon: "👂", label: "感官分组" },
  { key: "roles", icon: "🎭", label: "角色" },
  { key: "mcp", icon: "🔌", label: "MCP 服务" },
  { key: "global", icon: "⚙️", label: "全局" },
];

export const PROVIDERS = ["openai", "ollama", "mock"] as const;
export const SUPERVISIONS = ["auto", "confirm", "manual"] as const;
/** 监管等级中文展示名（下拉 label 用；value 仍存英文枚举，对应后端 SupervisionLevel）。 */
export const SUPERVISION_LABEL: Record<(typeof SUPERVISIONS)[number], string> = {
  auto: "自动",
  confirm: "确认",
  manual: "手动",
};
export const DANGEROUS_SENSES = ["execute_command", "write_file", "destroy_role"];
