import type { HandlerContext } from "../message/router.js";
import {
  createChunk,
  createError,
  createNotification,
  createResponse,
  ErrorCode,
  Method,
  type Chunk,
  type Notification,
  type Response as RpcResponse,
  type ChatSendRequestData,
  type ChatSendResponseData,
  type ChatResumeRequestData,
  type ChatResumeResponseData,
  type SenseApprovalRequestData,
  type SenseApprovalResponseData,
} from "../message/types.js";
import { getChat, addMessage, getMessages, parseMessageRow, fillApprovalResult, markMessagesRevoked, markMessageReplaced, getChatRuntimeSelection, updateChatMetadata } from "@/db/chat.js";
import { approvalManager } from "../approval/manager.js";
import { connectionManager } from "../websocket/connection.js";
import { AgentBuilder } from "@/agent/builder.js";
import type { RuntimeSelection } from "@/agent/runtimeResolver.js";
import type {
  MiddlewareChunk,
  SenseTriggerChunk,
  SenseAcceptChunk,
  SenseRejectChunk,
  StagedChunk,
} from "@/core/middleware/types";
import { SupervisionLevel } from "@/core/config";
import type { LLMResponse } from "@/core/message/adapter";
import { logger } from "@/utils/logger/index.js";

/**
 * Chat 运行时缓存：chatId → builder + runtime 选择（单 chat 绑定，跨轮不重建）
 *
 * 每个 chatId 独享一个 AgentBuilder 实例（不再全局单例），与 Middleware 一同随 chat 生命周期存在。
 * runtime selection 由 chat.create/runtime.set 原子注入。
 * 实例不重建，messages 天然保留，无需迁移。
 */
interface ChatRuntime {
  builder: AgentBuilder;
  selection?: RuntimeSelection;
}

const chatRuntimes = new Map<string, ChatRuntime>();

/**
 * 取 chat 对应的完整运行时。
 * ensureChat 后必定存在，缺失则视为内部错误。
 */
async function ensureRuntime(chatId: string): Promise<ChatRuntime> {
  await ensureChat(chatId);
  const runtime = chatRuntimes.get(chatId);
  if (!runtime) {
    throw new Error(`Chat runtime not initialized: ${chatId}`);
  }
  return runtime;
}

/**
 * 原子解析并注入完整 runtime。
 */
function configureRuntime(
  runtime: ChatRuntime,
  chatId: string,
  selection: RuntimeSelection,
): void {
  runtime.selection = selection;
  runtime.builder.configureRuntime(selection);
  // 持久化 selection 到 metadata.runtime，服务重启后 ensureChat 自动恢复
  updateChatMetadata(chatId, { runtime: selection });
}

/**
 * 从 DB 加载历史消息，交给 builder.init 注入 middleware 内存。
 * 仅 ensureChat 创建时调用一次，send/resume 不再重复加载。
 */
function loadHistory(chatId: string): LLMResponse[] | undefined {
  const rows = getMessages(chatId);
  if (rows.length === 0) {
    return undefined;
  }
  return rows.map((row) => {
    const parsed = parseMessageRow(row);
    return {
      id: row.id,
      role: parsed.role,
      content: parsed.content ?? "",
      thinking: parsed.thinking,
      senseCalls: parsed.senseCall,
      hash: parsed.hash,
      replace: parsed.replace,
      originalContent: parsed.originalContent,
      revoked: parsed.revoked,
      createdAt: row.created_at,
      updateAt: row.created_at,
    };
  });
}

/**
 * 获取或创建 chat 对应的 AgentBuilder 实例（单 chat 绑定，跨轮不重建）。
 *
 * 创建时完成：原子配置 runtime（如传入）→ 加载历史。
 * 幂等：已存在直接返回，不重新配置。send/resume 不带 brain/senseGroups，
 * 依赖 create 时已配置的 runtime；服务端重启内存丢失后须重新 create。
 *
 * @param selection 可选，chat.create/runtime.set 携带时参与原子 runtime 配置
 */
