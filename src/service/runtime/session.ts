import { parseRuntimeSelection } from '@/agent/runtimeResolver.js'
import { getChat } from '@/db/chat.js'
import { logger } from '@/utils/logger/index.js'
import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type SessionRuntimeSetRequestData,
  type SessionRuntimeSetResponseData,
} from '../message/types.js'
import { setSessionRoleRuntimes } from '../chat/runtime.js'

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
  const { applied, deferredRunning } = await setSessionRoleRuntimes(data.chatId, primary, roles)
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
