/**
 * 记忆 Markdown 文件读写。
 *
 * 文件格式：
 * ```
 * ---
 * name: kebab-case-slug
 * description: 一句话描述
 * metadata:
 *   node_type: memory
 *   type: feedback
 * ---
 *
 * 正文内容...
 * ```
 *
 * 索引文件格式（MEMORY.md）：
 * ```
 * # Memory Index
 *
 * - [标题](filename.md) — 描述
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import path from "path";
import yaml from "js-yaml";
import type {
  MemoryFrontmatter,
  HistoryFrontmatter,
  Memory,
  HistoryEntry,
  MemoryIndexEntry,
  HistoryIndexEntry,
  MemoryType,
} from "./types.js";
import {
  getMemoryRootDir,
  getMemoriesDir,
  getHistoryDir,
  getHistoryMemoriesDir,
  getMemoryIndexPath,
  getHistoryIndexPath,
} from "./path.js";

/** 解析 md 文件的 frontmatter + body（---\nYAML\n---\nBODY） */
function parseMd(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content.trim() };
  const fm = yaml.load(match[1] ?? "") as Record<string, unknown>;
  return { frontmatter: fm ?? {}, body: (match[2] ?? "").trim() };
}

/** 序列化 frontmatter + body 为 md 文件内容 */
function serializeMd(frontmatter: Record<string, unknown>, body: string): string {
  const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 }).trimEnd();
  return `---\n${yamlStr}\n---\n\n${body}\n`;
}

/** 确保目录存在（递归创建） */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === 活跃记忆索引（MEMORY.md）===

/** 解析 MEMORY.md 内容 → 索引条目列表 */
function parseMemoryIndex(content: string): MemoryIndexEntry[] {
  const entries: MemoryIndexEntry[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^- \[(.+?)\]\((.+?)\.md\)\s*(?:—|-)\s*(.*)$/);
    if (match) {
      entries.push({ title: match[1] ?? "", filename: match[2] ?? "", description: (match[3] ?? "").trim() });
    }
  }
  return entries;
}

/** 序列化索引条目为 MEMORY.md 内容 */
function serializeMemoryIndex(entries: MemoryIndexEntry[]): string {
  if (entries.length === 0) return "# Memory Index\n";
  const lines = entries.map((e) => `- [${e.title}](${e.filename}.md) — ${e.description}`);
  return `# Memory Index\n\n${lines.join("\n")}\n`;
}

/** 读取活跃记忆索引 */
export function readMemoryIndex(workspace?: string): MemoryIndexEntry[] {
  const indexPath = getMemoryIndexPath(workspace);
  if (!existsSync(indexPath)) return [];
  return parseMemoryIndex(readFileSync(indexPath, "utf-8"));
}

/** 写入活跃记忆索引 */
export function writeMemoryIndex(entries: MemoryIndexEntry[], workspace?: string): void {
  ensureDir(getMemoryRootDir(workspace));
  writeFileSync(getMemoryIndexPath(workspace), serializeMemoryIndex(entries), "utf-8");
}

// === 单条活跃记忆（memories/<name>.md）===

/** 读取单条活跃记忆 */
export function readMemory(name: string, workspace?: string): Memory | null {
  const filePath = path.join(getMemoriesDir(workspace), `${name}.md`);
  if (!existsSync(filePath)) return null;
  const { frontmatter, body } = parseMd(readFileSync(filePath, "utf-8"));
  const fm = frontmatter as unknown as MemoryFrontmatter;
  const meta = fm.metadata as { type?: MemoryType; originSessionId?: string } | undefined;
  return {
    name: fm.name ?? name,
    description: fm.description ?? "",
    type: meta?.type ?? "fact",
    content: body,
    originSessionId: meta?.originSessionId,
  };
}

/** 写入单条活跃记忆 */
export function writeMemory(memory: Memory, workspace?: string): void {
  const dir = getMemoriesDir(workspace);
  ensureDir(dir);
  const fm: MemoryFrontmatter = {
    name: memory.name,
    description: memory.description,
    metadata: {
      node_type: "memory",
      type: memory.type,
      ...(memory.originSessionId ? { originSessionId: memory.originSessionId } : {}),
    },
  };
  writeFileSync(
    path.join(dir, `${memory.name}.md`),
    serializeMd(fm as unknown as Record<string, unknown>, memory.content),
    "utf-8",
  );
}

/** 删除单条活跃记忆文件 */
export function deleteMemoryFile(name: string, workspace?: string): void {
  const filePath = path.join(getMemoriesDir(workspace), `${name}.md`);
  if (existsSync(filePath)) unlinkSync(filePath);
}

