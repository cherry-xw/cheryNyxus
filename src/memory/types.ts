/**
 * 项目记忆模块类型定义。
 *
 * 记忆格式参考 Claude 全局记忆系统：frontmatter（YAML）+ markdown 正文。
 * 分类（对齐 Claude Code 四类闭合分类）：user / feedback / project / reference。
 *   - user：用户角色、目标、专业水平、偏好
 *   - feedback：用户对工作方式的反馈（纠正 + 认可），必含 Why + How to apply
 *   - project：项目进展/决策/截止日期（不可从代码或 git 推导），必含 Why + How to apply；相对日期转绝对日期
 *   - reference：外部系统的指针（Linear/Grafana/Slack 等）
 * 活跃记忆存 <root>/<name>.md（与 main.md 同级，平铺），淘汰归档到 <root>/history/<name>.md（增加替换元数据）。
 */

/** 记忆分类（四类闭合，对齐 Claude Code） */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

/** 记忆 frontmatter 元数据 */
export interface MemoryMetadata {
  node_type: 'memory'
  type: MemoryType
  /** 写入时间（ISO），用于漂移防护新鲜度判断 */
  created_at?: string
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
  /** 写入时间（ISO），漂移防护新鲜度判断 */
  createdAt?: string
  originSessionId?: string
}

/** 历史记忆完整数据 */
export interface HistoryEntry extends Memory {
  replacedAt: string
  replacedReason: string
  replacedBy: string
}
