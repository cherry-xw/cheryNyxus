/**
 * 记忆 Markdown 文件读写（双层 · 平铺布局）。
 *
 * 每层目录结构：
 *   <root>/
 *   ├── main.md                ← 活跃索引
 *   ├── <name>.md              ← 活跃条目（与 main.md 同级）
 *   └── history/
 *       ├── main.md            ← 历史索引
 *       └── <name>.md          ← 历史条目
 *
 * 索引文件格式（main.md）：
 * ```
 * # Memory Index
 *
 * - [标题](<name>.md) — 描述
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type {
  MemoryFrontmatter,
  HistoryFrontmatter,
  Memory,
  HistoryEntry,
  MemoryIndexEntry,
  HistoryIndexEntry,
  MemoryType,
} from './types.js'
import { getMemoryRootDir, getHistoryDir, getMemoryIndexPath, getHistoryIndexPath } from './path.js'
import type { MemoryScope } from './path.js'

/** 解析 md 文件的 frontmatter + body（---\nYAML\n---\nBODY） */
function parseMd(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content.trim() }
  const fm = yaml.load(match[1] ?? '') as Record<string, unknown>
  return { frontmatter: fm ?? {}, body: (match[2] ?? '').trim() }
}

/** 序列化 frontmatter + body 为 md 文件内容 */
function serializeMd(frontmatter: Record<string, unknown>, body: string): string {
  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd()
  return `---\n${yamlStr}\n---\n\n${body}\n`
}

/** 确保目录存在（递归创建） */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** 活跃条目绝对路径：<root>/<name>.md */
function getMemoryFilePath(
  name: string,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): string {
  return path.join(getMemoryRootDir(workspace, scope), `${name}.md`)
}

/** 历史条目绝对路径：<root>/history/<name>.md */
function getHistoryFilePath(
  name: string,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): string {
  return path.join(getHistoryDir(workspace, scope), `${name}.md`)
}

// === 活跃记忆索引（main.md）===

/** 解析 main.md 内容 → 索引条目列表（链接形如 "<name>.md"） */
function parseMemoryIndex(content: string): MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[(.+?)\]\((.+?)\.md\)\s*(?:—|-)\s*(.*)$/)
    if (match) {
      entries.push({
        title: match[1] ?? '',
        filename: match[2] ?? '',
        description: (match[3] ?? '').trim(),
      })
    }
  }
  return entries
}

/** 序列化索引条目为 main.md 内容（活跃条目平铺，与 main.md 同级） */
function serializeMemoryIndex(entries: MemoryIndexEntry[]): string {
  if (entries.length === 0) return '# Memory Index\n'
  const lines = entries.map((e) => `- [${e.title}](${e.filename}.md) — ${e.description}`)
  return `# Memory Index\n\n${lines.join('\n')}\n`
}

/** 读取活跃记忆索引 */
export function readMemoryIndex(
  workspace?: string,
  scope: MemoryScope = 'workspace',
): MemoryIndexEntry[] {
  const indexPath = getMemoryIndexPath(workspace, scope)
  if (!existsSync(indexPath)) return []
  return parseMemoryIndex(readFileSync(indexPath, 'utf-8'))
}

/** 写入活跃记忆索引 */
export function writeMemoryIndex(
  entries: MemoryIndexEntry[],
  workspace?: string,
  scope: MemoryScope = 'workspace',
): void {
  const root = getMemoryRootDir(workspace, scope)
  ensureDir(root)
  writeFileSync(getMemoryIndexPath(workspace, scope), serializeMemoryIndex(entries), 'utf-8')
}

// === 单条活跃记忆（<root>/<name>.md）===

/** 读取单条活跃记忆 */
export function readMemory(
  name: string,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): Memory | null {
  const filePath = getMemoryFilePath(name, workspace, scope)
  if (!existsSync(filePath)) return null
  const { frontmatter, body } = parseMd(readFileSync(filePath, 'utf-8'))
  const fm = frontmatter as unknown as MemoryFrontmatter
  const meta = fm.metadata as
    | {
        type?: MemoryType
        created_at?: string
        originSessionId?: string
      }
    | undefined
  return {
    name: fm.name ?? name,
    description: fm.description ?? '',
    type: meta?.type ?? 'project',
    content: body,
    createdAt: meta?.created_at,
    originSessionId: meta?.originSessionId,
  }
}

/** 写入单条活跃记忆 */
export function writeMemory(
  memory: Memory,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): void {
  const root = getMemoryRootDir(workspace, scope)
  ensureDir(root)
  const fm: MemoryFrontmatter = {
    name: memory.name,
    description: memory.description,
    metadata: {
      node_type: 'memory',
      type: memory.type,
      ...(memory.createdAt ? { created_at: memory.createdAt } : {}),
      ...(memory.originSessionId ? { originSessionId: memory.originSessionId } : {}),
    },
  }
  writeFileSync(
    getMemoryFilePath(memory.name, workspace, scope),
    serializeMd(fm as unknown as Record<string, unknown>, memory.content),
    'utf-8',
  )
}

/** 删除单条活跃记忆文件 */
export function deleteMemoryFile(
  name: string,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): void {
  const filePath = getMemoryFilePath(name, workspace, scope)
  if (existsSync(filePath)) unlinkSync(filePath)
}