export async function ensureChat(
  chatId: string,
  selection?: RuntimeSelection,
): Promise<AgentBuilder> {
  const existing = chatRuntimes.get(chatId);
  if (existing) {
    if (selection) {
      configureRuntime(existing, chatId, selection);
    }
    return existing.builder;
  }

  // 每个 chat 独享一个 AgentBuilder 实例（不再全局单例）
  const builder = new AgentBuilder().build();

  const runtime: ChatRuntime = { builder };
  chatRuntimes.set(chatId, runtime);

  // 原子配置 runtime selection：
  //   1. 显式传入（chat.create/runtime.set）
  //   2. 否则从持久化 metadata.runtime 恢复（服务重启后内存丢失，自动恢复）
  const resolvedSelection = selection ?? getChatRuntimeSelection(chatId);
  if (resolvedSelection) {
    configureRuntime(runtime, chatId, resolvedSelection);
  }

  // 一次性加载历史到内存
  builder.init(chatId, loadHistory(chatId));

  return builder;
}

/**
 * 原子设置 runtime selection。
 * 由 runtime.set handler 调用。
 */
export async function setRuntime(
  chatId: string,
  selection: RuntimeSelection,
): Promise<void> {
  const runtime = await ensureRuntime(chatId);
  configureRuntime(runtime, chatId, selection);
}

/**
 * 将 chatId 从运行时缓存移除（删除 chat 时调用）
 */
export function clearChatRuntime(chatId: string): void {
  chatRuntimes.delete(chatId);
}

/**
 * 统一消费 agent 内部 effect chunk。
 * middleware 只产出事实流，service observer 在这里集中处理 DB/approval 副作用。
 */
export async function* observeAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  chatId: string,
  getMessages: () => LLMResponse[],
): AsyncGenerator<MiddlewareChunk, void, unknown> {
  // 历史消息（loadHistory 注入）视为已落库，避免 abort flush 时重复 INSERT 触发 UNIQUE 冲突。
  const syncedIds = new Set<string>(getMessages().map((m) => m.id));
  try {
    for await (const chunk of generator) {
      if (chunk.type === "message_created") {
        if (!syncedIds.has(chunk.message.id)) {
          addMessage(chunk.message.id, chatId, {
            role: chunk.message.role,
            content: chunk.message.content,
            thinking: chunk.message.thinking,
            senseCall: chunk.message.senseCalls,
            hash: chunk.message.hash,
          });
          syncedIds.add(chunk.message.id);
        }
        continue;
      }

      if (chunk.type === "message_updated") {
        if (chunk.patch.replace) {
          // 感官去重：标记历史消息 replaced（只 UPDATE replace_*/original_content，不动 content）
          markMessageReplaced(chatId, chunk.id, {
            replace: chunk.patch.replace,
            originalContent: chunk.patch.originalContent,
          });
        } else {
          // recovery update patch = { content, hash }，整体写入
          // （旧实现仅判 content 丢 hash → confirm pending sense hash 永远 NULL → 重启去重失效）
          fillApprovalResult(chatId, chunk.id, {
            content: chunk.patch.content,
            hash: chunk.patch.hash,
          });
        }
        syncedIds.add(chunk.id);
        continue;
      }

      if (chunk.type === "sense_pending") {
        if (chunk.approvalResolve && chunk.approvalReject) {
          approvalManager.register(chunk.approvalId, chunk.approvalResolve, chunk.approvalReject);
        }
        continue;
      }

      yield chunk;
    }
  } finally {
    // abort 兜底：ws.close → connectionManager.close → approvalManager.abort 解除 senseMiddleware
    // await（不调 gen.return，避免与 catch yield 死锁）。sense_call 流的 assistant 已在 sense_end
    // 时落库（for-await 内 effect）；纯 content 流的 assistant 在 checkpoint finally yield effect
    // 被 observer 消费落库。此处兜底 flush 极端情况未 sync 的消息，保证 DB 一致。
    for (const m of getMessages()) {
      // 仅落库 user/assistant/sense（system 仅内存 loadHistory 期不入库；function 本项目不产生）
      if (m.revoked) continue;
      if (m.role !== "user" && m.role !== "assistant" && m.role !== "sense") continue;
      if (syncedIds.has(m.id)) continue;
      addMessage(m.id, chatId, {
        role: m.role,
        content: m.content,
        thinking: m.thinking,
        senseCall: m.senseCalls,
        hash: m.hash,
      });
      syncedIds.add(m.id);
    }
  }
}

/**
 * 将 agent generator 的 MiddlewareChunk 转换为 WebSocket 协议的 Chunk/Notification
 * handleChatSend 和 handleChatResume 共用
 */