/** 列出所有活跃记忆文件名（不含扩展名） */
export function listMemoryNames(workspace?: string): string[] {
  const dir = getMemoriesDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
}

// === 历史记忆索引（history/MEMORY.md）===

/** 解析历史索引 */
function parseHistoryIndex(content: string): HistoryIndexEntry[] {
  const entries: HistoryIndexEntry[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^- \[(.+?)\]\(memories\/(.+?)\.md\)\s*(?:—|-)\s*(.*)$/);
    if (match) {
      const desc = (match[3] ?? "").trim();
      // 从描述行提取替换元数据（备用；主要来源为文件 frontmatter）
      const replMatch = desc.match(/^被 '(.+?)' 替换于 (.+?)（(.+?)）$/);
      entries.push({
        title: match[1] ?? "",
        filename: match[2] ?? "",
        description: desc,
        replacedBy: replMatch?.[1] ?? "",
        replacedAt: replMatch?.[2] ?? "",
        replacedReason: replMatch?.[3] ?? "",
      });
    }
  }
  return entries;
}

/** 序列化历史索引 */
function serializeHistoryIndex(entries: HistoryIndexEntry[]): string {
  if (entries.length === 0) return "# History Index\n";
  const lines = entries.map(
    (e) => `- [${e.title}](memories/${e.filename}.md) — 被 '${e.replacedBy}' 替换于 ${e.replacedAt}（${e.replacedReason}）`,
  );
  return `# History Index\n\n${lines.join("\n")}\n`;
}

/** 读取历史索引 */
export function readHistoryIndex(workspace?: string): HistoryIndexEntry[] {
  const indexPath = getHistoryIndexPath(workspace);
  if (!existsSync(indexPath)) return [];
  return parseHistoryIndex(readFileSync(indexPath, "utf-8"));
}

/** 写入历史索引 */
export function writeHistoryIndex(entries: HistoryIndexEntry[], workspace?: string): void {
  ensureDir(getHistoryDir(workspace));
  writeFileSync(getHistoryIndexPath(workspace), serializeHistoryIndex(entries), "utf-8");
}

// === 历史记忆详情（history/memories/<name>.md）===

/** 读取历史记忆详情 */
export function readHistoryEntry(name: string, workspace?: string): HistoryEntry | null {
  const filePath = path.join(getHistoryMemoriesDir(workspace), `${name}.md`);
  if (!existsSync(filePath)) return null;
  const { frontmatter, body } = parseMd(readFileSync(filePath, "utf-8"));
  const fm = frontmatter as unknown as HistoryFrontmatter;
  const meta = fm.metadata as {
    type?: MemoryType;
    originSessionId?: string;
    replaced_at?: string;
    replaced_reason?: string;
    replaced_by?: string;
  } | undefined;
  return {
    name: fm.name ?? name,
    description: fm.description ?? "",
    type: meta?.type ?? "fact",
    content: body,
    originSessionId: meta?.originSessionId,
    replacedAt: meta?.replaced_at ?? "",
    replacedReason: meta?.replaced_reason ?? "",
    replacedBy: meta?.replaced_by ?? "",
  };
}

/** 写入历史记忆 */
export function writeHistoryEntry(entry: HistoryEntry, workspace?: string): void {
  const dir = getHistoryMemoriesDir(workspace);
  ensureDir(dir);
  const fm: HistoryFrontmatter = {
    name: entry.name,
    description: entry.description,
    metadata: {
      node_type: "memory",
      type: entry.type,
      ...(entry.originSessionId ? { originSessionId: entry.originSessionId } : {}),
      replaced_at: entry.replacedAt,
      replaced_reason: entry.replacedReason,
      replaced_by: entry.replacedBy,
    },
  };
  writeFileSync(
    path.join(dir, `${entry.name}.md`),
    serializeMd(fm as unknown as Record<string, unknown>, entry.content),
    "utf-8",
  );
}

/** 列出所有历史记忆文件名 */
export function listHistoryNames(workspace?: string): string[] {
  const dir = getHistoryMemoriesDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
}

// === System Prompt 注入用 ===

/** 读取 MEMORY.md 全文（供 buildFirstSystemPrompt 注入 <memory> 段） */
export function readMemoryIndexContent(workspace?: string): string {
  const indexPath = getMemoryIndexPath(workspace);
  if (!existsSync(indexPath)) return "";
  return readFileSync(indexPath, "utf-8").trim();
}
