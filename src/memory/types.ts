/**
 * 项目记忆模块类型定义。
 *
 * 记忆格式参考 Claude 全局记忆系统：frontmatter（YAML）+ markdown 正文。
 * 分类：feedback / fact / instruction / decision / reference。
 * 活跃记忆存 <root>/<name>.md（与 main.md 同级，平铺），淘汰归档到 <root>/history/<name>.md（增加替换元数据）。
 */

/** 记忆分类 */
export type MemoryType = 'feedback' | 'fact' | 'instruction' | 'decision' | 'reference'

/** 记忆 frontmatter 元数据 */
export interface MemoryMetadata {
  node_type: 'memory'
  type: MemoryType
  originSessionId?: string
}

/** 活跃记忆 frontmatter（<root>/<name>.md） */
export interface MemoryFrontmatter {
  name: string
  description: string
  metadata: MemoryMetadata
}

/** 历史记忆 frontmatter（<root>/history/<name>.md）— 在活跃基础上增加淘汰元数据 */
export interface HistoryFrontmatter extends MemoryFrontmatter {
  metadata: MemoryMetadata & {
    replaced_at: string
    replaced_reason: string
    replaced_by: string
  }
}

/** 汇总索引条目（main.md 一行） */
export interface MemoryIndexEntry {
  /** 显示标题（≤40字，取自 description） */
  title: string
  /** 文件名（不含扩展名，= memory.name） */
  filename: string
  /** 简短描述 */
  description: string
}

/** 历史汇总索引条目（<root>/history/main.md） */
export interface HistoryIndexEntry extends MemoryIndexEntry {
  replacedAt: string
  replacedReason: string
  replacedBy: string
}

/** 活跃记忆完整数据 */
export interface Memory {
  name: string
  description: string
  type: MemoryType
  /** 正文（不含 frontmatter） */
  content: string
  originSessionId?: string
}

/** 历史记忆完整数据 */
export interface HistoryEntry extends Memory {
  replacedAt: string
  replacedReason: string
  replacedBy: string
}