export async function* streamAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  rid: string,
): AsyncGenerator<Chunk | Notification, void, unknown> {
  let seq = 0;

  for await (const chunk of generator) {
    if (chunk.type === "stream") {
      const streamData: Record<string, unknown> = {};
      if (chunk.thinkingDelta) {
        streamData.thinking = chunk.thinkingDelta;
      }
      if (chunk.contentDelta) {
        streamData.content = chunk.contentDelta;
      }
      if (chunk.senseDelta && chunk.senseDelta.length > 0) {
        streamData.senseCall = chunk.senseDelta;
      }
      yield createChunk("stream", rid, streamData, ++seq);
    } else if (chunk.type === "staged") {
      const staged = chunk as StagedChunk;
      const stagedData: Record<string, unknown> = {
        type: staged.stagedType,
      };
      if (staged.thinking) {
        stagedData.thinking = staged.thinking;
      }
      if (staged.content) {
        stagedData.content = staged.content;
      }
      if (staged.senseName) {
        stagedData.senseName = staged.senseName;
      }
      if (staged.senseArguments) {
        stagedData.arguments = staged.senseArguments;
      }
      if (staged.id) {
        stagedData.id = staged.id;
      }
      yield createChunk("staged", rid, stagedData);
    } else if (chunk.type === "sense_end") {
      const sc = chunk as SenseTriggerChunk;
      logger.info(`[Stream] sense_end, id=${sc.id}, name=${sc.name}, supervision=${sc.supervisionLevel}`);

      yield createNotification("interrupt", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        arguments: sc.arguments,
        supervisionLevel: sc.supervisionLevel,
        needsApproval: sc.supervisionLevel > SupervisionLevel.auto,
      });
    } else if (chunk.type === "sense_accept") {
      const sc = chunk as SenseAcceptChunk;
      logger.info(`[Stream] sense_accept, id=${sc.id}, name=${sc.name}`);
      yield createNotification("accept", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        result: sc.result,
      });
    } else if (chunk.type === "sense_reject") {
      const sc = chunk as SenseRejectChunk;
      logger.info(`[Stream] sense_reject, id=${sc.id}, name=${sc.name}`);
      yield createNotification("rejected", rid, {
        approvalId: sc.id,
        senseName: sc.name,
        reason: sc.reason,
      });
    } else if (chunk.type === "consumed") {
      yield createNotification("consumed", rid, { count: (chunk as { count?: number }).count || 0 });
    } else if (chunk.type === "error") {
      const e = chunk as { errors: Array<{ message: string }> };
      yield createNotification("error", rid, { message: e.errors[0]?.message || "Unknown error" });
    } else if (chunk.type === "done") {
      logger.info(`[Stream] done`);
      yield createNotification("done", rid, null);
    } else if (
      chunk.type === "message_created" ||
      chunk.type === "message_updated" ||
      chunk.type === "sense_pending"
    ) {
      // 内部 effect chunk 应由 observeAgentChunks 消费，不进入传输层。
      continue;
    }
  }
}

/**
 * 发送聊天消息（流式）
 * runtime 由 chat.create/runtime.set 设置，send 只携带 chatId + prompt。
 */
