/**
 * Settings 面板共享常量。各 tab 组件按需 import。
 */
export type TabKey = "brains" | "media" | "senses" | "roles" | "presets" | "mcp" | "global" | "commands";

export const TABS: { key: TabKey; icon: string; label: string }[] = [
  { key: "presets", icon: "📦", label: "预设" },
  { key: "brains", icon: "🧠", label: "AI 大脑" },
  { key: "senses", icon: "👂", label: "感官分组" },
  { key: "roles", icon: "🎭", label: "角色" },
  { key: "mcp", icon: "🔌", label: "MCP 服务" },
  { key: "media", icon: "🖼️", label: "媒体服务" },
  { key: "global", icon: "⚙️", label: "全局" },
  { key: "commands", icon: "📝", label: "指令" },
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

/**
 * 各 tab 的 hints slot 段落拆分（用于 SkeletonTab 复用真实 .sect-hint / .warn-hint
 * 渲染，让 .shell-hints 计算高度与真实 tab 像素级一致）。
 *  - sect：.sect-hint 段落数（行高 11×1.5 = 17px，无 padding）
 *  - warn：.warn-hint 段落数（行高 11×1.4 = 15.4 + padding 5×2 = 25.4px）
 */
export const HINT_LINES: Record<TabKey, { sect: number; warn: number }> = {
  presets: { sect: 1, warn: 0 },
  brains: { sect: 1, warn: 1 },
  media: { sect: 1, warn: 0 },
  senses: { sect: 1, warn: 1 },
  roles: { sect: 1, warn: 0 },
  mcp: { sect: 1, warn: 1 },
  global: { sect: 1, warn: 0 },
  commands: { sect: 1, warn: 0 },
};

/**
 * 各 tab 的骨架屏序号按钮数量估算（典型值，非实时）。
 * SkeletonTab 用此值渲染 .skel-dot 行数，使 .shell-sticky 高度与真实 tab 像素级一致，
 * 避免 skeleton → real 时 .shell-scroll 起点 y 跳动。
 * 真实数据加载后若 indexItems 长度与此不同，差异会被一行内排列吸收（按钮 16×16 + gap 3，13 个内不换行）。
 */
export const INDEX_COUNT: Record<TabKey, number> = {
  presets: 2,  // 典型 1-3 个预设
  brains: 3,   // 典型 2-5 颗 brain
  media: 2,    // 典型 0-4 个媒体服务
  senses: 2,   // 典型 1-4 组感官
  roles: 3,    // 典型 2-5 个角色
  mcp: 1,      // 典型 0-2 个 MCP
  global: 3,   // 默认监管 + logger + file_compression，常见三者齐
  commands: 2, // 默认仅 compact 一条；可扩展内置指令
};

