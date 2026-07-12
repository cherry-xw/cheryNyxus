import { parseRuntimeSelection } from "@/agent/runtimeResolver.js";
import { getChat } from "@/db/chat.js";
import { logger } from "@/utils/logger/index.js";
import type { HandlerContext } from "../message/router.js";
import { Method, type SessionRuntimeSetRequestData, type SessionRuntimeSetResponseData } from "../message/types.js";
import { setSessionRoleRuntimes } from "../chat/runtime.js";

/** 会话临时角色编制：验证后只写内存，生命周期止于服务重启/会话删除。 */
export async function handleSessionRuntimeSet(
  _ctx: HandlerContext,
  data: SessionRuntimeSetRequestData,
): Promise<SessionRuntimeSetResponseData> {
  if (!getChat(data.chatId)) throw new Error(`Chat "${data.chatId}" not found`);
  const primary = parseRuntimeSelection(data.primary, "session.runtime.set.primary");
  const roles = Object.fromEntries(
    Object.entries(data.roles).map(([role, selection]) => [
      role,
      parseRuntimeSelection(selection, `session.runtime.set.roles.${role}`),
    ]),
  );
  await setSessionRoleRuntimes(data.chatId, primary, roles);
  logger.event("session.runtime.set", {
    chatId: data.chatId,
    primary,
    roles,
    persistence: "memory",
  });
  return { chatId: data.chatId };
}

export function registerSessionRuntimeHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.SESSION_RUNTIME_SET, handleSessionRuntimeSet);
}
