/**
 * Settings 面板共享常量。各 tab 组件按需 import。
 */
import type { InjectionKey, Ref } from 'vue'
import { LLM_PROVIDER_CATALOG, LLM_PROTOCOL_CATALOG } from '@chery/protocol'

export type TabKey =
  | 'brains'
  | 'media'
  | 'senses'
  | 'roles'
  | 'presets'
  | 'mcp'
  | 'global'
  | 'commands'
  | 'hooks'
  | 'skills'
  | 'plugins'

/** TabShell 用于判断自身是否为当前可见 Tab，避免 v-show 下多个 Teleport 同时占用 footer。 */
export const SETTINGS_ACTIVE_TAB_KEY = Symbol('settings-active-tab') as InjectionKey<
  Readonly<Ref<TabKey>>
>

export const TABS: { key: TabKey; icon: string; label: string; color: string }[] = [
  { key: 'presets', icon: '📦', label: '预设', color: '#f6b73c' },
  { key: 'roles', icon: '🎭', label: '角色', color: '#fb7185' },
  { key: 'brains', icon: '🧠', label: '大脑', color: '#5ee7ff' },
  { key: 'senses', icon: '👂', label: '器官', color: '#34d399' },
  { key: 'skills', icon: '✨', label: '技能', color: '#6366f1' },
  { key: 'plugins', icon: '🧩', label: '组合技', color: '#3b82f6' },
  { key: 'commands', icon: '📝', label: '指令', color: '#84cc16' },
  { key: 'hooks', icon: '⚓', label: '钩子', color: '#f472b6' },
  { key: 'mcp', icon: '🔌', label: 'MCP', color: '#8b5cf6' },
  { key: 'media', icon: '🖼️', label: '多媒体', color: '#f97316' },
  { key: 'global', icon: '⚙️', label: '全局', color: '#06b6d4' },
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
  presets: { sect: 1, warn: 0 },
  brains: { sect: 1, warn: 1 },
  media: { sect: 1, warn: 0 },
  senses: { sect: 1, warn: 1 },
  roles: { sect: 1, warn: 0 },
  mcp: { sect: 1, warn: 1 },
  global: { sect: 1, warn: 0 },
  commands: { sect: 1, warn: 0 },
  hooks: { sect: 1, warn: 1 },
  skills: { sect: 1, warn: 0 },
  plugins: { sect: 1, warn: 0 },
}

/**
 * 各 tab 的骨架屏 footer 导航按钮数量估算（典型值，非实时）。
 * SkeletonTab 用此值在设置底栏左侧渲染 .skel-dot，占住导航区域直到真实 Tab 就绪。
 */
export const INDEX_COUNT: Record<TabKey, number> = {
  presets: 2, // 典型 1-3 个预设
  brains: 3, // 典型 2-5 颗 brain
  media: 2, // 典型 0-4 个媒体服务
  senses: 0, // 瀑布流后无 footer 圆点导航
  roles: 3, // 典型 2-5 个角色
  mcp: 1, // 典型 0-2 个 MCP
  global: 3, // 默认监管 + logger + file_compression，常见三者齐
  commands: 2, // 默认仅 compact 一条；可扩展内置指令
  hooks: 3, // 10 事件，典型 2-4 个有 handler
  skills: 4, // 典型 1-8 个独立 skill
  plugins: 1, // 典型 0-3 个插件
}
