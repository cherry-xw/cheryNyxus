/**
 * 记忆管理器：CRUD + 淘汰逻辑。
 *
 * 双层模型：
 * - global（scope="global"）— 跨 chat 共享，受 config.memory.global.{max_count,max_chars} 限制
 * - workspace（scope="workspace"）— per chat，受 config.memory.workspace.{max_count,max_chars} 限制
 *
 * 核心约束：
 * - 每层活跃记忆独立计数：global 默认 30、workspace 默认 15
 * - 单条正文按所在层 max_chars 校验：默认 500
 * - 达该层上限时必须指定淘汰目标（replaceTarget + replaceReason）
 * - 淘汰记忆移入该层 history/，标记替换时间/原因/被谁替换
 */

import dayjs from 'dayjs'
import config from '@/utils/config'
import type { Memory, HistoryEntry, MemoryType, MemoryScope } from './index.js'
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
} from './store.js'

/** kebab-case 校验（允许字母/数字/下划线/连字符） */
const NAME_PATTERN = /^[\w-]+$/

/** 读取指定层的活跃条数 / 单条字数上限（未配置回落到 utils/config.ts 默认值） */
function getLimits(scope: MemoryScope): { maxCount: number; maxChars: number } {
  const limits = scope === 'global' ? config.memory?.global : config.memory?.workspace
  return {
    maxCount: limits?.max_count ?? (scope === 'global' ? 30 : 15),
    maxChars: limits?.max_chars ?? 500,
  }
}

/** 淘汰记忆：从该层活跃移入该层历史 */
function evictMemory(
  name: string,
  reason: string,
  replacedBy: string,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): void {
  const memory = readMemory(name, workspace, scope)
  if (!memory) return

  const entry: HistoryEntry = {
    ...memory,
    replacedAt: dayjs().toISOString(),
    replacedReason: reason,
    replacedBy,
  }
  writeHistoryEntry(entry, workspace, scope)

  // 追加历史索引
  const historyIndex = readHistoryIndex(workspace, scope)
  historyIndex.push({
    title: memory.description.slice(0, 40),
    filename: name,
    description: memory.description,
    replacedAt: entry.replacedAt,
    replacedReason: reason,
    replacedBy,
  })
  writeHistoryIndex(historyIndex, workspace, scope)

  // 删除活跃记忆文件 + 从活跃索引移除
  deleteMemoryFile(name, workspace, scope)
  const index = readMemoryIndex(workspace, scope)
  writeMemoryIndex(
    index.filter((e) => e.filename !== name),
    workspace,
    scope,
  )
}

/** 添加记忆。达该层上限时必须指定淘汰目标 */
export function addMemory(params: {
  name: string
  description: string
  content: string
  type: MemoryType
  originSessionId?: string
  replaceTarget?: string
  replaceReason?: string
  workspace?: string
  scope?: MemoryScope
}): { ok: true; evicted?: string } | { ok: false; error: string } {
  const {
    name,
    description,
    content,
    type,
    originSessionId,
    replaceTarget,
    replaceReason,
    workspace,
    scope = 'workspace',
  } = params
  const { maxCount, maxChars } = getLimits(scope)

  if (!name || !NAME_PATTERN.test(name))
    return { ok: false, error: 'name 必须为 kebab-case（字母/数字/下划线/连字符）' }
  if (!description) return { ok: false, error: 'description 不能为空' }
  if (!content) return { ok: false, error: 'content 不能为空' }
  if (content.length > maxChars)
    return { ok: false, error: `正文超过 ${maxChars} 字限制（当前 ${content.length}）` }

  const currentNames = listMemoryNames(workspace, scope)
  if (currentNames.includes(name))
    return { ok: false, error: `记忆 '${name}' 已存在，使用 update 操作` }

  // 达上限 → 必须淘汰
  if (currentNames.length >= maxCount) {
    if (!replaceTarget)
      return { ok: false, error: `活跃记忆已达上限 ${maxCount}，必须指定 replaceTarget` }
    if (!currentNames.includes(replaceTarget))
      return { ok: false, error: `淘汰目标 '${replaceTarget}' 不存在` }
    if (!replaceReason) return { ok: false, error: '必须提供 replaceReason' }
    evictMemory(replaceTarget, replaceReason, name, workspace, scope)
  }

  // 写入新记忆
  const memory: Memory = { name, description, type, content, originSessionId }
  writeMemory(memory, workspace, scope)

  // 追加活跃索引
  const index = readMemoryIndex(workspace, scope)
  index.push({ title: description.slice(0, 40), filename: name, description })
  writeMemoryIndex(index, workspace, scope)

  return { ok: true, evicted: replaceTarget }
}

/** 删除记忆（移入该层历史，reason 缺省 → "用户主动删除"） */
export function removeMemory(
  name: string,
  reason: string,
  workspace?: string,
  scope: MemoryScope = 'workspace',
): { ok: true } | { ok: false; error: string } {
  const memory = readMemory(name, workspace, scope)
  if (!memory) return { ok: false, error: `记忆 '${name}' 不存在` }

  evictMemory(name, reason || '用户主动删除', '__deleted__', workspace, scope)
  return { ok: true }
}

/** 更新记忆内容/描述（按该层 max_chars 校验） */
export function updateMemory(params: {
  name: string
  content?: string
  description?: string
  workspace?: string
  scope?: MemoryScope
}): { ok: true } | { ok: false; error: string } {
  const { name, content, description, workspace, scope = 'workspace' } = params
  const { maxChars } = getLimits(scope)

  const existing = readMemory(name, workspace, scope)
  if (!existing) return { ok: false, error: `记忆 '${name}' 不存在` }

  if (content !== undefined && content.length > maxChars) {
    return { ok: false, error: `正文超过 ${maxChars} 字限制（当前 ${content.length}）` }
  }

  const updated: Memory = {
    ...existing,
    ...(content !== undefined ? { content } : {}),
    ...(description !== undefined ? { description } : {}),
  }
  writeMemory(updated, workspace, scope)

  // 更新索引中的描述
  if (description !== undefined) {
    const index = readMemoryIndex(workspace, scope)
    const entry = index.find((e) => e.filename === name)
    if (entry) {
      entry.title = description.slice(0, 40)
      entry.description = description
      writeMemoryIndex(index, workspace, scope)
    }
  }

  return { ok: true }
}

/** 列出该层所有活跃记忆 */
export function listMemories(workspace?: string, scope: MemoryScope = 'workspace'): Memory[] {
  return listMemoryNames(workspace, scope)
    .map((n) => readMemory(n, workspace, scope))
    .filter((m): m is Memory => m !== null)
}

/** 列出该层所有历史记忆 */
export function listHistories(
  workspace?: string,
  scope: MemoryScope = 'workspace',
): HistoryEntry[] {
  return listHistoryNames(workspace, scope)
    .map((n) => readHistoryEntry(n, workspace, scope))
    .filter((e): e is HistoryEntry => e !== null)
}
