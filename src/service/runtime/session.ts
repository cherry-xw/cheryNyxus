import { parseRuntimeSelection } from '@/agent/runtimeResolver.js'
import {
  collectDescendantsChatIds,
  getChat,
  getChatMetadata,
  getChatRuntimeSelection,
} from '@/db/chat.js'
import { logger } from '@/utils/logger/index.js'
import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type SessionRuntimeSetRequestData,
  type SessionRuntimeSetResponseData,
} from '../message/types.js'
import {
  getChatSelection,
  getSessionRoleConfiguration,
  isChatRunning,
  setSessionRoleRuntimes,
} from '../chat/runtime.js'
import config from '@/utils/config.js'
import { applyRetiredRoles } from '@/service/config/roleLifecycle.js'

/** 会话临时角色编制：验证后写内存 + 回灌已存在子 chat（idle 持久化到子 metadata；running 延迟）。 */
export async function handleSessionRuntimeSet(
  _ctx: HandlerContext,
  data: SessionRuntimeSetRequestData,
): Promise<SessionRuntimeSetResponseData> {
  if (!getChat(data.chatId)) throw new Error('这个会话不见了')
  const primary = parseRuntimeSelection(data.primary, 'session.runtime.set.primary')
  const roles = Object.fromEntries(
    Object.entries(data.roles).map(([role, selection]) => [
      role,
      parseRuntimeSelection(selection, `session.runtime.set.roles.${role}`),
    ]),
  )
  if (isChatRunning(data.chatId)) {
    throw new Error('主 Agent 正在运行，必须先到达安全检查点再修改角色编制')
  }
  const previousSession = getSessionRoleConfiguration(data.chatId)
  const currentPrimary =
    previousSession?.primary ?? getChatSelection(data.chatId) ?? getChatRuntimeSelection(data.chatId)
  const primaryChanged = JSON.stringify(currentPrimary) !== JSON.stringify(primary)
  const roleNames = new Set([
    ...Object.keys(previousSession?.roles ?? {}),
    ...Object.keys(roles),
  ])
  const changedRoles = [...roleNames].filter((role) => {
    const configured = config.roles?.[role]
    const current =
      previousSession?.roles[role] ??
      (configured
        ? {
            brain: configured.brain,
            senseGroup: configured.senseGroup,
            mcpServers: configured.mcpServers ?? [],
          }
        : undefined)
    return JSON.stringify(current) !== JSON.stringify(roles[role])
  })

  const descendants = collectDescendantsChatIds(data.chatId)
  const descendantRoles = new Set(
    descendants.flatMap((chatId) => {
      const type = getChatMetadata(chatId).type
      return typeof type === 'string' ? [type] : []
    }),
  )
  // A changed main Agent cannot safely inherit any of its old delegations.
  const invalidatedRoles = primaryChanged ? [...descendantRoles] : changedRoles
  const invalidatedSet = new Set(invalidatedRoles)
  const affectedTree = descendants.filter((chatId) => {
    const type = getChatMetadata(chatId).type
    return typeof type === 'string' && invalidatedSet.has(type)
  })
  if (affectedTree.some((chatId) => isChatRunning(chatId))) {
    throw new Error('受影响的子 Agent 仍在运行，必须先到达安全检查点再修改角色编制')
  }
  const lifecycle = applyRetiredRoles({
    roleIds: [],
    roleNames: invalidatedRoles,
    rootChatIds: [data.chatId],
    reason: '会话级角色运行配置已改变，旧子树不再可恢复',
  })
  const semanticChange = primaryChanged || changedRoles.length > 0
  const result = await setSessionRoleRuntimes(data.chatId, primary, roles, {
    rotateEpoch: semanticChange,
  })
  const applied = [...lifecycle.retiredChatIds, ...lifecycle.abandonedChatIds]
  const deferredRunning = result.deferredRunning
  logger.event('session.runtime.set', {
    chatId: data.chatId,
    primary,
    roles,
    persistence: 'memory',
    applied: applied.length,
    deferredRunning: deferredRunning.length,
  })
  return { chatId: data.chatId, applied, deferredRunning }
}

export function registerSessionRuntimeHandlers(
  router: import('../message/router.js').RpcRouter,
): void {
  router.register(Method.SESSION_RUNTIME_SET, handleSessionRuntimeSet)
}
