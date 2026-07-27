import type { WebSocket } from 'ws'
import { handleChatStartSpawn } from './handler.js'
import { connectionManager } from '../websocket/connection.js'
import { transport } from '../websocket/transport.js'
import { appendChatEvent } from '@/db/delivery.js'
import { logger } from '@/utils/logger/index.js'
import type { Chunk, Notification } from '../message/types.js'

/**
 * 子 agent 后台启动（fire-and-forget）。
 *
 * 动机：用户原设计要求「子 agent 与主 agent 走同一条 API 路径」。原 chat.startSpawn 「前端驱动」模型
 *   一旦前端 RPC 失败（网络抖动 / 页面关闭 / chatId 错配），子 agent stream 永远不到前端。
 *   把启动收敛到 spawn_role sense 内部后端（与 chat.send 同样在 ws 推送 stream），彻底消除该失败路径：
 *     spawn_role 完成 → startChildEager(taskId, parentChatId) → runChildTaskInBackground 后台 →
 *     handleChatStartSpawn claim + handleChatSend 绑子 chatId → chunk/notification 持久化 + 推 parent ws。
 *
 * 与 websocket/index.ts.handleRequest 的差异：本函数脱离 RPC 请求上下文（无 wrapStreamingHandler）。
 *   仍复用 persistChatEvent 加 seq + sendToWs 序列化发到 ws，保证 chat.sync 重连能回放。
 */

/** 持久化 chat 事件 seq（chat_events 表，monotonic per chat），与 websocket/index.ts.persistChatEvent 同语义。 */
function persistChatEvent<T extends { chatId?: string; seq?: number }>(
  method: string,
  event: T,
): T {
  if (
    (method === 'chat.send' || method === 'chat.resume' || method === 'chat.startSpawn') &&
    event.chatId
  ) {
    event.seq = appendChatEvent(event.chatId, event as Record<string, unknown>)
  }
  return event
}

/** 单条 ws 推送（与 websocket/index.ts.sendChatEvent 同语义，service 层脱离调用版）。 */
function sendToWss(targets: readonly WebSocket[], item: unknown): void {
  for (const ws of targets) {
    if (ws.readyState !== ws.OPEN) continue
    for (const routed of connectionManager.prepareSessionEvent(ws, item)) {
      try {
        ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
      } catch (err) {
        logger.event('ws.event.failed', { message: (err as Error).message }, 3)
      }
    }
  }
}

/**
 * 解析实时输出目标 ws（liveOutput 命中 → 重定向 ws；否则回落运行启动 ws）。
 * 与 websocket/index.ts.resolveOutputWs 同语义。
 */
function resolveOutputWss(item: { chatId?: string }, fallbackWs: WebSocket): WebSocket[] {
  return item.chatId ? connectionManager.getChatOutputs(item.chatId, fallbackWs) : [fallbackWs]
}

/**
 * 取父 chat 所属 ws + connectionId（用于子 agent 后台启动 stream 输出目标）。
 * 父 chat 流活跃期间（chat.send/chat.resume 入口 bindChatConnection）必定可解析。
 * spawn_role sense 期间 parent 流必然活跃（子 agent 不会在父未启动时 spawn）→ 此查找
 *   按设计 100% 命中；异常竞态返回 undefined → 上层 warn + 不阻塞（fallback to chat.startSpawn RPC）。
 */
function resolveParentWs(
  parentChatId: string,
): { ws: WebSocket; connectionId: string } | undefined {
  const ws = connectionManager.findWsByChatId(parentChatId)
  if (!ws) return undefined
  const state = connectionManager.get(ws)
  if (!state) return undefined
  return { ws, connectionId: state.id }
}

/**
 * 后台驱动 handleChatStartSpawn（fire-and-forget）。
 * 错误隔离：try/catch 包外层，失败仅记 logger.error，不回传 spawn_role 主流程。
 *
 * 不与 spawn_role sense 同步等待（避免阻塞 sense_end 返回），故调用方用 `void runChildTaskInBackground(...)`。
 * 若父 ws 异常竞态无可用 → 仅 warn 让 chat.startSpawn RPC 兜底；不抛错。
 *
 * 终态 Response（yield*.value）：含 success/data（runId / finished / alreadyFinished）。前端 chat.startSpawn RPC
 *   走 recovery 分支消费（同时调用将命中 alreadyFinished / alreadyRunning / 中途 resume）。
 */
export async function runChildTaskInBackground(
  taskId: string,
  parentChatId: string,
): Promise<void> {
  // 同步解析 ws（脱 ws 在 sense 同帧关闭/迁移时仍报 1-shot 失败，能早暴露）
  const resolved = resolveParentWs(parentChatId)
  if (!resolved) {
    logger.event('spawn.eager.no_parent_ws', { taskId, parentChatId }, 3)
    console.warn(
      `[spawnEager] parent ${parentChatId} 无活跃 ws，跳过 eager 启动（fallback to chat.startSpawn RPC）`,
    )
    return
  }
  const { ws: parentWs, connectionId } = resolved

  // 构造脱离 RPC 的 minimal ctx。requestId 用 eager-{taskId} 区分流（与 wsClient 收 chunk 时
  //   该 idx 不匹配 → 走 seq path 而非 response path 派发 chunk,符合 chat.send 同语义）。
  const ctx = {
    requestId: `eager-${taskId}`,
    connectionId,
    log: logger,
  }

  try {
    // handleChatStartSpawn 在 handleChatSend 内部已 bindChatConnection 子 chatId + 在 finally 中
    //   releaseChatConnection；chatOwnerConnections 持久保留（role_reply 唤醒后续可达）。
    const generator = handleChatStartSpawn(ctx, { taskId })

    while (true) {
      const iter = await generator.next()
      if (iter.done) {
        // 终态 Response——前端 chat.startSpawn RPC recovery 会拿到同样的 success/data（首次 claimed.firstStart=false
        //   走 resume 分支 → alreadyRunning / 已 finished 走 alreadyFinished,详见 handler.ts:471-489）。
        logger.event('spawn.eager.done', {
          taskId,
          success: 'success' in iter.value ? iter.value.success : undefined,
        })
        break
      }
      const item = persistChatEvent('chat.startSpawn', iter.value as Chunk | Notification)
      sendToWss(resolveOutputWss(item, parentWs), item)
    }
  } catch (error) {
    logger.event(
      'spawn.eager.failed',
      {
        taskId,
        parentChatId,
        message: (error as Error).message,
        stack: (error as Error).stack,
      },
      3,
    )
    console.error(`[spawnEager] task ${taskId} 后台运行失败:`, (error as Error).message)
  }
}