/** 列出所有活跃记忆文件名（不含扩展名，且排除 main.md / history/） */
export function listMemoryNames(workspace?: string, scope: MemoryScope = 'workspace'): string[] {
  const root = getMemoryRootDir(workspace, scope)
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((f) => f.endsWith('.md') && f !== 'main.md')
    .map((f) => f.slice(0, -3))
}

// === 历史记忆索引（history/main.md）===

/** 解析历史索引（链接形如 "<name>.md"，与 main.md 同级在 history/ 内） */
function parseHistoryIndex(content: string): HistoryIndexEntry[] {
  const entries: HistoryIndexEntry[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[(.+?)\]\((.+?)\.md\)\s*(?:—|-)\s*(.*)$/)
    if (match) {
      const desc = (match[3] ?? '').trim()
      const replMatch = desc.match(/^被 '(.+?)' 替换于 (.+?)（(.+?)）$/)
      entries.push({
        title: match[1] ?? '',
        filename: match[2] ?? '',
        description: desc,
        replacedBy: replMatch?.[1] ?? '',
        replacedAt: replMatch?.[2] ?? '',
        replacedReason: replMatch?.[3] ?? '',
      })
    }
  }
  return entries
}

/** 序列化历史索引 */
function serializeHistoryIndex(entries: HistoryIndexEntry[]): string {
  if (entries.length === 0) return '# History Index\n'
  const lines = entries.map(
    (e) =>
      `- [${e.title}](${e.filename}.md) — 被 '${e.replacedBy}' 替换于 ${e.replacedAt}（${e.replacedReason}）`,
  )
  return `# History Index\n\n${lines.join('\n')}\n`
}

/** 读取历史索引 */
export function readHistoryIndex(
  workspace?: string,
  scope: MemoryScope = 'workspace',
): HistoryIndexEntry[] {
  const indexPath = getHistoryIndexPath(workspace, scope)
  if (!existsSync(indexPath)) return []
  return parseHistoryIndex(readFileSync(indexPath, 'utf-8'))
}

/** 写入历史索引 */
export function writeHistoryIndex(
  entries: HistoryIndexEntry[],
  workspace?: string,
  scope: MemoryScope = 'workspace',
): void {
  const histDir = getHistoryDir(workspace, scope)
  ensureDir(histDir)
  writeFileSync(getHistoryIndexPath(workspace, scope), serializeHistoryIndex(entries), 'utf-8')
}

// === 历史记忆详情（<root>/history/<name>.md）===

/** 读取历史记忆详情 */
export function readHistoryEntry(
  name: string,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): HistoryEntry | null {
  const filePath = getHistoryFilePath(name, workspace, scope)
  if (!existsSync(filePath)) return null
  const { frontmatter, body } = parseMd(readFileSync(filePath, 'utf-8'))
  const fm = frontmatter as unknown as HistoryFrontmatter
  const meta = fm.metadata as
    | {
        type?: MemoryType
        created_at?: string
        originSessionId?: string
        replaced_at?: string
        replaced_reason?: string
        replaced_by?: string
      }
    | undefined
  return {
    name: fm.name ?? name,
    description: fm.description ?? '',
    type: meta?.type ?? 'project',
    content: body,
    createdAt: meta?.created_at,
    originSessionId: meta?.originSessionId,
    replacedAt: meta?.replaced_at ?? '',
    replacedReason: meta?.replaced_reason ?? '',
    replacedBy: meta?.replaced_by ?? '',
  }
}

/** 写入历史记忆 */
export function writeHistoryEntry(
  entry: HistoryEntry,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): void {
  const histDir = getHistoryDir(workspace, scope)
  ensureDir(histDir)
  const fm: HistoryFrontmatter = {
    name: entry.name,
    description: entry.description,
    metadata: {
      node_type: 'memory',
      type: entry.type,
      ...(entry.createdAt ? { created_at: entry.createdAt } : {}),
      ...(entry.originSessionId ? { originSessionId: entry.originSessionId } : {}),
      replaced_at: entry.replacedAt,
      replaced_reason: entry.replacedReason,
      replaced_by: entry.replacedBy,
    },
  }
  writeFileSync(
    getHistoryFilePath(entry.name, workspace, scope),
    serializeMd(fm as unknown as Record<string, unknown>, entry.content),
    'utf-8',
  )
}

/** 列出所有历史记忆文件名（排除 main.md） */
export function listHistoryNames(workspace?: string, scope: MemoryScope = 'workspace'): string[] {
  const histDir = getHistoryDir(workspace, scope)
  if (!existsSync(histDir)) return []
  return readdirSync(histDir)
    .filter((f) => f.endsWith('.md') && f !== 'main.md')
    .map((f) => f.slice(0, -3))
}

// === System Prompt 注入用 ===

/** 读取 main.md 全文（供 buildFirstSystemPrompt 注入 <memory layer="..."> 段） */
export function readMemoryIndexContent(
  workspace?: string,
  scope: MemoryScope = 'workspace',
): string {
  const indexPath = getMemoryIndexPath(workspace, scope)
  if (!existsSync(indexPath)) return ''
  return readFileSync(indexPath, 'utf-8').trim()
}
