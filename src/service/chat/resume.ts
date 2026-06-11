import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type Chunk,
  type Notification,
  type ChatResumeRequestData,
  type ChatResumeResponseData,
} from "../message/types.js";
import { ensureChat, streamAgentChunks } from "./send.js";
import { getChat } from "@/db/chat.js";

/**
 * 恢复执行（pending sense recovery）
 *
 * history 已由 chat.create 原子加载到内存；ensureChat 幂等返回已配置 runtime。
 * 启动 chain 后 senseMiddleware Phase 0 自动检测 role=sense 且 content 为空的
 * pending 消息，重新发起审批/执行。
 *
 * 前置：须先 chat.create（携带 brain + senseGroups，runtime 完整才能 resume）。
 */
export async function* handleChatResume(
  ctx: HandlerContext,
  params: unknown,
): AsyncGenerator<Chunk | Notification, ChatResumeResponseData, unknown> {
  const p = params as ChatResumeRequestData;
  const chatId = p.chatId;

  const chat = getChat(chatId);
  if (!chat) {
    throw new Error(`Chat "${chatId}" not found`);
  }

  // ensureChat 幂等：runtime 已由 chat.create 配置（brain/sense + history 一次性加载）
  const agent = await ensureChat(chatId);

  const generator = agent.resume(chatId);
  const rid = ctx.requestId ?? chatId;

  yield* streamAgentChunks(generator, rid);

  return { chatId };
}

/**
 * 注册 chat.resume handler（流式）
 */
export function registerResumeHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_RESUME, handleChatResume, true);
}
