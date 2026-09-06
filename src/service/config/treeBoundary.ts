import { getMonthlyDb, getSoulDb } from '@/db/index.js'
import { getChat, getChatMetadata } from '@/db/chat.js'
import { getRootChatIdForEpoch } from '@/db/epoch.js'
import type { ConfigRaw } from '@/utils/config.js'
import type { ConfigImpact } from '@chery/protocol'
import {
  getActiveChatRunId,
  getChatSelection,
  getSessionRoleConfiguration,
  isChatRunning,
} from '@/service/chat/runtime.js'
import { getWaitedParent } from '@/agent/spawnBroker.js'

export function treeChatIds(chatId: string): string[] {
  return (
    getSoulDb()
      .prepare(
        `WITH RECURSIVE tree(id) AS (
    SELECT id FROM chats WHERE id = ?
    UNION ALL SELECT c.id FROM chats c JOIN tree p ON c.parent_chat_id = p.id
  ) SELECT id FROM tree`,
      )
      .all(getRootChatIdForEpoch(chatId)) as { id: string }[]
  ).map((row) => row.id)
}

export function activeRootIds(): string[] {
  return (
    getSoulDb()
      .prepare("SELECT id FROM chats WHERE parent_chat_id IS NULL AND lifecycle = 'active'")
      .all() as { id: string }[]
  ).map((row) => row.id)
}

/** Include the roster, not just instantiated children: future spawns share the contract. */
export function treeUsesImpacts(rootId: string, raw: ConfigRaw, impacts: ConfigImpact[]): boolean {
  const meta = getChatMetadata(rootId)
  const presetEntry = Object.entries(raw.presets ?? {}).find(([name, preset]) =>
    meta.presetId ? preset.id === meta.presetId : name === meta.preset,
  )
  const preset = presetEntry?.[1]
  const roles = new Set<string>(
    preset
      ? [preset.leader, ...(preset.roles ?? Object.keys(raw.roles ?? {}))]
      : Object.keys(raw.roles ?? {}),
  )
  const brains = new Set<string>()
  const groups = new Set<string>()
  const servers = new Set<string>()
  const session = getSessionRoleConfiguration(rootId)
  for (const selection of session ? [session.primary, ...Object.values(session.roles)] : []) {
    brains.add(selection.brain)
    groups.add(selection.senseGroup)
    for (const server of selection.mcpServers ?? []) servers.add(server)
  }
  for (const id of treeChatIds(rootId)) {
    const child = getChatMetadata(id)
    for (const [name, role] of Object.entries(raw.roles ?? {}))
      if (child.roleId ? child.roleId === role.id : child.type === name) roles.add(name)
    const selection =
      getChatSelection(id) ??
      (child.runtime as { brain?: string; senseGroup?: string; mcpServers?: string[] } | undefined)
    if (selection?.brain) brains.add(selection.brain)
    if (selection?.senseGroup) groups.add(selection.senseGroup)
    for (const server of selection?.mcpServers ?? []) servers.add(server)
  }
  for (const name of roles) {
    const role = raw.roles?.[name]
    if (!role) continue
    if (role.brain) brains.add(role.brain)
    if (role.senseGroup) groups.add(role.senseGroup)
    for (const server of role.mcpServers ?? []) servers.add(server)
  }
  for (const group of groups) {
    for (const sense of raw.sense_groups?.[group] ?? []) {
      for (const server of Object.keys(raw.mcp_servers ?? {}))
        if (sense.startsWith(`mcp__${server}__`)) servers.add(server)
    }
  }
  return impacts.some((impact) => {
    const [root, name, brain] = JSON.parse(impact.resource) as string[]
    if (root === 'roles') return !name || roles.has(name)
    if (root === 'presets') return !name || name === presetEntry?.[0] || name === meta.preset
    if (root === 'llm') return !brain || brains.has(brain)
    if (root === 'sense_groups') return !name || groups.has(name)
    if (root === 'mcp_servers') return !name || servers.has(name)
    // File resources can be transitively referenced by prompts and tool source.
    return true
  })
}

/** Read both live reservations and durable work; a yielded generator is not an idle tree. */
export function treeBoundaryReason(rootId: string, deleting = false): string | undefined {
  const db = getSoulDb()
  for (const id of treeChatIds(rootId)) {
    if (isChatRunning(id) || getActiveChatRunId(id)) return '等待受影响节点树当前运行结束'
    if (getWaitedParent(id)) return '等待子任务完成并唤醒父任务'
    const chat = getChat(id)
    if (
      chat &&
      getMonthlyDb(chat.messages_month)
        .prepare("SELECT 1 FROM question_batches WHERE chat_id = ? AND status = 'pending' LIMIT 1")
        .get(id)
    )
      return '等待受影响节点树的问题处理完成；配置尚未生效'
    if (
      db
        .prepare(
          "SELECT 1 FROM interactions WHERE chat_id = ? AND status IN ('pending', 'resolving', 'blocked') LIMIT 1",
        )
        .get(id)
    )
      return '等待受影响节点树的问题或审批处理完成；配置尚未生效'
    if (
      db
        .prepare(
          "SELECT 1 FROM execution_active_runs WHERE chat_id = ? AND status IN ('running', 'waiting') LIMIT 1",
        )
        .get(id)
    )
      return '等待受影响节点树运行或恢复完成'
    if (
      db
        .prepare(
          "SELECT 1 FROM spawn_tasks WHERE child_chat_id = ? AND status IN ('pending', 'started') LIMIT 1",
        )
        .get(id)
    )
      return '等待已派发子任务完成'
    if (
      deleting &&
      db
        .prepare(
          "SELECT 1 FROM pending_inputs WHERE chat_id = ? AND state IN ('accepted', 'started', 'queued') LIMIT 1",
        )
        .get(id)
    )
      return '等待已接收输入完成后删除角色或预设'
  }
  return undefined
}

let retry: (() => Promise<void>) | undefined
let admission: ((chatId: string) => string | undefined) | undefined
export function setTreeConfigBoundary(input: {
  retry(): Promise<void>
  admission(chatId: string): string | undefined
}): void {
  retry = input.retry
  admission = input.admission
}
export async function awaitTreeConfigBoundary(chatId: string): Promise<void> {
  // Unrelated trees and existing work can continue while an MCP handshake is
  // awaiting I/O. Only an affected idle tree must wait for that preparation.
  if (!admission || admission(chatId)) await retry?.()
  else void retry?.().catch(() => {})
  const reason = admission?.(chatId)
  if (reason) throw new Error(reason)
}
export function notifyTreeConfigBoundary(): void {
  void retry?.().catch(() => {})
}
