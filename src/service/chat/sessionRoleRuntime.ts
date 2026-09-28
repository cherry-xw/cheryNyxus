import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import type { ConfigRaw } from '@/utils/config.js'
import { getChat, getChatRule, getChatRuntimeSelection, getChatType } from '@/db/chat.js'
import { treeChatIds } from '@/service/config/treeBoundary.js'
import { chatRuntimes } from './runtimeCache.js'

/** 会话级临时角色编制；进程重启即失效，刻意不写数据库。 */
export const sessionRoleRuntimes = new Map<
  string,
  { primary: RuntimeSelection; roles: Record<string, RuntimeSelection> }
>()
/** 子 chat 的临时运行时：用于 role 覆盖，优先于数据库默认值且不落盘。 */
export const ephemeralChatRuntimes = new Map<string, RuntimeSelection>()

/** Exact root-session override, without walking ancestor chats. */
export function getSessionRoleConfiguration(
  chatId: string,
): { primary: RuntimeSelection; roles: Record<string, RuntimeSelection> } | undefined {
  const value = sessionRoleRuntimes.get(chatId)
  return value ? { primary: value.primary, roles: { ...value.roles } } : undefined
}

/** Repair removed brain references only when they followed the associated role.
 * The caller owns the safe-boundary transaction and must restore on failure. */
export function reconcileSessionBrains(
  rootIds: string[],
  before: ConfigRaw,
  next: ConfigRaw,
): () => void {
  const sessions = new Map(sessionRoleRuntimes)
  const ephemeral = new Map(ephemeralChatRuntimes)
  const follow = (selection: RuntimeSelection, roleName: string | undefined): RuntimeSelection => {
    const oldRole = roleName ? before.roles?.[roleName] : undefined
    const newRole = oldRole?.id
      ? Object.values(next.roles ?? {}).find((role) => role.id === oldRole.id)
      : roleName
        ? next.roles?.[roleName]
        : undefined
    if (
      !next.llm.brain[selection.brain] &&
      oldRole?.brain === selection.brain &&
      newRole?.brain &&
      next.llm.brain[newRole.brain]
    )
      return { ...selection, brain: newRole.brain }
    return selection
  }
  for (const chatId of new Set(rootIds.flatMap(treeChatIds))) {
    const roleName = getChatType(chatId)
    const session = sessionRoleRuntimes.get(chatId)
    if (session)
      sessionRoleRuntimes.set(chatId, {
        primary: follow(session.primary, roleName),
        roles: Object.fromEntries(
          Object.entries(session.roles).map(([name, selection]) => [name, follow(selection, name)]),
        ),
      })
    const selection = ephemeralChatRuntimes.get(chatId)
    if (selection) ephemeralChatRuntimes.set(chatId, follow(selection, roleName))
  }
  return () => {
    for (const [id, session] of sessions) sessionRoleRuntimes.set(id, session)
    for (const [id, selection] of ephemeral) ephemeralChatRuntimes.set(id, selection)
  }
}

export function renameSessionRoles(renames: Array<{ from: string; to: string }>): () => void {
  const names = new Map(renames.map(({ from, to }) => [from, to]))
  const previous = [...sessionRoleRuntimes.values()].map((session) => ({
    session,
    roles: session.roles,
  }))
  for (const session of sessionRoleRuntimes.values())
    session.roles = Object.fromEntries(
      Object.entries(session.roles).map(([name, selection]) => [
        names.get(name) ?? name,
        selection,
      ]),
    )
  return () => {
    for (const { session, roles } of previous) session.roles = roles
  }
}

/** 返回祖先主会话的某角色临时编制，供 spawn_role 使用。 */
export function getSessionRoleRuntime(chatId: string, role: string): RuntimeSelection | undefined {
  let current = chatId
  // parent 链理论上无环；上限防脏数据无限循环。
  for (let depth = 0; depth < 32; depth += 1) {
    const session = sessionRoleRuntimes.get(current)
    if (session) return session.roles[role]
    const row = getChat(current)
    if (!row?.parent_chat_id) return undefined
    current = row.parent_chat_id
  }
  return undefined
}

/** 注册刚派发子角色的临时编制；在该 child 首次 ensureChat 时消费。（子 agent，排除 memory_manage） */
export function setEphemeralChatRuntime(chatId: string, selection: RuntimeSelection): void {
  ephemeralChatRuntimes.set(chatId, selection)
  const runtime = chatRuntimes.get(chatId)
  // 已初始化但尚未运行的复用子角色也切到临时编制；运行中的请求保持其启动时配置。
  if (runtime && !runtime.builder.isRunning()) {
    runtime.selection = selection
    runtime.builder.configureRuntime(selection, false, getChatRule(chatId), chatId)
  }
}

/**
 * 解析 chat 当前生效的 runtime selection（含 ephemeral 子角色覆盖），解析顺序与 ensureRuntime 对齐：
 * ephemeral 临时编制（子 agent role 覆盖）优先于数据库默认值。
 * 供 autoCompact 等热路径使用——使 compact 可用性按当次发送的实际 brain 判定。
 */
export function resolveChatRuntimeSelection(chatId: string): RuntimeSelection | undefined {
  return ephemeralChatRuntimes.get(chatId) ?? getChatRuntimeSelection(chatId)
}