export async function* handleChatSend(
  ctx: HandlerContext,
  data: ChatSendRequestData,
): AsyncGenerator<Chunk | Notification, ChatSendResponseData | RpcResponse, unknown> {
  const chatId = data.chatId;

  // 校验 chat 存在
  const chat = getChat(chatId);
  if (!chat) {
    throw new Error(`Chat "${chatId}" not found`);
  }

  logger.info(`[ChatSend] chatId=${chatId}, prompt="${data.prompt}"`);

  const agent = await ensureChat(chatId);
  const rid = ctx.requestId ?? chatId;

  // 绑定 chatId 到当前连接，拒绝跨连接并发 send（P0-3）
  try {
    connectionManager.bindChatConnection(chatId, ctx.connectionId);
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(`[ChatSend] 绑定连接失败: ${msg}`);
    yield createNotification("error", rid, { message: msg });
    return createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, msg));
  }

  // 恢复场景撤回：仅 idle 时触发（运行中 send 只入队，不撤回）。
  // 撤回末尾整个当前周期 AI 响应（assistant think/content/tool + 整个 sense 群），
  // 发 staged.reverse chunk 通知客户端回滚，再 run 用新 prompt 重跑。
  if (!agent.isRunning()) {
    const revokedIds = agent.revokeTrailingCycle();
    if (revokedIds.length > 0) {
      markMessagesRevoked(chatId, revokedIds);
      logger.info(`[ChatSend] Recovery revoke ${revokedIds.length} msgs: ${revokedIds.join(", ")}`);
      yield createChunk("staged", rid, { type: "reverse", messageIds: revokedIds });
    }
  }

  let failureResponse: RpcResponse | undefined;

  try {
    // history 已在 chat.create 时一次性加载到内存。
    // 若当前 chat 正在运行，send 只入队输入；新输出会跟随已有运行流发出。
    const generator = observeAgentChunks(agent.run(data.prompt), chatId, () => agent.getMessages());

    yield* streamAgentChunks(generator, rid);
  } catch (err) {
    const error = err as Error;
    logger.error(`[ChatSend] 执行失败: ${error.message}`, error.stack ?? "");
    yield createNotification("error", rid, { message: error.message });
    failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, error.message));
  } finally {
    connectionManager.releaseChatConnection(chatId, ctx.connectionId);
  }

  return failureResponse ?? { chatId };
}

/**
 * chat.resume — 续接（无 prompt，恢复执行 / 继续 loop）
 * 前置：chat.get 返回 canResume:true（末尾为未完成周期：pending sense 或 done sense 无后续 assistant）。
 * Case1（末尾有 pending sense）→ 置 resumePending 标志，首轮 senseMiddleware skip chat 层，
 *   从历史 pending 重建 SenseTriggerChunk 执行（按监管等级；工具不在 senseTable 写「无此工具」）；
 * Case2（末尾全 done）→ run("") 正常 loop，LLM 基于 done sense 结果回复。
 * 整体同默认 send 流一致，仅首轮跳过 chat。前置：须 chat.create / runtime.set 注入完整 runtime。
 */
export async function* handleChatResume(
  ctx: HandlerContext,
  data: ChatResumeRequestData,
): AsyncGenerator<Chunk | Notification, ChatResumeResponseData | RpcResponse, unknown> {
  const chatId = data.chatId;
  const rid = ctx.requestId ?? chatId;

  const chat = getChat(chatId);
  if (!chat) {
    throw new Error(`Chat "${chatId}" not found`);
  }

  logger.info(`[ChatResume] chatId=${chatId} (continue, no prompt)`);

  const agent = await ensureChat(chatId);

  // 绑定 chatId 到当前连接，拒绝跨连接并发 resume（P0-3）
  try {
    connectionManager.bindChatConnection(chatId, ctx.connectionId);
  } catch (e) {
    const msg = (e as Error).message;
    logger.error(`[ChatResume] 绑定连接失败: ${msg}`);
    yield createNotification("error", rid, { message: msg });
    return createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, msg));
  }

  let failureResponse: RpcResponse | undefined;
  try {
    // resume 内部据末尾状态决定 Case1/Case2（见 builder.resume）
    const generator = observeAgentChunks(agent.resume(), chatId, () => agent.getMessages());
    yield* streamAgentChunks(generator, rid);
  } catch (err) {
    const error = err as Error;
    logger.error(`[ChatResume] 执行失败: ${error.message}`, error.stack ?? "");
    yield createNotification("error", rid, { message: error.message });
    failureResponse = createResponse(rid, false, undefined, createError(ErrorCode.INTERNAL, error.message));
  } finally {
    connectionManager.releaseChatConnection(chatId, ctx.connectionId);
  }

  return failureResponse ?? { chatId };
}

/**
 * 审批 Sense
 */
export async function handleSenseApproval(
  _ctx: HandlerContext,
  data: SenseApprovalRequestData,
): Promise<SenseApprovalResponseData> {
  // 调用 approvalResolve
  approvalManager.confirm(data.approvalId, data.action, data.reason);

  return {
    approvalId: data.approvalId,
    action: data.action,
  };
}

/**
 * 注册 Chat handlers
 */
export function registerChatHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CHAT_SEND, handleChatSend, true);
  router.register(Method.CHAT_RESUME, handleChatResume, true);
  router.register(Method.SENSE_APPROVAL, handleSenseApproval);
}
