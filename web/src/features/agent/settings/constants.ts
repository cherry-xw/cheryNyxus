/**
 * Settings 面板共享常量。各 tab 组件按需 import。
 */
export type TabKey = "default" | "brains" | "senses" | "subagents" | "mcp" | "global";

export const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: "default", icon: "⭐", label: "默认宠物" },
  { key: "brains", icon: "🧠", label: "AI 大脑" },
  { key: "senses", icon: "👂", label: "感官分组" },
  { key: "subagents", icon: "🎭", label: "子 agent" },
  { key: "mcp", icon: "🔌", label: "MCP 服务" },
  { key: "global", icon: "⚙️", label: "全局" },
];

export const PROVIDERS = ["openai", "ollama", "mock"] as const;
export const SUPERVISIONS = ["auto", "confirm", "manual"] as const;
export const DANGEROUS_SENSES = ["execute_command", "write_file", "destroy_subagent"];
