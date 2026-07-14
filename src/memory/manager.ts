/**
 * 记忆管理器：CRUD + 淘汰逻辑。
 *
 * 核心约束：
 * - 活跃记忆最多 config.memory.max_count 条（默认 15）
 * - 单条正文不超过 config.memory.max_chars 字（默认 500）
 * - 达上限时必须指定淘汰目标（replaceTarget + replaceReason）
 * - 淘汰记忆移入 history/，标记替换时间/原因/被谁替换
 */

import dayjs from "dayjs";
import config from "@/utils/config";
import type { Memory, HistoryEntry, MemoryType } from "./types.js";
import {
  readMemoryIndex,
  writeMemoryIndex,
  readMemory,
  writeMemory,
  deleteMemoryFile,
  listMemoryNames,
  readHistoryIndex,
  writeHistoryIndex,
  writeHistoryEntry,
  listHistoryNames,
  readHistoryEntry,
} from "./store.js";

/** kebab-case 校验（允许字母/数字/下划线/连字符） */
const NAME_PATTERN = /^[\w-]+$/;

/** 淘汰记忆：从活跃移入历史 */
function evictMemory(name: string, reason: string, replacedBy: string, workspace?: string): void {
  const memory = readMemory(name, workspace);
  if (!memory) return;

  const entry: HistoryEntry = {
    ...memory,
    replacedAt: dayjs().toISOString(),
    replacedReason: reason,
    replacedBy,
  };
  writeHistoryEntry(entry, workspace);

  // 追加历史索引
  const historyIndex = readHistoryIndex(workspace);
  historyIndex.push({
    title: memory.description.slice(0, 40),
    filename: name,
    description: memory.description,
    replacedAt: entry.replacedAt,
    replacedReason: reason,
    replacedBy,
  });
  writeHistoryIndex(historyIndex, workspace);

  // 删除活跃记忆文件 + 从活跃索引移除
  deleteMemoryFile(name, workspace);
  const index = readMemoryIndex(workspace);
  writeMemoryIndex(index.filter((e) => e.filename !== name), workspace);
}

/** 添加记忆。达上限时必须指定淘汰目标 */
export function addMemory(params: {
  name: string;
  description: string;
  content: string;
  type: MemoryType;
  originSessionId?: string;
  replaceTarget?: string;
  replaceReason?: string;
  workspace?: string;
}): { ok: true; evicted?: string } | { ok: false; error: string } {
  const { name, description, content, type, originSessionId, replaceTarget, replaceReason, workspace } = params;
  const maxCount = config.memory?.max_count ?? 15;
  const maxChars = config.memory?.max_chars ?? 500;

  if (!name || !NAME_PATTERN.test(name)) return { ok: false, error: "name 必须为 kebab-case（字母/数字/下划线/连字符）" };
  if (!description) return { ok: false, error: "description 不能为空" };
  if (!content) return { ok: false, error: "content 不能为空" };
  if (content.length > maxChars) return { ok: false, error: `正文超过 ${maxChars} 字限制（当前 ${content.length}）` };

  const currentNames = listMemoryNames(workspace);
  if (currentNames.includes(name)) return { ok: false, error: `记忆 '${name}' 已存在，使用 update 操作` };

  // 达上限 → 必须淘汰
  if (currentNames.length >= maxCount) {
    if (!replaceTarget) return { ok: false, error: `活跃记忆已达上限 ${maxCount}，必须指定 replaceTarget` };
    if (!currentNames.includes(replaceTarget)) return { ok: false, error: `淘汰目标 '${replaceTarget}' 不存在` };
    if (!replaceReason) return { ok: false, error: "必须提供 replaceReason" };
    evictMemory(replaceTarget, replaceReason, name, workspace);
  }

  // 写入新记忆
  const memory: Memory = { name, description, type, content, originSessionId };
  writeMemory(memory, workspace);

  // 追加活跃索引
  const index = readMemoryIndex(workspace);
  index.push({ title: description.slice(0, 40), filename: name, description });
  writeMemoryIndex(index, workspace);

  return { ok: true, evicted: replaceTarget };
}

/** 删除记忆（移入历史，reason 缺省 → "用户主动删除"） */
export function removeMemory(
  name: string,
  reason: string,
  workspace?: string,
): { ok: true } | { ok: false; error: string } {
  const memory = readMemory(name, workspace);
  if (!memory) return { ok: false, error: `记忆 '${name}' 不存在` };

  evictMemory(name, reason || "用户主动删除", "__deleted__", workspace);
  return { ok: true };
}

/** 更新记忆内容/描述 */
export function updateMemory(params: {
  name: string;
  content?: string;
  description?: string;
  workspace?: string;
}): { ok: true } | { ok: false; error: string } {
  const { name, content, description, workspace } = params;
  const maxChars = config.memory?.max_chars ?? 500;

  const existing = readMemory(name, workspace);
  if (!existing) return { ok: false, error: `记忆 '${name}' 不存在` };

  if (content !== undefined && content.length > maxChars) {
    return { ok: false, error: `正文超过 ${maxChars} 字限制（当前 ${content.length}）` };
  }

  const updated: Memory = {
    ...existing,
    ...(content !== undefined ? { content } : {}),
    ...(description !== undefined ? { description } : {}),
  };
  writeMemory(updated, workspace);

  // 更新索引中的描述
  if (description !== undefined) {
    const index = readMemoryIndex(workspace);
    const entry = index.find((e) => e.filename === name);
    if (entry) {
      entry.title = description.slice(0, 40);
      entry.description = description;
      writeMemoryIndex(index, workspace);
    }
  }

  return { ok: true };
}

/** 列出所有活跃记忆 */
export function listMemories(workspace?: string): Memory[] {
  return listMemoryNames(workspace)
    .map((n) => readMemory(n, workspace))
    .filter((m): m is Memory => m !== null);
}

/** 列出所有历史记忆 */
export function listHistories(workspace?: string): HistoryEntry[] {
  return listHistoryNames(workspace)
    .map((n) => readHistoryEntry(n, workspace))
    .filter((e): e is HistoryEntry => e !== null);
}
