/**
 * Settings 面板共享常量。各 tab 组件按需 import。
 */
import type { InjectionKey, Ref } from 'vue'
import type { IconInput } from 'morphicons/vue'
import { LLM_PROVIDER_CATALOG, LLM_PROTOCOL_CATALOG } from '@chery/protocol'
import {
  Anchor,
  Archive,
  BrainCircuit,
  Ear,
  NotebookPen,
  Package,
  Plug,
  Puzzle,
  Settings,
  Sparkles,
  SquareTerminal,
} from 'lucide'

export type TabKey =
  | 'archive'
  | 'brains'
  | 'senses'
  | 'presets'
  | 'mcp'
  | 'global'
  | 'commands'
  | 'hooks'
  | 'skills'
  | 'plugins'
  | 'terminal'

/** TabShell 用于判断自身是否为当前可见 Tab，避免 v-show 下多个 Teleport 同时占用 footer。 */
export const SETTINGS_ACTIVE_TAB_KEY = Symbol('settings-active-tab') as InjectionKey<
  Readonly<Ref<TabKey>>
>

export const TABS: { key: TabKey; icon: IconInput; label: string; color: string }[] = [
  // 大脑是首次配置入口，固定放在首位；其余 tab 保持既有顺序与颜色。
  { key: 'brains', icon: BrainCircuit, label: '大脑', color: '#f59e0b' },
  { key: 'presets', icon: Package, label: '预设', color: '#ef4444' },
  { key: 'senses', icon: Ear, label: '器官', color: '#a3e635' },
  { key: 'skills', icon: Sparkles, label: '技能', color: '#22c55e' },
  { key: 'plugins', icon: Puzzle, label: '组合技', color: '#10b981' },
  { key: 'commands', icon: NotebookPen, label: '指令', color: '#06b6d4' },
  { key: 'hooks', icon: Anchor, label: '钩子', color: '#0ea5e9' },
  { key: 'mcp', icon: Plug, label: 'MCP', color: '#3b82f6' },
  { key: 'archive', icon: Archive, label: '归档', color: '#d946ef' },
  { key: 'terminal', icon: SquareTerminal, label: '终端', color: '#ec4899' },
  // 用户指定：全局固定放在页签最后一条
  { key: 'global', icon: Settings, label: '全局', color: '#8b5cf6' },
]

export const PROVIDERS = LLM_PROVIDER_CATALOG.map((provider) => provider.id)
export const PROTOCOLS = LLM_PROTOCOL_CATALOG.map((protocol) => protocol.id)
export const SUPERVISIONS = ['auto', 'smart', 'manual'] as const
/** 监管等级中文展示名（下拉 label 用；value 仍存英文枚举，对应后端 SupervisionLevel）。 */
export const SUPERVISION_LABEL: Record<(typeof SUPERVISIONS)[number], string> = {
  auto: '自动',
  smart: '智能',
  manual: '手动',
}
export const DANGEROUS_SENSES = ['execute_command', 'write_file', 'destroy_role']

/**
 * 各 tab 的 hints slot 段落拆分（用于 SkeletonTab 复用真实 .sect-hint / .warn-hint
 * 渲染，让 .shell-hints 计算高度与真实 tab 像素级一致）。
 *  - sect：.sect-hint 段落数（行高 11×1.5 = 17px，无 padding）
 *  - warn：.warn-hint 段落数（行高 11×1.4 = 15.4 + padding 5×2 = 25.4px）
 */
export const HINT_LINES: Record<TabKey, { sect: number; warn: number }> = {
  archive: { sect: 1, warn: 0 },
  presets: { sect: 1, warn: 0 },
  brains: { sect: 1, warn: 1 },
  senses: { sect: 1, warn: 1 },
  mcp: { sect: 1, warn: 1 },
  global: { sect: 1, warn: 0 },
  commands: { sect: 1, warn: 0 },
  hooks: { sect: 1, warn: 1 },
  skills: { sect: 1, warn: 0 },
  plugins: { sect: 1, warn: 0 },
  terminal: { sect: 1, warn: 1 },
}

/**
 * 各 tab 的骨架屏 footer 导航按钮数量估算（典型值，非实时）。
 * SkeletonTab 用此值在设置底栏左侧渲染 .skel-dot，占住导航区域直到真实 Tab 就绪。
 */
export const INDEX_COUNT: Record<TabKey, number> = {
  archive: 0,
  presets: 2, // 典型 1-3 个预设
  brains: 3, // 典型 2-5 颗 brain
  senses: 0, // 瀑布流后无 footer 圆点导航
  mcp: 1, // 典型 0-2 个 MCP
  global: 3, // 默认监管 + logger + file_compression，常见三者齐
  commands: 2, // 默认仅 compact 一条；可扩展内置指令
  hooks: 3, // 10 事件，典型 2-4 个有 handler
  skills: 4, // 典型 1-8 个独立 skill
  plugins: 1, // 典型 0-3 个插件
  terminal: 1,
}
